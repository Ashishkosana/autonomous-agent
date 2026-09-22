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
import type { Precondition } from './applicability.js';
import type { DecisionOutcome, OutcomeVerdict } from '../domain/outcome.js';
import type { Provenance } from '../domain/provenance.js';

/**
 * Persistent memory record kinds.
 *
 * The four logical memory categories are locked: working, knowledge,
 * experience, decision. Working memory is run-scoped and lives in
 * `working.ts`. The other three persist across runs and are modelled here.
 *
 * `lesson` is NOT a fifth category. A LessonRecord is a derived persistent
 * learning record produced by the learner from evaluated outcomes; it is
 * stored under the same store/retrieval machinery (hence it appears in
 * `PersistentMemoryKind`, a storage-level discriminator) and links back to
 * the knowledge, experience, decisions, evaluations, observations, actions,
 * strategies and retrievals it was derived from.
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
  /**
   * Conditions that held, or were required, when this record was written.
   * Optional so records stored before the field existed stay valid. Checked
   * deterministically at presentation; not a learned applicability score.
   */
  readonly preconditions?: readonly Precondition[];
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
  /**
   * Static initial confidence in [0, 1], fixed by the writer (0.5 for
   * `web.fetch`, 0.4 for `fs.read`). Nothing reads it to rank, filter, or
   * decide. It is not a posterior and it is not updated.
   */
  readonly confidence: number;
}

/** Same four words as `EvaluationVerdict`. `inconclusive` is not stored as `failure`. */
export type ExperienceOutcome = OutcomeVerdict;

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

export type { DecisionOutcome };

export interface DecisionRecord extends MemoryRecordBase<'decision'> {
  readonly decisionId: DecisionId;
  readonly context: string;
  readonly optionsConsidered: readonly DecisionOption[];
  readonly selectedOptionId: string;
  readonly evidence: readonly EvidenceReference[];
  readonly reason: string;
  /**
   * Optional number the model reported, in [0, 1]. Absent when it reported
   * none; never invented. Not an updated belief and not used in retrieval.
   */
  readonly confidence?: number;
  readonly actionId?: ActionId;
  readonly outcome: DecisionOutcome;
  readonly lessonIds: readonly LessonId[];
}

/**
 * Write-time snapshot. The learner stores `UNVALIDATED` and nothing in the
 * agent increments these fields: a later run may not overwrite a record owned
 * by an earlier run. Live exposure (retrieved, presented, explicitly cited)
 * is counted from the event stream by `exposureFromEvents`. `timesConfirmed`
 * and `timesContradicted` stay 0 until a future experiment defines attribution.
 * Task success does not increment them.
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
  /**
   * Static labels (usually tool names) copied from the attempts that produced
   * the lesson. Not a predicate and not updated. Contextual checks live on
   * `preconditions`.
   */
  readonly applicability: readonly string[];
  /**
   * Static initial confidence. The rule-based learner writes 0.6 once.
   * Nothing updates it and nothing ranks by it.
   */
  readonly confidence: number;
  readonly validation: LessonValidation;
}

export type PersistentMemoryRecord =
  KnowledgeRecord | ExperienceRecord | DecisionRecord | LessonRecord;

export type MemoryRecordOfKind<K extends PersistentMemoryKind> = Extract<
  PersistentMemoryRecord,
  { kind: K }
>;
