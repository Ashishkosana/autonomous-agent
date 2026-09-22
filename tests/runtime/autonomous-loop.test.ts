import { beforeAll, describe, expect, it } from 'vitest';
import type { RunOutcome } from '../../src/agent/runtime/agent-runtime.js';
import type { DecisionRecord, ExperienceRecord, LessonRecord } from '../../src/memory/records.js';
import type { ToolActionRequest } from '../../src/models/contracts.js';
import {
  APPROACH_A_CONTENT,
  APPROACH_B_CONTENT,
  GOAL_STATEMENT,
  REPORT_PATH,
  REQUIRED_MARKER,
  SEED_KNOWLEDGE_ID,
  buildScenario,
  planTurn,
  reviseTurn,
  seqOf,
  writeReport,
  type Scenario,
} from '../support/runtime-scenario.js';

/**
 * REQUIRED TEST 1 — failure → replan → retry → success, autonomously.
 *
 * The scripted "model" plays: plan, approach A, a revision that changes
 * strategy, approach B. The human supplies ONE goal string. The evaluator is
 * rule-based and inspects the artifact; the tool call for approach A returns
 * ok but the evaluation fails, and the runtime must recover on its own.
 */
describe('autonomous loop: tool ok → evaluation failure → strategy change → retry → success', () => {
  let scenario: Scenario;
  let outcome: RunOutcome;

  beforeAll(async () => {
    scenario = await buildScenario({
      turns: [
        planTurn([SEED_KNOWLEDGE_ID]),
        { proposal: writeReport(APPROACH_A_CONTENT, 'Write the report body directly') },
        reviseTurn({ strategyChanged: true }),
        {
          proposal: writeReport(
            APPROACH_B_CONTENT,
            'Rewrite the report and append the required Sources section',
          ),
        },
      ],
    });
    outcome = await scenario.run();
  });

  it('completes the goal', () => {
    expect(outcome.state.status).toBe('completed');
    expect(outcome.state.usage.iterations).toBe(2);
    expect(outcome.state.usage.toolCalls).toBe(2);
    expect(outcome.state.usage.retries).toBe(1);
    expect(outcome.state.usage.strategyChanges).toBe(1);
    expect(outcome.state.usage.modelCalls).toBe(4);
    expect(outcome.state.usage.memoryReads).toBe(1);
    expect(outcome.state.usage.memoryWrites).toBe(5);
  });

  it('the first tool call returned ok yet the first evaluation failed', () => {
    const completed = scenario.events.ofType('TOOL_COMPLETED');
    const evaluations = scenario.events.ofType('EVALUATION_COMPLETED');
    expect(completed).toHaveLength(2);
    expect(scenario.events.ofType('TOOL_FAILED')).toHaveLength(0);
    expect(evaluations.map((e) => e.payload.verdict)).toEqual(['failure', 'success']);
    expect(evaluations[0]?.correlation.actionId).toBe(completed[0]?.correlation.actionId);
  });

  it('detected the failure and changed strategy and plan without human input', () => {
    const failure = scenario.events.ofType('FAILURE_DETECTED');
    expect(failure).toHaveLength(1);
    expect(failure[0]?.payload.source).toBe('evaluation');
    expect(failure[0]?.payload.summary).toContain(REQUIRED_MARKER);

    const strategy = scenario.events.ofType('STRATEGY_CHANGED');
    expect(strategy).toHaveLength(1);
    expect(strategy[0]?.payload.previousStrategyId).not.toBe(strategy[0]?.payload.newStrategyId);

    const updated = scenario.events.ofType('PLAN_UPDATED');
    expect(updated).toHaveLength(1);
    expect(updated[0]?.payload.version).toBe(2);
    expect(outcome.finalPlan?.strategy.supersedes).toBe(strategy[0]?.payload.previousStrategyId);
  });

  it('retried the same task with a different action', () => {
    const retries = scenario.events.ofType('RETRY_STARTED');
    const selected = scenario.events.ofType('TOOL_SELECTED');
    expect(retries).toHaveLength(1);
    expect(retries[0]?.payload.attempt).toBe(2);
    expect(retries[0]?.payload.changedApproach).toBe(true);
    expect(retries[0]?.payload.retryOfActionId).toBe(selected[0]?.correlation.actionId);
    expect(retries[0]?.correlation.taskId).toBe(selected[0]?.correlation.taskId);
    expect(selected[1]?.correlation.actionId).not.toBe(selected[0]?.correlation.actionId);
  });

  it('the artifact in the sandbox now satisfies the requirement', async () => {
    expect(await scenario.environment.readFile(REPORT_PATH)).toContain(REQUIRED_MARKER);
  });

  it('wrote experience, decision and lesson records to memory', async () => {
    const experiences = (await scenario.store.query({
      kinds: ['experience'],
    })) as ExperienceRecord[];
    const decisions = (await scenario.store.query({ kinds: ['decision'] })) as DecisionRecord[];
    const lessons = (await scenario.store.query({ kinds: ['lesson'] })) as LessonRecord[];

    expect(experiences.map((e) => e.outcome)).toEqual(['failure', 'success']);
    expect(experiences[1]?.retryOf).toBe(experiences[0]?.actionId);
    expect(experiences[1]?.changedApproach).toBe(true);

    expect(decisions.map((d) => d.outcome)).toEqual(['failure', 'success']);
    expect(decisions[1]?.lessonIds).toEqual(lessons.map((l) => l.lessonId));

    expect(lessons).toHaveLength(1);
    expect(scenario.events.ofType('LESSON_CREATED')[0]?.payload.lessonId).toBe(
      lessons[0]?.lessonId,
    );
    expect(scenario.events.ofType('MEMORY_WRITTEN').map((e) => e.payload.kind)).toEqual([
      'decision',
      'experience',
      'decision',
      'experience',
      'lesson',
    ]);
  });

  it('the human specified only the goal; approach B came from the runtime/model turn', () => {
    expect(GOAL_STATEMENT).not.toContain(APPROACH_B_CONTENT);
    expect(GOAL_STATEMENT).not.toContain('Sources section,');
    // Four model turns were consumed: plan, act A, revise, act B — all initiated by the runtime.
    expect(scenario.provider.requests.map((r) => r.purpose)).toEqual([
      'create_plan',
      'select_action',
      'revise_plan',
      'select_action',
    ]);
    // The diagnosis reached the model: the revise request carried the evaluator's gap.
    const revise = scenario.provider.requests[2];
    expect(revise?.messages.map((m) => m.content).join('\n')).toContain(
      `missing the required "${REQUIRED_MARKER}" section`,
    );
    // The retry request showed the model its own failed attempt.
    const retry = scenario.provider.requests[3] as ToolActionRequest;
    expect(retry.messages.map((m) => m.content).join('\n')).toContain('attempt 1: fs.write');
  });

  /** REQUIRED TEST 5 — causal ordering by sequence number. */
  it('emits events in causal order with contiguous sequence numbers', () => {
    const seqs = scenario.events.events.map((e) => e.sequence);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));

    const s = (type: string, nth = 0) => seqOf(scenario.events, type, nth);
    const order = [
      s('GOAL_RECEIVED'),
      s('MEMORY_SEARCH_STARTED'),
      s('MEMORY_RETRIEVED'),
      s('PLAN_CREATED'),
      s('DECISION_CREATED', 0),
      s('TOOL_SELECTED', 0),
      s('TOOL_STARTED', 0),
      s('TOOL_COMPLETED', 0),
      s('EVALUATION_COMPLETED', 0),
      s('FAILURE_DETECTED'),
      s('STRATEGY_CHANGED'),
      s('PLAN_UPDATED'),
      s('RETRY_STARTED'),
      s('TOOL_SELECTED', 1),
      s('TOOL_STARTED', 1),
      s('TOOL_COMPLETED', 1),
      s('EVALUATION_COMPLETED', 1),
      s('LESSON_CREATED'),
      s('MEMORY_WRITTEN', 4),
      s('GOAL_COMPLETED'),
    ];
    for (const seq of order) expect(seq).toBeGreaterThan(0);
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i], `step ${i} should follow step ${i - 1}`).toBeGreaterThan(order[i - 1] ?? 0);
    }
    expect(scenario.events.events.at(-1)?.type).toBe('GOAL_COMPLETED');
  });

  /** REQUIRED TEST 4 — provenance traced through real records by id. */
  it('traces memory → retrieval → plan → decision → action → observation → evaluation → lesson', async () => {
    const retrieved = scenario.events.ofType('MEMORY_RETRIEVED')[0];
    const planCreated = scenario.events.ofType('PLAN_CREATED')[0];
    const lesson = (await scenario.store.query({ kinds: ['lesson'] }))[0] as LessonRecord;
    const decisions = (await scenario.store.query({ kinds: ['decision'] })) as DecisionRecord[];
    const experiences = (await scenario.store.query({
      kinds: ['experience'],
    })) as ExperienceRecord[];
    const toolCompleted = scenario.events.ofType('TOOL_COMPLETED');
    const evaluations = scenario.events.ofType('EVALUATION_COMPLETED');

    // memory → retrieval: the seed record was actually returned by the retrieval.
    expect(retrieved?.payload.recordIds).toContain(SEED_KNOWLEDGE_ID);
    const retrievalId = retrieved?.payload.retrievalId;

    // retrieval → plan: the plan cites that retrieval and that record.
    expect(planCreated?.payload.informedByRetrievalIds).toEqual([retrievalId]);
    expect(planCreated?.payload.informedByMemoryRecordIds).toEqual([SEED_KNOWLEDGE_ID]);
    const planId = planCreated?.payload.planId;

    // plan → decision → action: both decisions descend from a plan and carry their action.
    for (const decision of decisions) {
      expect(decision.provenance.retrievalIds).toEqual([retrievalId]);
      expect(decision.provenance.memoryRecordIds).toEqual([SEED_KNOWLEDGE_ID]);
      expect(decision.actionId).toBeDefined();
    }
    expect(decisions[0]?.provenance.planIds).toEqual([planId]);
    expect(decisions[1]?.provenance.planIds).toEqual([outcome.finalPlan?.planId]);
    // the second decision knew about the first failed attempt
    expect(decisions[1]?.provenance.actionIds).toEqual([decisions[0]?.actionId]);
    expect(decisions[1]?.provenance.evaluationIds).toEqual([evaluations[0]?.payload.evaluationId]);

    // action → observation → evaluation: experience records tie them together by id.
    experiences.forEach((experience, i) => {
      expect(experience.actionId).toBe(decisions[i]?.actionId);
      expect(experience.observationId).toBe(toolCompleted[i]?.correlation.observationId);
      expect(experience.evaluationId).toBe(evaluations[i]?.payload.evaluationId);
    });

    // evaluation → lesson: the lesson links both attempts end to end and back to the memory that started it.
    expect(lesson.provenance.evaluationIds).toEqual(evaluations.map((e) => e.payload.evaluationId));
    expect(lesson.provenance.actionIds).toEqual(decisions.map((d) => d.actionId));
    expect(lesson.provenance.decisionIds).toEqual(decisions.map((d) => d.decisionId));
    expect(lesson.provenance.observationIds).toEqual(
      toolCompleted.map((e) => e.correlation.observationId),
    );
    expect(lesson.provenance.planIds).toEqual([planId, outcome.finalPlan?.planId]);
    expect(lesson.provenance.retrievalIds).toEqual([retrievalId]);
    expect(lesson.provenance.memoryRecordIds).toContain(SEED_KNOWLEDGE_ID);
    expect(lesson.provenance.memoryRecordIds).toContain(experiences[1]?.recordId);
  });
});
