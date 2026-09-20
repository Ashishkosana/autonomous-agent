import type { Action } from '../../src/domain/action.js';
import type { Goal } from '../../src/domain/goal.js';
import {
  asActionId,
  asGoalId,
  asPlanId,
  asRunId,
  asStrategyId,
  asTaskId,
  type ActionId,
  type GoalId,
  type PlanId,
  type RunId,
  type TaskId,
} from '../../src/domain/ids.js';
import type { Plan } from '../../src/domain/plan.js';
import { EMPTY_PROVENANCE, type RunCorrelation } from '../../src/domain/provenance.js';
import type { ToolContext } from '../../src/tools/contracts.js';
import { FixedClock, SequentialIdGenerator } from './deterministic.js';
import { FakeExecutionEnvironment } from './fake-execution-environment.js';
import { InMemoryEventBus } from './in-memory-event-bus.js';

export const RUN_ID: RunId = asRunId('run-1');
export const GOAL_ID: GoalId = asGoalId('goal-1');
export const TASK_ID: TaskId = asTaskId('task-1');
export const PLAN_ID: PlanId = asPlanId('plan-1');
export const ACTION_ID: ActionId = asActionId('act-1');

export const CORRELATION: RunCorrelation = { runId: RUN_ID, goalId: GOAL_ID, taskId: TASK_ID };

export function makeGoal(statement = 'Write a short research report on X'): Goal {
  return {
    goalId: GOAL_ID,
    runId: RUN_ID,
    statement,
    constraints: [],
    successCriteria: ['A report file exists and is non-empty'],
    receivedAt: '2026-01-01T00:00:00.000Z',
  };
}

export function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    planId: PLAN_ID,
    runId: RUN_ID,
    goalId: GOAL_ID,
    version: 1,
    strategy: {
      strategyId: asStrategyId('strat-1'),
      summary: 'Search, read, write report',
      version: 1,
    },
    tasks: [
      {
        taskId: TASK_ID,
        description: 'Write the report file',
        status: 'pending',
        dependsOn: [],
        expectedEvidence: ['report.md exists and is non-empty'],
      },
    ],
    informedBy: EMPTY_PROVENANCE,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeAction(overrides: Partial<Action> = {}): Action {
  return {
    actionId: ACTION_ID,
    correlation: CORRELATION,
    planId: PLAN_ID,
    toolName: 'fs.write',
    input: { path: '/workspace/report.md', content: '' },
    attempt: 1,
    intent: 'Create the report file',
    derivedFrom: { planIds: [PLAN_ID] },
    requestedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export interface TestHarness {
  readonly ids: SequentialIdGenerator;
  readonly clock: FixedClock;
  readonly environment: FakeExecutionEnvironment;
  readonly events: InMemoryEventBus;
  toolContext(actionId?: ActionId): ToolContext;
}

export function makeHarness(): TestHarness {
  const ids = new SequentialIdGenerator();
  const clock = new FixedClock();
  const environment = new FakeExecutionEnvironment();
  const events = new InMemoryEventBus();
  return {
    ids,
    clock,
    environment,
    events,
    toolContext(actionId = ACTION_ID) {
      return { correlation: CORRELATION, actionId, environment, events, clock, ids };
    },
  };
}
