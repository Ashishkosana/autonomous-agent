import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asMemoryRecordId } from '../../../src/domain/ids.js';
import { SystemClock } from '../../../src/domain/system-clock.js';
import { UniqueIdGenerator } from '../../../src/domain/unique-ids.js';
import { PERSISTENT_MEMORY_KINDS, type LessonRecord } from '../../../src/memory/records.js';
import { SqliteMemoryStore } from '../../../src/memory/sqlite/sqlite-memory-store.js';
import { archiveArtifacts } from '../../../src/storage/archive.js';
import { FilesystemStorage } from '../../../src/storage/local/filesystem-storage.js';
import { createStandardToolRegistry } from '../../../src/tools/standard-tools.js';
import { chooseRealEnvironment } from '../real-environment.js';
import {
  APPROACH_A_CONTENT,
  APPROACH_B_CONTENT,
  GOAL_STATEMENT,
  REPORT_PATH,
  REQUIRED_MARKER,
  buildScenario,
  planTurn,
  reviseTurnEchoingTask,
  writeReport,
  type ScenarioTurn,
} from '../runtime-scenario.js';
import { E007_ENV, E007_FILES, type E007Role, type E007RunEvidence } from './shared.js';

const role = process.env[E007_ENV.role] as E007Role | undefined;
const dir = process.env[E007_ENV.dir];

describe.skipIf(!role || !dir)(`E-007 child process · ${role ?? 'no role'}`, () => {
  it(`performs ${role} against the shared memory file and a fresh sandbox`, async () => {
    if (!role || !dir) throw new Error('unreachable: skipped without role/dir');
    const choice = await chooseRealEnvironment();
    if ('unavailable' in choice) throw new Error(choice.unavailable);

    const clock = new SystemClock();
    const store = SqliteMemoryStore.open({ path: join(dir, E007_FILES.memory) });
    const storage = await FilesystemStorage.open({ root: join(dir, E007_FILES.storage), clock });
    const environment = await choice.open(`e007-${role}`);

    try {
      // A fresh sandbox never contains the previous run's report.
      const existsInFreshSandboxAtStart = await environment.fileExists(REPORT_PATH);

      const priorLesson = role === 'run2' ? readRun1Lesson(dir) : undefined;
      const turns: ScenarioTurn[] =
        role === 'run1'
          ? [
              planTurn([]),
              { proposal: writeReport(APPROACH_A_CONTENT, 'Write the report from known findings') },
              // Ids are unique per process here, so the revision must echo the real task id.
              reviseTurnEchoingTask({ strategyChanged: true }),
              { proposal: writeReport(APPROACH_B_CONTENT, 'Rewrite including a Sources section') },
            ]
          : [
              // Run 2 cites the lesson Run 1 wrote. The planner only keeps citations of
              // records it was actually shown, so a broken retrieval path would surface
              // here as an empty informedByMemoryRecordIds — not as a passing test.
              planTurn(priorLesson ? [priorLesson.recordId] : []),
              {
                proposal: writeReport(
                  APPROACH_B_CONTENT,
                  'Include the Sources section on the first attempt, as the retrieved lesson says',
                ),
              },
            ];

      // Two processes writing to one store need ids that are unique across processes;
      // the deterministic test generator would make Run 2 overwrite Run 1 (see E-007 notes).
      const scenario = await buildScenario({
        environment,
        clock,
        ids: new UniqueIdGenerator(),
        store,
        seed: [],
        goalStatement: GOAL_STATEMENT,
        tools: createStandardToolRegistry({ options: { defaultTimeoutMs: 30_000 } }),
        limits: { maxDurationMs: 600_000 },
        turns,
      });
      const outcome = await scenario.run();
      const events = scenario.events.events;

      const existsInSandboxBeforeDestroy = await environment.fileExists(REPORT_PATH);

      // Promote the report out of the sandbox before the sandbox dies.
      const artifacts = scenario.session.working
        .snapshot()
        .observations.flatMap((o) => o.artifacts ?? []);
      const archived = await archiveArtifacts(environment, artifacts, storage, {
        prefix: 'artifacts',
        clock,
        emit: (payload, correlation) =>
          scenario.session.emit('ARTIFACT_STORED', payload, correlation),
      });

      let archivedReadableInThisProcess: boolean | null = null;
      let archivedContainsRequiredMarker: boolean | null = null;
      if (role === 'run2') {
        const run1 = readRun1(dir);
        const key = run1.report.archived.find((a) => a.status === 'stored')?.key;
        const object = key ? await storage.getObject(key) : null;
        archivedReadableInThisProcess = object !== null;
        archivedContainsRequiredMarker = object
          ? new TextDecoder().decode(object.body).includes(REQUIRED_MARKER)
          : null;
      }

      await environment.destroy();
      const sandboxStatusAfterDestroy = (await environment.getState()).status;

      const written: Record<string, string[]> = {};
      for (const id of outcome.writtenRecordIds) {
        const record = await store.get(id);
        if (record) (written[record.kind] ??= []).push(id);
      }
      const storeCountsAfterRun: Record<string, number> = {};
      for (const kind of PERSISTENT_MEMORY_KINDS) {
        storeCountsAfterRun[kind] = await store.count({ kinds: [kind] });
      }
      const lessonStatements: string[] = [];
      for (const id of written['lesson'] ?? []) {
        const lesson = await store.getOfKind('lesson', asMemoryRecordId(id));
        if (lesson) lessonStatements.push(lesson.statement);
      }

      const retrievedEvent = events.find((e) => e.type === 'MEMORY_RETRIEVED');
      const planEvent = events.find((e) => e.type === 'PLAN_CREATED');
      const plannerRequest = scenario.provider.requests.find((r) => r.purpose === 'create_plan');
      const plannerPromptMentionsPriorLesson = priorLesson
        ? (plannerRequest?.messages ?? []).some((m) => m.content.includes(priorLesson.statement))
        : null;

      const evidence: E007RunEvidence = {
        role,
        pid: process.pid,
        runId: scenario.session.runId,
        environment: {
          provider: environment.descriptor.provider,
          environmentId: environment.descriptor.environmentId,
          label: choice.label,
        },
        status: outcome.state.status,
        ...(outcome.state.terminationReason
          ? { terminationReason: outcome.state.terminationReason }
          : {}),
        usage: { ...outcome.state.usage } as Record<string, number>,
        retrieved: {
          hitCount:
            retrievedEvent?.type === 'MEMORY_RETRIEVED' ? retrievedEvent.payload.hitCount : -1,
          recordIds:
            retrievedEvent?.type === 'MEMORY_RETRIEVED'
              ? [...retrievedEvent.payload.recordIds]
              : [],
        },
        plan: {
          informedByRetrievalIds:
            planEvent?.type === 'PLAN_CREATED' ? [...planEvent.payload.informedByRetrievalIds] : [],
          informedByMemoryRecordIds:
            planEvent?.type === 'PLAN_CREATED'
              ? [...planEvent.payload.informedByMemoryRecordIds]
              : [],
        },
        written,
        lessonStatements,
        plannerPromptMentionsPriorLesson,
        report: {
          existsInSandboxBeforeDestroy,
          existsInFreshSandboxAtStart,
          archived: archived.map((a) =>
            a.status === 'stored'
              ? {
                  status: a.status,
                  key: a.stored.location.storage === 'persistent' ? a.stored.location.key : '',
                }
              : { status: a.status, reason: a.reason },
          ),
          archivedReadableInThisProcess,
          archivedContainsRequiredMarker,
        },
        sandboxStatusAfterDestroy,
        storeCountsAfterRun,
        events: events.map((e) => ({ sequence: e.sequence, type: e.type })),
      };
      writeFileSync(join(dir, E007_FILES[role]), JSON.stringify(evidence, null, 2));

      // The child asserts the run-local facts; the parent asserts the cross-process ones.
      expect(outcome.state.status).toBe('completed');
      expect(existsInFreshSandboxAtStart).toBe(false);
      expect(existsInSandboxBeforeDestroy).toBe(true);
      expect(archived.some((a) => a.status === 'stored')).toBe(true);
      expect(events.some((e) => e.type === 'ARTIFACT_STORED')).toBe(true);
      expect(sandboxStatusAfterDestroy).toBe('stopped');
    } finally {
      store.close();
    }
  }, 300_000);
});

function readRun1(dir: string): E007RunEvidence {
  const file = join(dir, E007_FILES.run1);
  if (!existsSync(file)) throw new Error(`run2 needs ${file} from run1`);
  return JSON.parse(readFileSync(file, 'utf8')) as E007RunEvidence;
}

/** Run 2 learns the lesson id from Run 1's evidence file — the only thing shared besides the store. */
function readRun1Lesson(dir: string): Pick<LessonRecord, 'recordId' | 'statement'> | undefined {
  const run1 = readRun1(dir);
  const recordId = run1.written['lesson']?.[0];
  const statement = run1.lessonStatements[0];
  return recordId && statement
    ? { recordId: recordId as LessonRecord['recordId'], statement }
    : undefined;
}
