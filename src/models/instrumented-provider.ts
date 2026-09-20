import type { Clock, GoalId, RunId } from '../domain/ids.js';
import type {
  ModelCallRecord,
  ModelDescriptor,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StructuredModelRequest,
  StructuredModelResponse,
  ToolActionRequest,
  ToolActionResponse,
} from './contracts.js';

export interface InstrumentationContext {
  readonly runId: RunId;
  readonly goalId?: GoalId;
  readonly clock: Clock;
  readonly onCall: (record: ModelCallRecord) => void;
}

/**
 * Decorates any ModelProvider so that every call produces a ModelCallRecord.
 * This is how the runtime counts model calls and tokens without each planner
 * or selector having to remember to report them.
 */
export class InstrumentedModelProvider implements ModelProvider {
  readonly descriptor: ModelDescriptor;

  constructor(
    private readonly inner: ModelProvider,
    private readonly context: InstrumentationContext,
  ) {
    this.descriptor = inner.descriptor;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const startedAt = this.context.clock.now();
    const response = await this.inner.generate(request);
    this.record(request, response, startedAt);
    return response;
  }

  async structuredGenerate<T>(
    request: StructuredModelRequest<T>,
  ): Promise<StructuredModelResponse<T>> {
    const startedAt = this.context.clock.now();
    const response = await this.inner.structuredGenerate(request);
    this.record(request, response, startedAt);
    return response;
  }

  async requestToolAction(request: ToolActionRequest): Promise<ToolActionResponse> {
    const startedAt = this.context.clock.now();
    const response = await this.inner.requestToolAction(request);
    this.record(request, response, startedAt);
    return response;
  }

  private record(
    request: ModelRequest,
    response: Pick<
      ModelResponse,
      'modelCallId' | 'descriptor' | 'usage' | 'latencyMs' | 'finishReason'
    >,
    startedAt: string,
  ): void {
    this.context.onCall({
      modelCallId: response.modelCallId,
      runId: this.context.runId,
      purpose: request.purpose,
      descriptor: response.descriptor,
      usage: response.usage,
      latencyMs: response.latencyMs,
      finishReason: response.finishReason,
      startedAt,
      ...(this.context.goalId ? { goalId: this.context.goalId } : {}),
    });
  }
}
