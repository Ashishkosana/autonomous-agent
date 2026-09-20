import {
  ExecutionEnvironmentError,
  type CommandOptions,
  type CommandResult,
  type DirectoryEntry,
  type EnvironmentDescriptor,
  type EnvironmentState,
  type ExecutionEnvironment,
  type ProcessHandle,
  type ProcessState,
  type ProcessStatus,
} from '../execution-environment.js';
import {
  SandboxClientError,
  type SandboxClient,
  type SandboxExecOptions,
  type SandboxProcessRecord,
  type SandboxProcessStatus,
} from './sandbox-client.js';

export const CLOUDFLARE_SANDBOX_PROVIDER = 'cloudflare-sandbox';

export interface CloudflareSandboxEnvironmentOptions {
  /** Default working directory of the Sandbox image. */
  readonly workspaceRoot?: string;
  /** Where stdin payloads are staged before being redirected into a command. */
  readonly tempDir?: string;
  /** Seconds `timeout(1)` waits after SIGTERM before SIGKILL. */
  readonly killGraceSeconds?: number;
  /** Extra time granted to the SDK request beyond the command's own deadline. */
  readonly requestGraceMs?: number;
}

/** `timeout(1)` exit statuses: 124 = deadline reached, 137 = child needed SIGKILL. */
const TIMEOUT_EXIT_CODES: ReadonlySet<number> = new Set([124, 137]);

/**
 * Cloudflare Sandbox implementation of the provider-neutral
 * `ExecutionEnvironment`. All Cloudflare knowledge in `src/` lives here and in
 * the sibling files; the SDK itself is only touched by the gateway Worker.
 *
 * Where the stable Sandbox SDK (0.12.x) lacks a primitive the contract needs,
 * the gap is closed with ordinary Linux primitives *inside the sandbox* and
 * documented in ADR-001:
 *
 * - `stdin` — the SDK has no stdin option. The payload is staged in a temp
 *   file inside the sandbox and redirected (`sh -c '<cmd>' < file`), then the
 *   file is deleted. This is the same technique Cloudflare's own docs describe.
 * - `timeoutMs` — an SDK-side timeout aborts the *request* and leaves the
 *   process running. We instead wrap the command in `timeout(1)` so the
 *   process is actually terminated and partial output is preserved; the SDK
 *   deadline is only a backstop. Exit status 124/137 reached at or after the
 *   deadline is reported as `timedOut: true, exitCode: null`.
 * - Process states are merged from the live process list and our own record of
 *   processes started through this instance, so a stopped process stays
 *   observable even after the sandbox drops its record.
 */
export class CloudflareSandboxEnvironment implements ExecutionEnvironment {
  readonly descriptor: EnvironmentDescriptor;
  private readonly workspaceRoot: string;
  private readonly tempDir: string;
  private readonly killGraceSeconds: number;
  private readonly requestGraceMs: number;
  private readonly knownProcesses = new Map<string, ProcessState>();
  private stdinCounter = 0;
  private destroyed = false;

  constructor(
    private readonly client: SandboxClient,
    options: CloudflareSandboxEnvironmentOptions = {},
  ) {
    this.descriptor = { provider: CLOUDFLARE_SANDBOX_PROVIDER, environmentId: client.sandboxId };
    this.workspaceRoot = options.workspaceRoot ?? '/workspace';
    this.tempDir = options.tempDir ?? '/tmp';
    this.killGraceSeconds = options.killGraceSeconds ?? 2;
    this.requestGraceMs = options.requestGraceMs ?? 10_000;
  }

  async runCommand(command: string, options: CommandOptions = {}): Promise<CommandResult> {
    const startedAt = Date.now();
    let stdinPath: string | undefined;
    try {
      let shell = command;
      if (options.stdin !== undefined) {
        this.stdinCounter += 1;
        stdinPath = `${this.tempDir}/.agent-stdin-${startedAt}-${this.stdinCounter}`;
        await this.client.writeFile(stdinPath, options.stdin);
        shell = `sh -c ${shellQuote(command)} < ${shellQuote(stdinPath)}`;
      }
      if (options.timeoutMs !== undefined) {
        const seconds = Math.max(0.1, options.timeoutMs / 1000);
        shell = `timeout -k ${this.killGraceSeconds} ${seconds} sh -c ${shellQuote(shell)}`;
      }

      const result = await this.client.exec(shell, this.execOptions(options));
      const durationMs = Date.now() - startedAt;
      const timedOut =
        options.timeoutMs !== undefined &&
        TIMEOUT_EXIT_CODES.has(result.exitCode) &&
        durationMs >= options.timeoutMs;
      return {
        command,
        exitCode: timedOut ? null : result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs,
        timedOut,
      };
    } catch (error) {
      if (
        error instanceof SandboxClientError &&
        error.kind === 'request_timeout' &&
        options.timeoutMs !== undefined
      ) {
        // The backstop fired: the sandbox never answered. Output is lost; say so.
        return {
          command,
          exitCode: null,
          stdout: '',
          stderr: `[cloudflare-sandbox] request deadline exceeded; output unavailable: ${error.message}`,
          durationMs: Date.now() - startedAt,
          timedOut: true,
        };
      }
      throw toEnvironmentError(error, `run command`);
    } finally {
      if (stdinPath !== undefined) {
        await this.client.deleteFile(stdinPath).catch(() => undefined);
      }
    }
  }

  async readFile(path: string): Promise<string> {
    try {
      return await this.client.readFile(path);
    } catch (error) {
      throw toEnvironmentError(error, `read ${path}`);
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    try {
      const parent = parentDirectory(path);
      if (parent !== undefined) await this.client.mkdir(parent, true);
      await this.client.writeFile(path, content);
    } catch (error) {
      throw toEnvironmentError(error, `write ${path}`);
    }
  }

  async deleteFile(path: string): Promise<void> {
    try {
      await this.client.deleteFile(path);
    } catch (error) {
      throw toEnvironmentError(error, `delete ${path}`);
    }
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      return await this.client.exists(path);
    } catch (error) {
      throw toEnvironmentError(error, `stat ${path}`);
    }
  }

  async listDirectory(path: string): Promise<readonly DirectoryEntry[]> {
    try {
      const entries = await this.client.listFiles(path);
      return entries.map((entry) => ({
        name: entry.name,
        path: entry.absolutePath,
        type: entry.type,
        sizeBytes: entry.size,
      }));
    } catch (error) {
      throw toEnvironmentError(error, `list ${path}`);
    }
  }

  async startProcess(command: string, options: CommandOptions = {}): Promise<ProcessHandle> {
    try {
      const record = await this.client.startProcess(command, {
        ...this.execOptions(options),
        autoCleanup: false,
      });
      this.knownProcesses.set(record.id, {
        processId: record.id,
        command,
        status: toProcessStatus(record.status),
      });
      return { processId: record.id, command, startedAt: record.startedAt };
    } catch (error) {
      throw toEnvironmentError(error, `start process`);
    }
  }

  async stopProcess(processId: string): Promise<void> {
    try {
      await this.client.killProcess(processId);
    } catch (error) {
      throw toEnvironmentError(error, `stop process ${processId}`);
    }
    const known = this.knownProcesses.get(processId);
    this.knownProcesses.set(processId, {
      processId,
      command: known?.command ?? '',
      status: 'killed',
    });
  }

  async getState(): Promise<EnvironmentState> {
    if (this.destroyed) {
      return {
        descriptor: this.descriptor,
        status: 'stopped',
        workspaceRoot: this.workspaceRoot,
        processes: [...this.knownProcesses.values()],
        metadata: { sandboxId: this.client.sandboxId, destroyed: true },
      };
    }
    try {
      const [live, info] = await Promise.all([this.client.listProcesses(), this.client.info()]);
      return {
        descriptor: this.descriptor,
        status: 'ready',
        workspaceRoot: this.workspaceRoot,
        processes: this.mergeProcesses(live),
        metadata: {
          sandboxId: info.sandboxId,
          placementId: info.placementId ?? null,
          sdkVersion: info.sdkVersion ?? null,
          liveProcessCount: live.length,
        },
      };
    } catch (error) {
      if (error instanceof SandboxClientError && error.kind === 'unauthorized') {
        throw toEnvironmentError(error, 'inspect sandbox');
      }
      const unavailable =
        error instanceof SandboxClientError &&
        (error.kind === 'container_unavailable' || error.kind === 'request_timeout');
      return {
        descriptor: this.descriptor,
        status: unavailable ? 'starting' : 'error',
        workspaceRoot: this.workspaceRoot,
        processes: [...this.knownProcesses.values()],
        metadata: {
          sandboxId: this.client.sandboxId,
          lastError: error instanceof Error ? error.message : String(error),
          lastErrorKind: error instanceof SandboxClientError ? error.kind : 'unknown',
        },
      };
    }
  }

  /**
   * Destroys the Cloudflare container behind this environment. Not part of
   * the provider-neutral contract: lifecycle ownership is a composition
   * concern. Subsequent `getState()` reports `stopped`.
   */
  async destroy(): Promise<void> {
    try {
      await this.client.destroy();
    } catch (error) {
      throw toEnvironmentError(error, 'destroy sandbox');
    }
    this.destroyed = true;
  }

  private execOptions(options: CommandOptions): SandboxExecOptions {
    return {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs + this.requestGraceMs }
        : {}),
    };
  }

  private mergeProcesses(live: readonly SandboxProcessRecord[]): ProcessState[] {
    const liveById = new Map(live.map((record) => [record.id, record]));
    for (const [id, known] of this.knownProcesses) {
      const record = liveById.get(id);
      if (record) {
        const status = toProcessStatus(record.status);
        this.knownProcesses.set(id, {
          processId: id,
          command: known.command || record.command,
          // A process we terminated stays "killed" even if the sandbox files it as failed/completed.
          status: known.status === 'killed' && status !== 'running' ? 'killed' : status,
          ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
        });
      } else if (known.status === 'running') {
        // The sandbox no longer tracks it: it ended and the record was dropped.
        this.knownProcesses.set(id, { ...known, status: 'exited' });
      }
    }
    for (const record of live) {
      if (!this.knownProcesses.has(record.id)) {
        this.knownProcesses.set(record.id, {
          processId: record.id,
          command: record.command,
          status: toProcessStatus(record.status),
          ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
        });
      }
    }
    return [...this.knownProcesses.values()];
  }
}

export function toProcessStatus(status: SandboxProcessStatus): ProcessStatus {
  switch (status) {
    case 'starting':
    case 'running':
      return 'running';
    case 'killed':
      return 'killed';
    case 'completed':
    case 'failed':
    case 'error':
      return 'exited';
  }
}

export function toEnvironmentError(error: unknown, context: string): ExecutionEnvironmentError {
  if (error instanceof ExecutionEnvironmentError) return error;
  if (error instanceof SandboxClientError) {
    const message = `cloudflare-sandbox: failed to ${context}: ${error.message}`;
    switch (error.kind) {
      case 'file_not_found':
      case 'process_not_found':
        return new ExecutionEnvironmentError(message, 'not_found');
      case 'permission_denied':
        return new ExecutionEnvironmentError(message, 'permission_denied');
      case 'container_unavailable':
      case 'request_timeout':
        return new ExecutionEnvironmentError(message, 'unavailable');
      case 'unauthorized':
      case 'invalid_request':
      case 'protocol':
      case 'unknown':
        return new ExecutionEnvironmentError(`${message} (${error.kind})`, 'internal');
    }
  }
  const text = error instanceof Error ? error.message : String(error);
  return new ExecutionEnvironmentError(
    `cloudflare-sandbox: failed to ${context}: ${text}`,
    'internal',
  );
}

/** POSIX single-quote escaping: safe for any string including quotes and newlines. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function parentDirectory(path: string): string | undefined {
  const trimmed = path.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  if (slash <= 0) return undefined;
  return trimmed.slice(0, slash);
}
