import { createAutonomousRun } from '../agent/runtime/create-run.js';
import type { RunOutcome } from '../agent/runtime/agent-runtime.js';
import {
  compareEfficiency,
  efficiencyFromRun,
  formatComparisonLines,
  type MeasuredRun,
} from '../agent/runtime/efficiency.js';
import type { VerifiableCriterion } from '../domain/criteria.js';
import type { Clock, IdGenerator } from '../domain/ids.js';
import type { RunLimits } from '../domain/run.js';
import { DeterministicEvaluator } from '../evaluation/deterministic-evaluator.js';
import type { AnyAgentEvent, EventSink } from '../events/contracts.js';
import { HybridRetriever } from '../memory/hybrid-retriever.js';
import { IndexedMemoryStore } from '../memory/indexed-memory-store.js';
import type { OpenedMemory } from '../memory/opened-memory.js';
import type { RunMetricsRecord } from '../memory/run-metrics.js';
import type { SemanticIndex } from '../memory/retrieval.js';
import type { EmbeddingProvider } from '../models/embeddings.js';
import { InstrumentedEmbeddingProvider } from '../models/instrumented-embedding-provider.js';
import type { ModelProvider } from '../models/contracts.js';
import type { ResilienceOptions } from '../models/resilient-provider.js';
import type { ExecutionEnvironment } from '../sandbox/execution-environment.js';
import { createStandardToolRegistry } from '../tools/standard-tools.js';
import { DeferredEmbeddingProvider } from './deferred-embedding.js';

export interface SpaceRunOptions {
  readonly goalStatement: string;
  readonly constraints?: readonly string[];
  readonly verifiableCriteria?: readonly VerifiableCriterion[];
  readonly memoryRetrieval: 'on' | 'off';
  /** Already open. This function does not close it. */
  readonly memory: OpenedMemory;
  readonly model: ModelProvider;
  readonly embeddings?: EmbeddingProvider;
  readonly events: EventSink;
  readonly environment: ExecutionEnvironment;
  readonly limits: RunLimits;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly resilience?: Partial<ResilienceOptions>;
  readonly onIndexFailure?: (message: string) => void;
  readonly onMetricsFailure?: (message: string) => void;
}

/**
 * One run inside an already-started execution environment. The Hugging Face
 * Space uses this with `SpaceProcessEnvironment` because that host has no
 * nested Docker daemon. The caller destroys the environment.
 */
export async function runSpaceAgent(
  options: SpaceRunOptions,
): Promise<RunOutcome & { measured: MeasuredRun }> {
  const deferred = options.embeddings
    ? new DeferredEmbeddingProvider(options.embeddings)
    : undefined;
  const index: (SemanticIndex & { close(): void }) | undefined = deferred
    ? options.memory.openSemanticIndex(deferred)
    : undefined;
  const memoryStore = index
    ? new IndexedMemoryStore(options.memory.store, index, {
        onIndexFailure: (failure) => {
          const message =
            failure.error instanceof Error ? failure.error.message : String(failure.error);
          options.onIndexFailure?.(`${failure.recordId} (${failure.kind}): ${message}`);
        },
      })
    : options.memory.store;
  const collected: AnyAgentEvent[] = [];
  const prior = await readPrior(options.memory, options.goalStatement);
  try {
    const { session, runtime } = createAutonomousRun({
      goalStatement: options.goalStatement,
      ...(options.constraints && options.constraints.length > 0
        ? { constraints: options.constraints }
        : {}),
      ...(options.verifiableCriteria && options.verifiableCriteria.length > 0
        ? { verifiableCriteria: options.verifiableCriteria }
        : {}),
      memory: options.memoryRetrieval,
      limits: options.limits,
      ids: options.ids,
      clock: options.clock,
      events: {
        emit(event) {
          collected.push(event);
          options.events.emit(event);
        },
      },
      model: options.model,
      ...(options.resilience ? { resilience: options.resilience } : {}),
      tools: createStandardToolRegistry(),
      environment: options.environment,
      evaluator: new DeterministicEvaluator(options.ids, options.clock),
      memoryStore,
      retriever: new HybridRetriever(memoryStore, index, options.clock),
    });
    if (deferred && options.embeddings) {
      deferred.bind(
        new InstrumentedEmbeddingProvider(options.embeddings, {
          runId: session.runId,
          goalId: session.goal.goalId,
          clock: options.clock,
          ids: options.ids,
          onStarted: (record) => session.recordModelCallStarted(record),
          onCall: (record) => session.recordModelCall(record),
          onFailed: (record) => session.recordModelCallFailed(record),
        }),
      );
    }
    const outcome = await runtime.run();
    const metrics = efficiencyFromRun(outcome.state, collected, options.goalStatement);
    if (options.memory.recordEfficiency) {
      try {
        await options.memory.recordEfficiency(metrics);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        options.onMetricsFailure?.(message);
      }
    }
    const measured: MeasuredRun = {
      metrics,
      comparisonLines: prior ? formatComparisonLines(compareEfficiency(prior, metrics)) : [],
    };
    return { ...outcome, measured };
  } finally {
    index?.close();
  }
}

async function readPrior(
  memory: OpenedMemory,
  goalStatement: string,
): Promise<RunMetricsRecord | undefined> {
  if (!memory.latestEfficiency) return undefined;
  try {
    return await memory.latestEfficiency(goalStatement);
  } catch {
    return undefined;
  }
}
