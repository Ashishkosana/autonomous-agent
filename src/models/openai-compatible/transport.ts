import type { Clock } from '../../domain/ids.js';
import { ModelProviderError } from '../errors.js';
import { SecretRedactor } from '../redaction.js';

export interface TransportConfig {
  /** e.g. `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, `http://localhost:11434/v1`. */
  readonly baseUrl: string;
  /** Optional: local servers such as Ollama need none. Never logged, never serialised. */
  readonly apiKey?: string;
  /** Extra request headers some gateways want. Values are treated as secrets. */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface TransportDeps {
  readonly clock: Clock;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

export const DEFAULT_MODEL_TIMEOUT_MS = 60_000;
const ERROR_BODY_SNIPPET = 240;

/**
 * Request headers (which carry the credential) are kept off the instance so
 * that neither property enumeration, `util.inspect`, nor a spread of the
 * transport can surface them. Only `postJson()` reads them.
 */
const requestHeaders = new WeakMap<OpenAICompatibleTransport, Readonly<Record<string, string>>>();

/**
 * The one HTTP path every OpenAI-compatible adapter shares: JSON in, JSON
 * out, deadline, HTTP-status → `ModelErrorKind` mapping, and redaction of
 * anything that could echo a credential. Chat completions and embeddings are
 * different endpoints on the same server with the same failure vocabulary,
 * so they share this rather than each owning a copy of it.
 *
 * Credential handling: the key lives only in the `Authorization` header
 * value built in the constructor. It is not a property, and every error
 * message passes through the redactor.
 */
export class OpenAICompatibleTransport {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private readonly redactor: SecretRedactor;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;

  constructor(config: TransportConfig, deps: TransportDeps) {
    if (!/^https?:\/\//.test(config.baseUrl)) {
      throw new ModelProviderError('baseUrl must be an http(s) URL', 'configuration');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    requestHeaders.set(this, {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(config.extraHeaders ?? {}),
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    });
    this.redactor = new SecretRedactor([
      config.apiKey,
      ...Object.values(config.extraHeaders ?? {}),
    ]);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
    this.fetchImpl = deps.fetch ?? fetch;
    this.clock = deps.clock;
  }

  /** Defensive: serialising the transport must never expose headers. */
  toJSON(): { readonly baseUrl: string; readonly timeoutMs: number } {
    return { baseUrl: this.baseUrl, timeoutMs: this.timeoutMs };
  }

  redact(text: string): string {
    return this.redactor.redact(text);
  }

  /** POSTs `body` to `<baseUrl>/<path>` and returns the parsed JSON envelope with the measured latency. */
  async postJson(path: string, body: unknown): Promise<{ json: unknown; latencyMs: number }> {
    const startedMs = this.clock.monotonicMs();
    const latency = () => Math.max(0, this.clock.monotonicMs() - startedMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${path.replace(/^\/+/, '')}`, {
        method: 'POST',
        headers: requestHeaders.get(this) ?? {},
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause: unknown) {
      throw this.transportError(cause);
    }

    if (!response.ok) throw await this.httpError(response);

    let json: unknown;
    try {
      json = await response.json();
    } catch (cause: unknown) {
      throw new ModelProviderError('provider response was not JSON', 'server', { cause });
    }
    return { json, latencyMs: latency() };
  }

  /** Re-throws a parse-stage error with its message redacted; other errors pass through. */
  redactError(error: unknown): unknown {
    if (error instanceof ModelProviderError) {
      return new ModelProviderError(this.redactor.redact(error.message), error.kind, {
        ...(error.status !== undefined ? { status: error.status } : {}),
      });
    }
    return error;
  }

  private transportError(cause: unknown): ModelProviderError {
    const name = cause instanceof Error ? cause.name : '';
    const detail = this.redactor.redact(cause instanceof Error ? cause.message : String(cause));
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new ModelProviderError(`no response within ${this.timeoutMs} ms`, 'timeout', {
        cause,
      });
    }
    return new ModelProviderError(`request to model endpoint failed: ${detail}`, 'network', {
      cause,
    });
  }

  private async httpError(response: Response): Promise<ModelProviderError> {
    let snippet = '';
    try {
      snippet = (await response.text()).slice(0, ERROR_BODY_SNIPPET);
    } catch {
      snippet = '';
    }
    const message = this.redactor.redact(
      `HTTP ${response.status} from model endpoint${snippet ? `: ${snippet}` : ''}`,
    );
    const status = response.status;
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    const options = {
      status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
    if (status === 401 || status === 403)
      return new ModelProviderError(message, 'authentication', options);
    if (status === 429) return new ModelProviderError(message, 'rate_limited', options);
    if (status === 408 || status === 504)
      return new ModelProviderError(message, 'timeout', options);
    if (status >= 500) return new ModelProviderError(message, 'server', options);
    return new ModelProviderError(message, 'bad_request', options);
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}
