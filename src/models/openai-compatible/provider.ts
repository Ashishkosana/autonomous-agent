import { asModelCallId, type Clock, type IdGenerator } from '../../domain/ids.js';
import { parseFail } from '../../domain/parse.js';
import type {
  ModelDescriptor,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StructuredModelRequest,
  StructuredModelResponse,
  ToolActionRequest,
  ToolActionResponse,
} from '../contracts.js';
import { ModelProviderError } from '../errors.js';
import { SecretRedactor } from '../redaction.js';
import {
  buildStructuredRequest,
  buildTextRequest,
  buildToolActionRequest,
  extractJson,
  parseChatCompletion,
  parseToolActionProposal,
  proposalFromCompletion,
  renderToolsForJsonMode,
  ToolNameMap,
  toolActionProposalSchema,
  type ChatCompletionRequest,
  type ParsedCompletion,
  type StructuredMode,
  type ToolMode,
} from './wire.js';

export interface OpenAICompatibleConfig {
  /** e.g. `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, `http://localhost:11434/v1`. */
  readonly baseUrl: string;
  readonly model: string;
  /** Optional: local servers such as Ollama need none. Never logged, never serialised. */
  readonly apiKey?: string;
  /** Label reported in `descriptor.provider` and telemetry, e.g. `openrouter`. */
  readonly providerLabel?: string;
  readonly timeoutMs?: number;
  readonly structuredMode?: StructuredMode;
  readonly toolMode?: ToolMode;
  /** Extra request headers some gateways want (e.g. OpenRouter attribution). Values are treated as secrets. */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly defaultTemperature?: number;
}

export interface OpenAICompatibleDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

export const DEFAULT_MODEL_TIMEOUT_MS = 60_000;
const ERROR_BODY_SNIPPET = 240;

/**
 * Request headers (which carry the credential) are kept off the instance so
 * that neither property enumeration, `util.inspect`, nor a spread of the
 * provider can surface them. Only `complete()` reads them.
 */
const requestHeaders = new WeakMap<OpenAICompatibleProvider, Readonly<Record<string, string>>>();

/**
 * `ModelProvider` over the OpenAI chat-completions wire format using the
 * platform `fetch`. Vendor-neutral by construction: nothing here knows which
 * company runs the server. Structured output and tool actions are validated
 * by the runtime-owned parsers; content that fails validation is returned as
 * a `ParseResult` failure (structured) or thrown as an `invalid_response`
 * error (tool action) for the resilience layer to re-ask — never as a crash.
 *
 * Credential handling: the key lives only in the `Authorization` header
 * value built in the constructor. It is not on the descriptor, not on any
 * response, and every error message passes through the redactor.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly descriptor: ModelDescriptor;
  private readonly endpoint: string;
  private readonly redactor: SecretRedactor;
  private readonly timeoutMs: number;
  private readonly structuredMode: StructuredMode;
  private readonly toolMode: ToolMode;
  private readonly model: string;
  private readonly defaultTemperature: number | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(config: OpenAICompatibleConfig, deps: OpenAICompatibleDeps) {
    if (!/^https?:\/\//.test(config.baseUrl)) {
      throw new ModelProviderError('baseUrl must be an http(s) URL', 'configuration');
    }
    if (config.model.trim() === '') {
      throw new ModelProviderError('model must not be empty', 'configuration');
    }
    this.descriptor = {
      provider: config.providerLabel ?? 'openai-compatible',
      model: config.model,
    };
    this.model = config.model;
    this.endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
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
    this.structuredMode = config.structuredMode ?? 'json_schema';
    this.toolMode = config.toolMode ?? 'tools';
    this.defaultTemperature = config.defaultTemperature;
    this.fetchImpl = deps.fetch ?? fetch;
    this.clock = deps.clock;
    this.ids = deps.ids;
  }

  /** Defensive: serialising the provider must never expose headers. */
  toJSON(): ModelDescriptor {
    return this.descriptor;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const { completion, latencyMs } = await this.complete(
      buildTextRequest(request.messages, this.options(request)),
    );
    return {
      ...this.base(completion, latencyMs),
      text: completion.content ?? '',
    };
  }

  async structuredGenerate<T>(
    request: StructuredModelRequest<T>,
  ): Promise<StructuredModelResponse<T>> {
    const { completion, latencyMs } = await this.complete(
      buildStructuredRequest(
        request.messages,
        request.schema,
        this.structuredMode,
        this.options(request),
      ),
    );
    const raw = extractJson(completion.content);
    const parsed =
      raw === undefined ? parseFail<T>('model output contained no JSON value') : request.parse(raw);
    return {
      ...this.base(completion, latencyMs),
      raw: raw === undefined ? completion.content : raw,
      parsed,
    };
  }

  async requestToolAction(request: ToolActionRequest): Promise<ToolActionResponse> {
    const knownNames = request.tools.map((t) => t.name);
    if (this.toolMode === 'json') return this.requestToolActionAsJson(request, knownNames);

    const names = new ToolNameMap(knownNames);
    const { completion, latencyMs } = await this.complete(
      buildToolActionRequest(request.messages, request.tools, names, this.options(request)),
    );
    const proposal = proposalFromCompletion(completion, names, knownNames);
    if (!proposal.ok) {
      throw new ModelProviderError(
        `model did not return a valid tool action: ${proposal.errors.join('; ')}`,
        'invalid_response',
      );
    }
    return { ...this.base(completion, latencyMs), proposal: proposal.value };
  }

  private async requestToolActionAsJson(
    request: ToolActionRequest,
    knownNames: readonly string[],
  ): Promise<ToolActionResponse> {
    const messages = [
      ...request.messages,
      { role: 'user' as const, content: renderToolsForJsonMode(request.tools) },
    ];
    const { completion, latencyMs } = await this.complete(
      buildStructuredRequest(
        messages,
        toolActionProposalSchema(request.tools),
        this.structuredMode,
        this.options(request),
      ),
    );
    const raw = extractJson(completion.content);
    const proposal =
      raw === undefined
        ? parseFail('model output contained no JSON value')
        : parseToolActionProposal(raw, knownNames);
    if (!proposal.ok) {
      throw new ModelProviderError(
        `model did not return a valid tool action: ${proposal.errors.join('; ')}`,
        'invalid_response',
      );
    }
    return { ...this.base(completion, latencyMs), proposal: proposal.value };
  }

  // ------------------------------------------------------------ transport

  private options(request: ModelRequest) {
    const temperature = request.temperature ?? this.defaultTemperature;
    return {
      model: this.model,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(request.maxOutputTokens !== undefined
        ? { maxOutputTokens: request.maxOutputTokens }
        : {}),
    };
  }

  private base(completion: ParsedCompletion, latencyMs: number) {
    return {
      modelCallId: asModelCallId(this.ids.next('mc')),
      descriptor: this.descriptor,
      usage: completion.usage,
      latencyMs,
      finishReason: completion.finishReason,
    };
  }

  private async complete(
    body: ChatCompletionRequest,
  ): Promise<{ completion: ParsedCompletion; latencyMs: number }> {
    const startedMs = this.clock.monotonicMs();
    const latency = () => Math.max(0, this.clock.monotonicMs() - startedMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
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
    try {
      return { completion: parseChatCompletion(json), latencyMs: latency() };
    } catch (error: unknown) {
      if (error instanceof ModelProviderError) {
        throw new ModelProviderError(this.redactor.redact(error.message), error.kind, {
          ...(error.status !== undefined ? { status: error.status } : {}),
        });
      }
      throw error;
    }
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
