import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compareStoredRuns } from '../../src/agent/runtime/efficiency.js';
import { openMemoryStore } from '../../src/memory/config.js';
import type { OpenedMemory } from '../../src/memory/opened-memory.js';
import type { RunMetricsRecord } from '../../src/memory/run-metrics.js';
import { knowledge } from '../support/memory-store-contract.js';

function metrics(overrides: Partial<RunMetricsRecord> = {}): RunMetricsRecord {
  return {
    runId: 'run-1',
    goalStatement: 'Read https://example.com and write the lesson',
    status: 'completed',
    succeeded: true,
    iterations: 2,
    toolCalls: 2,
    modelCalls: 3,
    inputTokens: 20,
    outputTokens: 8,
    totalTokens: 28,
    durationMs: 900,
    retrievalHitRate: 0,
    retrievalHitCount: 0,
    signalsUsed: ['keyword'],
    citedRecordIds: [],
    retrievedRecordIds: [],
    ...overrides,
  };
}

describe('SQLite run metrics', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  async function open(): Promise<OpenedMemory> {
    const dir = mkdtempSync(join(tmpdir(), 'agent-metrics-'));
    dirs.push(dir);
    return openMemoryStore({ kind: 'sqlite', path: join(dir, 'memory.sqlite') });
  }

  it('writes a run and reads it back after reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-metrics-'));
    dirs.push(dir);
    const path = join(dir, 'memory.sqlite');
    const first = await openMemoryStore({ kind: 'sqlite', path });
    await first.recordEfficiency?.(metrics());
    await first.store.put(knowledge);
    await first.close();

    const again = await openMemoryStore({ kind: 'sqlite', path });
    try {
      await again.ping?.();
      const latest = await again.latestEfficiency?.(
        'Read https://example.com and write the lesson',
      );
      expect(latest?.durationMs).toBe(900);
      expect(latest?.toolCalls).toBe(2);
      expect(await again.store.get(knowledge.recordId)).toMatchObject({ kind: 'knowledge' });
    } finally {
      await again.close();
    }
  });

  it('compares the two latest runs of the same goal', async () => {
    const memory = await open();
    try {
      await memory.recordEfficiency?.(metrics({ runId: 'cold', durationMs: 2_000, toolCalls: 4 }));
      await memory.recordEfficiency?.(
        metrics({
          runId: 'warm',
          durationMs: 500,
          iterations: 1,
          toolCalls: 1,
          retrievalHitRate: 1,
          retrievalHitCount: 1,
          citedRecordIds: ['mem-1'],
          retrievedRecordIds: ['mem-1'],
        }),
      );
      const compared = await compareStoredRuns(
        memory,
        'Read https://example.com and write the lesson',
      );
      expect(compared.comparison?.fewerToolCalls).toBe(true);
      expect(compared.comparison?.fewerIterations).toBe(true);
      expect(compared.comparison?.shorterDuration).toBe(true);
      expect(compared.comparison?.mechanicalConditionMet).toBe(true);
      expect(compared.lines.join('\n')).toContain('does not train foundation-model weights');
      const other = await compareStoredRuns(memory, 'a different goal');
      expect(other.comparison).toBeUndefined();
      expect(other.lines.join('\n')).toContain('No stored runs');
    } finally {
      await memory.close();
    }
  });
});
