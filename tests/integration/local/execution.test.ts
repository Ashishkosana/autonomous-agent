import { afterAll, beforeAll, expect, it } from 'vitest';
import type { LocalLinuxEnvironment } from '../../../src/sandbox/local/local-linux-environment.js';
import {
  configureIntegrationTimeouts,
  describeLocalDocker,
  recordEvidence,
  startSandbox,
} from './gate.js';

/**
 * REAL LOCAL LINUX EXECUTION (Docker-gated). Phase 3B tests 1–9 against a
 * disposable container built from sandbox/local-linux/Dockerfile. Nothing here
 * touches a fake; without Docker the whole block is reported as skipped.
 */
configureIntegrationTimeouts();

describeLocalDocker('LocalLinuxEnvironment · real execution', () => {
  let env: LocalLinuxEnvironment;
  const evidence: Record<string, unknown> = {};

  beforeAll(async () => {
    const started = Date.now();
    env = await startSandbox('agent-p3b-exec');
    const state = await env.getState();
    evidence['start'] = {
      ms: Date.now() - started,
      status: state.status,
      metadata: state.metadata,
    };
  });

  afterAll(async () => {
    recordEvidence('execution', { container: env?.containerName, ...evidence });
    await env?.destroy().catch(() => undefined);
  });

  it('TEST 1 — command execution: stdout, stderr, exit code, env, cwd, stdin', async () => {
    const result = await env.runCommand(`printf 'agent-local-ok'`);
    expect(result).toMatchObject({
      command: `printf 'agent-local-ok'`,
      exitCode: 0,
      stdout: 'agent-local-ok',
      stderr: '',
      timedOut: false,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const streams = await env.runCommand(`printf 'to-stderr' >&2; printf 'to-stdout'`);
    expect(streams).toMatchObject({ stdout: 'to-stdout', stderr: 'to-stderr', exitCode: 0 });

    const envVar = await env.runCommand('printf "%s" "$AGENT_PROBE"', {
      env: { AGENT_PROBE: 'env-passthrough' },
    });
    expect(envVar.stdout).toBe('env-passthrough');

    const cwd = await env.runCommand('pwd', { cwd: '/tmp' });
    expect(cwd.stdout.trim()).toBe('/tmp');

    const stdin = await env.runCommand('cat', { stdin: "piped 'input' $HOME\nline2" });
    expect(stdin.stdout).toBe("piped 'input' $HOME\nline2");
    evidence['test1'] = {
      result,
      streams,
      env: envVar.stdout,
      cwd: cwd.stdout,
      stdin: stdin.stdout,
    };
  });

  it('TEST 2 — filesystem: create, read, modify, list, exists, delete, confirm', async () => {
    const dir = '/workspace/phase3b/fs';
    const path = `${dir}/note.txt`;
    expect(await env.fileExists(path)).toBe(false);
    await env.writeFile(path, 'version 1');
    expect(await env.fileExists(path)).toBe(true);
    expect(await env.readFile(path)).toBe('version 1');

    await env.writeFile(path, 'version 2 — modified');
    expect(await env.readFile(path)).toBe('version 2 — modified');

    const listing = await env.listDirectory(dir);
    expect(listing).toEqual([
      {
        name: 'note.txt',
        path,
        type: 'file',
        sizeBytes: Buffer.byteLength('version 2 — modified'),
      },
    ]);
    // Cross-check through the shell: adapter file ops and the container filesystem agree.
    const viaShell = await env.runCommand(`cat ${path} && stat -c '%s %U' ${path}`);
    expect(viaShell.stdout).toBe(
      `version 2 — modified${Buffer.byteLength('version 2 — modified')} agent\n`,
    );

    await env.deleteFile(path);
    expect(await env.fileExists(path)).toBe(false);
    await expect(env.readFile(path)).rejects.toMatchObject({ code: 'not_found' });
    evidence['test2'] = { listing, viaShell: viaShell.stdout };
  });

  it('TEST 3 — Python runs inside the sandbox', async () => {
    const version = await env.runCommand('python3 --version');
    expect(version.exitCode).toBe(0);
    await env.writeFile(
      '/workspace/phase3b/sum.py',
      'import json, sys, platform\nprint(json.dumps({"sum": sum(range(1, 11)), "runtime": "python3", "version": platform.python_version()}))\n',
    );
    const run = await env.runCommand('python3 /workspace/phase3b/sum.py');
    expect(run.exitCode).toBe(0);
    const parsed = JSON.parse(run.stdout) as { sum: number; runtime: string; version: string };
    expect(parsed).toMatchObject({ sum: 55, runtime: 'python3' });
    expect(parsed.version).toMatch(/^3\.\d+\.\d+$/);
    evidence['test3'] = { version: version.stdout.trim(), output: parsed };
  });

  it('TEST 4 — Node runs inside the sandbox', async () => {
    const version = await env.runCommand('node --version');
    expect(version.stdout.trim()).toMatch(/^v22\.\d+\.\d+$/);
    await env.writeFile(
      '/workspace/phase3b/sum.mjs',
      'const n = [...Array(10).keys()].map((i) => i + 1);\nconsole.log(JSON.stringify({ sum: n.reduce((a, b) => a + b, 0), runtime: "node", version: process.version }));\n',
    );
    const run = await env.runCommand('node /workspace/phase3b/sum.mjs');
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ sum: 55, runtime: 'node' });
    evidence['test4'] = { version: version.stdout.trim(), output: JSON.parse(run.stdout) };
  });

  it('TEST 5 — a failing command is a structured result, not a crash', async () => {
    const failing = await env.runCommand('ls /definitely/not/here; exit 7');
    expect(failing.exitCode).toBe(7);
    expect(failing.stderr).toContain('No such file or directory');
    expect(failing.timedOut).toBe(false);

    const missing = await env.runCommand('this-command-does-not-exist');
    expect(missing.exitCode).toBe(127);
    expect(missing.stderr.toLowerCase()).toContain('not found');

    const after = await env.runCommand(`printf 'still-alive'`);
    expect(after.stdout).toBe('still-alive');
    expect((await env.getState()).status).toBe('ready');
    evidence['test5'] = { failing, missing };
  });

  it('TEST 6 — a command exceeding its deadline is actually terminated', async () => {
    const started = Date.now();
    const timedOut = await env.runCommand('printf started; sleep 30; printf never', {
      timeoutMs: 1_500,
    });
    const elapsed = Date.now() - started;
    expect(timedOut).toMatchObject({ timedOut: true, exitCode: null, stdout: 'started' });
    expect(elapsed).toBeLessThan(15_000);

    let leftovers = '';
    for (let i = 0; i < 20; i += 1) {
      leftovers = (await env.runCommand('pgrep -f "[s]leep 30" | wc -l')).stdout.trim();
      if (leftovers === '0') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(leftovers).toBe('0');
    evidence['test6'] = { timedOut, elapsedMs: elapsed, leftovers };
  });

  it('TEST 7 — background process: start, observe running, stop, observe stopped', async () => {
    const marker = `p3bmark${Date.now()}`;
    const bracketed = `[${marker.slice(0, 1)}]${marker.slice(1)}`;
    const handle = await env.startProcess(
      `sh -c 'sleep 600; echo ${marker}' & sleep 600 # ${marker}`,
    );
    expect(handle.processId.length).toBeGreaterThan(0);

    const running = await env.getState();
    expect(running.processes.find((p) => p.processId === handle.processId)?.status).toBe('running');
    const before = Number((await env.runCommand(`pgrep -f '${bracketed}' | wc -l`)).stdout.trim());
    expect(before).toBeGreaterThan(0);

    await env.stopProcess(handle.processId);
    let after = '';
    for (let i = 0; i < 25; i += 1) {
      after = (await env.runCommand(`pgrep -f '${bracketed}' | wc -l`)).stdout.trim();
      if (after === '0') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(after).toBe('0');
    const stopped = await env.getState();
    expect(stopped.processes.find((p) => p.processId === handle.processId)?.status).toBe('killed');

    const quick = await env.startProcess('sh -c "exit 3"');
    let observed = stopped.processes[0];
    for (let i = 0; i < 20; i += 1) {
      observed = (await env.getState()).processes.find((p) => p.processId === quick.processId);
      if (observed?.status === 'exited') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(observed).toMatchObject({ status: 'exited', exitCode: 3 });
    await expect(env.stopProcess('no-such-process-id')).rejects.toMatchObject({
      code: 'not_found',
    });
    evidence['test7'] = { handle, before, after, processes: (await env.getState()).processes };
  });

  it('TEST 8 — outbound Internet from inside the sandbox', async () => {
    const example = await env.runCommand(
      `curl -sS -o /dev/null -w '%{http_code} %{remote_ip}' --max-time 20 https://example.com`,
      { timeoutMs: 30_000 },
    );
    expect(example.exitCode).toBe(0);
    expect(example.stdout).toMatch(/^200 /);

    const trace = await env.runCommand(
      'curl -sS --max-time 20 https://www.cloudflare.com/cdn-cgi/trace',
      {
        timeoutMs: 30_000,
      },
    );
    expect(trace.exitCode).toBe(0);
    expect(trace.stdout).toContain('visit_scheme=https');

    const dns = await env.runCommand('getent hosts example.com');
    expect(dns.exitCode).toBe(0);
    evidence['test8'] = {
      exampleStatus: example.stdout.split(' ')[0],
      trace: Object.fromEntries(
        trace.stdout
          .trim()
          .split('\n')
          .map((l) => l.split('=') as [string, string])
          .filter(([k]) => ['h', 'visit_scheme', 'loc', 'colo', 'http', 'tls'].includes(k)),
      ),
      dnsResolved: dns.exitCode === 0,
    };
  });

  it('TEST 9 — isolation: documents mounts, identity, environment and capabilities without escape attempts', async () => {
    const probes: Record<string, string> = {
      uname: 'uname -a',
      osRelease: 'head -3 /etc/os-release',
      identity: 'id',
      hostname: 'hostname',
      cwd: 'pwd',
      init: `tr '\\0' ' ' < /proc/1/cmdline`,
      root: 'ls -1 /',
      workspace: 'ls -la /workspace',
      home: 'ls -la ~',
      mounts: 'cat /proc/self/mounts',
      envNames: 'env | cut -d= -f1 | sort',
      capabilities: 'grep -E "^Cap(Eff|Bnd|Prm)" /proc/self/status',
      noNewPrivs: 'grep NoNewPrivs /proc/self/status',
      cgroupLimits:
        'cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max 2>/dev/null || echo cgroup-v1-or-unavailable',
      nproc: 'nproc',
      network:
        'cat /proc/net/route | tail -n +2 | wc -l; ip -brief addr 2>/dev/null || cat /proc/net/dev',
      dockerSocket: 'ls -la /var/run/docker.sock 2>&1 || true',
      windowsMounts: 'ls -d /mnt/c /c /host_mnt 2>&1 || true',
      sudo: 'command -v sudo || echo no-sudo',
      aptAsAgent: 'apt-get install -y curl 2>&1 | head -2 || true',
      tools:
        'for t in bash sh git curl jq python3 pip3 node npm timeout setsid find ps pgrep; do printf "%s=" $t; command -v $t || echo missing; done',
    };
    const boundary: Record<string, string> = {};
    for (const [name, command] of Object.entries(probes)) {
      const result = await env.runCommand(command, { timeoutMs: 20_000 });
      boundary[name] =
        result.exitCode === 0
          ? result.stdout
          : `exit ${result.exitCode}: ${result.stdout}${result.stderr}`;
    }
    evidence['test9'] = boundary;

    expect(boundary['uname']).toContain('Linux');
    expect(boundary['identity']).toMatch(/uid=10001\(agent\)/);
    expect(boundary['cwd']?.trim()).toBe('/workspace');
    expect(boundary['init']).toMatch(/init|tini|sleep/);
    // No host filesystem: no Windows drive mounts, no Docker socket, no bind mounts at all.
    expect(boundary['dockerSocket']).toMatch(/No such file/);
    expect(boundary['windowsMounts']).toMatch(/No such file/);
    expect(boundary['mounts']).not.toMatch(/\/mnt\/c|\/host_mnt|docker\.sock|C:\\/);
    expect(boundary['mounts']).not.toMatch(/ \/workspace /); // writable layer, not a bind mount
    // Only the variables we set: nothing from the host process environment.
    const names = (boundary['envNames'] ?? '').trim().split('\n');
    for (const forbidden of [
      'CLOUDFLARE_API_TOKEN',
      'AGENT_SANDBOX_GATEWAY_TOKEN',
      'USERPROFILE',
      'APPDATA',
      'SSH_AUTH_SOCK',
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
    ])
      expect(names).not.toContain(forbidden);
    expect(names).toContain('AGENT_SANDBOX');
    // Capabilities dropped: effective and bounding sets are empty; no-new-privileges set.
    expect(boundary['capabilities']).toMatch(/CapEff:\s+0000000000000000/);
    expect(boundary['capabilities']).toMatch(/CapBnd:\s+0000000000000000/);
    expect(boundary['noNewPrivs']).toMatch(/NoNewPrivs:\s+1/);
    expect(boundary['sudo']?.trim()).toBe('no-sudo');
    expect(boundary['aptAsAgent']).toMatch(/Permission denied|are you root|exit \d+/i);
    // Resource limits are visible from inside on cgroup v2 (the authoritative check is
    // `docker inspect` in lifecycle.test.ts; cgroup v1 engines print the fallback marker).
    if (!boundary['cgroupLimits']?.includes('cgroup-v1-or-unavailable'))
      expect(boundary['cgroupLimits']).toMatch(/^200000 100000\n2147483648\n256\n$/);
    expect(boundary['tools']).not.toContain('missing');
  });
});
