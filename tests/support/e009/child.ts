import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asGoalId, asMemoryRecordId, asRunId } from '../../../src/domain/ids.js';
import { SystemClock } from '../../../src/domain/system-clock.js';
import { UniqueIdGenerator } from '../../../src/domain/unique-ids.js';
import { HybridRetriever } from '../../../src/memory/hybrid-retriever.js';
import { IndexedMemoryStore } from '../../../src/memory/indexed-memory-store.js';
import { LexicalRetriever, lexicalTerms } from '../../../src/memory/lexical-retriever.js';
import { PERSISTENT_MEMORY_KINDS } from '../../../src/memory/records.js';
import { searchableText } from '../../../src/memory/searchable-text.js';
import { SqliteMemoryStore } from '../../../src/memory/sqlite/sqlite-memory-store.js';
import { SqliteSemanticIndex } from '../../../src/memory/sqlite/sqlite-semantic-index.js';
import { createEmbeddingProvider, resolveEmbeddingConfig } from '../../../src/models/config.js';
import { InstrumentedEmbeddingProvider } from '../../../src/models/instrumented-embedding-provider.js';
import { createStandardToolRegistry } from '../../../src/tools/standard-tools.js';
import { chooseRealEnvironment } from '../real-environment.js';
import {
  APPROACH_B_CONTENT,
  REPORT_PATH,
  buildScenario,
  planTurn,
  reviseTurnEchoingTask,
  writeReport,
  type ScenarioTurn,
} from '../runtime-scenario.js';
import {
  E009_ENV,
  E009_FILES,
  GOAL_2,
  PAGE_BODY,
  PAGE_HTML,
  PAGE_TITLE,
  type E009Role,
  type E009RunEvidence,
  type EmbedCallEvidence,
} from './shared.js';

const role = process.env[E009_ENV.role] as E009Role | undefined;
const dir = process.env[E009_ENV.dir];

describe.skipIf(!role || !dir)(`E-009 child process · ${role ?? 'no role'}`, () => {
  it(`performs ${role} against the shared memory file, a real embedding model and a fresh sandbox`, async () => {
    if (!role || !dir) throw new Error('unreachable: skipped without role/dir');
    const choice = await chooseRealEnvironment();
    if ('unavailable' in choice) throw new Error(choice.unavailable);
    const embeddingConfig = resolveEmbeddingConfig(process.env);
    if (embeddingConfig.kind === 'none') throw new Error('E-009 child needs AGENT_EMBEDDING_*');

    const clock = new SystemClock();
    const ids = new UniqueIdGenerator();
    const embedCalls: EmbedCallEvidence[] = [];
    const embeddings = new InstrumentedEmbeddingProvider(
      createEmbeddingProvider(embeddingConfig, { clock, ids }),
      {
        runId: asRunId(`e009-${role}`),
        goalId: asGoalId(`e009-${role}`),
        clock,
        ids,
        onStarted: () => {},
        onCall: (r) =>
          embedCalls.push({
            purpose: r.purpose,
            latencyMs: r.latencyMs,
            inputTokens: r.usage.inputTokens,
            ok: true,
          }),
        onFailed: (r) =>
          embedCalls.push({
            purpose: r.purpose,
            latencyMs: r.latencyMs,
            inputTokens: 0,
            ok: false,
            errorKind: r.errorKind,
          }),
      },
    );

    // One SQLite file holds both the records and their vectors.
    const memoryPath = join(dir, E009_FILES.memory);
    const inner = SqliteMemoryStore.open({ path: memoryPath });
    const index = SqliteSemanticIndex.open({ path: memoryPath, embeddings });
    const indexFailures: string[] = [];
    const store = new IndexedMemoryStore(inner, index, {
      onIndexFailure: (f) => indexFailures.push(`${f.recordId}: ${String(f.error)}`),
    });

    const environment = await choice.open(`e009-${role}`);
    let server: Server | undefined;
    let pageUrl: string | undefined;

    try {
      const reportExistsInFreshSandboxAtStart = await environment.fileExists(REPORT_PATH);
      const run1 = role === 'run2' ? readRun1(dir) : undefined;
      const priorKnowledgeId = run1?.page?.ingested?.recordId;

      let goal: string;
      let turns: ScenarioTurn[];
      if (role === 'run1') {
        server = await servePage();
        pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/style`;
        goal = `Read the style guide at ${pageUrl} and then write the report at ${REPORT_PATH}`;
        turns = [
          planTurn([]),
          {
            proposal: {
              kind: 'tool',
              toolName: 'web.fetch',
              input: { url: pageUrl },
              rationale: 'Read the style guide before writing',
            },
          },
          reviseTurnEchoingTask({ strategyChanged: true }),
          { proposal: writeReport(APPROACH_B_CONTENT, 'Write the report as the style guide says') },
        ];
      } else {
        goal = GOAL_2;
        turns = [
          // Run 2 cites the knowledge record Run 1 ingested. The planner keeps only
          // citations of records it was actually shown, so a retrieval that misses the
          // record surfaces as an empty informedByMemoryRecordIds, not a passing test.
          planTurn(priorKnowledgeId ? [priorKnowledgeId] : []),
          {
            proposal: writeReport(
              APPROACH_B_CONTENT,
              'Finish with a Sources section, as the retrieved style page requires',
            ),
          },
        ];
      }

      // Control for Run 2, before the run: the same goal through keywords only.
      let lexicalControl: E009RunEvidence['lexicalControl'];
      let pageStillServed: boolean | undefined;
      let semanticScan: E009RunEvidence['semanticScan'];
      if (role === 'run2' && run1 && priorKnowledgeId) {
        const lexical = new LexicalRetriever(inner, clock);
        const control = await lexical.retrieve({
          retrievalId: 'ret-control' as never,
          text: goal,
          kinds: PERSISTENT_MEMORY_KINDS,
          limit: 5,
          correlation: { runId: asRunId('e009-control'), goalId: asGoalId('e009-control') },
        });
        const knowledge = await inner.get(asMemoryRecordId(priorKnowledgeId));
        const goalTerms = lexicalTerms(goal);
        const knowledgeTerms = knowledge ? lexicalTerms(searchableText(knowledge)) : new Set();
        lexicalControl = {
          hitCount: control.hits.length,
          recordIds: control.hits.map((h) => h.record.recordId),
          foundKnowledge: control.hits.some((h) => h.record.recordId === priorKnowledgeId),
          goalTermsOverlappingKnowledge: [...goalTerms].filter((t) => knowledgeTerms.has(t)),
        };
        pageStillServed = await isServed(run1.page?.url);
        const scan: { recordId: string; kind: string; cosine: number }[] = [];
        for (const match of await index.search(goal, 100)) {
          const record = await inner.get(match.recordId);
          scan.push({
            recordId: match.recordId,
            kind: record?.kind ?? 'missing',
            cosine: Number(match.score.toFixed(4)),
          });
        }
        semanticScan = scan;
      }

      const scenario = await buildScenario({
        environment,
        clock,
        ids,
        store,
        retriever: (s, c) => new HybridRetriever(s, index, c),
        seed: [],
        goalStatement: goal,
        tools: createStandardToolRegistry({ options: { defaultTimeoutMs: 30_000 } }),
        limits: { maxDurationMs: 600_000 },
        turns,
      });
      const outcome = await scenario.run();
      const events = scenario.events.events;

      let page: E009RunEvidence['page'];
      if (role === 'run1' && server && pageUrl) {
        const fetched = events.find(
          (e) =>
            (e.type === 'TOOL_COMPLETED' || e.type === 'TOOL_FAILED') &&
            e.payload.toolName === 'web.fetch',
        );
        const ingestedEvent = events.find((e) => e.type === 'KNOWLEDGE_INGESTED');
        const ingested =
          ingestedEvent?.type === 'KNOWLEDGE_INGESTED'
            ? {
                recordId: ingestedEvent.payload.recordId,
                title: ingestedEvent.payload.title,
                source: ingestedEvent.payload.source,
                keptChars: ingestedEvent.payload.keptChars,
                truncated: ingestedEvent.payload.truncated,
                confidence: ingestedEvent.payload.confidence,
              }
            : null;
        await closeServer(server);
        server = undefined;
        page = {
          url: pageUrl,
          fetchStatus: fetched?.type ?? 'not attempted',
          ingested,
          indexedInSharedFile: ingested ? await index.contains(ingested.recordId) : false,
          serverClosedBeforeExit: !(await isServed(pageUrl)),
        };
      }

      await environment.destroy();
      const sandboxStatusAfterDestroy = (await environment.getState()).status;

      const written: Record<string, string[]> = {};
      for (const id of outcome.writtenRecordIds) {
        const record = await inner.get(id);
        if (record) (written[record.kind] ??= []).push(id);
      }
      const storeCountsAfterRun: Record<string, number> = {};
      for (const kind of PERSISTENT_MEMORY_KINDS) {
        storeCountsAfterRun[kind] = await inner.count({ kinds: [kind] });
      }

      const retrievedEvent = events.find((e) => e.type === 'MEMORY_RETRIEVED');
      const retrievalResult = scenario.session.working.snapshot().retrievals[0];
      const planEvent = events.find((e) => e.type === 'PLAN_CREATED');
      const plannerPromptText = (
        scenario.provider.requests.find((r) => r.purpose === 'create_plan')?.messages ?? []
      )
        .map((m) => m.content)
        .join('\n');

      const evidence: E009RunEvidence = {
        role,
        pid: process.pid,
        runId: scenario.session.runId,
        goal,
        environment: {
          provider: environment.descriptor.provider,
          environmentId: environment.descriptor.environmentId,
          label: choice.label,
        },
        embeddingModel: {
          provider: embeddings.descriptor.provider,
          model: embeddings.descriptor.model,
        },
        status: outcome.state.status,
        ...(outcome.state.terminationReason
          ? { terminationReason: outcome.state.terminationReason }
          : {}),
        usage: { ...outcome.state.usage } as Record<string, number>,
        ...(page ? { page } : {}),
        retrieval: {
          hitCount:
            retrievedEvent?.type === 'MEMORY_RETRIEVED' ? retrievedEvent.payload.hitCount : -1,
          recordIds:
            retrievedEvent?.type === 'MEMORY_RETRIEVED'
              ? [...retrievedEvent.payload.recordIds]
              : [],
          signalsUsed:
            retrievedEvent?.type === 'MEMORY_RETRIEVED'
              ? [...retrievedEvent.payload.signalsUsed]
              : [],
          degraded:
            retrievedEvent?.type === 'MEMORY_RETRIEVED' ? [...retrievedEvent.payload.degraded] : [],
          hits: (retrievalResult?.hits ?? []).map((h) => ({
            recordId: h.record.recordId,
            kind: h.record.kind,
            score: Number(h.score.toFixed(4)),
            matchedBy: [...h.matchedBy],
          })),
        },
        ...(lexicalControl ? { lexicalControl } : {}),
        ...(pageStillServed !== undefined ? { pageStillServed } : {}),
        ...(semanticScan ? { semanticScan } : {}),
        plan: {
          informedByRetrievalIds:
            planEvent?.type === 'PLAN_CREATED' ? [...planEvent.payload.informedByRetrievalIds] : [],
          informedByMemoryRecordIds:
            planEvent?.type === 'PLAN_CREATED'
              ? [...planEvent.payload.informedByMemoryRecordIds]
              : [],
        },
        plannerPrompt: {
          mentionsKnowledgeTitle: run1 ? plannerPromptText.includes(PAGE_TITLE) : null,
          mentionsKnowledgeSource: run1?.page?.url
            ? plannerPromptText.includes(run1.page.url)
            : null,
          mentionsKnowledgeExcerpt: run1
            ? plannerPromptText.includes(PAGE_BODY.slice(0, 80))
            : null,
        },
        written,
        embedCalls,
        indexFailures,
        reportExistsInFreshSandboxAtStart,
        sandboxStatusAfterDestroy,
        storeCountsAfterRun,
        events: events.map((e) => ({ sequence: e.sequence, type: e.type })),
      };
      writeFileSync(join(dir, E009_FILES[role]), JSON.stringify(evidence, null, 2));

      // The child asserts the run-local facts; the parent asserts the cross-process ones.
      expect(reportExistsInFreshSandboxAtStart).toBe(false);
      expect(outcome.state.status).toBe('completed');
      expect(indexFailures).toEqual([]);
      expect(sandboxStatusAfterDestroy).toBe('stopped');
      if (role === 'run1') {
        expect(page?.fetchStatus).toBe('TOOL_COMPLETED');
        expect(page?.ingested).not.toBeNull();
        expect(page?.indexedInSharedFile).toBe(true);
        expect(page?.serverClosedBeforeExit).toBe(true);
      }
    } finally {
      if (server) await closeServer(server);
      index.close();
      inner.close();
    }
  }, 300_000);
});

function readRun1(dir: string): E009RunEvidence {
  const file = join(dir, E009_FILES.run1);
  if (!existsSync(file)) throw new Error(`run2 needs ${file} from run1`);
  return JSON.parse(readFileSync(file, 'utf8')) as E009RunEvidence;
}

/** Serves the style page on an ephemeral loopback port for as long as Run 1 lasts. */
function servePage(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      if (request.url === '/style') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(PAGE_HTML);
      } else {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Test-side probe (not the agent's tool): is anything answering at the page URL? */
async function isServed(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}
