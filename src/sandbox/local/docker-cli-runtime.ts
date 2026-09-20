import { spawn } from 'node:child_process';
import {
  ContainerRuntimeError,
  type ContainerExecOptions,
  type ContainerExecResult,
  type ContainerRuntime,
  type ContainerRuntimeInfo,
  type ContainerSpec,
  type ContainerStatus,
} from './container-runtime.js';

export interface DockerCliRuntimeOptions {
  /** Executable name or path; `docker` resolves through PATH on every OS (`docker.exe` on Windows). */
  readonly binary?: string;
  /** Host-side ceiling for control-plane calls (inspect, stop, rm, image inspect). */
  readonly controlTimeoutMs?: number;
}

const CONTAINER_STATUSES: ReadonlySet<string> = new Set([
  'created',
  'running',
  'paused',
  'restarting',
  'removing',
  'exited',
  'dead',
]);

/**
 * `ContainerRuntime` over the Docker CLI. This is the trusted outer controller
 * that talks to Docker Desktop (Windows/macOS) or Docker Engine (Linux); the
 * CLI is spawned directly — never through a shell — with argv built by the
 * pure functions below, so tests can assert the exact flags without Docker.
 *
 * Only this file in `src/` spawns processes; `tests/architecture.test.ts`
 * enforces it.
 */
export class DockerCliRuntime implements ContainerRuntime {
  private readonly binary: string;
  private readonly controlTimeoutMs: number;

  constructor(options: DockerCliRuntimeOptions = {}) {
    this.binary = options.binary ?? 'docker';
    this.controlTimeoutMs = options.controlTimeoutMs ?? 60_000;
  }

  async info(): Promise<ContainerRuntimeInfo> {
    const result = await this.docker(['version', '--format', '{{json .}}'], {});
    if (result.exitCode !== 0) throw classifyDockerFailure(result, 'docker version');
    try {
      const parsed = JSON.parse(result.stdout) as {
        Client?: { Version?: string };
        Server?: { Version?: string; Os?: string; Arch?: string };
      };
      return {
        runtime: 'docker',
        clientVersion: parsed.Client?.Version ?? 'unknown',
        serverVersion: parsed.Server?.Version ?? 'unknown',
        serverOs: parsed.Server?.Os ?? 'unknown',
        serverArch: parsed.Server?.Arch ?? 'unknown',
      };
    } catch (error) {
      throw new ContainerRuntimeError('docker version returned unparseable output', 'unknown', {
        cause: error,
      });
    }
  }

  async imageExists(image: string): Promise<boolean> {
    const result = await this.docker(['image', 'inspect', '--format', '{{.Id}}', image], {});
    if (result.exitCode === 0) return true;
    if (/No such image/i.test(result.stderr)) return false;
    throw classifyDockerFailure(result, `docker image inspect ${image}`);
  }

  async createContainer(spec: ContainerSpec): Promise<string> {
    const result = await this.docker(dockerRunArgs(spec), { timeoutMs: this.controlTimeoutMs * 5 });
    if (result.exitCode !== 0) throw classifyDockerFailure(result, 'docker run');
    return result.stdout.trim();
  }

  async inspectContainer(name: string): Promise<ContainerStatus | undefined> {
    const result = await this.docker(['inspect', '--format', '{{.State.Status}}', name], {});
    if (result.exitCode === 0) {
      const status = result.stdout.trim();
      if (CONTAINER_STATUSES.has(status)) return status as ContainerStatus;
      throw new ContainerRuntimeError(`unexpected container status "${status}"`, 'unknown');
    }
    if (/No such object|No such container/i.test(result.stderr)) return undefined;
    throw classifyDockerFailure(result, `docker inspect ${name}`);
  }

  async exec(
    name: string,
    argv: readonly string[],
    options: ContainerExecOptions = {},
  ): Promise<ContainerExecResult> {
    const result = await this.docker(dockerExecArgs(name, argv, options), {
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (result.timedOut)
      return { exitCode: null, stdout: result.stdout, stderr: result.stderr, timedOut: true };
    if (result.exitCode !== 0 && isDaemonError(result.stderr)) {
      throw classifyDockerFailure(result, `docker exec ${name}`);
    }
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: false,
    };
  }

  async stopContainer(name: string, timeoutSeconds: number): Promise<void> {
    const result = await this.docker(['stop', '--time', String(timeoutSeconds), name], {
      timeoutMs: this.controlTimeoutMs + timeoutSeconds * 1000,
    });
    if (result.exitCode !== 0) throw classifyDockerFailure(result, `docker stop ${name}`);
  }

  async removeContainer(name: string, force: boolean): Promise<void> {
    const result = await this.docker(['rm', ...(force ? ['--force'] : []), name], {});
    if (result.exitCode !== 0) throw classifyDockerFailure(result, `docker rm ${name}`);
  }

  private docker(
    args: readonly string[],
    options: { stdin?: string; timeoutMs?: number },
  ): Promise<SpawnResult> {
    return spawnCollect(this.binary, args, {
      timeoutMs: options.timeoutMs ?? this.controlTimeoutMs,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    });
  }
}

export interface SpawnResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Spawns a binary without a shell, pipes optional stdin, collects UTF-8 output, enforces a wall-clock ceiling. */
export function spawnCollect(
  binary: string,
  args: readonly string[],
  options: { stdin?: string; timeoutMs: number },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(
        error.code === 'ENOENT'
          ? new ContainerRuntimeError(
              `${binary} not found on PATH — is Docker installed and running?`,
              'engine_unavailable',
              { cause: error },
            )
          : new ContainerRuntimeError(`failed to spawn ${binary}: ${error.message}`, 'unknown', {
              cause: error,
            }),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      });
    });
    child.stdin.on('error', () => undefined);
    if (options.stdin !== undefined) child.stdin.end(options.stdin, 'utf8');
    else child.stdin.end();
  });
}

/** Pure: the `docker run` argv for a spec. Every safety flag is visible here. */
export function dockerRunArgs(spec: ContainerSpec): string[] {
  const args = [
    'run',
    '--detach',
    '--name',
    spec.name,
    '--user',
    spec.user,
    '--workdir',
    spec.workdir,
    '--network',
    spec.network,
    '--cpus',
    String(spec.limits.cpus),
    '--memory',
    spec.limits.memory,
    '--memory-swap',
    spec.limits.memory,
    '--pids-limit',
    String(spec.limits.pidsLimit),
    '--stop-timeout',
    String(spec.stopTimeoutSeconds),
  ];
  if (spec.dropAllCapabilities) args.push('--cap-drop', 'ALL');
  if (spec.noNewPrivileges) args.push('--security-opt', 'no-new-privileges:true');
  if (spec.init) args.push('--init');
  for (const [key, value] of Object.entries(spec.env)) args.push('--env', `${key}=${value}`);
  for (const [key, value] of Object.entries(spec.labels)) args.push('--label', `${key}=${value}`);
  for (const mount of spec.mounts) {
    args.push(
      '--mount',
      `type=bind,source=${mount.source},target=${mount.target}${mount.readOnly ? ',readonly' : ''}`,
    );
  }
  args.push(spec.image, ...spec.command);
  return args;
}

/** Pure: the `docker exec` argv for one operation. */
export function dockerExecArgs(
  name: string,
  argv: readonly string[],
  options: ContainerExecOptions,
): string[] {
  const args = ['exec'];
  if (options.stdin !== undefined) args.push('--interactive');
  if (options.cwd !== undefined) args.push('--workdir', options.cwd);
  for (const [key, value] of Object.entries(options.env ?? {}))
    args.push('--env', `${key}=${value}`);
  args.push(name, ...argv);
  return args;
}

/** Daemon/CLI failures are distinguishable from the exec'd command's own stderr by Docker's fixed prefixes. */
export function isDaemonError(stderr: string): boolean {
  return /^(Error response from daemon|Error: No such container|error during connect|Cannot connect to the Docker daemon|docker: )/m.test(
    stderr,
  );
}

export function classifyDockerFailure(result: SpawnResult, context: string): ContainerRuntimeError {
  const stderr = result.stderr.trim();
  const message = `${context} failed (exit ${result.exitCode}): ${stderr || '(no stderr)'}`;
  if (result.timedOut)
    return new ContainerRuntimeError(`${context} timed out`, 'engine_unavailable');
  if (
    /error during connect|Cannot connect to the Docker daemon|pipe\/docker_engine|docker desktop/i.test(
      stderr,
    )
  )
    return new ContainerRuntimeError(message, 'engine_unavailable');
  if (/is not running|is paused|is restarting/i.test(stderr))
    return new ContainerRuntimeError(message, 'container_not_running');
  if (/No such container|No such object/i.test(stderr))
    return new ContainerRuntimeError(message, 'no_such_container');
  if (/No such image|Unable to find image|pull access denied/i.test(stderr))
    return new ContainerRuntimeError(message, 'no_such_image');
  if (/invalid|unknown flag|requires at least/i.test(stderr))
    return new ContainerRuntimeError(message, 'invalid_spec');
  return new ContainerRuntimeError(message, 'unknown');
}
