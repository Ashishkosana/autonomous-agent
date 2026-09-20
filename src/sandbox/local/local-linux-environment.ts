import {
  ExecutionEnvironmentError,
  type CommandOptions,
  type CommandResult,
  type DirectoryEntry,
  type DirectoryEntryType,
  type EnvironmentDescriptor,
  type EnvironmentState,
  type EnvironmentStatus,
  type ExecutionEnvironment,
  type ProcessHandle,
  type ProcessState,
} from '../execution-environment.js';
import {
  ContainerRuntimeError,
  type ContainerExecOptions,
  type ContainerExecResult,
  type ContainerRuntime,
  type ContainerSpec,
  type ContainerStatus,
} from './container-runtime.js';
import { ContainerScripts, parseListLine } from './container-scripts.js';
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  buildContainerSpec,
  type LocalSandboxOptions,
} from './sandbox-spec.js';

export const LOCAL_LINUX_PROVIDER = 'local-linux';

/** `timeout(1)` exit statuses: 124 = deadline reached, 137 = child needed SIGKILL. */
const TIMEOUT_EXIT_CODES: ReadonlySet<number> = new Set([124, 137]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface LocalLinuxEnvironmentOptions extends LocalSandboxOptions {
  /** Applied when a caller passes no `timeoutMs`; bounds runaway commands. */
  readonly defaultCommandTimeoutMs?: number;
  /** Seconds `timeout(1)` waits after SIGTERM before SIGKILL. */
  readonly killGraceSeconds?: number;
  /** Extra host-side wait for the exec client beyond the in-container deadline. */
  readonly clientGraceMs?: number;
  readonly now?: () => number;
}

interface TrackedProcess {
  readonly processId: string;
  readonly pid: string;
  readonly command: string;
  readonly startedAt: string;
  state: ProcessState;
}

/**
 * Local Linux container implementation of the provider-neutral
 * `ExecutionEnvironment` (ADR-002). One instance owns exactly one disposable
 * container created from the pinned sandbox image. All operations are
 * `exec`s of small POSIX scripts (`container-scripts.ts`) through a
 * `ContainerRuntime`; the agent never sees the runtime.
 *
 * Lifecycle (explicit, owned by the composition layer, not by the agent):
 *
 *   LocalLinuxEnvironment.start()  →  use  →  stop()  →  destroy()
 *
 * `stop()` halts the container but keeps its filesystem inspectable;
 * `destroy()` removes container and writable layer — every sandbox-local file
 * and process is gone. A new `start()` is a fresh Linux.
 *
 * Semantics chosen to match the Cloudflare adapter so the runtime cannot tell
 * them apart: `timeoutMs` is enforced INSIDE the container with `timeout(1)`
 * (partial output survives, exit 124/137 at/after the deadline →
 * `timedOut: true, exitCode: null`); stdin is piped natively; background
 * processes are detached in their own session and signalled as a group.
 */
export class LocalLinuxEnvironment implements ExecutionEnvironment {
  readonly descriptor: EnvironmentDescriptor;
  readonly containerName: string;
  readonly spec: ContainerSpec;
  private readonly workspaceRoot: string;
  private readonly defaultCommandTimeoutMs: number;
  private readonly killGraceSeconds: number;
  private readonly clientGraceMs: number;
  private readonly now: () => number;
  private readonly processes = new Map<string, TrackedProcess>();
  private processCounter = 0;
  private containerId: string | undefined;
  private phase: 'created' | 'running' | 'stopped' | 'destroyed' = 'created';

  private constructor(
    private readonly runtime: ContainerRuntime,
    containerName: string,
    options: LocalLinuxEnvironmentOptions,
  ) {
    this.containerName = containerName;
    this.spec = buildContainerSpec(containerName, options);
    this.workspaceRoot = this.spec.workdir;
    this.descriptor = { provider: LOCAL_LINUX_PROVIDER, environmentId: containerName };
    this.defaultCommandTimeoutMs = options.defaultCommandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.killGraceSeconds = options.killGraceSeconds ?? 2;
    this.clientGraceMs = options.clientGraceMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /** Creates and starts the container. Fails fast if the image was never built. */
  static async start(
    runtime: ContainerRuntime,
    containerName: string,
    options: LocalLinuxEnvironmentOptions = {},
  ): Promise<LocalLinuxEnvironment> {
    const env = new LocalLinuxEnvironment(runtime, containerName, options);
    await env.startContainer();
    return env;
  }

  /** Bare instance for unit tests that drive the lifecycle explicitly. */
  static create(
    runtime: ContainerRuntime,
    containerName: string,
    options: LocalLinuxEnvironmentOptions = {},
  ): LocalLinuxEnvironment {
    return new LocalLinuxEnvironment(runtime, containerName, options);
  }

  async startContainer(): Promise<void> {
    if (this.phase === 'running') return;
    if (this.phase === 'destroyed')
      throw new ExecutionEnvironmentError('environment was destroyed', 'unavailable');
    try {
      if (!(await this.runtime.imageExists(this.spec.image))) {
        throw new ExecutionEnvironmentError(
          `sandbox image ${this.spec.image} is not present; build it with \`npm run sandbox:build\``,
          'unavailable',
        );
      }
      this.containerId = await this.runtime.createContainer(this.spec);
      this.phase = 'running';
    } catch (error) {
      throw toEnvironmentError(error, 'start container');
    }
  }

  async runCommand(command: string, options: CommandOptions = {}): Promise<CommandResult> {
    const startedAt = this.now();
    const timeoutMs = options.timeoutMs ?? this.defaultCommandTimeoutMs;
    const seconds = Math.max(0.1, timeoutMs / 1000);
    const argv = ContainerScripts.runCommand(command, seconds, this.killGraceSeconds);
    const result = await this.exec(argv, this.execOptions(options, timeoutMs), 'run command');
    const durationMs = this.now() - startedAt;
    if (result.timedOut) {
      return {
        command,
        exitCode: null,
        stdout: result.stdout,
        stderr: `${result.stderr}[local-linux] exec client deadline exceeded; the in-container timeout should have terminated the process`,
        durationMs,
        timedOut: true,
      };
    }
    const timedOut =
      result.exitCode !== null &&
      TIMEOUT_EXIT_CODES.has(result.exitCode) &&
      durationMs >= timeoutMs;
    return {
      command,
      exitCode: timedOut ? null : result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs,
      timedOut,
    };
  }

  async readFile(path: string): Promise<string> {
    const result = await this.exec(ContainerScripts.readFile(path), {}, `read ${path}`);
    if (result.exitCode === 0) return result.stdout;
    throw fileError(result, `read ${path}`);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const result = await this.exec(
      ContainerScripts.writeFile(path),
      { stdin: content },
      `write ${path}`,
    );
    if (result.exitCode !== 0) throw fileError(result, `write ${path}`);
  }

  async deleteFile(path: string): Promise<void> {
    const result = await this.exec(ContainerScripts.deleteFile(path), {}, `delete ${path}`);
    if (result.exitCode !== 0) throw fileError(result, `delete ${path}`);
  }

  async fileExists(path: string): Promise<boolean> {
    const result = await this.exec(ContainerScripts.fileExists(path), {}, `stat ${path}`);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw fileError(result, `stat ${path}`);
  }

  async listDirectory(path: string): Promise<readonly DirectoryEntry[]> {
    const result = await this.exec(ContainerScripts.listDirectory(path), {}, `list ${path}`);
    if (result.exitCode !== 0) throw fileError(result, `list ${path}`);
    const base = path.endsWith('/') ? path.slice(0, -1) : path;
    const entries: DirectoryEntry[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line === '') continue;
      const parsed = parseListLine(line);
      if (!parsed) continue;
      entries.push({
        name: parsed.name,
        path: `${base}/${parsed.name}`,
        type: toEntryType(parsed.typeLetter),
        sizeBytes: parsed.size,
      });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async startProcess(command: string, options: CommandOptions = {}): Promise<ProcessHandle> {
    this.processCounter += 1;
    const processId = `proc-${this.processCounter}`;
    const result = await this.exec(
      ContainerScripts.startProcess(processId, command),
      this.execOptions(options, undefined),
      'start process',
    );
    const pid = result.stdout.trim();
    if (result.exitCode !== 0 || !/^\d+$/.test(pid)) {
      throw new ExecutionEnvironmentError(
        `local-linux: failed to start process: ${result.stderr || `exit ${result.exitCode}`}`,
        'internal',
      );
    }
    const startedAt = new Date(this.now()).toISOString();
    this.processes.set(processId, {
      processId,
      pid,
      command,
      startedAt,
      state: { processId, command, status: 'running' },
    });
    return { processId, command, startedAt };
  }

  async stopProcess(processId: string): Promise<void> {
    const tracked = this.processes.get(processId);
    if (!tracked) {
      throw new ExecutionEnvironmentError(`local-linux: unknown process ${processId}`, 'not_found');
    }
    const result = await this.exec(
      ContainerScripts.stopProcess(tracked.pid, this.killGraceSeconds * 10),
      {},
      `stop process ${processId}`,
    );
    if (result.exitCode === 3) {
      // Nothing left to signal: it exited on its own before we got there.
      if (tracked.state.status === 'running') await this.refreshProcess(tracked);
      return;
    }
    if (result.exitCode !== 0) {
      throw new ExecutionEnvironmentError(
        `local-linux: failed to stop process ${processId}: ${result.stderr}`,
        'internal',
      );
    }
    tracked.state = { processId, command: tracked.command, status: 'killed' };
  }

  async getState(): Promise<EnvironmentState> {
    const base = {
      descriptor: this.descriptor,
      workspaceRoot: this.workspaceRoot,
    };
    if (this.phase === 'destroyed' || this.phase === 'created') {
      return {
        ...base,
        status: 'stopped',
        processes: this.processStates(),
        metadata: { containerName: this.containerName, phase: this.phase },
      };
    }
    let status: ContainerStatus | undefined;
    try {
      status = await this.runtime.inspectContainer(this.containerName);
    } catch (error) {
      return {
        ...base,
        status: 'error',
        processes: this.processStates(),
        metadata: {
          containerName: this.containerName,
          phase: this.phase,
          lastError: error instanceof Error ? error.message : String(error),
          lastErrorKind: error instanceof ContainerRuntimeError ? error.kind : 'unknown',
        },
      };
    }
    if (status === 'running') {
      for (const tracked of this.processes.values()) {
        if (tracked.state.status === 'running') await this.refreshProcess(tracked);
      }
    }
    return {
      ...base,
      status: toEnvironmentStatus(status, this.phase),
      processes: this.processStates(),
      metadata: {
        containerName: this.containerName,
        containerId: this.containerId ?? null,
        containerStatus: status ?? 'absent',
        phase: this.phase,
        image: this.spec.image,
        limits: this.spec.limits,
        network: this.spec.network,
        user: this.spec.user,
        mounts: this.spec.mounts.map((m) => `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`),
      },
    };
  }

  /** Halts the container; filesystem stays until `destroy()`. */
  async stop(): Promise<void> {
    if (this.phase !== 'running') return;
    try {
      await this.runtime.stopContainer(this.containerName, this.spec.stopTimeoutSeconds);
    } catch (error) {
      throw toEnvironmentError(error, 'stop container');
    }
    this.phase = 'stopped';
    for (const tracked of this.processes.values()) {
      if (tracked.state.status === 'running')
        tracked.state = { ...tracked.state, status: 'killed' };
    }
  }

  /** Removes the container and its writable layer. Idempotent. */
  async destroy(): Promise<void> {
    if (this.phase === 'destroyed') return;
    if (this.phase !== 'created') {
      try {
        await this.runtime.removeContainer(this.containerName, true);
      } catch (error) {
        if (!(error instanceof ContainerRuntimeError && error.kind === 'no_such_container'))
          throw toEnvironmentError(error, 'destroy container');
      }
    }
    this.phase = 'destroyed';
    for (const tracked of this.processes.values()) {
      if (tracked.state.status === 'running')
        tracked.state = { ...tracked.state, status: 'killed' };
    }
  }

  private async exec(
    argv: readonly string[],
    options: ContainerExecOptions,
    context: string,
  ): Promise<ContainerExecResult> {
    if (this.phase !== 'running') {
      throw new ExecutionEnvironmentError(
        `local-linux: cannot ${context}: container is ${this.phase}`,
        'unavailable',
      );
    }
    try {
      return await this.runtime.exec(this.containerName, argv, options);
    } catch (error) {
      throw toEnvironmentError(error, context);
    }
  }

  private execOptions(
    options: CommandOptions,
    timeoutMs: number | undefined,
  ): ContainerExecOptions {
    if (options.env) {
      for (const name of Object.keys(options.env)) {
        if (!ENV_NAME.test(name))
          throw new ExecutionEnvironmentError(
            `local-linux: invalid environment variable name ${JSON.stringify(name)}`,
            'internal',
          );
      }
    }
    return {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(timeoutMs !== undefined
        ? { timeoutMs: timeoutMs + this.killGraceSeconds * 1000 + this.clientGraceMs }
        : {}),
    };
  }

  private async refreshProcess(tracked: TrackedProcess): Promise<void> {
    const result = await this.exec(
      ContainerScripts.processStatus(tracked.pid, tracked.processId),
      {},
      `inspect process ${tracked.processId}`,
    );
    const [word, code] = result.stdout.trim().split(/\s+/);
    if (word === 'running') return;
    const exitCode = code !== undefined && /^\d+$/.test(code) ? Number(code) : undefined;
    tracked.state = {
      processId: tracked.processId,
      command: tracked.command,
      status: 'exited',
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
  }

  private processStates(): ProcessState[] {
    return [...this.processes.values()].map((p) => p.state);
  }
}

export function toEnvironmentStatus(
  status: ContainerStatus | undefined,
  phase: 'created' | 'running' | 'stopped' | 'destroyed',
): EnvironmentStatus {
  if (status === undefined) return phase === 'running' ? 'error' : 'stopped';
  switch (status) {
    case 'running':
      return 'ready';
    case 'created':
    case 'restarting':
      return 'starting';
    case 'paused':
    case 'exited':
    case 'removing':
      return 'stopped';
    case 'dead':
      return 'error';
  }
}

export function toEntryType(letter: string): DirectoryEntryType {
  switch (letter) {
    case 'f':
      return 'file';
    case 'd':
      return 'directory';
    case 'l':
      return 'symlink';
    default:
      return 'other';
  }
}

export function fileError(result: ContainerExecResult, context: string): ExecutionEnvironmentError {
  const stderr = result.stderr.trim();
  const message = `local-linux: failed to ${context}: ${stderr || `exit ${result.exitCode}`}`;
  if (/No such file or directory/i.test(stderr))
    return new ExecutionEnvironmentError(message, 'not_found');
  if (/Permission denied/i.test(stderr))
    return new ExecutionEnvironmentError(message, 'permission_denied');
  return new ExecutionEnvironmentError(message, 'internal');
}

export function toEnvironmentError(error: unknown, context: string): ExecutionEnvironmentError {
  if (error instanceof ExecutionEnvironmentError) return error;
  if (error instanceof ContainerRuntimeError) {
    const message = `local-linux: failed to ${context}: ${error.message}`;
    switch (error.kind) {
      case 'engine_unavailable':
      case 'container_not_running':
      case 'no_such_container':
      case 'no_such_image':
        return new ExecutionEnvironmentError(message, 'unavailable');
      case 'invalid_spec':
      case 'unknown':
        return new ExecutionEnvironmentError(message, 'internal');
    }
  }
  return new ExecutionEnvironmentError(
    `local-linux: failed to ${context}: ${error instanceof Error ? error.message : String(error)}`,
    'internal',
  );
}
