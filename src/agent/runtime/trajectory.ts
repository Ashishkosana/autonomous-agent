import type { AnyAgentEvent } from '../../events/contracts.js';

/**
 * A run reconstructed from its event log. Enough to compare two runs later.
 * It does not claim that a cited memory caused the following action.
 */
export interface TrajectoryStep {
  index: number;
  taskId?: string;
  actionId?: string;
  toolName?: string;
  intent?: string;
  attempt?: number;
  inputSummary?: string;
  observationSummary?: string;
  toolStatus?: 'ok' | 'error';
  evaluationId?: string;
  verdict?: string;
  evaluatorName?: string;
  checksPassed?: number;
  checksTotal?: number;
  gaps?: number;
}

export interface RunTrajectory {
  readonly runId: string;
  readonly goalStatement?: string;
  readonly finalStatus?: 'completed' | 'failed' | 'limit_reached';
  readonly finalSummary?: string;
  readonly retrievals: readonly {
    readonly retrievalId: string;
    readonly hitCount: number;
    readonly recordIds: readonly string[];
    readonly signalsUsed: readonly string[];
    readonly suppressed?: 'memory_off';
    readonly presentedRecordIds: readonly string[];
    readonly violatedRecordIds: readonly string[];
  }[];
  readonly citedMemoryRecordIds: readonly string[];
  readonly steps: readonly TrajectoryStep[];
  readonly retries: number;
  readonly strategyChanges: number;
  readonly memoryWrites: number;
  readonly modelCalls: number;
  readonly modelFailures: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
}

export function trajectoryFromEvents(events: readonly AnyAgentEvent[]): RunTrajectory {
  const first = events[0];
  const retrievals: RunTrajectory['retrievals'][number][] = [];
  const presentedByRetrieval = new Map<string, { presented: string[]; violated: string[] }>();
  const cited = new Set<string>();
  const steps: TrajectoryStep[] = [];
  let goalStatement: string | undefined;
  let finalStatus: RunTrajectory['finalStatus'];
  let finalSummary: string | undefined;
  let retries = 0;
  let strategyChanges = 0;
  let memoryWrites = 0;
  let modelCalls = 0;
  let modelFailures = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let latencyMs = 0;

  for (const event of events) {
    switch (event.type) {
      case 'GOAL_RECEIVED':
        goalStatement = event.payload.statement;
        break;
      case 'MEMORY_RETRIEVED':
        retrievals.push({
          retrievalId: event.payload.retrievalId,
          hitCount: event.payload.hitCount,
          recordIds: [...event.payload.recordIds],
          signalsUsed: [...event.payload.signalsUsed],
          ...(event.payload.suppressed ? { suppressed: event.payload.suppressed } : {}),
          presentedRecordIds: [],
          violatedRecordIds: [],
        });
        break;
      case 'MEMORY_PRESENTED':
        presentedByRetrieval.set(event.payload.retrievalId, {
          presented: [...event.payload.recordIds],
          violated: [...event.payload.violatedRecordIds],
        });
        break;
      case 'PLAN_CREATED':
        for (const id of event.payload.informedByMemoryRecordIds) cited.add(id);
        break;
      case 'PLAN_UPDATED':
        for (const id of event.payload.informedByMemoryRecordIds ?? []) cited.add(id);
        break;
      case 'TOOL_SELECTED':
        steps.push({
          index: steps.length,
          ...(event.correlation.taskId !== undefined ? { taskId: event.correlation.taskId } : {}),
          ...(event.correlation.actionId !== undefined
            ? { actionId: event.correlation.actionId }
            : {}),
          toolName: event.payload.toolName,
          intent: event.payload.intent,
          attempt: event.payload.attempt,
          ...(event.payload.inputSummary !== undefined
            ? { inputSummary: event.payload.inputSummary }
            : {}),
        });
        break;
      case 'TOOL_COMPLETED': {
        const step = stepFor(steps, event.correlation.actionId);
        if (step) {
          step.observationSummary = event.payload.summary;
          step.toolStatus = 'ok';
        }
        break;
      }
      case 'TOOL_FAILED': {
        const step = stepFor(steps, event.correlation.actionId);
        if (step) {
          step.observationSummary = event.payload.message;
          step.toolStatus = 'error';
        }
        break;
      }
      case 'EVALUATION_COMPLETED': {
        const step = stepFor(steps, event.correlation.actionId) ?? steps.at(-1);
        if (step && step.evaluationId === undefined) {
          step.evaluationId = event.payload.evaluationId;
          step.verdict = event.payload.verdict;
          step.checksPassed = event.payload.checksPassed;
          step.checksTotal = event.payload.checksTotal;
          step.gaps = event.payload.gapCount;
          if (event.payload.evaluatorName) step.evaluatorName = event.payload.evaluatorName;
        }
        break;
      }
      case 'RETRY_STARTED':
        retries += 1;
        break;
      case 'STRATEGY_CHANGED':
        strategyChanges += 1;
        break;
      case 'MEMORY_WRITTEN':
        memoryWrites += 1;
        break;
      case 'MODEL_CALL_COMPLETED':
        modelCalls += 1;
        inputTokens += event.payload.inputTokens;
        outputTokens += event.payload.outputTokens;
        latencyMs += event.payload.latencyMs;
        break;
      case 'MODEL_CALL_FAILED':
        modelCalls += 1;
        modelFailures += 1;
        latencyMs += event.payload.latencyMs;
        break;
      case 'GOAL_COMPLETED':
        finalStatus = 'completed';
        finalSummary = event.payload.summary;
        break;
      case 'GOAL_FAILED':
        finalStatus = 'failed';
        finalSummary = event.payload.reason;
        break;
      case 'RUN_LIMIT_REACHED':
        finalStatus = 'limit_reached';
        finalSummary = `${event.payload.limit} ${event.payload.value}/${event.payload.max}`;
        break;
      default:
        break;
    }
  }

  return {
    runId: first?.runId ?? '',
    ...(goalStatement !== undefined ? { goalStatement } : {}),
    ...(finalStatus !== undefined ? { finalStatus } : {}),
    ...(finalSummary !== undefined ? { finalSummary } : {}),
    retrievals: retrievals.map((retrieval) => {
      const presented = presentedByRetrieval.get(retrieval.retrievalId);
      return presented
        ? {
            ...retrieval,
            presentedRecordIds: presented.presented,
            violatedRecordIds: presented.violated,
          }
        : retrieval;
    }),
    citedMemoryRecordIds: [...cited],
    steps,
    retries,
    strategyChanges,
    memoryWrites,
    modelCalls,
    modelFailures,
    inputTokens,
    outputTokens,
    latencyMs,
  };
}

function stepFor(
  steps: TrajectoryStep[],
  actionId: string | undefined,
): TrajectoryStep | undefined {
  if (!actionId) return undefined;
  return [...steps].reverse().find((step) => step.actionId === actionId);
}
