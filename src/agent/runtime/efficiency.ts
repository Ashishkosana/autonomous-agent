import type { AnyAgentEvent } from '../../events/contracts.js';
import type { OpenedMemory } from '../../memory/opened-memory.js';
import type { RunMetricsRecord } from '../../memory/run-metrics.js';
import type { RunState } from '../../domain/run.js';
import { trajectoryFromEvents } from './trajectory.js';

/**
 * Measurement note printed with every comparison. The condition below is a
 * boolean check on measured counters. It is not a learning score and it is
 * not evidence that a retrieved record caused the later run.
 */
export const EFFICIENCY_MEASUREMENT_NOTE =
  'Measured from the two runs. Not a learning score, and not evidence that memory caused the difference. This system does not train foundation-model weights.';

export interface MeasuredRun {
  readonly metrics: RunMetricsRecord;
  /** Empty when this database has no earlier metrics for the same goal. */
  readonly comparisonLines: readonly string[];
}

export interface EfficiencyComparison {
  readonly cold: RunMetricsRecord;
  readonly warm: RunMetricsRecord;
  readonly sameGoal: boolean;
  readonly fewerIterations: boolean;
  readonly fewerToolCalls: boolean;
  readonly fewerTokens: boolean;
  /** Latest run finished in less wall-clock time. Reported, not scored. */
  readonly shorterDuration: boolean;
  /** Warm cited a record id that its own retrieval returned. */
  readonly warmCitedRetrievedRecord: boolean;
  readonly citedRetrievedRecordIds: readonly string[];
  readonly warmSucceeded: boolean;
  /**
   * Warm passed its mechanical criteria, and either used fewer iterations,
   * or fewer tool calls, or cited a record it retrieved. Same goal required.
   */
  readonly mechanicalConditionMet: boolean;
  readonly note: string;
}

export function efficiencyFromRun(
  state: RunState,
  events: readonly AnyAgentEvent[],
  goalStatement: string,
): RunMetricsRecord {
  const trajectory = trajectoryFromEvents(events);
  const ran = trajectory.retrievals.filter((retrieval) => retrieval.suppressed !== 'memory_off');
  const hitCount = ran.reduce((sum, retrieval) => sum + retrieval.hitCount, 0);
  const signals = [...new Set(ran.flatMap((retrieval) => retrieval.signalsUsed))];
  const retrieved = [...new Set(ran.flatMap((retrieval) => retrieval.recordIds))];
  return {
    runId: state.runId,
    goalStatement,
    status: state.status,
    succeeded: state.status === 'completed',
    iterations: state.usage.iterations,
    toolCalls: state.usage.toolCalls,
    modelCalls: state.usage.modelCalls,
    inputTokens: state.usage.inputTokens,
    outputTokens: state.usage.outputTokens,
    totalTokens: state.usage.inputTokens + state.usage.outputTokens,
    durationMs: wallDurationMs(state.startedAt, state.finishedAt),
    retrievalHitRate:
      ran.length === 0
        ? null
        : ran.filter((retrieval) => retrieval.hitCount > 0).length / ran.length,
    retrievalHitCount: hitCount,
    signalsUsed: signals,
    citedRecordIds: [...trajectory.citedMemoryRecordIds],
    retrievedRecordIds: retrieved,
  };
}

export function compareEfficiency(
  cold: RunMetricsRecord,
  warm: RunMetricsRecord,
): EfficiencyComparison {
  const citedRetrievedRecordIds = warm.citedRecordIds.filter((id) =>
    warm.retrievedRecordIds.includes(id),
  );
  const sameGoal = cold.goalStatement === warm.goalStatement;
  const fewerIterations = warm.iterations < cold.iterations;
  const fewerToolCalls = warm.toolCalls < cold.toolCalls;
  const fewerTokens = warm.totalTokens < cold.totalTokens;
  const shorterDuration = warm.durationMs < cold.durationMs;
  const warmCitedRetrievedRecord = citedRetrievedRecordIds.length > 0;
  const warmSucceeded = warm.succeeded;
  return {
    cold,
    warm,
    sameGoal,
    fewerIterations,
    fewerToolCalls,
    fewerTokens,
    shorterDuration,
    warmCitedRetrievedRecord,
    citedRetrievedRecordIds,
    warmSucceeded,
    mechanicalConditionMet:
      sameGoal && warmSucceeded && (fewerIterations || fewerToolCalls || warmCitedRetrievedRecord),
    note: EFFICIENCY_MEASUREMENT_NOTE,
  };
}

export function formatEfficiencyLines(snapshot: RunMetricsRecord): readonly string[] {
  const rate =
    snapshot.retrievalHitRate === null ? 'not run' : snapshot.retrievalHitRate.toFixed(2);
  return [
    `Duration: ${snapshot.durationMs} ms`,
    `Retrieval hit rate: ${rate} (${snapshot.retrievalHitCount} hits)`,
    `Signals: ${snapshot.signalsUsed.join(', ') || 'none'}`,
    `Retrieved records: ${snapshot.retrievedRecordIds.join(', ') || 'none'}`,
    `Cited records: ${snapshot.citedRecordIds.join(', ') || 'none'}`,
  ];
}

export function formatComparisonLines(comparison: EfficiencyComparison): readonly string[] {
  const line = (snapshot: RunMetricsRecord, label: string) =>
    `${label}: status ${snapshot.status}, iterations ${snapshot.iterations}, tool calls ${snapshot.toolCalls}, tokens ${snapshot.totalTokens}, duration ${snapshot.durationMs} ms, retrieval hit rate ${snapshot.retrievalHitRate === null ? 'not run' : snapshot.retrievalHitRate.toFixed(2)}`;
  return [
    'Efficiency comparison (measurement, not a score)',
    line(comparison.cold, 'Cold'),
    line(comparison.warm, 'Warm'),
    `Same goal: ${comparison.sameGoal}`,
    `Fewer iterations: ${comparison.fewerIterations}`,
    `Fewer tool calls: ${comparison.fewerToolCalls}`,
    `Fewer tokens: ${comparison.fewerTokens}`,
    `Shorter duration: ${comparison.shorterDuration}`,
    `Warm cited a retrieved record: ${comparison.warmCitedRetrievedRecord}`,
    `Warm passed criteria: ${comparison.warmSucceeded}`,
    `Mechanical condition met: ${comparison.mechanicalConditionMet}`,
    comparison.note,
  ];
}

/**
 * The two latest stored runs of one goal. Cold is the earlier of those two;
 * warm is the latest. Fewer than two rows is a report, not an error.
 */
export async function compareStoredRuns(
  memory: OpenedMemory,
  goalStatement: string,
): Promise<{
  readonly goalStatement: string;
  readonly runs: readonly RunMetricsRecord[];
  readonly comparison?: EfficiencyComparison;
  readonly lines: readonly string[];
}> {
  if (!memory.listEfficiency) {
    return {
      goalStatement,
      runs: [],
      lines: ['This memory backend does not store run metrics.'],
    };
  }
  const runs = await memory.listEfficiency({ goalStatement, limit: 2 });
  if (runs.length < 2) {
    return {
      goalStatement,
      runs,
      lines: [
        runs.length === 0
          ? 'No stored runs for this goal yet.'
          : 'One stored run for this goal. Run the same goal again to compare.',
      ],
    };
  }
  const warm = runs[0];
  const cold = runs[1];
  if (!warm || !cold) {
    return { goalStatement, runs, lines: ['No stored runs for this goal yet.'] };
  }
  const comparison = compareEfficiency(cold, warm);
  return { goalStatement, runs, comparison, lines: formatComparisonLines(comparison) };
}

function wallDurationMs(startedAt: string, finishedAt: string | undefined): number {
  if (!finishedAt) return 0;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round(end - start));
}
