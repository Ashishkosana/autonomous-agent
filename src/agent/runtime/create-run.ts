import type { Clock, IdGenerator } from '../../domain/ids.js';
import type { RunLimits } from '../../domain/run.js';
import type { Evaluator } from '../../evaluation/contracts.js';
import type { EventSink } from '../../events/contracts.js';
import type { MemoryRetriever } from '../../memory/retrieval.js';
import type { MemoryStore } from '../../memory/store.js';
import type { ModelProvider } from '../../models/contracts.js';
import { InstrumentedModelProvider } from '../../models/instrumented-provider.js';
import { ResilientModelProvider, type ResilienceOptions } from '../../models/resilient-provider.js';
import type { ExecutionEnvironment } from '../../sandbox/execution-environment.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { ModelActionSelector } from '../action-selector.js';
import { ToolExecutor } from '../executor.js';
import { OutcomeLearner } from '../learner.js';
import { ModelPlanner } from '../planner.js';
import { AgentRuntime, type RuntimeOptions } from './agent-runtime.js';
import { RunSession } from './run-session.js';

export interface AutonomousRunConfig extends RuntimeOptions {
  readonly goalStatement: string;
  readonly constraints?: readonly string[];
  readonly successCriteria?: readonly string[];
  readonly limits: RunLimits;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly events: EventSink;
  readonly model: ModelProvider;
  readonly tools: ToolRegistry;
  readonly environment: ExecutionEnvironment;
  readonly evaluator: Evaluator;
  readonly memoryStore: MemoryStore;
  readonly retriever: MemoryRetriever;
  /**
   * Bounded retry/re-ask behaviour around the model. Defaults are tuned for
   * real providers; deterministic tests pass zeros so every scripted turn is
   * consumed exactly once.
   */
  readonly resilience?: Partial<ResilienceOptions>;
}

export interface AutonomousRun {
  readonly session: RunSession;
  readonly runtime: AgentRuntime;
}

/**
 * Composition root for one autonomous run. Wires the default components
 * around the caller-supplied model, tools, environment, evaluator and memory.
 * Everything supplied is an interface; nothing here knows about vendors —
 * the caller picks the model with `resolveModelConfig`/`createModelProvider`
 * (`src/models/config.ts`) or hands in a scripted one.
 */
export function createAutonomousRun(config: AutonomousRunConfig): AutonomousRun {
  const session = new RunSession({
    goalStatement: config.goalStatement,
    limits: config.limits,
    ids: config.ids,
    clock: config.clock,
    events: config.events,
    ...(config.constraints ? { constraints: config.constraints } : {}),
    ...(config.successCriteria ? { successCriteria: config.successCriteria } : {}),
  });

  // Resilience wraps instrumentation so that every attempt — including the
  // ones that fail or get re-asked — is a separately observable model call.
  const model = new ResilientModelProvider(
    new InstrumentedModelProvider(config.model, {
      runId: session.runId,
      goalId: session.goal.goalId,
      clock: config.clock,
      ids: config.ids,
      onStarted: (record) => session.recordModelCallStarted(record),
      onCall: (record) => session.recordModelCall(record),
      onFailed: (record) => session.recordModelCallFailed(record),
    }),
    config.resilience ?? {},
  );

  const runtime = new AgentRuntime(
    {
      session,
      planner: new ModelPlanner(model, config.ids, config.clock),
      selector: new ModelActionSelector(model, config.ids, config.clock),
      executor: new ToolExecutor(config.tools, config.environment, session),
      evaluator: config.evaluator,
      learner: new OutcomeLearner(config.ids, config.clock),
      memoryStore: config.memoryStore,
      retriever: config.retriever,
      tools: config.tools,
      environment: config.environment,
    },
    { ...(config.retrievalLimit !== undefined ? { retrievalLimit: config.retrievalLimit } : {}) },
  );

  return { session, runtime };
}
