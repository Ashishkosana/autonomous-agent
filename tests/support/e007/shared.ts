/**
 * E-007 — MEMORY OUTLIVES THE PROCESS AND THE SANDBOX (Phase 6).
 *
 * Two separate OS processes, two separate sandboxes, one SQLite file and one
 * storage directory between them. The parent test spawns each child with
 * vitest (`vitest.config.ts` here), so the child sees the repository's
 * TypeScript sources exactly as every other test does.
 *
 *   child role=run1  fresh sandbox → E-000 goal with the scripted model:
 *                    approach A fails evaluation, strategy changes, approach B
 *                    succeeds, a lesson is derived → records land in SQLite →
 *                    the report is archived to storage → the sandbox is destroyed
 *   (process exits)
 *   child role=run2  fresh sandbox (Run 1's file is provably absent) → same goal
 *                    → retrieval returns Run 1's records → planner is shown them →
 *                    plan cites the lesson → approach B first time → done
 *
 * The model is scripted in both runs, so this proves the persistence and
 * provenance plumbing across process and sandbox boundaries — not that a
 * model *chooses* better because of memory. E-007b measures that with a real
 * model.
 */
export const E007_ENV = {
  role: 'AGENT_E007_ROLE',
  dir: 'AGENT_E007_DIR',
} as const;

export type E007Role = 'run1' | 'run2';

export const E007_FILES = {
  memory: 'memory.sqlite',
  storage: 'storage',
  run1: 'run1.json',
  run2: 'run2.json',
} as const;

export interface E007RunEvidence {
  readonly role: E007Role;
  readonly pid: number;
  readonly runId: string;
  readonly environment: {
    readonly provider: string;
    readonly environmentId: string;
    readonly label: string;
  };
  readonly status: string;
  readonly terminationReason?: string;
  readonly usage: Record<string, number>;
  readonly retrieved: { readonly hitCount: number; readonly recordIds: readonly string[] };
  readonly plan: {
    readonly informedByRetrievalIds: readonly string[];
    readonly informedByMemoryRecordIds: readonly string[];
  };
  /** Ids of the records this run wrote, by kind. */
  readonly written: Record<string, readonly string[]>;
  readonly lessonStatements: readonly string[];
  /** Did the planner's prompt (the scripted provider records requests) contain the retrieved lesson text? */
  readonly plannerPromptMentionsPriorLesson: boolean | null;
  readonly report: {
    readonly existsInSandboxBeforeDestroy: boolean;
    readonly existsInFreshSandboxAtStart: boolean;
    readonly archived: readonly {
      readonly status: string;
      readonly key?: string;
      readonly reason?: string;
    }[];
    readonly archivedReadableInThisProcess: boolean | null;
    readonly archivedContainsRequiredMarker: boolean | null;
  };
  readonly sandboxStatusAfterDestroy: string;
  readonly storeCountsAfterRun: Record<string, number>;
  readonly events: readonly { readonly sequence: number; readonly type: string }[];
}
