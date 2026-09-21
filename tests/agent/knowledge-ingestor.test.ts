import { describe, expect, it } from 'vitest';
import type { IngestionInput } from '../../src/agent/contracts.js';
import { ObservationKnowledgeIngestor } from '../../src/agent/knowledge-ingestor.js';
import type { Observation } from '../../src/domain/observation.js';
import { asDecisionId, asObservationId } from '../../src/domain/ids.js';
import type { ToolResult } from '../../src/tools/contracts.js';
import { FixedClock, SequentialIdGenerator } from '../support/deterministic.js';
import { ACTION_ID, CORRELATION, makeAction, makeGoal, makePlan } from '../support/fixtures.js';

const PAGE_TEXT =
  'The Sources section of a research report lists every reference the author consulted, one per line.';

function okResult(toolName: string, output: unknown): ToolResult<unknown> {
  return {
    toolName,
    actionId: ACTION_ID,
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:00:02.000Z',
    durationMs: 1000,
    status: 'ok',
    output,
  };
}

function errorResult(toolName: string): ToolResult<unknown> {
  return {
    toolName,
    actionId: ACTION_ID,
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:00:02.000Z',
    durationMs: 1000,
    status: 'error',
    error: { code: 'execution_failed', message: 'connection refused', retryable: true },
  };
}

function input(toolResult: ToolResult<unknown>, toolName = toolResult.toolName): IngestionInput {
  const plan = makePlan();
  const observation: Observation = {
    observationId: asObservationId('obs-1'),
    actionId: ACTION_ID,
    correlation: CORRELATION,
    toolResult,
    artifacts: [],
    summary: `${toolName} finished`,
    observedAt: '2026-01-01T00:00:02.000Z',
  };
  return {
    correlation: CORRELATION,
    goal: makeGoal(),
    task: plan.tasks[0]!,
    action: makeAction({ toolName, input: {}, decisionId: asDecisionId('dec-1') }),
    observation,
  };
}

function ingestor(options?: ConstructorParameters<typeof ObservationKnowledgeIngestor>[2]) {
  return new ObservationKnowledgeIngestor(new SequentialIdGenerator(), new FixedClock(), options);
}

describe('ObservationKnowledgeIngestor: web.fetch', () => {
  const fetched = okResult('web.fetch', {
    url: 'http://example.test/style',
    finalUrl: 'https://example.test/style/',
    status: 200,
    contentType: 'text/html',
    title: 'Report style guide',
    text: PAGE_TEXT,
  });

  it('turns a fetched page into one knowledge record that names its source', async () => {
    const { knowledge, skipped } = await ingestor().ingest(input(fetched));
    expect(skipped).toBeUndefined();
    expect(knowledge).toHaveLength(1);
    const record = knowledge[0]!;
    expect(record.kind).toBe('knowledge');
    expect(record.title).toBe('Report style guide');
    expect(record.content).toBe(PAGE_TEXT);
    expect(record.confidence).toBe(0.5);
    expect(record.tags).toEqual(['ingested', 'web.fetch', 'example.test']);
    expect(record.sources).toEqual([
      {
        url: 'https://example.test/style/',
        title: 'Report style guide',
        toolName: 'web.fetch',
        retrievedAt: '2026-01-01T00:00:02.000Z',
        actionId: ACTION_ID,
      },
    ]);
  });

  it('carries the correlation and full provenance of the action that fetched it', async () => {
    const { knowledge } = await ingestor().ingest(input(fetched));
    const record = knowledge[0]!;
    expect(record.runId).toBe(CORRELATION.runId);
    expect(record.goalId).toBe(CORRELATION.goalId);
    expect(record.taskId).toBe(CORRELATION.taskId);
    expect(record.provenance).toEqual({
      actionIds: [ACTION_ID],
      observationIds: [asObservationId('obs-1')],
      planIds: [makeAction().planId],
      decisionIds: [asDecisionId('dec-1')],
    });
    expect(record.summary).toContain('web.fetch');
    expect(record.summary).toContain(`${PAGE_TEXT.length} chars`);
  });

  it('falls back to the URL as title when the page had none', async () => {
    const untitled = okResult('web.fetch', {
      url: 'https://example.test/plain.txt',
      finalUrl: 'https://example.test/plain.txt',
      status: 200,
      contentType: 'text/plain',
      title: undefined,
      text: PAGE_TEXT,
    });
    const { knowledge } = await ingestor().ingest(input(untitled));
    expect(knowledge[0]?.title).toBe('https://example.test/plain.txt');
  });

  it('an HTTP error page is not knowledge even though the tool call succeeded', async () => {
    const notFound = okResult('web.fetch', {
      url: 'https://example.test/missing',
      finalUrl: 'https://example.test/missing',
      status: 404,
      title: 'Not Found',
      text: 'The page you requested could not be found on this server. Check the address.',
    });
    const { knowledge, skipped } = await ingestor().ingest(input(notFound));
    expect(knowledge).toEqual([]);
    expect(skipped).toBe('HTTP 404 is not knowledge');
  });

  it('caps long content and says so in the summary', async () => {
    const long = okResult('web.fetch', {
      url: 'https://example.test/long',
      finalUrl: 'https://example.test/long',
      status: 200,
      title: 'Long page',
      text: 'word '.repeat(1000),
    });
    const { knowledge } = await ingestor({ maxContentChars: 100 }).ingest(input(long));
    const record = knowledge[0]!;
    expect(record.content).toHaveLength(101);
    expect(record.content.endsWith('…')).toBe(true);
    expect(record.summary).toContain('truncated');
  });
});

describe('ObservationKnowledgeIngestor: fs.read', () => {
  it('turns a file read from the sandbox into a lower-confidence record tagged as a sandbox file', async () => {
    const read = okResult('fs.read', {
      path: '/workspace/notes/style.md',
      content: `# Style\n\n${PAGE_TEXT}\n`,
      truncated: false,
    });
    const { knowledge } = await ingestor().ingest(input(read));
    expect(knowledge).toHaveLength(1);
    const record = knowledge[0]!;
    expect(record.title).toBe('/workspace/notes/style.md');
    expect(record.content).toBe(`# Style\n\n${PAGE_TEXT}`);
    expect(record.confidence).toBe(0.4);
    expect(record.tags).toEqual(['ingested', 'fs.read', 'sandbox-file']);
    expect(record.sources[0]).toMatchObject({
      title: '/workspace/notes/style.md',
      toolName: 'fs.read',
      actionId: ACTION_ID,
    });
    expect(record.sources[0]).not.toHaveProperty('url');
  });

  it('a nearly empty file is not worth a record', async () => {
    const read = okResult('fs.read', { path: '/workspace/x', content: 'ok\n', truncated: false });
    const { knowledge, skipped } = await ingestor().ingest(input(read));
    expect(knowledge).toEqual([]);
    expect(skipped).toBe('content too short (2 chars)');
  });
});

describe('ObservationKnowledgeIngestor: what is never knowledge', () => {
  it('a failed tool call', async () => {
    const { knowledge, skipped } = await ingestor().ingest(input(errorResult('web.fetch')));
    expect(knowledge).toEqual([]);
    expect(skipped).toBe('tool call did not complete');
  });

  it('a tool that returns no ingestible content', async () => {
    const { knowledge, skipped } = await ingestor().ingest(
      input(okResult('fs.write', { path: '/workspace/report.md', bytes: 120, created: true })),
    );
    expect(knowledge).toEqual([]);
    expect(skipped).toBe('fs.write does not return ingestible content');
  });

  it('a tool registered under a standard name that returns a different shape', async () => {
    const impostor = okResult('web.fetch', { body: PAGE_TEXT });
    const { knowledge, skipped } = await ingestor().ingest(input(impostor));
    expect(knowledge).toEqual([]);
    expect(skipped).toBe('web.fetch output lacks url/status/text');

    const notObject = okResult('fs.read', PAGE_TEXT);
    expect((await ingestor().ingest(input(notObject))).skipped).toBe('output is not an object');
  });
});
