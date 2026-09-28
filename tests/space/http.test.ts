import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openMemoryStore } from '../../src/memory/config.js';
import type { OpenedMemory } from '../../src/memory/opened-memory.js';
import type { RunMetricsRecord } from '../../src/memory/run-metrics.js';
import {
  DEMO_CRITERIA,
  DEMO_GOAL,
  LEARNING_STATEMENT,
  createSpaceApp,
  type PreparedSpaceRun,
} from '../../spaces/huggingface/app.js';

function metrics(runId: string, overrides: Partial<RunMetricsRecord> = {}): RunMetricsRecord {
  return {
    runId,
    goalStatement: DEMO_GOAL,
    status: 'completed',
    succeeded: true,
    iterations: runId === 'warm' ? 1 : 2,
    toolCalls: runId === 'warm' ? 1 : 2,
    modelCalls: 2,
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    durationMs: runId === 'warm' ? 400 : 900,
    retrievalHitRate: runId === 'warm' ? 1 : 0,
    retrievalHitCount: runId === 'warm' ? 1 : 0,
    signalsUsed: ['keyword'],
    citedRecordIds: runId === 'warm' ? ['mem-1'] : [],
    retrievedRecordIds: runId === 'warm' ? ['mem-1'] : [],
    ...overrides,
  };
}

describe('space HTTP app', () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  const handles: OpenedMemory[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    await Promise.all(handles.splice(0).map((memory) => memory.close()));
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  async function start(options?: {
    readonly memory?: OpenedMemory;
    readonly failPing?: boolean;
  }): Promise<{ readonly base: string; readonly memory: OpenedMemory | undefined }> {
    const dir = mkdtempSync(join(tmpdir(), 'agent-space-http-'));
    dirs.push(dir);
    const memory =
      options?.memory ??
      (await openMemoryStore({ kind: 'sqlite', path: join(dir, 'memory.sqlite') }));
    if (options?.memory === undefined) handles.push(memory);
    const wrapped: OpenedMemory | undefined = options?.failPing
      ? {
          ...memory,
          ping: () => Promise.reject(new Error('postgres://user:secret@db/agent')),
        }
      : memory;
    const app = createSpaceApp({
      memory: wrapped,
      memoryLabel: 'Memory: SQLite (test)',
      memoryWarning: 'test warning',
      memoryBackend: 'sqlite',
      startRun: () => {
        const prepared: PreparedSpaceRun = {
          async execute(emit) {
            emit('done', {
              summary: ['dry run'],
              efficiency: ['Duration: 1 ms'],
              comparison: [],
            });
          },
        };
        return Promise.resolve(prepared);
      },
    });
    const server = createServer((request, response) => {
      void app(request, response);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${address.port}`, memory };
  }

  it('health reports durable-memory learning and a reachable database', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      learning: string;
      fineTuning: boolean;
      nestedDocker: boolean;
      memory: { reachable: boolean; backend: string };
    };
    expect(body).toMatchObject({
      ok: true,
      learning: 'durable-memory',
      fineTuning: false,
      nestedDocker: false,
      memory: { backend: 'sqlite', open: true, reachable: true },
    });
    expect(JSON.stringify(body)).not.toContain('postgres://');
  });

  it('health fails when the database ping fails and does not echo the error', async () => {
    const { base } = await start({ failPing: true });
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain('"ok":false');
    expect(text).toContain('"reachable":false');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('postgres://');
  });

  it('serves the public-web demo and says this is not fine-tuning', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(LEARNING_STATEMENT);
    expect(html).toContain('does not fine-tune');
    expect(html).toContain(DEMO_GOAL);
    expect(html).toContain(DEMO_CRITERIA);
    expect(html).toContain('https://example.com');
    expect(html).toContain('goal → retrieve memory → plan');
  });

  it('compares two stored runs of the demo goal', async () => {
    const { base, memory } = await start();
    if (!memory) throw new Error('memory missing');
    await memory.recordEfficiency?.(metrics('cold'));
    await memory.recordEfficiency?.(metrics('warm'));
    const response = await fetch(`${base}/api/compare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: DEMO_GOAL }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      fewerToolCalls: boolean;
      shorterDuration: boolean;
      mechanicalConditionMet: boolean;
      fineTuning: boolean;
      lines: string[];
    };
    expect(body.fineTuning).toBe(false);
    expect(body.fewerToolCalls).toBe(true);
    expect(body.shorterDuration).toBe(true);
    expect(body.mechanicalConditionMet).toBe(true);
    expect(body.lines.join('\n')).toContain('does not train foundation-model weights');
  });

  it('runs a dry loop through the API without calling a model', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: DEMO_GOAL, criteria: DEMO_CRITERIA, memory: 'on' }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('dry run');
    expect(text).toContain('Duration: 1 ms');
  });
});
