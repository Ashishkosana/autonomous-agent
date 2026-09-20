import { describe, expect, it } from 'vitest';
import {
  APPROACH_A_CONTENT,
  APPROACH_B_CONTENT,
  SEED_KNOWLEDGE_ID,
  buildScenario,
  planTurn,
  reviseTurn,
  writeReport,
  type ScenarioTurn,
} from '../support/runtime-scenario.js';

/** A model that never learns: always writes the inadequate draft and never changes strategy. */
function stubbornTurns(rounds: number): ScenarioTurn[] {
  const turns: ScenarioTurn[] = [planTurn([SEED_KNOWLEDGE_ID])];
  for (let i = 0; i < rounds; i += 1) {
    turns.push({
      proposal: writeReport(APPROACH_A_CONTENT, `Write the report (attempt ${i + 1})`),
    });
    turns.push(reviseTurn({ strategyChanged: false }));
  }
  return turns;
}

/** REQUIRED TEST 2 — the run stops because of a configured limit, not because the goal resolved. */
describe('run limits', () => {
  it('stops at maxIterations, emits RUN_LIMIT_REACHED, and executes no further tools', async () => {
    const scenario = await buildScenario({
      turns: stubbornTurns(20),
      limits: { maxIterations: 2 },
    });
    const outcome = await scenario.run();

    expect(outcome.state.status).toBe('limit_reached');
    expect(outcome.state.terminationReason).toBe('Run limit maxIterations reached (2/2)');
    expect(outcome.state.usage.iterations).toBe(2);
    expect(outcome.state.usage.toolCalls).toBe(2);

    const limit = scenario.events.ofType('RUN_LIMIT_REACHED');
    expect(limit).toHaveLength(1);
    expect(limit[0]?.payload).toEqual({ limit: 'maxIterations', value: 2, max: 2 });

    expect(scenario.events.ofType('GOAL_COMPLETED')).toHaveLength(0);
    expect(scenario.events.ofType('GOAL_FAILED')).toHaveLength(0);
    expect(scenario.events.ofType('TOOL_STARTED')).toHaveLength(2);
    expect(scenario.events.events.at(-1)?.type).toBe('RUN_LIMIT_REACHED');

    // The scripted model still had turns available; the runtime chose to stop.
    expect(scenario.provider.requests).toHaveLength(1 + 2 * 2);
  });

  it('stops at maxToolCalls independently of iterations', async () => {
    const scenario = await buildScenario({
      turns: stubbornTurns(20),
      limits: { maxIterations: 50, maxToolCalls: 1 },
    });
    const outcome = await scenario.run();

    expect(outcome.state.status).toBe('limit_reached');
    expect(scenario.events.ofType('RUN_LIMIT_REACHED')[0]?.payload.limit).toBe('maxToolCalls');
    expect(scenario.events.ofType('TOOL_STARTED')).toHaveLength(1);
  });

  it('stops at maxModelCalls before the loop can consume another model turn', async () => {
    const scenario = await buildScenario({
      turns: stubbornTurns(20),
      limits: { maxModelCalls: 3 },
    });
    const outcome = await scenario.run();

    expect(outcome.state.status).toBe('limit_reached');
    expect(scenario.events.ofType('RUN_LIMIT_REACHED')[0]?.payload.limit).toBe('maxModelCalls');
    expect(outcome.state.usage.modelCalls).toBe(3);
  });
});

/** REQUIRED TEST 3 — the agent decides to stop on its own. */
describe('give up', () => {
  it('terminates intentionally with a recorded reason, distinct from success and limits', async () => {
    const reason = 'The available tools cannot produce a Sources section from verified references';
    const scenario = await buildScenario({
      turns: [
        planTurn([SEED_KNOWLEDGE_ID]),
        { proposal: writeReport(APPROACH_A_CONTENT, 'Write the report body directly') },
        reviseTurn({ strategyChanged: false }),
        { proposal: { kind: 'give_up', reason } },
      ],
    });
    const outcome = await scenario.run();

    expect(outcome.state.status).toBe('gave_up');
    expect(outcome.state.terminationReason).toBe(reason);

    const failed = scenario.events.ofType('GOAL_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toEqual({ reason, iterations: 2, cause: 'gave_up' });
    expect(scenario.events.events.at(-1)?.type).toBe('GOAL_FAILED');

    expect(scenario.events.ofType('GOAL_COMPLETED')).toHaveLength(0);
    expect(scenario.events.ofType('RUN_LIMIT_REACHED')).toHaveLength(0);
    expect(scenario.events.ofType('TOOL_STARTED')).toHaveLength(1);
    // The failed first attempt was still recorded as experience before giving up.
    expect(await scenario.store.count({ kinds: ['experience'] })).toBe(1);
  });
});

describe('unrecoverable failure', () => {
  it('an invalid plan from the model ends the run as failed, not as gave_up or limit_reached', async () => {
    const scenario = await buildScenario({
      turns: [{ structured: { strategySummary: 'x', tasks: 'not-an-array' } }],
    });
    const outcome = await scenario.run();

    expect(outcome.state.status).toBe('failed');
    const failed = scenario.events.ofType('GOAL_FAILED');
    expect(failed[0]?.payload.cause).toBe('unrecoverable');
    expect(failed[0]?.payload.reason).toContain('invalid plan');
    expect(scenario.events.ofType('PLAN_CREATED')).toHaveLength(0);
    expect(scenario.events.ofType('TOOL_STARTED')).toHaveLength(0);
  });
});

describe('finish claims are verified, not trusted', () => {
  it('a premature "finish" is evaluated at goal level and treated as a failure', async () => {
    const scenario = await buildScenario({
      turns: [
        planTurn([SEED_KNOWLEDGE_ID]),
        {
          proposal: {
            kind: 'finish',
            summary: 'The report is complete',
            rationale: 'Nothing more to do',
          },
        },
        reviseTurn({ strategyChanged: true }),
        { proposal: writeReport(APPROACH_B_CONTENT, 'Actually write the report with Sources') },
      ],
    });
    const outcome = await scenario.run();

    expect(outcome.state.status).toBe('completed');
    const evaluations = scenario.events.ofType('EVALUATION_COMPLETED');
    expect(evaluations.map((e) => e.payload.verdict)).toEqual(['failure', 'success']);
    // The rejected claim had no action behind it; the evaluation was goal-level.
    expect(evaluations[0]?.correlation.actionId).toBeUndefined();
    expect(scenario.events.ofType('FAILURE_DETECTED')).toHaveLength(1);
    expect(scenario.events.ofType('TOOL_STARTED')).toHaveLength(1);
    // No retry: the failed claim was not an action on the task.
    expect(scenario.events.ofType('RETRY_STARTED')).toHaveLength(0);
  });
});
