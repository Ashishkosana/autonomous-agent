import { describe, expect, it } from 'vitest';
import { ModelPlanner, parsePlanProposal, parseRevisionProposal } from '../../src/agent/planner.js';
import { OutcomeLearner } from '../../src/agent/learner.js';
import { ToolExecutor } from '../../src/agent/executor.js';
import { RunSession } from '../../src/agent/runtime/run-session.js';
import { RunUsageTracker } from '../../src/agent/runtime/run-usage.js';
import type { TaskAttempt } from '../../src/agent/contracts.js';
import {
  asActionId,
  asEvaluationId,
  asObservationId,
  asRetrievalId,
} from '../../src/domain/ids.js';
import type { RetrievalResult } from '../../src/memory/retrieval.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { FixedClock, SequentialIdGenerator } from '../support/deterministic.js';
import { FakeExecutionEnvironment } from '../support/fake-execution-environment.js';
import { CORRELATION, makeAction, makeGoal, makePlan } from '../support/fixtures.js';
import { InMemoryEventBus } from '../support/in-memory-event-bus.js';
import { ScriptedModelProvider } from '../support/scripted-model-provider.js';
import { DEFAULT_LIMITS, seedKnowledge } from '../support/runtime-scenario.js';
import { echoTool } from '../support/tools.js';

describe('RunUsageTracker', () => {
  it('reports the first limit reached and nothing before that', () => {
    const clock = new FixedClock();
    const tracker = new RunUsageTracker(
      { ...DEFAULT_LIMITS, maxToolCalls: 2, maxDurationMs: 1000 },
      clock,
    );
    expect(tracker.breach()).toBeUndefined();
    tracker.increment('toolCalls');
    expect(tracker.breach()).toBeUndefined();
    tracker.increment('toolCalls');
    expect(tracker.breach()).toEqual({ limit: 'maxToolCalls', value: 2, max: 2 });
  });

  it('treats elapsed time as a limit too', () => {
    const clock = new FixedClock();
    const tracker = new RunUsageTracker({ ...DEFAULT_LIMITS, maxDurationMs: 500 }, clock);
    clock.advance(499);
    expect(tracker.breach()).toBeUndefined();
    clock.advance(1);
    expect(tracker.breach()?.limit).toBe('maxDurationMs');
  });
});

describe('plan proposal parsing', () => {
  it('rejects structurally invalid plans with specific errors', () => {
    expect(parsePlanProposal(null)).toEqual({ ok: false, errors: ['plan must be an object'] });
    const result = parsePlanProposal({ strategySummary: '', tasks: [{ description: 1 }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      'strategySummary must be a non-empty string',
      'tasks[0].description must be a non-empty string',
      'tasks[0].expectedEvidence must be an array of strings',
    ]);
  });

  it('requires a changeReason when the strategy changed', () => {
    const result = parseRevisionProposal({
      strategySummary: 's',
      tasks: [{ description: 'd', expectedEvidence: [] }],
      strategyChanged: true,
      revisionReason: 'r',
    });
    expect(result).toEqual({
      ok: false,
      errors: ['changeReason is required when strategyChanged'],
    });
  });
});

describe('ModelPlanner provenance', () => {
  const retrieval = (hits: RetrievalResult['hits']): RetrievalResult => ({
    retrievalId: asRetrievalId('ret-9'),
    query: {
      retrievalId: asRetrievalId('ret-9'),
      text: 'q',
      kinds: ['knowledge'],
      limit: 5,
      correlation: CORRELATION,
    },
    hits,
    signalsUsed: ['metadata', 'keyword'],
    startedAt: 't',
    finishedAt: 't',
    durationMs: 0,
  });

  it('only records citations of records the model was actually shown', async () => {
    const ids = new SequentialIdGenerator();
    const provider = new ScriptedModelProvider(
      [
        {
          structured: {
            strategySummary: 's',
            tasks: [{ description: 'd', expectedEvidence: ['e'] }],
            citedMemoryRecordIds: [seedKnowledge.recordId, 'fabricated-id'],
          },
        },
      ],
      ids,
    );
    const planner = new ModelPlanner(provider, ids, new FixedClock());
    const plan = await planner.createPlan({
      goal: makeGoal(),
      working: {
        runId: CORRELATION.runId,
        goal: makeGoal(),
        observations: [],
        retrievals: [],
        notes: [],
      },
      retrievals: [retrieval([{ record: seedKnowledge, score: 1, matchedBy: ['keyword'] }])],
      availableTools: [],
    });
    expect(plan.informedBy).toEqual({
      retrievalIds: ['ret-9'],
      memoryRecordIds: [seedKnowledge.recordId],
    });
  });

  it('an empty retrieval informs nothing', async () => {
    const ids = new SequentialIdGenerator();
    const provider = new ScriptedModelProvider(
      [
        {
          structured: { strategySummary: 's', tasks: [{ description: 'd', expectedEvidence: [] }] },
        },
      ],
      ids,
    );
    const planner = new ModelPlanner(provider, ids, new FixedClock());
    const plan = await planner.createPlan({
      goal: makeGoal(),
      working: {
        runId: CORRELATION.runId,
        goal: makeGoal(),
        observations: [],
        retrievals: [],
        notes: [],
      },
      retrievals: [retrieval([])],
      availableTools: [],
    });
    expect(plan.informedBy).toEqual({});
  });

  it('a revision keeps an echoed task id, preserves completed tasks and versions the strategy', async () => {
    const ids = new SequentialIdGenerator();
    const previous = makePlan({
      tasks: [
        { ...makePlan().tasks[0]!, taskId: asTaskIdLoose('done-1'), status: 'completed' },
        { ...makePlan().tasks[0]!, taskId: asTaskIdLoose('todo-1'), status: 'in_progress' },
      ],
    });
    const provider = new ScriptedModelProvider(
      [
        {
          structured: {
            strategySummary: 'new approach',
            strategyChanged: true,
            changeReason: 'old one failed',
            revisionReason: 'evaluator gap',
            tasks: [
              { taskId: 'todo-1', description: 'retry differently', expectedEvidence: ['x'] },
              { description: 'a brand new task', expectedEvidence: ['y'] },
            ],
          },
        },
      ],
      ids,
    );
    const planner = new ModelPlanner(provider, ids, new FixedClock());
    const revised = await planner.revisePlan({
      goal: makeGoal(),
      working: {
        runId: CORRELATION.runId,
        goal: makeGoal(),
        observations: [],
        retrievals: [],
        notes: [],
      },
      retrievals: [],
      availableTools: [],
      previousPlan: previous,
      triggeringEvaluations: [],
    });

    expect(revised.version).toBe(2);
    expect(revised.strategy.version).toBe(2);
    expect(revised.strategy.supersedes).toBe(previous.strategy.strategyId);
    expect(revised.strategy.changeReason).toBe('old one failed');
    expect(revised.tasks.map((t) => [t.taskId, t.status])).toEqual([
      ['done-1', 'completed'],
      ['todo-1', 'in_progress'],
      ['task-1', 'pending'],
    ]);
    expect(revised.tasks[1]?.description).toBe('retry differently');
    expect(revised.informedBy.planIds).toEqual([previous.planId]);
  });
});

function asTaskIdLoose(value: string) {
  return value as ReturnType<typeof makePlan>['tasks'][number]['taskId'];
}

describe('OutcomeLearner', () => {
  const attempt = (n: number, verdict: 'success' | 'failure', content: string): TaskAttempt => {
    const action = makeAction({
      actionId: asActionId(`act-${n}`),
      attempt: n,
      input: { path: '/workspace/report.md', content },
      intent: `attempt ${n}`,
      ...(n > 1 ? { retryOf: asActionId(`act-${n - 1}`) } : {}),
    });
    return {
      action,
      observation: {
        observationId: asObservationId(`obs-${n}`),
        actionId: action.actionId,
        correlation: CORRELATION,
        toolResult: {
          status: 'ok',
          toolName: 'fs.write',
          actionId: action.actionId,
          output: {},
          startedAt: 't',
          finishedAt: 't',
          durationMs: 0,
        },
        artifacts: [],
        summary: 'ok',
        observedAt: 't',
      },
      evaluation: {
        evaluationId: asEvaluationId(`eval-${n}`),
        correlation: CORRELATION,
        verdict,
        checks: [],
        gaps: verdict === 'failure' ? ['missing section'] : [],
        summary: verdict,
        toolStatus: 'ok',
        derivedFrom: {},
        evaluatedAt: 't',
      },
    };
  };

  it('records experience for every attempt but derives a lesson only from a failure→success contrast', async () => {
    const learner = new OutcomeLearner(new SequentialIdGenerator(), new FixedClock());
    const task = makePlan().tasks[0]!;

    const first = await learner.learn({
      correlation: CORRELATION,
      task,
      attempt: attempt(1, 'failure', 'a'),
      previousAttempts: [],
    });
    expect(first.experience.outcome).toBe('failure');
    expect(first.experience.changedApproach).toBe(false);
    expect(first.lessons).toEqual([]);

    const second = await learner.learn({
      correlation: CORRELATION,
      task,
      attempt: attempt(2, 'success', 'b'),
      previousAttempts: [attempt(1, 'failure', 'a')],
    });
    expect(second.experience.outcome).toBe('success');
    expect(second.experience.changedApproach).toBe(true);
    expect(second.experience.retryOf).toBe('act-1');
    expect(second.lessons).toHaveLength(1);
    const lesson = second.lessons[0]!;
    expect(lesson.provenance.actionIds).toEqual(['act-1', 'act-2']);
    expect(lesson.provenance.evaluationIds).toEqual(['eval-1', 'eval-2']);
    expect(lesson.provenance.memoryRecordIds).toEqual([second.experience.recordId]);
    expect(lesson.statement).toContain('missing section');
  });

  it('a first-try success yields no lesson (nothing was contrasted)', async () => {
    const learner = new OutcomeLearner(new SequentialIdGenerator(), new FixedClock());
    const result = await learner.learn({
      correlation: CORRELATION,
      task: makePlan().tasks[0]!,
      attempt: attempt(1, 'success', 'b'),
      previousAttempts: [],
    });
    expect(result.lessons).toEqual([]);
  });
});

describe('ToolExecutor', () => {
  it('emits TOOL_FAILED for an unknown tool and still returns an observation', async () => {
    const events = new InMemoryEventBus();
    const session = new RunSession({
      goalStatement: 'g',
      limits: DEFAULT_LIMITS,
      ids: new SequentialIdGenerator(),
      clock: new FixedClock(),
      events,
    });
    const executor = new ToolExecutor(
      new ToolRegistry().register(echoTool),
      new FakeExecutionEnvironment(),
      session,
    );
    const observation = await executor.execute(makeAction({ toolName: 'missing' }));

    expect(observation.toolResult.status).toBe('error');
    expect(events.events.map((e) => e.type)).toEqual(['TOOL_STARTED', 'TOOL_FAILED']);
    expect(events.ofType('TOOL_FAILED')[0]?.payload.errorCode).toBe('unknown_tool');
    expect(events.ofType('TOOL_FAILED')[0]?.correlation.observationId).toBe(
      observation.observationId,
    );
    expect(session.usage.snapshot.toolCalls).toBe(1);
  });
});
