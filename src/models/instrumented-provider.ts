import {
  asModelCallId,
  type Clock,
  type GoalId,
  type IdGenerator,
  type RunId,
} from '../domain/ids.js';
import type {
  ModelCallFailure,
  ModelCallRecord,
  ModelCallStart,
  ModelDescriptor,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StructuredModelRequest,
  StructuredModelResponse,
  ToolActionRequest,
  ToolActionResponse,
} from './contracts.js';
import { errorKindOf, isRetryableModelError } from './errors.js';

export interface InstrumentationContext {
  readonly runId: RunId;
  readonly goalId?: GoalId;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly onStarted: (record: ModelCallStart) => void;
  readonly onCall: (record: ModelCallRecord) => void;
  readonly onFailed: (record: ModelCallFailure) => void;
}

/**
 * Decorates any ModelProvider so that every attempt produces telemetry:
 * a start record before the call, then either a completion record (with
 * usage and latency) or a failure record (with the redacted error). This is
 * how the runtime counts model calls and tokens without each planner or
 * selector having to remember to report them.
 *
 * Call identity is owned here: the id is assigned before the provider is
 * invoked so that started/completed/failed records — and the response the
 * caller receives — all carry the same `modelCallId`.
 */
export class InstrumentedModelProvider implements ModelProvider {
  readonly descriptor: ModelDescriptor;

  constructor(
    private readonly inner: ModelProvider,
    private readonly context: InstrumentationContext,
  ) {
    this.descriptor = inner.descriptor;
  }

  generate(request: ModelRequest): Promise<ModelResponse> {
    return this.observe(request, () => this.inner.generate(request));
  }

  structuredGenerate<T>(request: StructuredModelRequest<T>): Promise<StructuredModelResponse<T>> {
    return this.observe(request, () => this.inner.structuredGenerate(request));
  }

  requestToolAction(request: ToolActionRequest): Promise<ToolActionResponse> {
    return this.observe(request, () => this.inner.requestToolAction(request));
  }

  private async observe<R extends ResponseLike>(
    request: ModelRequest,
    call: () => Promise<R>,
  ): Promise<R> {
    const { clock, ids } = this.context;
    const modelCallId = asModelCallId(ids.next('mc'));
    const startedAt = clock.now();
    const startedMs = clock.monotonicMs();
    const attempt = request.attempt ?? 1;
    const common = {
      modelCallId,
      runId: this.context.runId,
      purpose: request.purpose,
      descriptor: this.descriptor,
      startedAt,
      attempt,
      ...(this.context.goalId ? { goalId: this.context.goalId } : {}),
    };

    this.context.onStarted(common);
    try {
      const response = await call();
      this.context.onCall({
        ...common,
        descriptor: response.descriptor,
        usage: response.usage,
        latencyMs: response.latencyMs,
        finishReason: response.finishReason,
      });
      return { ...response, modelCallId };
    } catch (error: unknown) {
      this.context.onFailed({
        ...common,
        latencyMs: Math.max(0, clock.monotonicMs() - startedMs),
        errorKind: errorKindOf(error),
        message: error instanceof Error ? error.message : String(error),
        retryable: isRetryableModelError(error),
      });
      throw error;
    }
  }
}

type ResponseLike = Pick<
  ModelResponse,
  'modelCallId' | 'descriptor' | 'usage' | 'latencyMs' | 'finishReason'
>;
