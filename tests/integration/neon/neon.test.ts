import { describe, expect, it } from 'vitest';
import { compareEfficiency } from '../../../src/agent/runtime/efficiency.js';
import { NeonDatabase } from '../../../src/adapters/neon/neon-database.js';
import { UniqueIdGenerator } from '../../../src/domain/unique-ids.js';
import { asMemoryRecordId } from '../../../src/domain/ids.js';
import { FakeEmbeddingProvider } from '../../support/fake-embedding-provider.js';
import { E010_GOAL, runEfficiencyPair } from '../../support/e010-harness.js';
import { knowledge, describeMemoryStoreContract } from '../../support/memory-store-contract.js';
import { NEON_CONFIGURED, NEON_URL } from './gate.js';

const describeNeon = describe.skipIf(!NEON_CONFIGURED);

async function openFresh(): Promise<NeonDatabase> {
  if (!NEON_URL) throw new Error('Neon URL is not configured');
  const db = await NeonDatabase.open({ connectionString: NEON_URL });
  await db.deleteAll();
  return db;
}

describeNeon('Neon memory store', () => {
  describeMemoryStoreContract('neon', async () => {
    const db = await openFresh();
    return { store: db.store, close: () => db.close() };
  });

  it('round-trips a vector and finds it again after the connection is closed', async () => {
    const db = await openFresh();
    const embeddings = new FakeEmbeddingProvider();
    try {
      await db.store.put(knowledge);
      const index = db.openSemanticIndex(embeddings);
      await index.index(knowledge.recordId, `${knowledge.title} ${knowledge.content}`);
      expect(await index.contains(knowledge.recordId)).toBe(true);
      const matches = await index.search('Sources section of a written report', 5);
      expect(matches.map((match) => match.recordId)).toContain(knowledge.recordId);
      index.close();
    } finally {
      await db.close();
    }

    const again = await NeonDatabase.open({ connectionString: NEON_URL! });
    try {
      const index = again.openSemanticIndex(new FakeEmbeddingProvider());
      expect(await index.contains(knowledge.recordId)).toBe(true);
      expect(await again.store.get(knowledge.recordId)).toEqual(knowledge);
      index.close();
    } finally {
      await again.deleteAll();
      await again.close();
    }
  });

  it('stores run metrics and returns the latest row for that goal', async () => {
    const db = await openFresh();
    try {
      await db.recordEfficiency({
        runId: 'run-1',
        goalStatement: 'same goal',
        status: 'completed',
        succeeded: true,
        iterations: 3,
        toolCalls: 4,
        modelCalls: 5,
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        durationMs: 1_200,
        retrievalHitRate: 0,
        retrievalHitCount: 0,
        signalsUsed: ['keyword'],
        citedRecordIds: [],
        retrievedRecordIds: [],
      });
      await db.recordEfficiency({
        runId: 'run-2',
        goalStatement: 'same goal',
        status: 'completed',
        succeeded: true,
        iterations: 1,
        toolCalls: 1,
        modelCalls: 2,
        inputTokens: 8,
        outputTokens: 1,
        totalTokens: 9,
        durationMs: 400,
        retrievalHitRate: 1,
        retrievalHitCount: 1,
        signalsUsed: ['semantic'],
        citedRecordIds: ['mem-1'],
        retrievedRecordIds: ['mem-1'],
      });
      const latest = await db.latestEfficiency('same goal');
      expect(latest?.runId).toBe('run-2');
      expect(latest?.iterations).toBe(1);
      expect(latest?.durationMs).toBe(400);
      expect(latest?.retrievalHitRate).toBe(1);
      expect(latest?.citedRecordIds).toEqual(['mem-1']);
      expect(await db.latestEfficiency('other goal')).toBeUndefined();
    } finally {
      await db.deleteAll();
      await db.close();
    }
  });

  it('E-010 cold then warm: the second run is cheaper and still cites retrieved knowledge', async () => {
    const db = await openFresh();
    try {
      const pair = await runEfficiencyPair({
        memory: db,
        embeddings: new FakeEmbeddingProvider(),
        ids: new UniqueIdGenerator(),
      });
      const knowledgeId = pair.coldEvents.ofType('KNOWLEDGE_INGESTED')[0]?.payload.recordId;
      expect(knowledgeId).toBeDefined();
      expect(await db.store.get(asMemoryRecordId(knowledgeId!))).toMatchObject({
        kind: 'knowledge',
      });
      const comparison = compareEfficiency(pair.cold.measured.metrics, pair.warm.measured.metrics);
      expect(pair.cold.measured.metrics.goalStatement).toBe(E010_GOAL);
      expect(comparison.mechanicalConditionMet).toBe(true);
      expect(comparison.fewerToolCalls || comparison.fewerIterations).toBe(true);
      expect(comparison.citedRetrievedRecordIds).toContain(knowledgeId);
      expect(pair.warm.measured.comparisonLines.join('\n')).toContain(
        'Mechanical condition met: true',
      );
      expect(pair.warm.measured.comparisonLines.join('\n')).toContain(
        'does not train foundation-model weights',
      );

      const reopened = await NeonDatabase.open({ connectionString: NEON_URL! });
      try {
        const stored = await reopened.latestEfficiency(E010_GOAL);
        expect(stored?.runId).toBe(pair.warm.state.runId);
        expect(stored?.toolCalls).toBe(pair.warm.state.usage.toolCalls);
        expect(await reopened.store.get(asMemoryRecordId(knowledgeId!))).toMatchObject({
          kind: 'knowledge',
        });
      } finally {
        await reopened.close();
      }
    } finally {
      await db.deleteAll();
      await db.close();
    }
  });
});
