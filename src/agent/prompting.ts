import type { VerifiableCriterion } from '../domain/criteria.js';
import { collectCriteria } from '../domain/criteria.js';
import type { Goal } from '../domain/goal.js';
import type { Observation } from '../domain/observation.js';
import type { MemoryRecordId, RetrievalId } from '../domain/ids.js';
import type { Plan } from '../domain/plan.js';
import type { EvaluationResult } from '../evaluation/contracts.js';
import type { ApplicabilityReport } from '../memory/applicability.js';
import type { PersistentMemoryRecord } from '../memory/records.js';
import type { RetrievalResult } from '../memory/retrieval.js';
import type { ToolDescriptor } from '../tools/contracts.js';
import type { TaskAttempt } from './contracts.js';

/**
 * Plain-text rendering of runtime state for model prompts. Kept deliberately
 * simple and vendor-neutral. Everything rendered here is already observable
 * elsewhere (events, records); prompts never carry hidden state.
 */

export function renderGoal(goal: Goal): string {
  const lines = [`GOAL: ${goal.statement}`];
  if (goal.constraints.length > 0) lines.push(`CONSTRAINTS: ${goal.constraints.join('; ')}`);
  if (goal.successCriteria.length > 0) {
    lines.push(`SUCCESS CRITERIA: ${goal.successCriteria.join('; ')}`);
  }
  const checks = (goal.verifiableCriteria ?? []).map(formatCriterion);
  if (checks.length > 0) lines.push(`MUST PASS: ${checks.join('; ')}`);
  return lines.join('\n');
}

function formatCriterion(criterion: VerifiableCriterion): string {
  switch (criterion.kind) {
    case 'file_contains':
      return `file ${criterion.path} must contain ${JSON.stringify(criterion.marker)}`;
    case 'file_exists':
      return `file ${criterion.path} must exist`;
    case 'json_file':
      return `file ${criterion.path} must be JSON`;
    case 'command_exits_zero':
      return `command must exit 0: ${criterion.command}`;
    case 'http_status':
      return `HTTP status ${criterion.status}`;
    case 'tool_succeeded':
      return criterion.toolName === undefined
        ? 'the tool call must succeed'
        : `${criterion.toolName} must succeed`;
  }
}

/**
 * After a page fetch, the file criterion is still unmet. Say so before the
 * model spends another model call fetching the same URL.
 */
export function renderNextStepHint(goal: Goal, attempts: readonly TaskAttempt[]): string {
  const fetched = attempts.some(
    (attempt) =>
      attempt.action.toolName === 'web.fetch' && attempt.observation.toolResult.status === 'ok',
  );
  if (!fetched) return '';
  const wrote = attempts.some(
    (attempt) =>
      attempt.action.toolName === 'fs.write' && attempt.observation.toolResult.status === 'ok',
  );
  if (wrote) return '';
  const { criteria } = collectCriteria(goal.verifiableCriteria, goal.successCriteria);
  const file = criteria.find(
    (criterion) => criterion.kind === 'file_contains' || criterion.kind === 'file_exists',
  );
  const wantsFile = file !== undefined || /\b(write|lesson\.txt|fs\.write)\b/i.test(goal.statement);
  if (!wantsFile) return '';
  const target = file !== undefined ? file.path : 'the file named in the goal';
  const marker =
    file?.kind === 'file_contains' ? ` The file must contain ${JSON.stringify(file.marker)}.` : '';
  return `NEXT ACTION: call fs.write to create ${target}.${marker} The page text is in the observation above. Do not call web.fetch again.`;
}

export function renderRecentObservations(observations: readonly Observation[]): string {
  if (observations.length === 0) return '';
  return [
    'RECENT OBSERVATIONS:',
    ...observations.slice(-3).map((observation) => `- ${observation.summary}`),
  ].join('\n');
}

export function renderTools(tools: readonly ToolDescriptor[]): string {
  if (tools.length === 0) return 'TOOLS: none';
  return ['TOOLS:', ...tools.map((t) => `- ${t.name} (${t.family}): ${t.description}`)].join('\n');
}

/**
 * The memory records a model was actually shown. Only retrievals with at
 * least one hit count as "presented"; an empty retrieval informed nothing.
 */
export interface PresentedMemory {
  readonly retrievalIds: readonly RetrievalId[];
  readonly records: readonly PersistentMemoryRecord[];
  /** Keyed by record id. Only hits the runtime annotated carry a report. */
  readonly applicability: ReadonlyMap<string, ApplicabilityReport>;
}

export function presentedMemory(retrievals: readonly RetrievalResult[]): PresentedMemory {
  const retrievalIds: RetrievalId[] = [];
  const records: PersistentMemoryRecord[] = [];
  const applicability = new Map<string, ApplicabilityReport>();
  const seen = new Set<MemoryRecordId>();
  for (const retrieval of retrievals) {
    if (retrieval.hits.length === 0) continue;
    retrievalIds.push(retrieval.retrievalId);
    for (const hit of retrieval.hits) {
      if (hit.applicability) applicability.set(hit.record.recordId, hit.applicability);
      if (seen.has(hit.record.recordId)) continue;
      seen.add(hit.record.recordId);
      records.push(hit.record);
    }
  }
  return { retrievalIds, records, applicability };
}

export function renderMemory(memory: PresentedMemory): string {
  if (memory.records.length === 0) return 'RELEVANT MEMORY: none retrieved';
  return [
    'RELEVANT MEMORY (cite record ids you rely on):',
    ...memory.records.map(
      (r) =>
        `- [${r.recordId}] (${r.kind}) ${r.summary}${describeRecord(r)}${describeApplicability(memory.applicability.get(r.recordId))}`,
    ),
  ].join('\n');
}

/**
 * Knowledge content is untrusted text from the world and can be long; the
 * prompt gets an excerpt, quoted as data, never the whole record.
 */
const KNOWLEDGE_EXCERPT_CHARS = 400;

function describeApplicability(report: ApplicabilityReport | undefined): string {
  if (!report || report.status !== 'violated') return '';
  const failed = report.checks
    .filter((check) => check.status === 'violated')
    .map((check) => check.evidence);
  return ` — PRECONDITION VIOLATED (${failed.join('; ')}). This record may not apply to the current environment. It is not evidence that the same action will succeed now.`;
}

function describeRecord(record: PersistentMemoryRecord): string {
  switch (record.kind) {
    case 'knowledge': {
      const source = record.sources[0]?.url ?? record.sources[0]?.title;
      const excerpt =
        record.content.length > KNOWLEDGE_EXCERPT_CHARS
          ? `${record.content.slice(0, KNOWLEDGE_EXCERPT_CHARS)}…`
          : record.content;
      return ` — ${record.title}${source ? ` (source: ${source})` : ''}: "${excerpt.replace(/\s+/g, ' ')}"`;
    }
    case 'experience':
      return ` — outcome: ${record.outcome}`;
    case 'decision':
      return ` — chose: ${record.selectedOptionId}; ${record.reason}`;
    case 'lesson':
      return ` — ${record.statement}`;
  }
}

export function renderPlan(plan: Plan): string {
  return [
    `PLAN v${plan.version} — strategy: ${plan.strategy.summary}`,
    ...plan.tasks.map(
      (t) =>
        `- [${t.taskId}] (${t.status}) ${t.description} | evidence: ${t.expectedEvidence.join('; ')}`,
    ),
  ].join('\n');
}

export function renderEvaluation(evaluation: EvaluationResult): string {
  const checks = evaluation.checks.map(
    (c) => `  - ${c.passed ? 'PASS' : 'FAIL'} ${c.name}: ${c.evidence}`,
  );
  const gaps = evaluation.gaps.map((g) => `  - ${g}`);
  return [
    `EVALUATION ${evaluation.evaluationId}: ${evaluation.verdict} (tool status: ${evaluation.toolStatus})`,
    ...checks,
    ...(gaps.length > 0 ? ['  gaps:', ...gaps] : []),
  ].join('\n');
}

export function renderAttempts(attempts: readonly TaskAttempt[]): string {
  if (attempts.length === 0) return 'PREVIOUS ATTEMPTS: none';
  return [
    'PREVIOUS ATTEMPTS AT THIS TASK:',
    ...attempts.flatMap((a) => [
      `- attempt ${a.action.attempt}: ${a.action.toolName} — ${a.action.intent}`,
      `  observation: ${a.observation.summary}`,
      `  ${renderEvaluation(a.evaluation).split('\n').join('\n  ')}`,
    ]),
  ].join('\n');
}
