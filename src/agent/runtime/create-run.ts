import type { Clock, IdGenerator } from '../../domain/ids.js';
import type { RunLimits } from '../../domain/run.js';
import type { Evaluator } from '../../evaluation/contracts.js';
import type { EventSink } from '../../events/contracts.js';
import type { MemoryRetriever } from '../../memory/retrieval.js';
import type { MemoryStore } from '../../memory/store.js';
import type { ModelProvider } from '../../models/contracts.js';
import { InstrumentedModelProvider } from '../../models/instrumented-provider.js';
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
}

export interface AutonomousRun {
  readonly session: RunSession;
  readonly runtime: AgentRuntime;
}

/**
 * Composition root for one autonomous run. Wires the default components
 * around the caller-supplied model, tools, environment, evaluator and memory.
 * Everything supplied is an interface; nothing here knows about vendors.
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

  const model = new InstrumentedModelProvider(config.model, {
    runId: session.runId,
    goalId: session.goal.goalId,
    clock: config.clock,
    onCall: (record) => session.recordModelCall(record),
  });

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
