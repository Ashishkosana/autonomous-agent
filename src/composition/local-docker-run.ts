import { createAutonomousRun } from '../agent/runtime/create-run.js';
import type { RunOutcome } from '../agent/runtime/agent-runtime.js';
import type { VerifiableCriterion } from '../domain/criteria.js';
import type { Clock, IdGenerator } from '../domain/ids.js';
import { SystemClock } from '../domain/system-clock.js';
import { UniqueIdGenerator } from '../domain/unique-ids.js';
import type { RunLimits } from '../domain/run.js';
import { DeterministicEvaluator } from '../evaluation/deterministic-evaluator.js';
import type { EventSink } from '../events/contracts.js';
import { HybridRetriever } from '../memory/hybrid-retriever.js';
import { IndexedMemoryStore } from '../memory/indexed-memory-store.js';
import { SqliteMemoryStore } from '../memory/sqlite/sqlite-memory-store.js';
import { SqliteSemanticIndex } from '../memory/sqlite/sqlite-semantic-index.js';
import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../models/embeddings.js';
import { InstrumentedEmbeddingProvider } from '../models/instrumented-embedding-provider.js';
import type { ModelDescriptor } from '../models/contracts.js';
import type { ModelProvider } from '../models/contracts.js';
import type { ResilienceOptions } from '../models/resilient-provider.js';
import {
  ContainerRuntimeError,
  type ContainerRuntime,
  type ContainerRuntimeInfo,
} from '../sandbox/local/container-runtime.js';
import { DockerCliRuntime } from '../sandbox/local/docker-cli-runtime.js';
import { LocalLinuxEnvironment } from '../sandbox/local/local-linux-environment.js';
import { LOCAL_SANDBOX_IMAGE } from '../sandbox/local/sandbox-spec.js';
import { createStandardToolRegistry } from '../tools/standard-tools.js';
import { DEFAULT_CLI_LIMITS } from '../cli/limits.js';

export interface LocalDockerRunOptions {
  readonly goalStatement: string;
  readonly constraints?: readonly string[];
  readonly verifiableCriteria?: readonly VerifiableCriterion[];
  readonly memoryRetrieval: 'on' | 'off';
  readonly memoryPath: string;
  /** Raw provider. `createAutonomousRun` adds instrumentation and bounded retry. */
  readonly model: ModelProvider;
  /** When set, records and the query are embedded into the same SQLite file. */
  readonly embeddings?: EmbeddingProvider;
  readonly events: EventSink;
  readonly limits?: RunLimits;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly resilience?: Partial<ResilienceOptions>;
  /** Defaults to the Docker CLI. Tests pass a fake runtime. */
  readonly runtime?: ContainerRuntime;
  /** Called once resources exist, so a signal handler can destroy them. */
  readonly registerCleanup?: (cleanup: () => Promise<void>) => void;
  readonly onIndexFailure?: (message: string) => void;
}

/**
 * One production run: Docker/Linux sandbox, SQLite memory, hybrid retrieval,
 * the standard tool registry, and `DeterministicEvaluator`, all through
 * `createAutonomousRun`. The caller owns argv and environment variables.
 * The sandbox is destroyed on success, failure, and a second cleanup call.
 */
export async function runLocalDockerAgent(options: LocalDockerRunOptions): Promise<RunOutcome> {
  const clock = options.clock ?? new SystemClock();
  const ids = options.ids ?? new UniqueIdGenerator();
  const runtime = options.runtime ?? new DockerCliRuntime();
  await assertLocalDockerReady(runtime);

  const store = SqliteMemoryStore.open({ path: options.memoryPath });
  let index: SqliteSemanticIndex | undefined;
  let environment: LocalLinuxEnvironment | undefined;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    if (environment) await environment.destroy().catch(() => undefined);
    index?.close();
    store.close();
  };
  options.registerCleanup?.(cleanup);

  try {
    const deferred = options.embeddings
      ? new DeferredEmbeddingProvider(options.embeddings)
      : undefined;
    if (deferred) {
      index = SqliteSemanticIndex.open({ path: options.memoryPath, embeddings: deferred });
    }
    const memoryStore = index
      ? new IndexedMemoryStore(store, index, {
          onIndexFailure: (failure) => {
            const message =
              failure.error instanceof Error ? failure.error.message : String(failure.error);
            options.onIndexFailure?.(`${failure.recordId} (${failure.kind}): ${message}`);
          },
        })
      : store;
    environment = await LocalLinuxEnvironment.start(runtime, `agent-${ids.next('box')}`, {
      defaultCommandTimeoutMs: 60_000,
    });
    const { session, runtime: agent } = createAutonomousRun({
      goalStatement: options.goalStatement,
      ...(options.constraints && options.constraints.length > 0
        ? { constraints: options.constraints }
        : {}),
      ...(options.verifiableCriteria && options.verifiableCriteria.length > 0
        ? { verifiableCriteria: options.verifiableCriteria }
        : {}),
      memory: options.memoryRetrieval,
      limits: options.limits ?? DEFAULT_CLI_LIMITS,
      ids,
      clock,
      events: options.events,
      model: options.model,
      ...(options.resilience ? { resilience: options.resilience } : {}),
      tools: createStandardToolRegistry(),
      environment,
      evaluator: new DeterministicEvaluator(ids, clock),
      memoryStore,
      retriever: new HybridRetriever(memoryStore, index, clock),
    });
    if (deferred && options.embeddings) {
      deferred.bind(
        new InstrumentedEmbeddingProvider(options.embeddings, {
          runId: session.runId,
          goalId: session.goal.goalId,
          clock,
          ids,
          onStarted: (record) => session.recordModelCallStarted(record),
          onCall: (record) => session.recordModelCall(record),
          onFailed: (record) => session.recordModelCallFailed(record),
        }),
      );
    }
    return await agent.run();
  } finally {
    await cleanup();
  }
}

/**
 * Fails before a container is created when Docker or the pinned sandbox image
 * is missing. Host execution is not a substitute.
 */
export async function assertLocalDockerReady(
  runtime: ContainerRuntime,
): Promise<ContainerRuntimeInfo> {
  let info: ContainerRuntimeInfo;
  try {
    info = await runtime.info();
  } catch (error: unknown) {
    const detail = error instanceof ContainerRuntimeError ? error.message : String(error);
    throw new Error(
      `Docker is unavailable (${detail}). The CLI does not fall back to host execution. Install Docker and ensure the daemon is running.`,
    );
  }
  if (info.serverOs !== 'linux') {
    throw new Error(
      `Docker engine OS is ${info.serverOs}. Linux containers are required. The CLI does not fall back to host execution.`,
    );
  }
  if (!(await runtime.imageExists(LOCAL_SANDBOX_IMAGE))) {
    throw new Error(
      `Sandbox image ${LOCAL_SANDBOX_IMAGE} was not found. Build it with \`npm run sandbox:build\`. The CLI does not fall back to host execution.`,
    );
  }
  return info;
}

/**
 * The semantic index is opened before the run session exists, but embedding
 * calls must be attributed to that session. The index holds this object;
 * `bind` installs the instrumented provider before `runtime.run()`.
 */
class DeferredEmbeddingProvider implements EmbeddingProvider {
  readonly descriptor: ModelDescriptor;
  private bound: EmbeddingProvider | undefined;

  constructor(raw: EmbeddingProvider) {
    this.descriptor = raw.descriptor;
  }

  bind(provider: EmbeddingProvider): void {
    this.bound = provider;
  }

  embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (!this.bound) {
      return Promise.reject(new Error('embedding provider was used before the run was ready'));
    }
    return this.bound.embed(request);
  }
}
