import type {
  ActionId,
  DecisionId,
  EvaluationId,
  GoalId,
  IsoTimestamp,
  LessonId,
  MemoryRecordId,
  ObservationId,
  RunId,
  TaskId,
} from '../domain/ids.js';
import type { Provenance } from '../domain/provenance.js';

/**
 * Persistent memory record kinds.
 *
 * The four logical memory categories are locked: working, knowledge,
 * experience, decision. Working memory is run-scoped and lives in
 * `working.ts`. The other three persist across runs and are modelled here,
 * together with `lesson`, the persistent output of the learning step.
 *
 * Field-level schemas below are OPEN and expected to change; the identifiers
 * and provenance fields are the parts we commit to keeping stable.
 */
export type PersistentMemoryKind = 'knowledge' | 'experience' | 'decision' | 'lesson';

export const PERSISTENT_MEMORY_KINDS: readonly PersistentMemoryKind[] = [
  'knowledge',
  'experience',
  'decision',
  'lesson',
];

interface MemoryRecordBase<TKind extends PersistentMemoryKind> {
  readonly recordId: MemoryRecordId;
  readonly kind: TKind;
  /** The run in which this record was written. */
  readonly runId: RunId;
  readonly goalId?: GoalId;
  readonly taskId?: TaskId;
  readonly createdAt: IsoTimestamp;
  /** One-line description used in retrieval hits and the dashboard. */
  readonly summary: string;
  /** Free-form labels used for metadata filtering during retrieval. */
  readonly tags: readonly string[];
  /** What this record was derived from. */
  readonly provenance: Provenance;
}

/** Where a piece of knowledge came from. */
export interface SourceReference {
  readonly url?: string;
  readonly title?: string;
  readonly toolName?: string;
  readonly retrievedAt: IsoTimestamp;
  readonly actionId?: ActionId;
}

export interface KnowledgeRecord extends MemoryRecordBase<'knowledge'> {
  readonly title: string;
  readonly content: string;
  readonly sources: readonly SourceReference[];
  /** 0..1 — how much the agent trusts this content. */
  readonly confidence: number;
}

export type ExperienceOutcome = 'success' | 'failure' | 'partial';

export interface ExperienceRecord extends MemoryRecordBase<'experience'> {
  readonly actionId: ActionId;
  readonly toolName: string;
  /** Brief description of what input was used (never the full raw payload). */
  readonly inputSummary: string;
  readonly observationId: ObservationId;
  /** The evaluation that judged this action, when one exists. */
  readonly evaluationId?: EvaluationId;
  readonly outcome: ExperienceOutcome;
  readonly attempt: number;
  readonly retryOf?: ActionId;
  /** True when this attempt used a different approach from the one it retried. */
  readonly changedApproach: boolean;
}

export interface DecisionOption {
  readonly optionId: string;
  readonly description: string;
  /** Why this option was or was not chosen. Concise, human-facing. */
  readonly assessment: string;
}

export interface EvidenceReference {
  readonly description: string;
  readonly memoryRecordId?: MemoryRecordId;
  readonly observationId?: ObservationId;
  readonly url?: string;
}

export type DecisionOutcome = 'pending' | 'succeeded' | 'failed' | 'inconclusive';

export interface DecisionRecord extends MemoryRecordBase<'decision'> {
  readonly decisionId: DecisionId;
  readonly context: string;
  readonly optionsConsidered: readonly DecisionOption[];
  readonly selectedOptionId: string;
  readonly evidence: readonly EvidenceReference[];
  readonly reason: string;
  /** 0..1 */
  readonly confidence: number;
  readonly actionId?: ActionId;
  readonly outcome: DecisionOutcome;
  readonly lessonIds: readonly LessonId[];
}

/**
 * Lesson validation counters. These are the raw telemetry the growth formula
 * (OPEN) will eventually consume: a lesson that is retrieved, applied, and
 * confirmed by a later evaluation is worth more than one merely written.
 */
export interface LessonValidation {
  readonly timesRetrieved: number;
  readonly timesApplied: number;
  readonly timesConfirmed: number;
  readonly timesContradicted: number;
}

export const UNVALIDATED: LessonValidation = Object.freeze({
  timesRetrieved: 0,
  timesApplied: 0,
  timesConfirmed: 0,
  timesContradicted: 0,
});

export interface LessonRecord extends MemoryRecordBase<'lesson'> {
  readonly lessonId: LessonId;
  /** The lesson itself, phrased so a future planner can act on it. */
  readonly statement: string;
  /** When this lesson is expected to apply. */
  readonly applicability: readonly string[];
  /** 0..1 */
  readonly confidence: number;
  readonly validation: LessonValidation;
}

export type PersistentMemoryRecord =
  KnowledgeRecord | ExperienceRecord | DecisionRecord | LessonRecord;

export type MemoryRecordOfKind<K extends PersistentMemoryKind> = Extract<
  PersistentMemoryRecord,
  { kind: K }
>;
