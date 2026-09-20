/**
 * SandboxClient is the narrow, Cloudflare-Sandbox-shaped surface that
 * `CloudflareSandboxEnvironment` is built on. It exists for one structural
 * reason: the Cloudflare Sandbox SDK can only be invoked from inside a
 * Cloudflare Worker (it needs a Durable Object binding), while the agent
 * runtime and its tests run wherever they run. Two implementations exist:
 *
 * - `worker/src/sdk-sandbox-client.ts` — wraps the real `@cloudflare/sandbox`
 *   stub inside the gateway Worker.
 * - `src/sandbox/cloudflare/http-sandbox-client.ts` — speaks to that gateway
 *   over authenticated HTTPS from Node (or any other host).
 *
 * The method names and shapes deliberately mirror the SDK subset we use so that
 * the Worker-side wrapper is a near 1:1 pass-through and the mapping to the
 * provider-neutral `ExecutionEnvironment` lives in exactly one place. This is
 * NOT a second provider-neutral abstraction: it is Cloudflare-specific and
 * stays inside `src/sandbox/cloudflare/`.
 *
 * This file must not import the Cloudflare SDK; the whole of `src/` is
 * SDK-free (enforced by `tests/architecture.test.ts`).
 */

export interface SandboxExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** SDK-side request deadline in milliseconds (see notes in the environment adapter). */
  readonly timeoutMs?: number;
}

export interface SandboxExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SandboxStartProcessOptions extends SandboxExecOptions {
  /** Keep the process record after exit so it can still be inspected. */
  readonly autoCleanup?: boolean;
}

/** Status vocabulary of the stable Sandbox SDK's `Process.status`. */
export type SandboxProcessStatus =
  'starting' | 'running' | 'completed' | 'failed' | 'killed' | 'error';

export interface SandboxProcessRecord {
  readonly id: string;
  readonly pid?: number;
  readonly command: string;
  readonly status: SandboxProcessStatus;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly exitCode?: number;
}

export interface SandboxFileEntry {
  readonly name: string;
  readonly absolutePath: string;
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
  readonly size: number;
  readonly modifiedAt: string;
}

export interface SandboxInfo {
  readonly sandboxId: string;
  /** Cloudflare placement id when known; `null` in local dev; `undefined` before first contact. */
  readonly placementId?: string | null;
  readonly sdkVersion?: string;
}

export interface SandboxClient {
  readonly sandboxId: string;

  exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult>;

  startProcess(
    command: string,
    options?: SandboxStartProcessOptions,
  ): Promise<SandboxProcessRecord>;
  listProcesses(): Promise<readonly SandboxProcessRecord[]>;
  killProcess(processId: string, signal?: string): Promise<void>;

  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, recursive: boolean): Promise<void>;
  deleteFile(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  listFiles(path: string): Promise<readonly SandboxFileEntry[]>;

  info(): Promise<SandboxInfo>;
  /** Destroys the container and all sandbox-local state. Used by lifecycle experiments and cleanup. */
  destroy(): Promise<void>;
}

/**
 * Normalised failure vocabulary. The Worker-side wrapper translates SDK error
 * classes (by `name`/`code`) into these kinds so that the environment adapter
 * can map them to `ExecutionEnvironmentError` codes without knowing the SDK.
 */
export type SandboxClientErrorKind =
  | 'file_not_found'
  | 'process_not_found'
  | 'permission_denied'
  | 'container_unavailable'
  | 'request_timeout'
  | 'unauthorized'
  | 'invalid_request'
  | 'protocol'
  | 'unknown';

export class SandboxClientError extends Error {
  constructor(
    message: string,
    readonly kind: SandboxClientErrorKind,
    readonly detail: { readonly sdkErrorName?: string; readonly sdkErrorCode?: string } = {},
  ) {
    super(message);
    this.name = 'SandboxClientError';
  }
}

/**
 * Maps a Cloudflare SDK error (identified only by its `name` and optional
 * `code`) to a normalised kind. Kept here, SDK-free, so the mapping is unit
 * tested and shared by the Worker wrapper.
 */
export function classifySdkError(name: string | undefined, code?: string): SandboxClientErrorKind {
  switch (name) {
    case 'FileNotFoundError':
      return 'file_not_found';
    case 'ProcessNotFoundError':
      return 'process_not_found';
    case 'PermissionDeniedError':
    case 'CommandPermissionDeniedError':
    case 'ProcessPermissionDeniedError':
      return 'permission_denied';
    case 'ContainerUnavailableError':
    case 'OperationInterruptedError':
    case 'RPCTransportError':
      return 'container_unavailable';
    case 'TimeoutError':
      return 'request_timeout';
    default:
      break;
  }
  if (code === 'FILE_NOT_FOUND') return 'file_not_found';
  if (code === 'PROCESS_NOT_FOUND') return 'process_not_found';
  if (code === 'PERMISSION_DENIED') return 'permission_denied';
  return 'unknown';
}
