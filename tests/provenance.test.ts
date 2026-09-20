import { describe, expect, it } from 'vitest';
import type { Action } from '../src/domain/action.js';
import {
  asActionId,
  asDecisionId,
  asEvaluationId,
  asLessonId,
  asMemoryRecordId,
  asObservationId,
  asPlanId,
  asRetrievalId,
  asStrategyId,
} from '../src/domain/ids.js';
import type { Observation } from '../src/domain/observation.js';
import type { Plan } from '../src/domain/plan.js';
import { isEmptyProvenance, mergeProvenance } from '../src/domain/provenance.js';
import type { EvaluationResult } from '../src/evaluation/contracts.js';
import type { DecisionRecord, LessonRecord } from '../src/memory/records.js';
import { UNVALIDATED } from '../src/memory/records.js';
import { CORRELATION, GOAL_ID, RUN_ID, TASK_ID } from './support/fixtures.js';

const T = '2026-01-01T00:00:00.000Z';

describe('provenance helpers', () => {
  it('merges and de-duplicates identifiers per field, dropping empty fields', () => {
    const a = asActionId('act-1');
    const merged = mergeProvenance(
      { actionIds: [a], retrievalIds: [asRetrievalId('ret-1')] },
      { actionIds: [a, asActionId('act-2')] },
      {},
    );
    expect(merged).toEqual({
      retrievalIds: ['ret-1'],
      actionIds: ['act-1', 'act-2'],
    });
    expect(isEmptyProvenance(mergeProvenance({}, { lessonIds: [] }))).toBe(true);
  });
});

describe('the full learning chain is representable and traversable by ids', () => {
  const retrievalId = asRetrievalId('ret-1');
  const retrievedRecordId = asMemoryRecordId('exp-prev');

  const plan: Plan = {
    planId: asPlanId('plan-1'),
    runId: RUN_ID,
    goalId: GOAL_ID,
    version: 1,
    strategy: { strategyId: asStrategyId('strat-1'), summary: 'virtualenv first', version: 1 },
    tasks: [
      {
        taskId: TASK_ID,
        description: 'install',
        status: 'pending',
        dependsOn: [],
        expectedEvidence: [],
      },
    ],
    informedBy: { retrievalIds: [retrievalId], memoryRecordIds: [retrievedRecordId] },
    createdAt: T,
  };

  const decision: DecisionRecord = {
    recordId: asMemoryRecordId('dec-rec-1'),
    kind: 'decision',
    decisionId: asDecisionId('dec-1'),
    runId: RUN_ID,
    goalId: GOAL_ID,
    taskId: TASK_ID,
    createdAt: T,
    summary: 'Use virtualenv',
    tags: ['python'],
    provenance: {
      planIds: [plan.planId],
      retrievalIds: [retrievalId],
      memoryRecordIds: [retrievedRecordId],
    },
    context: 'Need to install a python package',
    optionsConsidered: [
      {
        optionId: 'system-pip',
        description: 'pip install at system level',
        assessment: 'failed last run',
      },
      {
        optionId: 'venv',
        description: 'create venv then pip install',
        assessment: 'succeeded last run',
      },
    ],
    selectedOptionId: 'venv',
    evidence: [{ description: 'previous experience', memoryRecordId: retrievedRecordId }],
    reason: 'Prior experience shows system pip fails in the sandbox',
    confidence: 0.8,
    outcome: 'pending',
    lessonIds: [],
  };

  const action: Action = {
    actionId: asActionId('act-1'),
    correlation: CORRELATION,
    planId: plan.planId,
    decisionId: decision.decisionId,
    toolName: 'terminal',
    input: { command: 'python -m venv .venv && .venv/bin/pip install pypdf' },
    attempt: 1,
    intent: 'Install pypdf inside a virtualenv',
    derivedFrom: { planIds: [plan.planId], decisionIds: [decision.decisionId] },
    requestedAt: T,
  };

  const observation: Observation = {
    observationId: asObservationId('obs-1'),
    actionId: action.actionId,
    correlation: CORRELATION,
    toolResult: {
      status: 'ok',
      toolName: 'terminal',
      actionId: action.actionId,
      output: { exitCode: 0 },
      startedAt: T,
      finishedAt: T,
      durationMs: 5,
    },
    artifacts: [],
    summary: 'install exit 0',
    observedAt: T,
  };

  const evaluation: EvaluationResult = {
    evaluationId: asEvaluationId('eval-1'),
    correlation: CORRELATION,
    verdict: 'success',
    checks: [
      {
        name: 'import works',
        passed: true,
        method: 'command_check',
        evidence: 'python -c "import pypdf" exit 0',
      },
    ],
    gaps: [],
    summary: 'installed',
    toolStatus: 'ok',
    derivedFrom: { actionIds: [action.actionId], observationIds: [observation.observationId] },
    evaluatedAt: T,
  };

  const newLesson: LessonRecord = {
    recordId: asMemoryRecordId('les-rec-1'),
    kind: 'lesson',
    lessonId: asLessonId('lesson-2'),
    runId: RUN_ID,
    goalId: GOAL_ID,
    taskId: TASK_ID,
    createdAt: T,
    summary: 'virtualenv install confirmed',
    statement: 'Virtualenv-based installs work reliably in the sandbox.',
    applicability: ['python', 'install'],
    tags: ['python'],
    confidence: 0.9,
    validation: UNVALIDATED,
    provenance: mergeProvenance(
      { evaluationIds: [evaluation.evaluationId] },
      evaluation.derivedFrom,
      { decisionIds: [decision.decisionId] },
      decision.provenance,
    ),
  };

  it('walks lesson → evaluation → observation → action → decision → plan → retrieval → memory record', () => {
    expect(newLesson.provenance.evaluationIds).toEqual([evaluation.evaluationId]);
    expect(evaluation.derivedFrom.observationIds).toEqual([observation.observationId]);
    expect(observation.actionId).toBe(action.actionId);
    expect(action.decisionId).toBe(decision.decisionId);
    expect(decision.provenance.planIds).toEqual([plan.planId]);
    expect(plan.informedBy.retrievalIds).toEqual([retrievalId]);
    expect(plan.informedBy.memoryRecordIds).toEqual([retrievedRecordId]);
  });

  it('the lesson alone carries enough ids to reach the memory that started the chain', () => {
    expect(newLesson.provenance.retrievalIds).toEqual([retrievalId]);
    expect(newLesson.provenance.memoryRecordIds).toEqual([retrievedRecordId]);
    expect(newLesson.provenance.actionIds).toEqual([action.actionId]);
    expect(newLesson.provenance.planIds).toEqual([plan.planId]);
  });

  it('every record in the chain is placed in the same run/goal/task context', () => {
    for (const correlation of [
      action.correlation,
      observation.correlation,
      evaluation.correlation,
    ]) {
      expect(correlation).toEqual(CORRELATION);
    }
    expect(decision.taskId).toBe(TASK_ID);
    expect(newLesson.taskId).toBe(TASK_ID);
  });
});
