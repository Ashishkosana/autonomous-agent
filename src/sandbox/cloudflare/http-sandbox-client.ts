import {
  gatewayPath,
  type GatewayErrorBody,
  type GatewayOperation,
  type GatewayRequests,
  type GatewayResponse,
  type GatewayResults,
} from './protocol.js';
import {
  SandboxClientError,
  type SandboxClient,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxFileEntry,
  type SandboxInfo,
  type SandboxProcessRecord,
  type SandboxStartProcessOptions,
} from './sandbox-client.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpSandboxClientOptions {
  /** Base URL of the deployed gateway Worker, e.g. https://agent-sandbox-gateway.<sub>.workers.dev */
  readonly gatewayUrl: string;
  /** Bearer secret shared with the Worker. Held in memory only; never logged or serialised. */
  readonly token: string;
  readonly sandboxId: string;
  /** Client-side deadline for a single gateway call. Defaults to 130 s (SDK request timeout + margin). */
  readonly requestTimeoutMs?: number;
  readonly fetch?: FetchLike;
}

/**
 * `SandboxClient` for hosts outside Cloudflare Workers. Every method is one
 * authenticated HTTPS call to the gateway Worker, which performs the matching
 * Cloudflare SDK call. No Cloudflare SDK is imported here.
 */
export class HttpSandboxClient implements SandboxClient {
  readonly sandboxId: string;
  private readonly gatewayUrl: string;
  private readonly authorization: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: HttpSandboxClientOptions) {
    if (!options.gatewayUrl) throw new Error('HttpSandboxClient: gatewayUrl is required');
    if (!options.token) throw new Error('HttpSandboxClient: token is required');
    this.sandboxId = options.sandboxId;
    this.gatewayUrl = options.gatewayUrl.replace(/\/+$/, '');
    this.authorization = `Bearer ${options.token}`;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 130_000;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult> {
    return this.call('exec', { command, ...(options ? { options } : {}) }, options?.timeoutMs);
  }

  startProcess(
    command: string,
    options?: SandboxStartProcessOptions,
  ): Promise<SandboxProcessRecord> {
    return this.call('startProcess', { command, ...(options ? { options } : {}) });
  }

  listProcesses(): Promise<readonly SandboxProcessRecord[]> {
    return this.call('listProcesses', {});
  }

  async killProcess(processId: string, signal?: string): Promise<void> {
    await this.call('killProcess', { processId, ...(signal ? { signal } : {}) });
  }

  async readFile(path: string): Promise<string> {
    const { content } = await this.call('readFile', { path });
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.call('writeFile', { path, content });
  }

  async mkdir(path: string, recursive: boolean): Promise<void> {
    await this.call('mkdir', { path, recursive });
  }

  async deleteFile(path: string): Promise<void> {
    await this.call('deleteFile', { path });
  }

  async exists(path: string): Promise<boolean> {
    const { exists } = await this.call('exists', { path });
    return exists;
  }

  listFiles(path: string): Promise<readonly SandboxFileEntry[]> {
    return this.call('listFiles', { path });
  }

  info(): Promise<SandboxInfo> {
    return this.call('info', {});
  }

  async destroy(): Promise<void> {
    await this.call('destroy', {});
  }

  private async call<TOp extends GatewayOperation>(
    operation: TOp,
    body: GatewayRequests[TOp],
    commandTimeoutMs?: number,
  ): Promise<GatewayResults[TOp]> {
    const url = `${this.gatewayUrl}${gatewayPath(this.sandboxId, operation)}`;
    const deadline = Math.max(this.requestTimeoutMs, (commandTimeoutMs ?? 0) + 15_000);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: this.authorization,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(deadline),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new SandboxClientError(
          `gateway call ${operation} exceeded ${deadline} ms`,
          'request_timeout',
        );
      }
      const text = error instanceof Error ? error.message : String(error);
      throw new SandboxClientError(`gateway unreachable for ${operation}: ${text}`, 'protocol');
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new SandboxClientError(
        `gateway returned non-JSON response (${response.status}) for ${operation}`,
        response.status === 401 ? 'unauthorized' : 'protocol',
      );
    }
    if (!isGatewayResponse<TOp>(parsed)) {
      throw new SandboxClientError(
        `gateway returned malformed response (${response.status}) for ${operation}`,
        'protocol',
      );
    }
    if (!parsed.ok) throw errorFromBody(parsed.error);
    return parsed.result;
  }
}

function isGatewayResponse<TOp extends GatewayOperation>(
  value: unknown,
): value is GatewayResponse<TOp> {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false;
  const record = value as { ok: unknown; result?: unknown; error?: unknown };
  if (record.ok === true) return 'result' in record;
  if (record.ok === false) {
    const error = record.error as Partial<GatewayErrorBody> | undefined;
    return typeof error?.kind === 'string' && typeof error.message === 'string';
  }
  return false;
}

function errorFromBody(body: GatewayErrorBody): SandboxClientError {
  return new SandboxClientError(body.message, body.kind, {
    ...(body.sdkErrorName ? { sdkErrorName: body.sdkErrorName } : {}),
    ...(body.sdkErrorCode ? { sdkErrorCode: body.sdkErrorCode } : {}),
  });
}
