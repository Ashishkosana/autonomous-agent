import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  configureIntegrationTimeouts,
  describeCloudflare,
  realSandbox,
  recordEvidence,
  uniqueSandboxId,
  type RealSandbox,
} from './gate.js';

/**
 * REAL CLOUDFLARE EXECUTION (credential-gated). Phase 3 required tests 1–7
 * against an actual Cloudflare Sandbox reached through the deployed gateway
 * Worker. Nothing here runs against a fake; when not configured the whole
 * block is reported as skipped.
 */
configureIntegrationTimeouts();

describeCloudflare('Cloudflare Sandbox · execution boundary', () => {
  let sandbox: RealSandbox;
  const evidence: Record<string, unknown> = {};

  beforeAll(async () => {
    sandbox = realSandbox(uniqueSandboxId('agent-p3-boundary'));
    const started = Date.now();
    const state = await sandbox.environment.getState();
    evidence['coldStart'] = {
      status: state.status,
      ms: Date.now() - started,
      metadata: state.metadata,
    };
  });

  afterAll(async () => {
    recordEvidence('execution-boundary', { sandboxId: sandbox?.sandboxId, ...evidence });
    await sandbox?.environment.destroy().catch(() => undefined);
  });

  it('TEST 1 — runs a deterministic Linux command and returns a structured result', async () => {
    const result = await sandbox.environment.runCommand(`printf 'agent-sandbox-ok'`);
    expect(result).toMatchObject({
      command: `printf 'agent-sandbox-ok'`,
      exitCode: 0,
      stdout: 'agent-sandbox-ok',
      stderr: '',
      timedOut: false,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const stderr = await sandbox.environment.runCommand(
      `printf 'to-stderr' >&2; printf 'to-stdout'`,
    );
    expect(stderr.stdout).toBe('to-stdout');
    expect(stderr.stderr).toBe('to-stderr');
    expect(stderr.exitCode).toBe(0);

    const env = await sandbox.environment.runCommand('printf "%s" "$AGENT_PROBE"', {
      env: { AGENT_PROBE: 'env-passthrough' },
    });
    expect(env.stdout).toBe('env-passthrough');

    const cwd = await sandbox.environment.runCommand('pwd', { cwd: '/tmp' });
    expect(cwd.stdout.trim()).toBe('/tmp');

    const stdin = await sandbox.environment.runCommand('cat', {
      stdin: "piped 'input' $HOME\nline2",
    });
    expect(stdin.stdout).toBe("piped 'input' $HOME\nline2");
    evidence['test1'] = { result, stderr, env: env.stdout, cwd: cwd.stdout, stdin: stdin.stdout };
  });

  it('TEST 2 — creates, reads, modifies, lists, checks and deletes a sandbox-local file', async () => {
    const env = sandbox.environment;
    const dir = '/workspace/phase3/fs';
    const path = `${dir}/note.txt`;

    expect(await env.fileExists(path)).toBe(false);
    await env.writeFile(path, 'version 1');
    expect(await env.fileExists(path)).toBe(true);
    expect(await env.readFile(path)).toBe('version 1');

    await env.writeFile(path, 'version 2 — modified');
    expect(await env.readFile(path)).toBe('version 2 — modified');

    const listing = await env.listDirectory(dir);
    const entry = listing.find((e) => e.name === 'note.txt');
    expect(entry).toMatchObject({ path, type: 'file' });
    expect(entry?.sizeBytes).toBe(Buffer.byteLength('version 2 — modified'));

    // Cross-check through the shell: the SDK file API and the container filesystem agree.
    const viaShell = await env.runCommand(`cat ${path} && stat -c '%s' ${path}`);
    expect(viaShell.stdout).toBe(
      `version 2 — modified${Buffer.byteLength('version 2 — modified')}\n`,
    );

    await env.deleteFile(path);
    expect(await env.fileExists(path)).toBe(false);
    await expect(env.readFile(path)).rejects.toMatchObject({ code: 'not_found' });
    evidence['test2'] = { listing, viaShell: viaShell.stdout };
  });

  it('TEST 3 — writes and executes a small program with a runtime that is actually present', async () => {
    const env = sandbox.environment;
    const probe = await env.runCommand(
      'for r in node python3 bun; do if command -v $r >/dev/null 2>&1; then printf "%s=%s\\n" $r "$($r --version 2>&1 | head -1)"; fi; done',
    );
    const runtimes = Object.fromEntries(
      probe.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('=') as [string, string]),
    );
    evidence['test3'] = { runtimes };
    expect(Object.keys(runtimes).length, 'no supported runtime found in the image').toBeGreaterThan(
      0,
    );

    if (runtimes['node']) {
      await env.writeFile(
        '/workspace/phase3/sum.mjs',
        'const n = [...Array(10).keys()].map((i) => i + 1);\nconsole.log(JSON.stringify({ sum: n.reduce((a, b) => a + b, 0), runtime: "node" }));\n',
      );
      const run = await env.runCommand('node /workspace/phase3/sum.mjs');
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ sum: 55, runtime: 'node' });
    }
    if (runtimes['python3']) {
      await env.writeFile(
        '/workspace/phase3/sum.py',
        'import json\nprint(json.dumps({"sum": sum(range(1, 11)), "runtime": "python3"}))\n',
      );
      const run = await env.runCommand('python3 /workspace/phase3/sum.py');
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ sum: 55, runtime: 'python3' });
    }
    if (runtimes['bun']) {
      const run = await env.runCommand(
        'bun -e \'console.log(JSON.stringify({sum: 55, runtime: "bun"}))\'',
      );
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ sum: 55, runtime: 'bun' });
    }
  });

  it('TEST 4 — a failing command is an observation, not a crash', async () => {
    const env = sandbox.environment;
    const failing = await env.runCommand('ls /definitely/not/here; exit 7');
    expect(failing.exitCode).toBe(7);
    expect(failing.stderr).toContain('No such file or directory');
    expect(failing.timedOut).toBe(false);

    const missing = await env.runCommand('this-command-does-not-exist');
    expect(missing.exitCode).toBe(127);
    expect(missing.stderr.toLowerCase()).toContain('not found');

    const timedOut = await env.runCommand('printf started; sleep 30; printf never', {
      timeoutMs: 1_500,
    });
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.exitCode).toBeNull();
    expect(timedOut.stdout).toBe('started');

    // The runtime is still healthy afterwards.
    const after = await env.runCommand(`printf 'still-alive'`);
    expect(after.stdout).toBe('still-alive');
    expect((await env.getState()).status).toBe('ready');
    evidence['test4'] = { failing, missing, timedOut };
  });

  it('TEST 5 — starts a background process, observes it running, stops it, observes termination', async () => {
    const env = sandbox.environment;
    const marker = `agent-p3-${Date.now()}`;
    const handle = await env.startProcess(`sleep 600 # ${marker}`);
    expect(handle.processId.length).toBeGreaterThan(0);

    const running = await env.getState();
    const tracked = running.processes.find((p) => p.processId === handle.processId);
    expect(tracked?.status).toBe('running');
    const psBefore = await env.runCommand(`pgrep -f '${marker}' | wc -l`);
    expect(Number(psBefore.stdout.trim())).toBeGreaterThan(0);

    await env.stopProcess(handle.processId);
    // Give the sandbox a moment to reap; poll briefly rather than sleep blindly.
    let psAfter = '';
    for (let attempt = 0; attempt < 10; attempt += 1) {
      psAfter = (await env.runCommand(`pgrep -f '${marker}' | wc -l`)).stdout.trim();
      if (psAfter === '0') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(psAfter).toBe('0');
    const stopped = await env.getState();
    expect(stopped.processes.find((p) => p.processId === handle.processId)?.status).toBe('killed');
    await expect(env.stopProcess('no-such-process-id')).rejects.toMatchObject({
      code: 'not_found',
    });
    evidence['test5'] = {
      handle,
      before: tracked,
      psBefore: psBefore.stdout,
      psAfter,
      after: stopped.processes,
    };
  });

  it('TEST 6 — has outbound public Internet connectivity from inside the sandbox', async () => {
    const env = sandbox.environment;
    const trace = await env.runCommand(
      'curl -sS --max-time 20 https://www.cloudflare.com/cdn-cgi/trace',
      { timeoutMs: 30_000 },
    );
    expect(trace.exitCode).toBe(0);
    expect(trace.stdout).toContain('h=www.cloudflare.com');
    expect(trace.stdout).toContain('visit_scheme=https');
    expect(trace.stdout).toMatch(/^ip=.+$/m);

    const example = await env.runCommand(
      `curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://example.com`,
      { timeoutMs: 30_000 },
    );
    expect(example.stdout).toBe('200');

    const dns = await env.runCommand('getent hosts example.com || nslookup example.com || true');
    evidence['test6'] = {
      trace: Object.fromEntries(
        trace.stdout
          .trim()
          .split('\n')
          .map((l) => l.split('=') as [string, string])
          .filter(([k]) =>
            ['h', 'visit_scheme', 'loc', 'colo', 'http', 'tls', 'warp', 'sni'].includes(k),
          ),
      ),
      exampleStatus: example.stdout,
      dns: dns.stdout,
    };
  });

  it('TEST 7 — documents the execution boundary without attempting escape', async () => {
    const env = sandbox.environment;
    const probes: Record<string, string> = {
      uname: 'uname -a',
      osRelease: 'head -3 /etc/os-release',
      identity: 'id',
      hostname: 'hostname',
      cwd: 'pwd',
      root: 'ls -1 /',
      workspace: 'ls -la /workspace',
      init: `tr '\\0' ' ' < /proc/1/cmdline`,
      cpus: 'nproc',
      cpuModel: `grep -m1 'model name' /proc/cpuinfo || true`,
      memory: 'free -m',
      disk: 'df -h / /workspace /tmp',
      envNames: 'env | cut -d= -f1 | sort',
      resolv: 'cat /etc/resolv.conf',
      cgroup: 'head -5 /proc/self/cgroup',
      mounts: 'mount | head -25',
      tools:
        'for t in bash sh git curl wget jq python3 node bun timeout; do printf "%s=" $t; command -v $t || echo missing; done',
      processes: 'ps -eo pid,user,comm --no-headers | head -30',
      network: 'ip -brief addr 2>/dev/null || cat /proc/net/dev',
    };
    const boundary: Record<string, string> = {};
    for (const [name, command] of Object.entries(probes)) {
      const result = await env.runCommand(command, { timeoutMs: 20_000 });
      boundary[name] =
        result.exitCode === 0 ? result.stdout : `exit ${result.exitCode}: ${result.stderr}`;
    }
    evidence['test7'] = boundary;

    expect(boundary['uname']).toContain('Linux');
    expect(boundary['identity']).toMatch(/uid=\d+/);
    expect(boundary['cwd']?.trim()).toBe('/workspace');
    expect(boundary['root']).toContain('workspace');
    expect(boundary['tools']).toContain('timeout=/');
    // We only ever print environment variable NAMES.
    expect(boundary['envNames']).not.toContain('=');
  });
});
