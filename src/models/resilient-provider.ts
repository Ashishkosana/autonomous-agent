import type {
  ModelDescriptor,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StructuredModelRequest,
  StructuredModelResponse,
  ToolActionRequest,
  ToolActionResponse,
} from './contracts.js';
import { ModelProviderError, isRetryableModelError } from './errors.js';

export interface ResilienceOptions {
  /** Extra attempts after a transient failure (rate limit, network, timeout, 5xx). */
  readonly maxRetries: number;
  /** Extra attempts after a well-formed but invalid answer (schema violation, no tool call). */
  readonly maxReasks: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Injectable so tests never wait. */
  readonly sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_RESILIENCE: ResilienceOptions = {
  maxRetries: 2,
  maxReasks: 1,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Bounded recovery around any ModelProvider.
 *
 * - Transient provider failures are retried with exponential backoff (or the
 *   provider's Retry-After), at most `maxRetries` times. Authentication,
 *   configuration and bad-request failures are never retried.
 * - Invalid answers are re-asked at most `maxReasks` times: the rejected
 *   answer and the validation errors are appended to the conversation so the
 *   model can correct itself. After the budget is spent the last result is
 *   returned (structured: a `ParseResult` failure) or thrown (tool action:
 *   `invalid_response`) for the runtime to handle as an ordinary failure.
 *
 * Every attempt is a separate call on the inner provider, so when the inner
 * provider is instrumented each attempt is visible as its own MODEL_CALL_*
 * events and counts against the run's model-call limit.
 */
export class ResilientModelProvider implements ModelProvider {
  readonly descriptor: ModelDescriptor;
  private readonly options: ResilienceOptions;

  constructor(
    private readonly inner: ModelProvider,
    options: Partial<ResilienceOptions> = {},
  ) {
    this.descriptor = inner.descriptor;
    this.options = { ...DEFAULT_RESILIENCE, ...options };
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const attempts = new AttemptCounter(request.attempt);
    return this.withRetries(attempts, (attempt) => this.inner.generate({ ...request, attempt }));
  }

  async structuredGenerate<T>(
    request: StructuredModelRequest<T>,
  ): Promise<StructuredModelResponse<T>> {
    const attempts = new AttemptCounter(request.attempt);
    let messages = request.messages;
    let reasks = 0;
    for (;;) {
      const response = await this.withRetries(attempts, (attempt) =>
        this.inner.structuredGenerate({ ...request, messages, attempt }),
      );
      if (response.parsed.ok || reasks >= this.options.maxReasks) return response;
      reasks += 1;
      messages = withCorrection(messages, renderRaw(response.raw), response.parsed.errors);
    }
  }

  async requestToolAction(request: ToolActionRequest): Promise<ToolActionResponse> {
    const attempts = new AttemptCounter(request.attempt);
    let messages = request.messages;
    let reasks = 0;
    for (;;) {
      try {
        return await this.withRetries(attempts, (attempt) =>
          this.inner.requestToolAction({ ...request, messages, attempt }),
        );
      } catch (error: unknown) {
        if (!isReaskable(error) || reasks >= this.options.maxReasks) throw error;
        reasks += 1;
        messages = withCorrection(messages, undefined, [error.message]);
      }
    }
  }

  private async withRetries<R>(
    attempts: AttemptCounter,
    call: (attempt: number) => Promise<R>,
  ): Promise<R> {
    let retries = 0;
    for (;;) {
      try {
        return await call(attempts.next());
      } catch (error: unknown) {
        if (
          !(error instanceof ModelProviderError) ||
          !isRetryableModelError(error) ||
          retries >= this.options.maxRetries
        ) {
          throw error;
        }
        await this.options.sleep(this.delayFor(retries, error));
        retries += 1;
      }
    }
  }

  private delayFor(retry: number, error: ModelProviderError): number {
    if (error.retryAfterMs !== undefined)
      return Math.min(error.retryAfterMs, this.options.maxDelayMs);
    return Math.min(this.options.baseDelayMs * 2 ** retry, this.options.maxDelayMs);
  }
}

class AttemptCounter {
  private current: number;

  constructor(start: number | undefined) {
    this.current = (start ?? 1) - 1;
  }

  next(): number {
    this.current += 1;
    return this.current;
  }
}

function isReaskable(error: unknown): error is ModelProviderError {
  return error instanceof ModelProviderError && error.kind === 'invalid_response';
}

const RAW_LIMIT = 4_000;

function renderRaw(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return text.length > RAW_LIMIT ? `${text.slice(0, RAW_LIMIT)}…` : text;
}

/**
 * The correction turn: echo the rejected answer as the assistant's, then tell
 * it exactly what was wrong. Only validation errors are quoted — they are
 * produced by our parsers and contain no secrets.
 */
function withCorrection(
  messages: readonly ModelMessage[],
  rejected: string | undefined,
  errors: readonly string[],
): ModelMessage[] {
  return [
    ...messages,
    ...(rejected !== undefined ? [{ role: 'assistant' as const, content: rejected }] : []),
    {
      role: 'user',
      content: [
        'Your previous answer was rejected by validation:',
        ...errors.map((e) => `- ${e}`),
        'Answer again, correcting these problems. Return only the requested structure.',
      ].join('\n'),
    },
  ];
}
