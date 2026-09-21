import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteMemoryStore } from '../../src/memory/sqlite/sqlite-memory-store.js';
import { SqliteSemanticIndex } from '../../src/memory/sqlite/sqlite-semantic-index.js';
import { createEmbeddingProvider } from '../../src/models/config.js';
import { SystemClock } from '../../src/domain/system-clock.js';
import {
  EMBEDDING_CONFIG,
  EMBEDDING_SKIP_REASON,
  EMBEDDING_SUMMARY,
  REAL_EMBEDDING_AVAILABLE,
} from '../integration/model/embedding-gate.js';
import { SequentialIdGenerator } from '../support/deterministic.js';
import { recordEvidence } from '../support/evidence.js';
import { NamespaceContainerRuntime } from '../support/namespace-container-runtime.js';
import {
  E009_ENV,
  E009_FILES,
  GOAL_2,
  PAGE_TITLE,
  type E009RunEvidence,
} from '../support/e009/shared.js';

/**
 * E-009 — knowledge read from the world in Run 1 is found by meaning in Run 2.
 * See `tests/support/e009/shared.ts` for the design. This file is the parent:
 * it spawns the two child processes and asserts what can only be known across
 * the process boundary.
 *
 * Runs only with a real Linux environment AND a real embedding endpoint
 * (AGENT_EMBEDDING_*). Docker mode is not supported here yet: the page is
 * served on the child's loopback, which a container cannot reach as 127.0.0.1.
 */
const nsUnavailable = await NamespaceContainerRuntime.available();
const dockerRequested =
  process.env['AGENT_LOCAL_DOCKER'] === '1' || process.env['AGENT_REQUIRE_LOCAL_DOCKER'] === '1';
const skipReason = !REAL_EMBEDDING_AVAILABLE
  ? EMBEDDING_SKIP_REASON
  : dockerRequested
    ? 'E-009 serves its page on the host loopback; a Docker-isolated run is PENDING (needs a reachable page host)'
    : nsUnavailable
      ? `no real Linux environment: ${nsUnavailable}`
      : '';
if (skipReason) console.warn(`[skip] E-009 NOT RUN — ${skipReason}`);

const ROOT = join(import.meta.dirname, '..', '..');
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const CHILD_CONFIG = join(ROOT, 'tests', 'support', 'e009', 'vitest.config.ts');

function spawnChild(role: 'run1' | 'run2', dir: string) {
  const result = spawnSync(process.execPath, [VITEST, 'run', '--config', CHILD_CONFIG], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, [E009_ENV.role]: role, [E009_ENV.dir]: dir },
    timeout: 300_000,
  });
  const file = join(dir, E009_FILES[role]);
  const evidence = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as E009RunEvidence)
    : undefined;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, evidence };
}

describe.skipIf(skipReason !== '')(
  'E-009 · knowledge ingested in Run 1 is retrieved by meaning in Run 2, across processes and sandboxes',
  () => {
    let dir: string;
    let run1: ReturnType<typeof spawnChild>;
    let run2: ReturnType<typeof spawnChild>;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'agent-e009-'));
      run1 = spawnChild('run1', dir);
      run2 = spawnChild('run2', dir);
    }, 600_000);

    afterAll(() => {
      recordEvidence('e009-knowledge-across-runs', {
        dir,
        embedding: EMBEDDING_SUMMARY,
        run1: run1?.evidence ?? {
          failedToProduceEvidence: true,
          stderr: run1?.stderr?.slice(-4000),
        },
        run2: run2?.evidence ?? {
          failedToProduceEvidence: true,
          stderr: run2?.stderr?.slice(-4000),
        },
      });
      rmSync(dir, { recursive: true, force: true });
    });

    it('both child processes completed their goals in separate processes and separate sandboxes', () => {
      expect(run1.status, `run1 failed:\n${run1.stderr}\n${run1.stdout}`).toBe(0);
      expect(run2.status, `run2 failed:\n${run2.stderr}\n${run2.stdout}`).toBe(0);
      const a = run1.evidence!;
      const b = run2.evidence!;
      expect(a.pid).not.toBe(process.pid);
      expect(b.pid).not.toBe(a.pid);
      expect(a.runId).not.toBe(b.runId);
      expect(a.environment.environmentId).not.toBe(b.environment.environmentId);
      expect(a.status).toBe('completed');
      expect(b.status).toBe('completed');
      expect(a.embeddingModel).toEqual(b.embeddingModel);
    });

    it('Run 1 fetched the page through the sandbox, ingested it as knowledge, embedded it with the real model, then lost the page and the sandbox', () => {
      const a = run1.evidence!;
      expect(a.retrieval.hitCount).toBe(0);
      expect(a.page?.fetchStatus).toBe('TOOL_COMPLETED');
      expect(a.page?.ingested?.title).toBe(PAGE_TITLE);
      expect(a.page?.ingested?.source).toBe(a.page?.url);
      expect(a.page?.ingested?.confidence).toBe(0.5);
      expect(a.page?.ingested?.truncated).toBe(false);
      expect(a.page?.indexedInSharedFile).toBe(true);
      expect(a.page?.serverClosedBeforeExit).toBe(true);
      expect(a.written['knowledge']).toEqual([a.page?.ingested?.recordId]);
      expect(a.indexFailures).toEqual([]);
      // Every record Run 1 wrote was embedded (embed_memory), plus one query embedding for its own retrieval.
      const writtenCount = Object.values(a.written).flat().length;
      expect(a.embedCalls.filter((c) => c.purpose === 'embed_memory' && c.ok)).toHaveLength(
        writtenCount,
      );
      expect(a.sandboxStatusAfterDestroy).toBe('stopped');
      const sequence = a.events.map((e) => e.type);
      expect(sequence.indexOf('KNOWLEDGE_INGESTED')).toBeGreaterThan(
        sequence.indexOf('TOOL_COMPLETED'),
      );
    });

    it("Run 2's goal shares no indexable term with the knowledge record, and the keyword-only control misses it", () => {
      const b = run2.evidence!;
      expect(b.goal).toBe(GOAL_2);
      expect(b.lexicalControl?.goalTermsOverlappingKnowledge).toEqual([]);
      expect(b.lexicalControl?.foundKnowledge).toBe(false);
      expect(b.pageStillServed).toBe(false);
    });

    it('Run 2 retrieved the knowledge record by semantic similarity from a fresh sandbox, and the planner was shown it', () => {
      const a = run1.evidence!;
      const b = run2.evidence!;
      const knowledgeId = a.page!.ingested!.recordId;
      expect(b.reportExistsInFreshSandboxAtStart).toBe(false);
      expect(b.retrieval.signalsUsed).toContain('semantic');
      expect(b.retrieval.degraded).toEqual([]);
      expect(b.retrieval.recordIds).toContain(knowledgeId);
      const hit = b.retrieval.hits.find((h) => h.recordId === knowledgeId);
      expect(hit?.kind).toBe('knowledge');
      expect(hit?.matchedBy).toContain('semantic');
      expect(hit?.matchedBy).not.toContain('keyword');
      for (const id of b.retrieval.recordIds) {
        expect(Object.values(a.written).flat()).toContain(id);
      }
      // One query embedding for the runtime's retrieval, one for the child's diagnostic semantic scan.
      expect(b.embedCalls.filter((c) => c.purpose === 'embed_query' && c.ok)).toHaveLength(2);
      // The diagnostic confirms the ranking problem is real and not fixed by pretending:
      // by cosine alone the page is still below every bookkeeping record of Run 1 but one.
      const scan = b.semanticScan ?? [];
      const pageCosine = scan.find((s) => s.recordId === knowledgeId)?.cosine ?? 0;
      expect(pageCosine).toBeGreaterThanOrEqual(0.5);
      expect(scan.filter((s) => s.cosine > pageCosine).length).toBeGreaterThanOrEqual(1);
      expect(b.plannerPrompt).toEqual({
        mentionsKnowledgeTitle: true,
        mentionsKnowledgeSource: true,
        mentionsKnowledgeExcerpt: true,
      });
      expect(b.plan.informedByRetrievalIds).toHaveLength(1);
      expect(b.plan.informedByMemoryRecordIds).toEqual([knowledgeId]);
    });

    it('Run 2 wrote the report correctly on the first attempt and left Run 1 records intact', () => {
      const a = run1.evidence!;
      const b = run2.evidence!;
      expect(b.usage['iterations']).toBe(1);
      expect(b.usage['retries']).toBe(0);
      expect(b.written['knowledge'] ?? []).toEqual([]); // fs.write brings nothing back from the world
      expect(b.storeCountsAfterRun['knowledge']).toBe(1);
      expect(b.storeCountsAfterRun['experience']).toBe(a.storeCountsAfterRun['experience']! + 1);
      const sequence = b.events.map((e) => e.type);
      expect(sequence.indexOf('MEMORY_RETRIEVED')).toBeLessThan(sequence.indexOf('PLAN_CREATED'));
      expect(sequence).not.toContain('FAILURE_DETECTED');
    });

    it('the parent (a third process) sees one knowledge record and its vector in the shared file', async () => {
      const a = run1.evidence!;
      const knowledgeId = a.page!.ingested!.recordId;
      const path = join(dir, E009_FILES.memory);
      const store = SqliteMemoryStore.open({ path });
      const embeddings = createEmbeddingProvider(EMBEDDING_CONFIG!, {
        clock: new SystemClock(),
        ids: new SequentialIdGenerator(),
      });
      const index = SqliteSemanticIndex.open({ path, embeddings });
      try {
        const record = await store.getOfKind('knowledge', knowledgeId as never);
        expect(record?.runId).toBe(a.runId);
        expect(record?.title).toBe(PAGE_TITLE);
        expect(record?.sources[0]?.url).toBe(a.page?.url);
        expect(record?.tags).toContain('ingested');
        expect(await index.contains(knowledgeId as never)).toBe(true);
        expect(await store.count({ kinds: ['knowledge'] })).toBe(1);
      } finally {
        index.close();
        store.close();
      }
    });
  },
);
