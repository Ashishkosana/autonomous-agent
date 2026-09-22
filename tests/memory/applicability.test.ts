import { describe, expect, it } from 'vitest';
import { OutcomeLearner } from '../../src/agent/learner.js';
import { renderMemory, presentedMemory } from '../../src/agent/prompting.js';
import {
  asEvaluationId,
  asGoalId,
  asMemoryRecordId,
  asObservationId,
  asRetrievalId,
  asRunId,
} from '../../src/domain/ids.js';
import { assessPreconditions, preconditionsFromToolCall } from '../../src/memory/applicability.js';
import type { ExperienceRecord } from '../../src/memory/records.js';
import { UNVALIDATED } from '../../src/memory/records.js';
import { FixedClock, SequentialIdGenerator } from '../support/deterministic.js';
import { CORRELATION, makeAction, makePlan } from '../support/fixtures.js';
import { experience } from '../support/memory-store-contract.js';

describe('preconditions', () => {
  it('records file_exists for fs.read and nothing for fs.write', () => {
    expect(preconditionsFromToolCall('fs.read', { path: '/workspace/report.md' })).toEqual([
      { kind: 'file_exists', path: '/workspace/report.md' },
    ]);
    expect(
      preconditionsFromToolCall('fs.write', { path: '/workspace/report.md', content: 'x' }),
    ).toEqual([]);
  });

  it('reports a fresh sandbox as a violated file precondition', async () => {
    const report = await assessPreconditions(
      [{ kind: 'file_exists', path: '/workspace/report.md' }],
      {
        fileExists: async () => false,
        toolNames: ['fs.read', 'fs.write'],
        environmentProvider: 'fake',
      },
    );
    expect(report.status).toBe('violated');
    expect(report.checks[0]?.evidence).toContain('does not exist');
  });

  it('the learner stores the fs.read precondition and does not touch validation counters', async () => {
    const learner = new OutcomeLearner(new SequentialIdGenerator(), new FixedClock());
    const action = makeAction({
      toolName: 'fs.read',
      input: { path: '/workspace/report.md' },
    });
    const result = await learner.learn({
      correlation: CORRELATION,
      task: makePlan().tasks[0]!,
      attempt: {
        action,
        observation: {
          observationId: asObservationId('obs-1'),
          actionId: action.actionId,
          correlation: CORRELATION,
          toolResult: {
            status: 'ok',
            toolName: 'fs.read',
            actionId: action.actionId,
            output: { path: '/workspace/report.md', content: 'x' },
            startedAt: 't',
            finishedAt: 't',
            durationMs: 1,
          },
          artifacts: [],
          summary: 'read',
          observedAt: 't',
        },
        evaluation: {
          evaluationId: asEvaluationId('eval-1'),
          correlation: CORRELATION,
          verdict: 'inconclusive',
          checks: [],
          gaps: [],
          summary: 'inconclusive',
          toolStatus: 'ok',
          derivedFrom: {},
          evaluatedAt: 't',
        },
      },
      previousAttempts: [],
    });
    expect(result.experience.outcome).toBe('inconclusive');
    expect(result.experience.preconditions).toEqual([
      { kind: 'file_exists', path: '/workspace/report.md' },
    ]);
    expect(result.lessons).toEqual([]);
  });

  it('a prompt flags violated preconditions and does not call that causation', () => {
    const stale: ExperienceRecord = {
      ...experience,
      recordId: asMemoryRecordId('mem-stale'),
      summary: 'fs.read for the research report succeeded',
      toolName: 'fs.read',
      outcome: 'success',
      preconditions: [{ kind: 'file_exists', path: '/workspace/report.md' }],
    };
    const rendered = renderMemory(
      presentedMemory([
        {
          retrievalId: asRetrievalId('ret-1'),
          query: {
            retrievalId: asRetrievalId('ret-1'),
            text: 'report',
            kinds: ['experience'],
            limit: 1,
            correlation: { runId: asRunId('run-1'), goalId: asGoalId('goal-1') },
          },
          hits: [
            {
              record: stale,
              score: 1,
              matchedBy: ['keyword'],
              applicability: {
                status: 'violated',
                checks: [
                  {
                    precondition: { kind: 'file_exists', path: '/workspace/report.md' },
                    status: 'violated',
                    evidence: '/workspace/report.md does not exist in this environment',
                  },
                ],
              },
            },
          ],
          signalsUsed: ['keyword'],
          startedAt: 't',
          finishedAt: 't',
          durationMs: 0,
        },
      ]),
    );
    expect(rendered).toContain('PRECONDITION VIOLATED');
    expect(rendered).toContain('does not exist');
    expect(rendered).not.toContain('caused');
    expect(UNVALIDATED.timesConfirmed).toBe(0);
  });
});
