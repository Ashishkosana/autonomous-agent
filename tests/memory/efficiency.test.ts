import { describe, expect, it } from 'vitest';
import {
  EFFICIENCY_MEASUREMENT_NOTE,
  compareEfficiency,
} from '../../src/agent/runtime/efficiency.js';
import type { RunMetricsRecord } from '../../src/memory/run-metrics.js';

function metrics(overrides: Partial<RunMetricsRecord> = {}): RunMetricsRecord {
  return {
    runId: 'run-cold',
    goalStatement: 'same goal',
    status: 'completed',
    succeeded: true,
    iterations: 4,
    toolCalls: 6,
    modelCalls: 8,
    inputTokens: 100,
    outputTokens: 40,
    totalTokens: 140,
    retrievalHitRate: 0,
    retrievalHitCount: 0,
    signalsUsed: ['metadata', 'keyword'],
    citedRecordIds: [],
    retrievedRecordIds: [],
    ...overrides,
  };
}

describe('efficiency comparison', () => {
  it('meets the mechanical condition when the warm run uses fewer iterations', () => {
    const comparison = compareEfficiency(
      metrics(),
      metrics({ runId: 'run-warm', iterations: 2, toolCalls: 6, retrievalHitRate: 1 }),
    );
    expect(comparison.fewerIterations).toBe(true);
    expect(comparison.fewerToolCalls).toBe(false);
    expect(comparison.mechanicalConditionMet).toBe(true);
    expect(comparison.note).toBe(EFFICIENCY_MEASUREMENT_NOTE);
    expect(comparison.note).toContain('does not train foundation-model weights');
  });

  it('meets the condition when iterations stay the same but a retrieved record is cited', () => {
    const comparison = compareEfficiency(
      metrics(),
      metrics({
        runId: 'run-warm',
        iterations: 4,
        toolCalls: 6,
        citedRecordIds: ['mem-1', 'mem-other'],
        retrievedRecordIds: ['mem-1'],
        retrievalHitRate: 1,
      }),
    );
    expect(comparison.fewerIterations).toBe(false);
    expect(comparison.fewerToolCalls).toBe(false);
    expect(comparison.warmCitedRetrievedRecord).toBe(true);
    expect(comparison.citedRetrievedRecordIds).toEqual(['mem-1']);
    expect(comparison.mechanicalConditionMet).toBe(true);
  });

  it('does not meet the condition when the warm run fails, even if it cited a retrieved record', () => {
    const comparison = compareEfficiency(
      metrics(),
      metrics({
        runId: 'run-warm',
        status: 'failed',
        succeeded: false,
        iterations: 1,
        toolCalls: 1,
        citedRecordIds: ['mem-1'],
        retrievedRecordIds: ['mem-1'],
      }),
    );
    expect(comparison.mechanicalConditionMet).toBe(false);
  });

  it('does not meet the condition when the warm run costs more and cites nothing it retrieved', () => {
    const comparison = compareEfficiency(
      metrics(),
      metrics({
        runId: 'run-warm',
        iterations: 5,
        toolCalls: 7,
        citedRecordIds: ['mem-not-retrieved'],
        retrievedRecordIds: ['mem-1'],
      }),
    );
    expect(comparison.warmCitedRetrievedRecord).toBe(false);
    expect(comparison.mechanicalConditionMet).toBe(false);
  });

  it('does not compare runs of different goals', () => {
    const comparison = compareEfficiency(
      metrics(),
      metrics({ runId: 'run-warm', goalStatement: 'other goal', iterations: 1, toolCalls: 1 }),
    );
    expect(comparison.sameGoal).toBe(false);
    expect(comparison.mechanicalConditionMet).toBe(false);
  });

  it('treats fewer tokens as information and not as the mechanical condition', () => {
    const comparison = compareEfficiency(
      metrics(),
      metrics({
        runId: 'run-warm',
        iterations: 4,
        toolCalls: 6,
        totalTokens: 10,
        inputTokens: 8,
        outputTokens: 2,
      }),
    );
    expect(comparison.fewerTokens).toBe(true);
    expect(comparison.mechanicalConditionMet).toBe(false);
  });
});
