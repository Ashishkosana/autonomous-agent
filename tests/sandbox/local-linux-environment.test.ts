import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExecutionEnvironmentError } from '../../src/sandbox/execution-environment.js';
import { ContainerRuntimeError } from '../../src/sandbox/local/container-runtime.js';
import {
  ContainerScripts,
  PROCESS_DIR,
  START_PROCESS_SCRIPT,
  parseListLine,
} from '../../src/sandbox/local/container-scripts.js';
import {
  classifyDockerFailure,
  dockerExecArgs,
  dockerRunArgs,
  isDaemonError,
} from '../../src/sandbox/local/docker-cli-runtime.js';
import {
  LOCAL_LINUX_PROVIDER,
  LocalLinuxEnvironment,
  fileError,
  toEnvironmentStatus,
} from '../../src/sandbox/local/local-linux-environment.js';
import {
  DEFAULT_LOCAL_SANDBOX_LIMITS,
  LOCAL_SANDBOX_IMAGE,
  LOCAL_SANDBOX_IMAGE_VERSION,
  MountPolicyViolation,
  buildContainerSpec,
  validateMount,
} from '../../src/sandbox/local/sandbox-spec.js';
import { describeExecutionEnvironmentContract } from '../support/execution-environment-contract.js';
import { FakeContainerRuntime } from '../support/fake-container-runtime.js';

/**
 * UNIT TESTS WITH A FAKE RUNTIME. They prove the adapter's mapping from the
 * provider-neutral contract onto container exec calls — not that Docker or
 * Linux behave as assumed. That evidence comes from tests/integration/local
 * (real Docker) and tests/sandbox/local-linux-namespace.test.ts (real kernel,
 * scripts only).
 */

let counter = 0;
async function build(options: Parameters<typeof LocalLinuxEnvironment.start>[2] = {}) {
  const runtime = new FakeContainerRuntime();
  runtime.images.add(LOCAL_SANDBOX_IMAGE);
  counter += 1;
  const env = await LocalLinuxEnvironment.start(runtime, `agent-test-${counter}`, options);
  return { runtime, env };
}

describeExecutionEnvironmentContract(
  'local-linux adapter over FakeContainerRuntime',
  async () => (await build()).env,
);

describe('LocalLinuxEnvironment · lifecycle', () => {
  it('refuses to start when the image has not been built, with a helpful message', async () => {
    const runtime = new FakeContainerRuntime();
    await expect(LocalLinuxEnvironment.start(runtime, 'agent-no-image')).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('npm run sandbox:build'),
    });
    expect(runtime.containers.size).toBe(0);
  });

  it('creates one container per environment with the reviewed spec', async () => {
    const { runtime, env } = await build();
    expect(env.descriptor).toEqual({
      provider: LOCAL_LINUX_PROVIDER,
      environmentId: env.containerName,
    });
    const created = runtime.containers.get(env.containerName);
    expect(created?.spec).toMatchObject({
      image: LOCAL_SANDBOX_IMAGE,
      user: 'agent',
      workdir: '/workspace',
      network: 'bridge',
      dropAllCapabilities: true,
      noNewPrivileges: true,
      init: true,
      mounts: [],
      command: ['sleep', 'infinity'],
      limits: DEFAULT_LOCAL_SANDBOX_LIMITS,
    });
    expect(created?.spec.labels).toMatchObject({ 'agent.sandbox': '1' });
  });

  it('start → use → stop → destroy is observable through getState', async () => {
    const { runtime, env } = await build();
    expect((await env.getState()).status).toBe('ready');

    await env.writeFile('/workspace/f.txt', 'x');
    await env.stop();
    expect((await env.getState()).status).toBe('stopped');
    expect((await env.getState()).metadata['containerStatus']).toBe('exited');
    // Filesystem survives stop (container still exists) but operations are refused.
    expect(runtime.containers.get(env.containerName)?.files.get('/workspace/f.txt')).toBe('x');
    await expect(env.readFile('/workspace/f.txt')).rejects.toMatchObject({ code: 'unavailable' });

    await env.destroy();
    expect(runtime.containers.has(env.containerName)).toBe(false);
    expect((await env.getState()).status).toBe('stopped');
    expect((await env.getState()).metadata['phase']).toBe('destroyed');
    await env.destroy(); // idempotent
    expect(runtime.controlLog.filter((l) => l.startsWith('rm'))).toHaveLength(1);
  });

  it('destroy removes the writable layer: a new start on the same name is a fresh filesystem', async () => {
    const runtime = new FakeContainerRuntime();
    runtime.images.add(LOCAL_SANDBOX_IMAGE);
    const first = await LocalLinuxEnvironment.start(runtime, 'agent-recreate');
    await first.writeFile('/workspace/state.txt', 'from the first life');
    await first.destroy();
    const second = await LocalLinuxEnvironment.start(runtime, 'agent-recreate');
    expect(await second.fileExists('/workspace/state.txt')).toBe(false);
  });

  it('reports error when the container vanished underneath a running environment', async () => {
    const { runtime, env } = await build();
    runtime.containers.delete(env.containerName);
    const state = await env.getState();
    expect(state.status).toBe('error');
    expect(state.metadata['containerStatus']).toBe('absent');
  });

  it('reports error with the engine failure when the runtime is unreachable', async () => {
    const { runtime, env } = await build();
    runtime.failWith = new ContainerRuntimeError(
      'Cannot connect to the Docker daemon',
      'engine_unavailable',
    );
    const state = await env.getState();
    expect(state.status).toBe('error');
    expect(state.metadata['lastErrorKind']).toBe('engine_unavailable');
    await expect(env.runCommand('true')).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('LocalLinuxEnvironment · runCommand', () => {
  it('always wraps commands in an in-container timeout(1); the default bounds runaway commands', async () => {
    const { runtime, env } = await build({ defaultCommandTimeoutMs: 30_000, killGraceSeconds: 2 });
    await env.runCommand(`printf 'agent-local-ok'`);
    const call = runtime.calls.at(-1);
    expect(call?.argv).toEqual(['timeout', '-k', '2', '30', 'sh', '-c', `printf 'agent-local-ok'`]);
    // Host-side backstop is deadline + kill grace + client grace, never shorter than the deadline.
    expect(call?.options.timeoutMs).toBeGreaterThan(30_000);
  });

  it('passes cwd, env and stdin through the runtime without touching the shell string', async () => {
    const { runtime, env } = await build();
    const result = await env.runCommand('cat', {
      cwd: '/tmp',
      env: { AGENT_PROBE: 'value with spaces' },
      stdin: "piped 'input' $HOME",
    });
    expect(result.stdout).toBe("piped 'input' $HOME");
    const call = runtime.calls.at(-1);
    expect(call?.options).toMatchObject({
      cwd: '/tmp',
      env: { AGENT_PROBE: 'value with spaces' },
      stdin: "piped 'input' $HOME",
    });
    expect(call?.argv.at(-1)).toBe('cat');
  });

  it('rejects environment variable names that could be mistaken for flags or shell', async () => {
    const { env } = await build();
    await expect(env.runCommand('true', { env: { '-e X': '1' } })).rejects.toBeInstanceOf(
      ExecutionEnvironmentError,
    );
    await expect(env.runCommand('true', { env: { 'A=B': '1' } })).rejects.toMatchObject({
      code: 'internal',
    });
  });

  it('a deadline reached inside the container is timedOut with partial output and no exit code', async () => {
    let now = 0;
    const { env } = await build({ now: () => (now += 2_000) });
    const result = await env.runCommand('printf started; sleep 30; printf never', {
      timeoutMs: 1_500,
    });
    expect(result).toMatchObject({ timedOut: true, exitCode: null, stdout: 'started' });
  });

  it('exit 124 from a fast command is an ordinary exit code, not a timeout', async () => {
    const { env } = await build();
    const result = await env.runCommand('exit 124', { timeoutMs: 60_000 });
    expect(result).toMatchObject({ timedOut: false, exitCode: 124 });
  });

  it('a hung exec client (host backstop) is reported as timedOut, not thrown', async () => {
    const { runtime, env } = await build();
    runtime.setShell(() => ({ exitCode: null, stdout: 'partial', stderr: '', timedOut: true }));
    const result = await env.runCommand('hang', { timeoutMs: 1_000 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe('partial');
    expect(result.stderr).toContain('[local-linux]');
  });

  it('non-zero exit codes are results, not exceptions, and command not found is 127', async () => {
    const { env } = await build();
    expect((await env.runCommand('exit 7')).exitCode).toBe(7);
    const missing = await env.runCommand('this-command-does-not-exist');
    expect(missing.exitCode).toBe(127);
    expect(missing.stderr).toContain('not found');
  });
});

describe('LocalLinuxEnvironment · files', () => {
  it('writeFile creates parents by streaming the content on stdin (no shell interpolation)', async () => {
    const { runtime, env } = await build();
    const content = 'line1\n$(rm -rf /) `x` \'quotes\' "dq"\n';
    await env.writeFile('/workspace/deep/er/file.txt', content);
    const call = runtime.calls.at(-1);
    expect(call?.argv).toEqual(ContainerScripts.writeFile('/workspace/deep/er/file.txt'));
    expect(call?.options.stdin).toBe(content);
    expect(await env.readFile('/workspace/deep/er/file.txt')).toBe(content);
    const listing = await env.listDirectory('/workspace/deep');
    expect(listing).toEqual([
      { name: 'er', path: '/workspace/deep/er', type: 'directory', sizeBytes: 4096 },
    ]);
  });

  it('listDirectory maps find output to typed entries with absolute paths and byte sizes', async () => {
    const { env } = await build();
    await env.writeFile('/workspace/dir/b.txt', 'bb');
    await env.writeFile('/workspace/dir/a.txt', 'a');
    await env.writeFile('/workspace/dir/sub/c.txt', 'ccc');
    expect(await env.listDirectory('/workspace/dir/')).toEqual([
      { name: 'a.txt', path: '/workspace/dir/a.txt', type: 'file', sizeBytes: 1 },
      { name: 'b.txt', path: '/workspace/dir/b.txt', type: 'file', sizeBytes: 2 },
      { name: 'sub', path: '/workspace/dir/sub', type: 'directory', sizeBytes: 4096 },
    ]);
    await expect(env.listDirectory('/workspace/nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('maps filesystem errors from stderr onto contract codes', async () => {
    const { env } = await build();
    await expect(env.readFile('/workspace/missing')).rejects.toMatchObject({ code: 'not_found' });
    await expect(env.deleteFile('/workspace/missing')).rejects.toMatchObject({ code: 'not_found' });
    await expect(env.readFile('/workspace')).rejects.toMatchObject({ code: 'internal' });
    expect(
      fileError(
        { exitCode: 1, stdout: '', stderr: 'cat: /etc/shadow: Permission denied', timedOut: false },
        'read',
      ).code,
    ).toBe('permission_denied');
  });

  it('fileExists distinguishes false (exit 1) from failures (other exits)', async () => {
    const { runtime, env } = await build();
    expect(await env.fileExists('/workspace')).toBe(true);
    expect(await env.fileExists('/workspace/nope')).toBe(false);
    runtime.setShell(() => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
    runtime.failWith = new ContainerRuntimeError(
      'container x is not running',
      'container_not_running',
    );
    await expect(env.fileExists('/workspace')).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('LocalLinuxEnvironment · processes', () => {
  it('starts a detached session leader, tracks it by our own id, and stops the whole group', async () => {
    const { runtime, env } = await build({ killGraceSeconds: 3 });
    const handle = await env.startProcess('sleep 600', { cwd: '/tmp', env: { A: '1' } });
    expect(handle.processId).toBe('proc-1');
    const startCall = runtime.calls.at(-1);
    expect(startCall?.argv).toEqual([
      'sh',
      '-c',
      START_PROCESS_SCRIPT,
      'sh',
      'proc-1',
      'sleep 600',
    ]);
    expect(startCall?.options).toMatchObject({ cwd: '/tmp', env: { A: '1' } });

    let state = await env.getState();
    expect(state.processes).toEqual([
      { processId: 'proc-1', command: 'sleep 600', status: 'running' },
    ]);

    await env.stopProcess('proc-1');
    const stopCall = runtime.calls.at(-1);
    expect(stopCall?.argv).toEqual(ContainerScripts.stopProcess('1001', 30));
    state = await env.getState();
    expect(state.processes[0]?.status).toBe('killed');
  });

  it('observes a process that exited on its own, with its exit code', async () => {
    const { runtime, env } = await build();
    const handle = await env.startProcess('sh -c "exit 3"');
    runtime.finishProcess(env.containerName, handle.processId, 3);
    const state = await env.getState();
    expect(state.processes[0]).toEqual({
      processId: handle.processId,
      command: 'sh -c "exit 3"',
      status: 'exited',
      exitCode: 3,
    });
    // Stopping an already-exited process is not an error; it just refreshes state.
    await env.stopProcess(handle.processId);
    expect((await env.getState()).processes[0]?.status).toBe('exited');
  });

  it('unknown process ids are not_found; processes never leak across environments', async () => {
    const { env } = await build();
    await expect(env.stopProcess('proc-99')).rejects.toMatchObject({ code: 'not_found' });
    const other = (await build()).env;
    await env.startProcess('sleep 1');
    expect((await other.getState()).processes).toEqual([]);
  });

  it('stopping or destroying the container marks running processes killed', async () => {
    const { env } = await build();
    await env.startProcess('sleep 600');
    await env.stop();
    expect((await env.getState()).processes[0]?.status).toBe('killed');
  });
});

describe('container scripts', () => {
  it('pass caller data as positional parameters, never interpolated', () => {
    const hostile = `'; rm -rf / #`;
    for (const argv of [
      ContainerScripts.readFile(hostile),
      ContainerScripts.writeFile(hostile),
      ContainerScripts.deleteFile(hostile),
      ContainerScripts.fileExists(hostile),
      ContainerScripts.listDirectory(hostile),
      ContainerScripts.startProcess('p', hostile),
    ]) {
      expect(argv).toContain(hostile);
      expect(argv.filter((a) => a !== hostile).join(' ')).not.toContain('rm -rf');
    }
    expect(ContainerScripts.processStatus('42', 'p')).toContain(`${PROCESS_DIR}/p/exit`);
  });

  it('parses find lines, including names containing tabs', () => {
    expect(parseListLine('f\t12\ta.txt')).toEqual({ typeLetter: 'f', size: 12, name: 'a.txt' });
    expect(parseListLine('d\t4096\tweird\tname')).toEqual({
      typeLetter: 'd',
      size: 4096,
      name: 'weird\tname',
    });
    expect(parseListLine('garbage')).toBeUndefined();
  });
});

describe('sandbox spec and mount policy', () => {
  it('has safe defaults: no mounts, bridge network, non-root, limits, cap-drop, no-new-privileges, init', () => {
    const spec = buildContainerSpec('x');
    expect(spec.mounts).toEqual([]);
    expect(spec.network).toBe('bridge');
    expect(spec.user).toBe('agent');
    expect(spec.limits).toEqual({ cpus: 2, memory: '2g', pidsLimit: 256 });
    expect(spec.dropAllCapabilities && spec.noNewPrivileges && spec.init).toBe(true);
    expect(Object.keys(spec.env).sort()).toEqual(['AGENT_SANDBOX', 'LANG', 'PYTHONUNBUFFERED']);
  });

  it.each([
    ['/', 'root'],
    ['C:\\', 'drive'],
    ['C:\\Users', 'users'],
    ['C:\\Users\\ashish', 'a Windows home'],
    ['c:/users/ashish/', 'a Windows home, forward slashes'],
    ['/home/ashish', 'a Linux home'],
    ['/Users/ashish', 'a macOS home'],
    ['/var/run/docker.sock', 'the Docker socket'],
    ['//./pipe/docker_engine', 'the Windows Docker pipe'],
    ['/var/run', 'a parent of the Docker socket'],
    ['/etc', 'etc'],
  ])('refuses to mount %s (%s)', (source) => {
    expect(() => validateMount({ source, target: '/mnt/x', readOnly: true })).toThrow(
      MountPolicyViolation,
    );
  });

  it('allows an explicit project directory and requires absolute targets', () => {
    expect(() =>
      validateMount({
        source: 'C:\\Users\\ashish\\projects\\agent\\workspace',
        target: '/workspace/project',
        readOnly: false,
      }),
    ).not.toThrow();
    expect(() =>
      validateMount({
        source: '/home/ashish/projects/agent',
        target: '/workspace/project',
        readOnly: false,
      }),
    ).not.toThrow();
    expect(() =>
      validateMount({ source: '/srv/data', target: 'relative', readOnly: true }),
    ).toThrow(MountPolicyViolation);
  });

  it('refuses host networking at the type level and in the spec', () => {
    // 'host' is not assignable; runtime check for callers that bypass types.
    expect(buildContainerSpec('x', { network: 'none' }).network).toBe('none');
    expect(dockerRunArgs(buildContainerSpec('x'))).not.toContain('host');
  });
});

describe('docker CLI argv builders (pure)', () => {
  it('docker run carries every safety flag and no forbidden ones', () => {
    const args = dockerRunArgs(buildContainerSpec('agent-sandbox-1'));
    const joined = args.join(' ');
    expect(args.slice(0, 2)).toEqual(['run', '--detach']);
    expect(joined).toContain('--name agent-sandbox-1');
    expect(joined).toContain('--user agent');
    expect(joined).toContain('--workdir /workspace');
    expect(joined).toContain('--network bridge');
    expect(joined).toContain('--cpus 2');
    expect(joined).toContain('--memory 2g --memory-swap 2g');
    expect(joined).toContain('--pids-limit 256');
    expect(joined).toContain('--cap-drop ALL');
    expect(joined).toContain('--security-opt no-new-privileges:true');
    expect(joined).toContain('--init');
    expect(joined).toContain('--label agent.sandbox=1');
    expect(args.slice(-3)).toEqual([LOCAL_SANDBOX_IMAGE, 'sleep', 'infinity']);
    for (const forbidden of [
      '--privileged',
      '--network host',
      '--mount',
      '--volume',
      '-v ',
      '--publish',
      '-p ',
      'docker.sock',
    ]) {
      expect(joined).not.toContain(forbidden);
    }
  });

  it('docker exec adds --interactive only with stdin and passes cwd/env as flags', () => {
    expect(dockerExecArgs('c', ['sh', '-c', 'true'], {})).toEqual([
      'exec',
      'c',
      'sh',
      '-c',
      'true',
    ]);
    expect(dockerExecArgs('c', ['cat'], { stdin: 'x', cwd: '/tmp', env: { A: '1' } })).toEqual([
      'exec',
      '--interactive',
      '--workdir',
      '/tmp',
      '--env',
      'A=1',
      'c',
      'cat',
    ]);
  });

  it('classifies docker failures into runtime error kinds', () => {
    const r = (stderr: string) => ({ exitCode: 1, stdout: '', stderr, timedOut: false });
    expect(
      classifyDockerFailure(r('error during connect: open //./pipe/docker_engine'), 'x').kind,
    ).toBe('engine_unavailable');
    expect(
      classifyDockerFailure(
        r('Cannot connect to the Docker daemon at unix:///var/run/docker.sock'),
        'x',
      ).kind,
    ).toBe('engine_unavailable');
    expect(
      classifyDockerFailure(r('Error response from daemon: container abc is not running'), 'x')
        .kind,
    ).toBe('container_not_running');
    expect(
      classifyDockerFailure(r('Error response from daemon: No such container: abc'), 'x').kind,
    ).toBe('no_such_container');
    expect(
      classifyDockerFailure(r('Unable to find image agent-sandbox-local:9.9.9 locally'), 'x').kind,
    ).toBe('no_such_image');
    expect(isDaemonError('Error response from daemon: x')).toBe(true);
    expect(isDaemonError('ls: cannot access /x: No such file or directory')).toBe(false);
  });

  it('maps container statuses to environment statuses', () => {
    expect(toEnvironmentStatus('running', 'running')).toBe('ready');
    expect(toEnvironmentStatus('created', 'running')).toBe('starting');
    expect(toEnvironmentStatus('exited', 'stopped')).toBe('stopped');
    expect(toEnvironmentStatus('dead', 'running')).toBe('error');
    expect(toEnvironmentStatus(undefined, 'running')).toBe('error');
    expect(toEnvironmentStatus(undefined, 'destroyed')).toBe('stopped');
  });
});

describe('image version is pinned consistently', () => {
  const root = join(import.meta.dirname, '..', '..');
  it('Dockerfile label, sandbox-spec constant and scripts/sandbox-image.mjs agree', () => {
    const dockerfile = readFileSync(join(root, 'sandbox', 'local-linux', 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain(
      `org.opencontainers.image.version="${LOCAL_SANDBOX_IMAGE_VERSION}"`,
    );
    expect(dockerfile).toMatch(/^FROM node:\d+\.\d+\.\d+-bookworm-slim$/m);
    expect(dockerfile).toMatch(/^USER agent$/m);
    expect(dockerfile).not.toMatch(/docker(\.io|-ce|\.sock)/);
    const script = readFileSync(join(root, 'scripts', 'sandbox-image.mjs'), 'utf8');
    expect(script).toContain(`IMAGE = '${LOCAL_SANDBOX_IMAGE}'`);
  });
});
