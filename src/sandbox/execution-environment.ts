/**
 * ExecutionEnvironment is the boundary between the agent and the place where
 * its actions physically run. The agent runtime, tools, and memory layers
 * depend only on this interface. Cloudflare Sandbox (Phase 3), a local Linux
 * container, or any other backend implements it.
 *
 * Nothing in this file may reference a specific provider.
 */

export interface CommandOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly stdin?: string;
}

export interface CommandResult {
  readonly command: string;
  /** `null` when the process was terminated before it could exit (timeout, kill). */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface ProcessHandle {
  readonly processId: string;
  readonly command: string;
  readonly startedAt: string;
}

export type ProcessStatus = 'running' | 'exited' | 'killed';

export interface ProcessState {
  readonly processId: string;
  readonly command: string;
  readonly status: ProcessStatus;
  readonly exitCode?: number;
}

export type DirectoryEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface DirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly type: DirectoryEntryType;
  readonly sizeBytes?: number;
}

export type EnvironmentStatus = 'starting' | 'ready' | 'stopped' | 'error';

export interface EnvironmentDescriptor {
  /** Implementation identifier, e.g. "cloudflare-sandbox", "local-linux", "fake". */
  readonly provider: string;
  /** Instance identifier within that provider. */
  readonly environmentId: string;
}

export interface EnvironmentState {
  readonly descriptor: EnvironmentDescriptor;
  readonly status: EnvironmentStatus;
  readonly workspaceRoot: string;
  readonly processes: readonly ProcessState[];
  /** Provider-specific diagnostics. Opaque to the agent; shown on the dashboard. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ExecutionEnvironment {
  readonly descriptor: EnvironmentDescriptor;

  runCommand(command: string, options?: CommandOptions): Promise<CommandResult>;

  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  listDirectory(path: string): Promise<readonly DirectoryEntry[]>;

  startProcess(command: string, options?: CommandOptions): Promise<ProcessHandle>;
  stopProcess(processId: string): Promise<void>;

  getState(): Promise<EnvironmentState>;
}

/**
 * Thrown by implementations for environment-level failures (not for non-zero
 * exit codes, which are ordinary results). Kept deliberately simple.
 */
export class ExecutionEnvironmentError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'unavailable' | 'permission_denied' | 'internal',
  ) {
    super(message);
    this.name = 'ExecutionEnvironmentError';
  }
}
