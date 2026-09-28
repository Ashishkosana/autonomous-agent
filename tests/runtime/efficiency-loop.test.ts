import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareEfficiency } from '../../src/agent/runtime/efficiency.js';
import { UniqueIdGenerator } from '../../src/domain/unique-ids.js';
import { openMemoryStore } from '../../src/memory/config.js';
import type { OpenedMemory } from '../../src/memory/opened-memory.js';
import type { KnowledgeRecord } from '../../src/memory/records.js';
import { FakeEmbeddingProvider } from '../support/fake-embedding-provider.js';
import { E010_GOAL, runEfficiencyPair, type EfficiencyPair } from '../support/e010-harness.js';
import { PUBLIC_PAGE_TITLE, PUBLIC_PAGE_URL } from '../support/public-page.js';
import { REPORT_PATH, REQUIRED_MARKER } from '../support/runtime-scenario.js';

/**
 * Always-on proof of the measurement, on SQLite. A real model is not
 * involved. E-010 on Neon is the gated experiment in
 * `tests/integration/neon/neon.test.ts`.
 */
describe('internet knowledge then a cheaper second run (scripted)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-e010-sqlite-'));
  const embeddings = new FakeEmbeddingProvider();
  let memory: OpenedMemory;
  let pair: EfficiencyPair;

  beforeAll(async () => {
    memory = await openMemoryStore({ kind: 'sqlite', path: join(dir, 'memory.sqlite') });
    pair = await runEfficiencyPair({
      memory,
      embeddings,
      ids: new UniqueIdGenerator(),
    });
  });

  afterAll(async () => {
    await memory.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ingests the public page into knowledge owned by the first run', async () => {
    expect(pair.cold.state.status).toBe('completed');
    const ingested = pair.coldEvents.ofType('KNOWLEDGE_INGESTED');
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.payload.source).toBe(PUBLIC_PAGE_URL);
    expect(ingested[0]?.payload.title).toBe(PUBLIC_PAGE_TITLE);
    const record = (await memory.store.get(ingested[0]!.payload.recordId)) as
      KnowledgeRecord | undefined;
    expect(record?.kind).toBe('knowledge');
    expect(record?.sources[0]?.url).toBe(PUBLIC_PAGE_URL);
    expect(record?.content).toContain('Sources');
    expect(pair.coldEvents.ofType('TOOL_COMPLETED').map((event) => event.payload.toolName)).toEqual(
      ['web.fetch', 'fs.write'],
    );
  });

  it('retrieves that knowledge on the second run and the plan cites it', () => {
    expect(pair.warm.state.status).toBe('completed');
    const knowledgeId = pair.coldEvents.ofType('KNOWLEDGE_INGESTED')[0]?.payload.recordId;
    const retrieved = pair.warmEvents.ofType('MEMORY_RETRIEVED');
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0]?.payload.recordIds).toContain(knowledgeId);
    expect(retrieved[0]?.payload.hitCount).toBeGreaterThan(0);
    const plan = pair.warmEvents.ofType('PLAN_CREATED')[0];
    expect(plan?.payload.informedByMemoryRecordIds).toEqual([knowledgeId]);
    expect(pair.warmEvents.ofType('TOOL_COMPLETED').map((event) => event.payload.toolName)).toEqual(
      ['fs.write'],
    );
  });

  it('records fewer iterations and tool calls, and the mechanical condition holds', () => {
    const comparison = compareEfficiency(
      {
        ...measured(pair, 'cold'),
        goalStatement: E010_GOAL,
      },
      {
        ...measured(pair, 'warm'),
        goalStatement: E010_GOAL,
      },
    );
    expect(pair.cold.state.usage.iterations).toBe(2);
    expect(pair.warm.state.usage.iterations).toBe(1);
    expect(pair.cold.state.usage.toolCalls).toBe(2);
    expect(pair.warm.state.usage.toolCalls).toBe(1);
    expect(comparison.fewerIterations).toBe(true);
    expect(comparison.fewerToolCalls).toBe(true);
    expect(comparison.warmCitedRetrievedRecord).toBe(true);
    expect(comparison.mechanicalConditionMet).toBe(true);
    expect(comparison.cold.retrievalHitRate).toBe(0);
    expect(comparison.warm.retrievalHitRate).toBe(1);
    expect(pair.cold.measured.comparisonLines).toEqual([]);
    expect(pair.warm.measured.comparisonLines).toEqual([]);
  });

  it('both runs leave a report that contains the required marker', async () => {
    expect(pair.cold.state.status).toBe('completed');
    expect(pair.warm.state.status).toBe('completed');
    const written = pair.warmEvents
      .ofType('TOOL_COMPLETED')
      .find((event) => event.payload.toolName === 'fs.write');
    expect(written).toBeDefined();
    expect(REPORT_PATH).toContain('report.md');
    expect(REQUIRED_MARKER).toBe('## Sources');
  });
});

function measured(pair: EfficiencyPair, which: 'cold' | 'warm') {
  return pair[which].measured.metrics;
}
