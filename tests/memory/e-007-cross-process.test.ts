import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteMemoryStore } from '../../src/memory/sqlite/sqlite-memory-store.js';
import { FilesystemStorage } from '../../src/storage/local/filesystem-storage.js';
import { recordEvidence } from '../support/evidence.js';
import { NamespaceContainerRuntime } from '../support/namespace-container-runtime.js';
import { E007_ENV, E007_FILES, type E007RunEvidence } from '../support/e007/shared.js';

/**
 * E-007 — memory outlives the process and the sandbox. See
 * `tests/support/e007/shared.ts` for the design. This file is the parent: it
 * spawns the two child processes and asserts everything that can only be
 * known across the process boundary.
 */
const unavailable = await NamespaceContainerRuntime.available();
const ROOT = join(import.meta.dirname, '..', '..');
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const CHILD_CONFIG = join(ROOT, 'tests', 'support', 'e007', 'vitest.config.ts');

function spawnChild(role: 'run1' | 'run2', dir: string) {
  const result = spawnSync(process.execPath, [VITEST, 'run', '--config', CHILD_CONFIG], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, [E007_ENV.role]: role, [E007_ENV.dir]: dir },
    timeout: 300_000,
  });
  const file = join(dir, E007_FILES[role]);
  const evidence = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as E007RunEvidence)
    : undefined;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, evidence };
}

describe.skipIf(unavailable)('E-007 · memory outlives the process and the sandbox', () => {
  let dir: string;
  let run1: ReturnType<typeof spawnChild>;
  let run2: ReturnType<typeof spawnChild>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-e007-'));
    run1 = spawnChild('run1', dir);
    run2 = spawnChild('run2', dir);
  }, 600_000);

  afterAll(() => {
    recordEvidence('e007-cross-process', {
      dir,
      run1: run1?.evidence ?? { failedToProduceEvidence: true, stderr: run1?.stderr?.slice(-4000) },
      run2: run2?.evidence ?? { failedToProduceEvidence: true, stderr: run2?.stderr?.slice(-4000) },
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('both child processes ran to completion in separate processes and separate sandboxes', () => {
    expect(run1.status, `run1 failed:\n${run1.stderr}\n${run1.stdout}`).toBe(0);
    expect(run2.status, `run2 failed:\n${run2.stderr}\n${run2.stdout}`).toBe(0);
    const a = run1.evidence!;
    const b = run2.evidence!;
    expect(a.pid).not.toBe(process.pid);
    expect(b.pid).not.toBe(a.pid);
    expect(a.runId).not.toBe(b.runId);
    expect(a.environment.environmentId).not.toBe(b.environment.environmentId);
    expect(a.environment.provider).toBe(b.environment.provider);
    expect(a.status).toBe('completed');
    expect(b.status).toBe('completed');
  });

  it('Run 1 had nothing to retrieve, needed one recovery, and left experience/decision/lesson records in the file', () => {
    const a = run1.evidence!;
    expect(a.retrieved.hitCount).toBe(0);
    expect(a.plan.informedByMemoryRecordIds).toEqual([]);
    expect(a.usage['iterations']).toBe(2);
    expect(a.usage['retries']).toBe(1);
    expect(a.usage['strategyChanges']).toBe(1);
    expect(a.written['experience']).toHaveLength(2);
    expect(a.written['decision']).toHaveLength(2);
    expect(a.written['lesson']).toHaveLength(1);
    expect(a.lessonStatements[0]).toContain('Sources');
    expect(a.storeCountsAfterRun).toEqual({ knowledge: 0, experience: 2, decision: 2, lesson: 1 });
    expect(a.sandboxStatusAfterDestroy).toBe('stopped');
  });

  it('Run 2 started from a fresh sandbox without Run 1 files, retrieved Run 1 records, showed the lesson to the planner, and the plan cites it', () => {
    const a = run1.evidence!;
    const b = run2.evidence!;
    const lessonId = a.written['lesson']![0]!;
    expect(b.report.existsInFreshSandboxAtStart).toBe(false);
    expect(b.retrieved.hitCount).toBeGreaterThan(0);
    expect(b.retrieved.recordIds).toContain(lessonId);
    for (const id of b.retrieved.recordIds) {
      // Everything retrieved came from Run 1's process, never from Run 2 itself.
      expect(Object.values(a.written).flat()).toContain(id);
    }
    expect(b.plannerPromptMentionsPriorLesson).toBe(true);
    expect(b.plan.informedByRetrievalIds).toHaveLength(1);
    expect(b.plan.informedByMemoryRecordIds).toEqual([lessonId]);
  });

  it("Run 2 succeeded on the first attempt and added its own records without disturbing Run 1's", () => {
    const b = run2.evidence!;
    expect(b.usage['iterations']).toBe(1);
    expect(b.usage['retries']).toBe(0);
    expect(b.usage['strategyChanges']).toBe(0);
    expect(b.written['experience']).toHaveLength(1);
    expect(b.written['lesson'] ?? []).toHaveLength(0); // no contrast → no lesson (learner rule)
    expect(b.storeCountsAfterRun).toEqual({ knowledge: 0, experience: 3, decision: 3, lesson: 1 });
    const sequence = b.events.map((e) => e.type);
    expect(sequence.indexOf('MEMORY_RETRIEVED')).toBeLessThan(sequence.indexOf('PLAN_CREATED'));
    expect(sequence).not.toContain('FAILURE_DETECTED');
    // Archiving happens after the run has finished, so it is the final act.
    expect(sequence.indexOf('GOAL_COMPLETED')).toBeLessThan(sequence.indexOf('ARTIFACT_STORED'));
    expect(sequence.at(-1)).toBe('ARTIFACT_STORED');
  });

  it("Run 1's report outlived its sandbox: archived to storage in process 1, read back in process 2", () => {
    const a = run1.evidence!;
    const b = run2.evidence!;
    expect(a.report.existsInSandboxBeforeDestroy).toBe(true);
    // Both drafts of the report (approach A, approach B) were artifacts; both were kept.
    expect(a.report.archived.filter((x) => x.status === 'stored')).toHaveLength(2);
    for (const item of a.report.archived) {
      expect(item.key).toMatch(new RegExp(`^artifacts/${a.runId}/`));
    }
    expect(b.report.archivedReadableInThisProcess).toBe(true);
    expect(b.report.archivedContainsRequiredMarker).toBe(true);
  });

  it('the parent (a third process) reads the same file and storage and sees both runs', async () => {
    const a = run1.evidence!;
    const b = run2.evidence!;
    const store = SqliteMemoryStore.open({ path: join(dir, E007_FILES.memory) });
    try {
      expect(await store.count()).toBe(7);
      expect(await store.count({ runId: a.runId as never })).toBe(5);
      expect(await store.count({ runId: b.runId as never })).toBe(2);
      const lesson = await store.getOfKind('lesson', a.written['lesson']![0]! as never);
      expect(lesson?.runId).toBe(a.runId);
      expect(lesson?.provenance.memoryRecordIds).toContain(a.written['experience']![1]);
    } finally {
      store.close();
    }
    const storage = await FilesystemStorage.open({ root: join(dir, E007_FILES.storage) });
    const objects = await storage.listObjects('artifacts/');
    expect(objects.map((o) => o.key).sort()).toEqual(
      [...a.report.archived, ...b.report.archived].map((x) => x.key!).sort(),
    );
  });
});
