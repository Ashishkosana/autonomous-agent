import type { IncomingMessage, ServerResponse } from 'node:http';
import { compareStoredRuns } from '../../src/agent/runtime/efficiency.js';
import { parseVerifiableCriterion, type VerifiableCriterion } from '../../src/domain/criteria.js';
import type { OpenedMemory } from '../../src/memory/opened-memory.js';
import { PERSISTENT_MEMORY_KINDS } from '../../src/memory/records.js';

/**
 * Default public-internet goal. The second run of this same text is the
 * efficiency comparison. example.com is a stable public page.
 */
export const DEMO_GOAL =
  'Read the public page https://example.com. Write /workspace/lesson.txt containing the page title and one lesson worth reusing on a later run of this same goal.';

export const DEMO_CRITERIA = 'file_contains:/workspace/lesson.txt|Example Domain';

export const LEARNING_STATEMENT =
  'This agent learns by writing durable memory — knowledge, experience, decisions, and lessons — into Neon Postgres (or SQLite on a single machine). It does not fine-tune or train model weights.';

export interface SpaceRunRequest {
  readonly goal: string;
  readonly criteria: readonly VerifiableCriterion[];
  readonly memory: 'on' | 'off';
}

export interface PreparedSpaceRun {
  execute(emit: (event: string, data: unknown) => void): Promise<void>;
}

export interface SpaceAppOptions {
  readonly memory: OpenedMemory | undefined;
  readonly memoryLabel: string;
  readonly memoryWarning: string;
  readonly memoryBackend: 'neon' | 'sqlite' | 'none';
  startRun(request: SpaceRunRequest): Promise<PreparedSpaceRun>;
}

export function createSpaceApp(
  options: SpaceAppOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  let busy = false;
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/health') {
      await sendHealth(response, options);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page(options));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/memory') {
      await sendMemory(response, options.memory);
      return;
    }
    if (
      (request.method === 'GET' || request.method === 'POST') &&
      url.pathname === '/api/compare'
    ) {
      await sendCompare(request, response, url, options.memory);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/run') {
      await runRequest(
        request,
        response,
        options,
        () => busy,
        (value) => {
          busy = value;
        },
      );
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  };
}

async function sendHealth(response: ServerResponse, options: SpaceAppOptions): Promise<void> {
  let reachable = false;
  if (options.memory?.ping) {
    try {
      await options.memory.ping();
      reachable = true;
    } catch {
      reachable = false;
    }
  }
  const open = options.memory !== undefined;
  const ok = open && reachable;
  sendJson(response, ok ? 200 : 503, {
    ok,
    learning: 'durable-memory',
    fineTuning: false,
    execution: 'space-process',
    nestedDocker: false,
    memory: {
      backend: options.memoryBackend,
      open,
      reachable,
    },
  });
}

async function sendMemory(
  response: ServerResponse,
  memory: OpenedMemory | undefined,
): Promise<void> {
  if (!memory) {
    sendJson(response, 400, { error: 'memory is not open' });
    return;
  }
  const counts: Record<string, number> = {};
  for (const kind of PERSISTENT_MEMORY_KINDS) {
    counts[kind] = await memory.store.count({ kinds: [kind] });
  }
  const runs = memory.listEfficiency ? await memory.listEfficiency({ limit: 8 }) : [];
  sendJson(response, 200, {
    learning: 'durable-memory',
    fineTuning: false,
    counts,
    runs: runs.map(publicMetrics),
  });
}

async function sendCompare(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  memory: OpenedMemory | undefined,
): Promise<void> {
  if (!memory) {
    sendJson(response, 400, { error: 'memory is not open' });
    return;
  }
  let goal = url.searchParams.get('goal') ?? '';
  if (request.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(request)) as unknown;
      if (
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { goal?: unknown }).goal === 'string'
      ) {
        goal = (body as { goal: string }).goal;
      }
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
  }
  const trimmed = goal.trim();
  if (trimmed === '') {
    sendJson(response, 400, { error: 'goal is required' });
    return;
  }
  if (trimmed.length > 4_000) {
    sendJson(response, 400, { error: 'goal is too long' });
    return;
  }
  const compared = await compareStoredRuns(memory, trimmed);
  sendJson(response, 200, {
    learning: 'durable-memory',
    fineTuning: false,
    goal: compared.goalStatement,
    lines: compared.lines,
    mechanicalConditionMet: compared.comparison?.mechanicalConditionMet ?? false,
    sameGoal: compared.comparison?.sameGoal ?? false,
    fewerIterations: compared.comparison?.fewerIterations ?? false,
    fewerToolCalls: compared.comparison?.fewerToolCalls ?? false,
    fewerTokens: compared.comparison?.fewerTokens ?? false,
    shorterDuration: compared.comparison?.shorterDuration ?? false,
    runs: compared.runs.map(publicMetrics),
    note: compared.comparison?.note,
  });
}

async function runRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: SpaceAppOptions,
  isBusy: () => boolean,
  setBusy: (value: boolean) => void,
): Promise<void> {
  if (isBusy()) {
    sendJson(response, 409, { error: 'a run is already in progress' });
    return;
  }
  let body: SpaceRunRequest;
  try {
    body = parseRunBody(JSON.parse(await readBody(request)) as unknown);
  } catch (error: unknown) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (!options.memory) {
    sendJson(response, 400, {
      error: 'memory is not open. Set DATABASE_URL or NEON_DATABASE_URL for Neon.',
    });
    return;
  }
  setBusy(true);
  let prepared: PreparedSpaceRun;
  try {
    prepared = await options.startRun(body);
  } catch (error: unknown) {
    setBusy(false);
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const ping = setInterval(() => {
    response.write(': ping\n\n');
  }, 15_000);
  const send = (event: string, data: unknown) => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  try {
    await prepared.execute(send);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    send('error', { message });
  } finally {
    clearInterval(ping);
    setBusy(false);
    response.end();
  }
}

export function parseRunBody(value: unknown): SpaceRunRequest {
  if (typeof value !== 'object' || value === null) throw new Error('body must be a JSON object');
  const record = value as Record<string, unknown>;
  if (typeof record['goal'] !== 'string' || record['goal'].trim() === '') {
    throw new Error('goal is required');
  }
  if (record['goal'].length > 4_000) throw new Error('goal is too long');
  const rawCriteria = record['criteria'];
  const lines = Array.isArray(rawCriteria)
    ? rawCriteria.filter((item): item is string => typeof item === 'string')
    : typeof rawCriteria === 'string'
      ? rawCriteria.split('\n')
      : [];
  if (lines.length > 20) throw new Error('too many criteria');
  const criteria: VerifiableCriterion[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const parsed = parseVerifiableCriterion(trimmed);
    if (!parsed) throw new Error(`criterion not recognised: ${trimmed}`);
    criteria.push(parsed);
  }
  const memory = record['memory'] === 'off' ? 'off' : 'on';
  return { goal: record['goal'].trim(), criteria, memory };
}

function publicMetrics(snapshot: {
  readonly runId: string;
  readonly status: string;
  readonly succeeded: boolean;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly modelCalls: number;
  readonly totalTokens: number;
  readonly durationMs: number;
  readonly retrievalHitCount: number;
}): {
  readonly runId: string;
  readonly status: string;
  readonly succeeded: boolean;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly modelCalls: number;
  readonly totalTokens: number;
  readonly durationMs: number;
  readonly retrievalHitCount: number;
} {
  return {
    runId: snapshot.runId,
    status: snapshot.status,
    succeeded: snapshot.succeeded,
    iterations: snapshot.iterations,
    toolCalls: snapshot.toolCalls,
    modelCalls: snapshot.modelCalls,
    totalTokens: snapshot.totalTokens,
    durationMs: snapshot.durationMs,
    retrievalHitCount: snapshot.retrievalHitCount,
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function page(options: SpaceAppOptions): string {
  const warning = escapeHtml(options.memoryWarning);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Autonomous agent — durable memory</title>
  <style>
    body { font: 16px/1.45 ui-sans-serif, system-ui, sans-serif; margin: 0; background: #f6f4ef; color: #1c1915; }
    main { max-width: 52rem; margin: 0 auto; padding: 1.5rem; }
    h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
    .note, .warn, .loop { background: #fff; border: 1px solid #ddd6c8; border-radius: 8px; padding: 0.8rem 1rem; }
    .warn { background: #fff6e8; }
    .loop { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; }
    label { display: block; font-weight: 600; margin-top: 1rem; }
    textarea, select, button { font: inherit; width: 100%; box-sizing: border-box; }
    textarea { min-height: 6rem; }
    .actions { display: flex; gap: 0.75rem; flex-wrap: wrap; }
    button { width: auto; margin-top: 1rem; padding: 0.5rem 1rem; }
    pre { white-space: pre-wrap; background: #1c1915; color: #f6f4ef; padding: 1rem; border-radius: 8px; min-height: 8rem; }
  </style>
</head>
<body>
<main>
  <h1>Autonomous agent</h1>
  <p>${escapeHtml(LEARNING_STATEMENT)} A later run retrieves those records before it plans. Efficiency is measured — steps, tool calls, tokens, and duration — and is not a learning score.</p>
  <p class="note">${escapeHtml(options.memoryLabel)}</p>
  <p class="warn">${warning}</p>
  <p class="loop">goal → retrieve memory → plan
  → decide → tools → observe → evaluate
  → write knowledge | experience | decision | lesson
  → on failure, retrieve again and revise
  → continue until done or a limit</p>
  <p id="counts">Memory counts load when the page opens.</p>
  <form id="run">
    <label for="goal">Goal</label>
    <textarea id="goal" name="goal">${escapeHtml(DEMO_GOAL)}</textarea>
    <label for="criteria">Mechanical criteria, one per line. The model cannot declare success.</label>
    <textarea id="criteria" name="criteria">${escapeHtml(DEMO_CRITERIA)}</textarea>
    <label for="memory">Retrieval</label>
    <select id="memory" name="memory">
      <option value="on">on — retrieve records from earlier runs</option>
      <option value="off">off — write records, do not read them</option>
    </select>
    <div class="actions">
      <button type="submit">Run goal</button>
      <button type="button" id="compare">Compare last two runs of this goal</button>
    </div>
  </form>
  <h2>Events</h2>
  <pre id="log">Waiting.</pre>
</main>
<script>
  const log = document.getElementById('log');
  const goalEl = document.getElementById('goal');
  const criteriaEl = document.getElementById('criteria');
  const memoryEl = document.getElementById('memory');
  const counts = document.getElementById('counts');
  loadMemory();
  document.getElementById('run').addEventListener('submit', async (event) => {
    event.preventDefault();
    log.textContent = '';
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goal: goalEl.value,
        criteria: criteriaEl.value,
        memory: memoryEl.value,
      }),
    });
    if (!response.ok || !response.body) {
      log.textContent = await response.text();
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split(String.fromCharCode(10) + String.fromCharCode(10));
      buffer = parts.pop() || '';
      for (const part of parts) append(part);
    }
    if (buffer.trim()) append(buffer);
    loadMemory();
  });
  document.getElementById('compare').addEventListener('click', async () => {
    log.textContent = '';
    const response = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: goalEl.value.trim() }),
    });
    const payload = await response.json();
    const lines = payload.lines || [];
    if (payload.error) lines.push(payload.error);
    log.textContent = lines.join(String.fromCharCode(10));
  });
  async function loadMemory() {
    const response = await fetch('/api/memory');
    if (!response.ok) {
      counts.textContent = 'Memory summary is unavailable.';
      return;
    }
    const payload = await response.json();
    const countsText = Object.entries(payload.counts || {}).map(([kind, n]) => kind + ' ' + n).join(', ');
    const runCount = (payload.runs || []).length;
    counts.textContent = 'Stored records: ' + (countsText || 'none') + '. Recent measured runs: ' + runCount + '.';
  }
  function append(part) {
    const dataLine = part.split(String.fromCharCode(10)).find((line) => line.startsWith('data: '));
    if (!dataLine) return;
    let payload;
    try { payload = JSON.parse(dataLine.slice(6)); } catch { return; }
    const lines = [];
    if (payload.lines) lines.push(...payload.lines);
    if (payload.summary) lines.push(...payload.summary);
    if (payload.efficiency) lines.push(...payload.efficiency);
    if (payload.comparison) lines.push(...payload.comparison);
    if (payload.message) lines.push(payload.message);
    if (lines.length) log.textContent += lines.join(String.fromCharCode(10)) + String.fromCharCode(10);
  }
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
