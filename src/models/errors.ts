/**
 * Failure vocabulary for model providers. Every adapter maps its transport's
 * failures onto these kinds so the runtime, the re-ask/retry layer and the
 * dashboard reason about "what went wrong" without knowing the vendor.
 *
 * - `authentication`  credential missing/rejected — never retried, never re-asked
 * - `rate_limited`    provider asked us to slow down — retried with backoff
 * - `network`         connection failed / reset before a response
 * - `timeout`         no complete response within the configured deadline
 * - `server`          provider returned 5xx or an unparseable envelope
 * - `bad_request`     provider rejected the request shape (our bug or an unsupported feature)
 * - `invalid_response` the model answered, but not in the requested form — eligible for a re-ask
 * - `configuration`   the adapter itself is misconfigured (e.g. missing base URL)
 * - `unknown`         anything else
 */
export type ModelErrorKind =
  | 'authentication'
  | 'rate_limited'
  | 'network'
  | 'timeout'
  | 'server'
  | 'bad_request'
  | 'invalid_response'
  | 'configuration'
  | 'unknown';

const RETRYABLE_KINDS: ReadonlySet<ModelErrorKind> = new Set([
  'rate_limited',
  'network',
  'timeout',
  'server',
]);

export interface ModelProviderErrorOptions {
  /** HTTP status when the failure came from an HTTP response. */
  readonly status?: number;
  /** Provider-suggested wait before retrying, when it sent one. */
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

/**
 * The only error type providers throw for provider-level failures. Messages
 * must already be redacted by the thrower; this class never inspects secrets.
 */
export class ModelProviderError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    readonly kind: ModelErrorKind,
    options: ModelProviderErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ModelProviderError';
    this.retryable = RETRYABLE_KINDS.has(kind);
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Kind of an arbitrary thrown value, for telemetry. Unknown throwables are `unknown`. */
export function errorKindOf(error: unknown): ModelErrorKind {
  return error instanceof ModelProviderError ? error.kind : 'unknown';
}

export function isRetryableModelError(error: unknown): boolean {
  return error instanceof ModelProviderError && error.retryable;
}
