import { describe, expect, it } from 'vitest';
import type { IngestionInput } from '../../src/agent/contracts.js';
import { ObservationKnowledgeIngestor } from '../../src/agent/knowledge-ingestor.js';
import type { Observation } from '../../src/domain/observation.js';
import { asActionId, asDecisionId, asObservationId, type ActionId } from '../../src/domain/ids.js';
import type { ToolResult } from '../../src/tools/contracts.js';
import { htmlToText } from '../../src/tools/web/html-to-text.js';
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

function input(
  toolResult: ToolResult<unknown>,
  toolName = toolResult.toolName,
  extras?: { readonly actionId?: ActionId; readonly actionInput?: unknown },
): IngestionInput {
  const plan = makePlan();
  const actionId = extras?.actionId ?? ACTION_ID;
  const observation: Observation = {
    observationId: asObservationId('obs-1'),
    actionId,
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
    action: makeAction({
      actionId,
      toolName,
      input: extras?.actionInput ?? {},
      decisionId: asDecisionId('dec-1'),
    }),
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

const EXAMPLE_HTML = `<!doctype html><html><head><title>Example Domain</title></head>
<body><h1>Example Domain</h1><p>This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.</p></body></html>`;

function httpResponse(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://example.com/',
    finalUrl: 'https://example.com/',
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: EXAMPLE_HTML,
    bodyTruncated: false,
    bodyBytes: EXAMPLE_HTML.length,
    redirects: 0,
    durationMs: 12,
    ...overrides,
  };
}

describe('ObservationKnowledgeIngestor: http.request documents', () => {
  it('turns an HTML page into one knowledge record with the source URL and a capped excerpt', async () => {
    const { knowledge, skipped } = await ingestor().ingest(
      input(okResult('http.request', httpResponse())),
    );
    expect(skipped).toBeUndefined();
    expect(knowledge).toHaveLength(1);
    const record = knowledge[0]!;
    const page = htmlToText(EXAMPLE_HTML);
    expect(record.kind).toBe('knowledge');
    expect(record.title).toBe('Example Domain');
    expect(record.content).toBe(page.text);
    expect(record.content).not.toContain('<');
    expect(record.confidence).toBe(0.5);
    expect(record.tags).toEqual(['ingested', 'http.request', 'example.com']);
    expect(record.sources).toEqual([
      {
        url: 'https://example.com/',
        title: 'Example Domain',
        toolName: 'http.request',
        retrievedAt: '2026-01-01T00:00:02.000Z',
        actionId: ACTION_ID,
      },
    ]);
    expect(record.provenance).toEqual({
      actionIds: [ACTION_ID],
      observationIds: [asObservationId('obs-1')],
      planIds: [makeAction().planId],
      decisionIds: [asDecisionId('dec-1')],
    });
    expect(record.summary).toContain('http.request');
  });

  it('treats an explicit GET the same as the tool default, and keeps plain text', async () => {
    const { knowledge } = await ingestor().ingest(
      input(okResult('http.request', httpResponse()), 'http.request', {
        actionInput: { url: 'https://example.com/', method: 'get' },
      }),
    );
    expect(knowledge).toHaveLength(1);

    const plain = httpResponse({
      url: 'https://example.test/notes.txt',
      finalUrl: 'https://example.test/notes.txt',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: PAGE_TEXT,
    });
    const untitled = await ingestor().ingest(input(okResult('http.request', plain)));
    expect(untitled.knowledge[0]?.title).toBe('https://example.test/notes.txt');
    expect(untitled.knowledge[0]?.content).toBe(PAGE_TEXT);
    expect(untitled.knowledge[0]?.confidence).toBe(0.5);
  });

  it('ingests HTML when the response omitted content-type', async () => {
    const { knowledge } = await ingestor().ingest(
      input(okResult('http.request', httpResponse({ headers: {} }))),
    );
    expect(knowledge[0]?.title).toBe('Example Domain');
    expect(knowledge[0]?.content).toContain('illustrative examples');
  });

  it('caps a long HTML page the same way as web.fetch', async () => {
    const long = `<html><head><title>Long page</title></head><body><p>${'word '.repeat(1000)}</p></body></html>`;
    const { knowledge } = await ingestor({ maxContentChars: 100 }).ingest(
      input(okResult('http.request', httpResponse({ body: long }))),
    );
    const record = knowledge[0]!;
    expect(record.content).toHaveLength(101);
    expect(record.content.endsWith('…')).toBe(true);
    expect(record.summary).toContain('truncated');
  });

  it('does not ingest HTTP errors, non-GET calls, JSON, binary, or noise', async () => {
    const cases: { output: Record<string, unknown>; actionInput?: unknown; skipped: string }[] = [
      {
        output: httpResponse({ status: 404, body: EXAMPLE_HTML }),
        skipped: 'HTTP 404 is not knowledge',
      },
      {
        output: httpResponse(),
        actionInput: { method: 'POST', url: 'https://example.com/' },
        skipped: 'HTTP POST is not a document read',
      },
      {
        output: httpResponse({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'Example Domain', text: PAGE_TEXT }),
        }),
        skipped: 'content type application/json is not a document',
      },
      {
        output: httpResponse({
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify({ ok: true, note: PAGE_TEXT }),
        }),
        skipped: 'http.request body is not a document',
      },
      {
        output: httpResponse({
          headers: { 'content-type': 'application/octet-stream' },
          body: PAGE_TEXT,
        }),
        skipped: 'content type application/octet-stream is not a document',
      },
      {
        output: httpResponse({
          headers: { 'content-type': 'image/png' },
          body: PAGE_TEXT,
        }),
        skipped: 'content type image/png is not a document',
      },
      {
        output: httpResponse({
          headers: { 'content-type': 'text/html' },
          body: `<html><body>${'A'.repeat(80)}\0</body></html>`,
        }),
        skipped: 'http.request body is binary',
      },
      {
        output: httpResponse({ headers: {}, body: 'not-a-page' }),
        skipped: 'http.request body is not a document',
      },
      {
        output: httpResponse({
          headers: { 'content-type': 'text/html' },
          body: '<html><title>Hi</title><body>OK</body></html>',
        }),
        skipped: 'http.request body is not a document',
      },
    ];
    for (const entry of cases) {
      const { knowledge, skipped } = await ingestor().ingest(
        input(okResult('http.request', entry.output), 'http.request', {
          ...(entry.actionInput !== undefined ? { actionInput: entry.actionInput } : {}),
        }),
      );
      expect(knowledge, entry.skipped).toEqual([]);
      expect(skipped, JSON.stringify(entry.output['headers'])).toBe(entry.skipped);
    }

    const shapeless = await ingestor().ingest(
      input(okResult('http.request', { body: EXAMPLE_HTML })),
    );
    expect(shapeless.knowledge).toEqual([]);
    expect(shapeless.skipped).toBe('http.request output lacks url/status/body');
  });

  it('writes one record when web.fetch and http.request read the same URL in one action', async () => {
    const fetched = okResult('web.fetch', {
      url: 'https://example.com',
      finalUrl: 'https://example.com/',
      status: 200,
      contentType: 'text/html',
      title: 'Example Domain',
      text: htmlToText(EXAMPLE_HTML).text,
    });
    const requested = okResult('http.request', httpResponse());

    const fetchFirst = ingestor();
    expect((await fetchFirst.ingest(input(fetched))).knowledge).toHaveLength(1);
    const afterFetch = await fetchFirst.ingest(input(requested));
    expect(afterFetch.knowledge).toEqual([]);
    expect(afterFetch.skipped).toBe('same URL already ingested in this action');

    const httpFirst = ingestor();
    expect((await httpFirst.ingest(input(requested))).knowledge).toHaveLength(1);
    const afterHttp = await httpFirst.ingest(input(fetched));
    expect(afterHttp.knowledge).toEqual([]);
    expect(afterHttp.skipped).toBe('same URL already ingested in this action');
  });

  it('treats a trailing slash as the same document URL within one action', async () => {
    const reader = ingestor();
    const first = await reader.ingest(
      input(
        okResult('web.fetch', {
          url: 'https://example.com/guide',
          finalUrl: 'https://example.com/guide',
          status: 200,
          title: 'Guide',
          text: PAGE_TEXT,
        }),
      ),
    );
    const second = await reader.ingest(
      input(
        okResult(
          'http.request',
          httpResponse({
            url: 'https://example.com/guide/',
            finalUrl: 'https://example.com/guide/',
            body: `<html><head><title>Guide</title></head><body><p>${PAGE_TEXT}</p></body></html>`,
          }),
        ),
      ),
    );
    expect(first.knowledge).toHaveLength(1);
    expect(second.knowledge).toEqual([]);
    expect(second.skipped).toBe('same URL already ingested in this action');
  });

  it('a later action may record the same URL again', async () => {
    const reader = ingestor();
    const page = okResult('http.request', httpResponse());
    const first = await reader.ingest(input(page));
    const second = await reader.ingest(
      input(page, 'http.request', { actionId: asActionId('act-2') }),
    );
    expect(first.knowledge).toHaveLength(1);
    expect(second.knowledge).toHaveLength(1);
    expect(second.knowledge[0]?.sources[0]?.actionId).toBe(asActionId('act-2'));
  });

  it('a different URL in the same action is still knowledge', async () => {
    const reader = ingestor();
    await reader.ingest(input(okResult('http.request', httpResponse())));
    const other = await reader.ingest(
      input(
        okResult(
          'http.request',
          httpResponse({
            url: 'https://example.test/notes.txt',
            finalUrl: 'https://example.test/notes.txt',
            headers: { 'content-type': 'text/plain' },
            body: PAGE_TEXT,
          }),
        ),
      ),
    );
    expect(other.knowledge).toHaveLength(1);
    expect(other.knowledge[0]?.sources[0]?.url).toBe('https://example.test/notes.txt');
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
