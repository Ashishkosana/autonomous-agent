import { afterAll, describe, expect, it } from 'vitest';
import { LocalLinuxEnvironment } from '../../src/sandbox/local/local-linux-environment.js';
import { describeExecutionEnvironmentContract } from '../support/execution-environment-contract.js';
import { NamespaceContainerRuntime } from '../support/namespace-container-runtime.js';

/**
 * REAL KERNEL, NO CONTAINER ENGINE. Runs `LocalLinuxEnvironment` over the
 * test-only namespace runtime so the adapter's shell scripts (setsid, kill of
 * a process group, timeout(1), find -printf, cat/rm/test error texts) are
 * exercised on actual Linux. This is NOT Docker and NOT isolation evidence —
 * it only proves the scripts. Skipped on non-Linux hosts and where unshare is
 * unavailable, and never replaces the Docker suite in tests/integration/local.
 */
const unavailable = await NamespaceContainerRuntime.available();
if (unavailable) console.warn(`[skip] namespace script validation NOT RUN — ${unavailable}`);

const runtime = new NamespaceContainerRuntime();
let counter = 0;
const opened: LocalLinuxEnvironment[] = [];
async function open(): Promise<LocalLinuxEnvironment> {
  counter += 1;
  const env = await LocalLinuxEnvironment.start(runtime, `ns-${process.pid}-${counter}`, {
    defaultCommandTimeoutMs: 60_000,
  });
  opened.push(env);
  return env;
}

afterAll(async () => {
  await Promise.all(opened.map((e) => e.destroy().catch(() => undefined)));
});

if (!unavailable) {
  describeExecutionEnvironmentContract(
    'local-linux adapter over Linux namespaces (scripts only)',
    open,
  );
}

describe.skipIf(unavailable)('local-linux scripts on a real kernel', () => {
  it('stdin is piped natively and the shell string is untouched', async () => {
    const env = await open();
    const result = await env.runCommand('cat', { stdin: "piped 'input' $HOME\nline2" });
    expect(result.stdout).toBe("piped 'input' $HOME\nline2");
    const stderr = await env.runCommand(`printf 'to-stderr' >&2; printf 'to-stdout'; exit 7`);
    expect(stderr).toMatchObject({ stdout: 'to-stdout', stderr: 'to-stderr', exitCode: 7 });
  });

  it('cwd and env are applied per call, and the environment is clean', async () => {
    const env = await open();
    expect((await env.runCommand('pwd', { cwd: '/tmp' })).stdout.trim()).toBe('/tmp');
    expect(
      (await env.runCommand('printf "%s" "$AGENT_PROBE"', { env: { AGENT_PROBE: 'v' } })).stdout,
    ).toBe('v');
    const names = (await env.runCommand('env | cut -d= -f1 | sort')).stdout.trim().split('\n');
    expect(names).toContain('AGENT_SANDBOX');
    expect(names).not.toContain('CLOUDFLARE_API_TOKEN');
    expect(names).not.toContain('AGENT_SANDBOX_GATEWAY_TOKEN');
  });

  it('timeout(1) really terminates the process and keeps partial output', async () => {
    const env = await open();
    const started = Date.now();
    const result = await env.runCommand('printf started; sleep 30; printf never', {
      timeoutMs: 1_000,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({ timedOut: true, exitCode: null, stdout: 'started' });
    // The killed sleep may be a zombie for a moment until init reaps it; poll briefly.
    let leftovers = '';
    for (let i = 0; i < 20; i += 1) {
      leftovers = (await env.runCommand('pgrep -f "[s]leep 30" | wc -l')).stdout.trim();
      if (leftovers === '0') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(leftovers).toBe('0');
  });

  it('write/read/list/delete use real coreutils, including parent creation and byte sizes', async () => {
    const env = await open();
    const content = 'line1\n$(rm -rf /) `x` \'q\' "dq" — utf8\n';
    await env.writeFile('/workspace/deep/er/file.txt', content);
    expect(await env.readFile('/workspace/deep/er/file.txt')).toBe(content);
    const [entry] = await env.listDirectory('/workspace/deep/er');
    expect(entry).toEqual({
      name: 'file.txt',
      path: '/workspace/deep/er/file.txt',
      type: 'file',
      sizeBytes: Buffer.byteLength(content),
    });
    expect((await env.listDirectory('/workspace/deep'))[0]?.type).toBe('directory');
    await expect(env.listDirectory('/workspace/absent')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(env.deleteFile('/workspace/absent')).rejects.toMatchObject({ code: 'not_found' });
    await expect(env.readFile('/workspace/deep')).rejects.toMatchObject({ code: 'internal' });
    await env.deleteFile('/workspace/deep/er/file.txt');
    expect(await env.fileExists('/workspace/deep/er/file.txt')).toBe(false);
  });

  it('background processes are session leaders; stop kills the whole group; exit codes are captured', async () => {
    const env = await open();
    const marker = `nsmark${Date.now()}`;
    const handle = await env.startProcess(
      `sh -c 'sleep 600; echo ${marker}' & sleep 600 # ${marker}`,
    );
    let state = await env.getState();
    expect(state.processes[0]?.status).toBe('running');
    expect(
      Number(
        (
          await env.runCommand(`pgrep -f "[${marker.slice(0, 1)}]${marker.slice(1)}" | wc -l`)
        ).stdout.trim(),
      ),
    ).toBeGreaterThan(0);

    await env.stopProcess(handle.processId);
    let remaining = '';
    for (let i = 0; i < 20; i += 1) {
      remaining = (
        await env.runCommand(`pgrep -f "[${marker.slice(0, 1)}]${marker.slice(1)}" | wc -l`)
      ).stdout.trim();
      if (remaining === '0') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(remaining).toBe('0');
    state = await env.getState();
    expect(state.processes[0]?.status).toBe('killed');

    const quick = await env.startProcess('sh -c "printf out; exit 3"');
    let observed = state.processes[1];
    for (let i = 0; i < 20; i += 1) {
      observed = (await env.getState()).processes.find((p) => p.processId === quick.processId);
      if (observed?.status === 'exited') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(observed).toMatchObject({ status: 'exited', exitCode: 3 });
    await env.stopProcess(quick.processId); // idempotent on an exited process
  });

  it('destroy removes sandbox-local files; a fresh start does not see them', async () => {
    const env = await open();
    await env.writeFile('/workspace/state.txt', 'first life');
    const dir = runtime.containers.get(env.containerName)?.workspaceDir;
    await env.destroy();
    expect(dir && (await import('node:fs')).existsSync(dir)).toBe(false);
    const again = await open();
    expect(await again.fileExists('/workspace/state.txt')).toBe(false);
  });
});
