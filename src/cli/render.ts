import type { RunState } from '../domain/run.js';
import type { AnyAgentEvent } from '../events/contracts.js';

const CLIP = 400;

/**
 * Text for one real runtime event. Returns nothing for high-volume telemetry
 * that the closing summary already reports (successful model calls, the
 * retrieval query — which is the goal text). It never fabricates a step.
 */
export function renderEvent(event: AnyAgentEvent): readonly string[] {
  switch (event.type) {
    case 'GOAL_RECEIVED':
      return ['', 'GOAL', clip(event.payload.statement, 2_000)];
    case 'MEMORY_RETRIEVED': {
      if (event.payload.suppressed === 'memory_off') {
        return [
          '',
          '🧠 MEMORY',
          'Retrieval suppressed (memory off). No store read and no query embedding.',
        ];
      }
      const kinds = event.payload.kinds.length > 0 ? event.payload.kinds.join(', ') : 'none';
      const lines = [
        '',
        '🧠 MEMORY',
        `Retrieved ${event.payload.hitCount} records · ${kinds} · ${event.payload.durationMs} ms · signals ${event.payload.signalsUsed.join(', ') || 'none'}`,
      ];
      for (const hit of event.payload.hits ?? []) {
        const rank = hit.finalRank === null ? '?' : String(hit.finalRank);
        lines.push(`- ${hit.recordId} · rank ${rank} · score ${hit.score.toFixed(3)}`);
      }
      if (event.payload.degraded.length > 0) {
        lines.push(
          `Degraded: ${event.payload.degraded.map((item) => `${item.signal} (${item.reason})`).join('; ')}`,
        );
      }
      return lines;
    }
    case 'MEMORY_PRESENTED': {
      const lines = [`Presented ${event.payload.recordIds.length} records to the planner`];
      if (event.payload.violatedRecordIds.length > 0) {
        lines.push(`PRECONDITION VIOLATED: ${event.payload.violatedRecordIds.join(', ')}`);
      }
      return lines;
    }
    case 'PLAN_CREATED':
      return [
        '',
        '📋 PLAN',
        `Strategy: ${clip(event.payload.strategySummary)}`,
        `Tasks: ${event.payload.taskCount}`,
        `Cited prior records: ${listed(event.payload.informedByMemoryRecordIds)}`,
      ];
    case 'PLAN_UPDATED':
      return [
        '',
        '📋 PLAN REVISED',
        `Reason: ${clip(event.payload.reason)}`,
        `Tasks: ${event.payload.taskCount}`,
        `Cited prior records: ${listed(event.payload.informedByMemoryRecordIds ?? [])}`,
      ];
    case 'DECISION_CREATED':
      return [`Decision: ${clip(event.payload.summary)}`];
    case 'TOOL_SELECTED':
      return [
        '',
        '⚡ ACTION',
        event.payload.toolName,
        `Intent: ${clip(event.payload.intent)}`,
        ...(event.payload.inputSummary ? [`Input: ${clip(event.payload.inputSummary)}`] : []),
      ];
    case 'TOOL_STARTED':
      return [`Tool started: ${event.payload.toolName}`];
    case 'TOOL_COMPLETED':
      return ['👁 OBSERVATION', clip(event.payload.summary)];
    case 'TOOL_FAILED':
      return [
        '👁 OBSERVATION',
        `${event.payload.toolName} failed (${event.payload.errorCode}): ${clip(event.payload.message)}`,
      ];
    case 'COMMAND_STARTED':
      return [`Command: ${clip(event.payload.command)}`];
    case 'COMMAND_OUTPUT':
      return [`${event.payload.stream}: ${clip(event.payload.chunk)}`];
    case 'COMMAND_FINISHED':
      return [
        `Command finished: exit ${event.payload.exitCode ?? 'none'} · ${event.payload.durationMs} ms${event.payload.timedOut ? ' · timed out' : ''}`,
      ];
    case 'FILE_CREATED':
      return [`File created: ${event.payload.path}`];
    case 'FILE_CHANGED':
      return [`File changed: ${event.payload.path}`];
    case 'FILE_DELETED':
      return [`File deleted: ${event.payload.path}`];
    case 'EVALUATION_COMPLETED':
      return [
        '',
        '🔍 EVALUATION',
        `${event.payload.verdict} — ${event.payload.summary}`,
        ...(event.payload.evaluatorName ? [`Evaluator: ${event.payload.evaluatorName}`] : []),
      ];
    case 'FAILURE_DETECTED':
      return [`Failure (${event.payload.source}): ${clip(event.payload.summary)}`];
    case 'RETRY_STARTED':
      return ['', '↻ RETRY', `Attempt ${event.payload.attempt}`];
    case 'STRATEGY_CHANGED':
      return [
        '',
        '🔄 STRATEGY CHANGE',
        clip(event.payload.summary),
        `Reason: ${clip(event.payload.reason)}`,
      ];
    case 'LESSON_CREATED':
      return [`Lesson: ${clip(event.payload.statement)}`];
    case 'MEMORY_WRITTEN':
      return [`Memory written · ${event.payload.kind} · ${clip(event.payload.summary)}`];
    case 'KNOWLEDGE_INGESTED':
      return [`Knowledge ingested · ${clip(event.payload.title)} · ${event.payload.source}`];
    case 'ARTIFACT_STORED':
      return [`Artifact stored: ${event.payload.sandboxPath}`];
    case 'GOAL_COMPLETED':
      return ['', '🔥 COMPLETED', clip(event.payload.summary, 2_000)];
    case 'GOAL_FAILED':
      return ['', '🔥 STOPPED', `${event.payload.cause}: ${clip(event.payload.reason, 2_000)}`];
    case 'RUN_LIMIT_REACHED':
      return [
        '',
        '🔥 LIMIT',
        `${event.payload.limit} reached (${event.payload.value}/${event.payload.max})`,
      ];
    case 'MODEL_CALL_FAILED':
      return [
        `Model call failed · ${event.payload.purpose} · ${event.payload.errorKind}: ${clip(event.payload.message)}`,
      ];
    case 'MEMORY_SEARCH_STARTED':
    case 'MODEL_CALL_STARTED':
    case 'MODEL_CALL_COMPLETED':
    case 'BROWSER_NAVIGATION':
      return [];
    default: {
      const unexpected: never = event;
      return unexpected;
    }
  }
}

/** Closing totals from the run state. These counters are the runtime's, not a score. */
export function formatRunSummary(state: RunState): readonly string[] {
  const usage = state.usage;
  const tokens = usage.inputTokens + usage.outputTokens;
  const duration =
    state.finishedAt !== undefined
      ? Date.parse(state.finishedAt) - Date.parse(state.startedAt)
      : undefined;
  return [
    '',
    `Status: ${state.status}`,
    ...(state.terminationReason ? [`Reason: ${clip(state.terminationReason, 2_000)}`] : []),
    `Iterations: ${usage.iterations}`,
    `Model calls: ${usage.modelCalls}`,
    `Tool calls: ${usage.toolCalls}`,
    `Retries: ${usage.retries}`,
    `Strategy changes: ${usage.strategyChanges}`,
    `Tokens: ${tokens} (${usage.inputTokens} in, ${usage.outputTokens} out)`,
    `Memory reads: ${usage.memoryReads}`,
    `Memory writes: ${usage.memoryWrites}`,
    ...(duration !== undefined && Number.isFinite(duration) ? [`Duration: ${duration} ms`] : []),
  ];
}

export class TerminalEventRenderer {
  constructor(private readonly write: (line: string) => void) {}

  handle(event: AnyAgentEvent): void {
    for (const line of renderEvent(event)) this.write(line);
  }
}

function listed(ids: readonly string[]): string {
  return ids.length > 0 ? ids.join(', ') : 'none';
}

function clip(text: string, limit = CLIP): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}
