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
import {
  DEFAULT_MODEL_TIMEOUT_MS,
  OpenAICompatibleTransport,
  type TransportConfig,
} from './transport.js';
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

export { DEFAULT_MODEL_TIMEOUT_MS };

export interface OpenAICompatibleConfig extends TransportConfig {
  readonly model: string;
  /** Label reported in `descriptor.provider` and telemetry, e.g. `openrouter`. */
  readonly providerLabel?: string;
  readonly structuredMode?: StructuredMode;
  readonly toolMode?: ToolMode;
  readonly defaultTemperature?: number;
}

export interface OpenAICompatibleDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

/**
 * `ModelProvider` over the OpenAI chat-completions wire format. Vendor-neutral
 * by construction: nothing here knows which company runs the server.
 * Structured output and tool actions are validated by the runtime-owned
 * parsers; content that fails validation is returned as a `ParseResult`
 * failure (structured) or thrown as an `invalid_response` error (tool action)
 * for the resilience layer to re-ask — never as a crash.
 *
 * HTTP, deadlines, error mapping and credential containment live in
 * `OpenAICompatibleTransport`; this class owns only the chat-completions
 * request/response shapes.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly descriptor: ModelDescriptor;
  private readonly transport: OpenAICompatibleTransport;
  private readonly structuredMode: StructuredMode;
  private readonly toolMode: ToolMode;
  private readonly model: string;
  private readonly defaultTemperature: number | undefined;
  private readonly ids: IdGenerator;

  constructor(config: OpenAICompatibleConfig, deps: OpenAICompatibleDeps) {
    if (config.model.trim() === '') {
      throw new ModelProviderError('model must not be empty', 'configuration');
    }
    this.transport = new OpenAICompatibleTransport(config, {
      clock: deps.clock,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    this.descriptor = {
      provider: config.providerLabel ?? 'openai-compatible',
      model: config.model,
    };
    this.model = config.model;
    this.structuredMode = config.structuredMode ?? 'json_schema';
    this.toolMode = config.toolMode ?? 'tools';
    this.defaultTemperature = config.defaultTemperature;
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
    const { json, latencyMs } = await this.transport.postJson('chat/completions', body);
    try {
      return { completion: parseChatCompletion(json), latencyMs };
    } catch (error: unknown) {
      throw this.transport.redactError(error);
    }
  }
}
