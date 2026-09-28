import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { formatEfficiencyLines } from '../../src/agent/runtime/efficiency.js';
import { resolveCliStartup, configuredSecrets } from '../../src/cli/config.js';
import { formatRunSummary, renderEvent } from '../../src/cli/render.js';
import { parseAgentArgs } from '../../src/cli/args.js';
import { runSpaceAgent } from '../../src/composition/space-run.js';
import { parseVerifiableCriterion, type VerifiableCriterion } from '../../src/domain/criteria.js';
import type { RunLimits } from '../../src/domain/run.js';
import { SystemClock } from '../../src/domain/system-clock.js';
import { UniqueIdGenerator } from '../../src/domain/unique-ids.js';
import { SubscribableEventSink } from '../../src/events/subscriber.js';
import { openMemoryStore, resolveMemoryConfig, type Environment } from '../../src/memory/config.js';
import type { OpenedMemory } from '../../src/memory/opened-memory.js';
import { createEmbeddingProvider, createModelProvider } from '../../src/models/config.js';
import { SecretRedactor } from '../../src/models/redaction.js';
import { SpaceProcessEnvironment } from '../../src/sandbox/space/space-process-environment.js';

/**
 * Hugging Face Docker Space entrypoint. This file is a composition root:
 * it reads the environment and passes the values in. `src/` does not.
 *
 * Execution is `SpaceProcessEnvironment` (the Space container itself).
 * A free Space has no Docker daemon, so the local-linux and Cloudflare
 * sandbox adapters are not used here. They remain the CLI and Worker paths.
 *
 * Memory is Neon when a connection string is set, otherwise a SQLite file
 * under /tmp that disappears when the Space restarts.
 */

const PORT = Number(process.env['PORT'] ?? '7860');
const SPACE_LIMITS: RunLimits = {
  maxIterations: 8,
  maxToolCalls: 12,
  maxModelCalls: 24,
  maxTotalTokens: 200_000,
  maxDurationMs: 8 * 60_000,
};

const env = spaceMemoryEnv(process.env);
const memoryConfig = safeMemoryConfig(env);
const memoryLabel = memoryConfig.label;
const memoryWarning = memoryConfig.warning;

let memory: OpenedMemory | undefined;
let memoryOpenError: string | undefined;
if (memoryConfig.config.kind !== 'none') {
  try {
    if (memoryConfig.config.kind === 'sqlite' && memoryConfig.config.path !== ':memory:') {
      mkdirSync(dirname(memoryConfig.config.path), { recursive: true });
    }
    memory = await openMemoryStore(memoryConfig.config);
  } catch (error: unknown) {
    memoryOpenError = error instanceof Error ? error.message : String(error);
  }
}

let busy = false;

const server = createServer((request, response) => {
  void handle(request, response);
});
server.requestTimeout = 0;
server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`autonomous-agent space listening on ${PORT}\n${memoryLabel}\n`);
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, {
      ok: true,
      execution: 'space-process',
      nestedDocker: false,
      memory: memoryLabel,
      memoryOpen: memory !== undefined,
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page());
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/run') {
    await runRequest(request, response);
    return;
  }
  sendJson(response, 404, { error: 'not found' });
}

async function runRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (busy) {
    sendJson(response, 409, { error: 'a run is already in progress' });
    return;
  }
  let body: RunBody;
  try {
    body = parseRunBody(JSON.parse(await readBody(request)) as unknown);
  } catch (error: unknown) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (!memory) {
    sendJson(response, 400, {
      error:
        memoryOpenError ?? 'memory is not open. Set DATABASE_URL or NEON_DATABASE_URL for Neon.',
    });
    return;
  }
  let startup;
  try {
    const parsed = parseAgentArgs([body.goal]);
    if (parsed.kind !== 'run') throw new Error('goal is empty');
    startup = resolveCliStartup(
      { ...parsed.args, verifiableCriteria: body.criteria, memoryRetrieval: body.memory },
      env,
      '/tmp',
    );
  } catch (error: unknown) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  busy = true;
  const redactor = new SecretRedactor(
    configuredSecrets(startup.model, startup.embedding, startup.memory),
  );
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
  const id = randomBytes(4).toString('hex');
  const environment = await SpaceProcessEnvironment.start({
    workspaceRoot: `/tmp/agent-space-${id}`,
    environmentId: `space-${id}`,
    ephemeral: true,
  });
  try {
    const clock = new SystemClock();
    const ids = new UniqueIdGenerator();
    const events = new SubscribableEventSink();
    events.subscribe((event) => {
      const lines = renderEvent(event).map((line) => redactor.redact(line));
      if (lines.length > 0) send('agent', { lines });
    });
    const embeddings =
      startup.embedding.kind === 'none'
        ? undefined
        : createEmbeddingProvider(startup.embedding, { clock, ids });
    const outcome = await runSpaceAgent({
      goalStatement: startup.goalStatement,
      constraints: startup.constraints,
      verifiableCriteria: startup.verifiableCriteria,
      memoryRetrieval: startup.memoryRetrieval,
      memory,
      model: createModelProvider(startup.model, { clock, ids }),
      ...(embeddings ? { embeddings } : {}),
      events,
      environment,
      limits: SPACE_LIMITS,
      clock,
      ids,
      onIndexFailure: (message) =>
        send('agent', { lines: [`Memory index: ${redactor.redact(message)}`] }),
      onMetricsFailure: (message) =>
        send('agent', { lines: [`Run metrics: ${redactor.redact(message)}`] }),
    });
    send('done', {
      summary: formatRunSummary(outcome.state).map((line) => redactor.redact(line)),
      efficiency: formatEfficiencyLines(outcome.measured.metrics).map((line) =>
        redactor.redact(line),
      ),
      comparison: outcome.measured.comparisonLines.map((line) => redactor.redact(line)),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    send('error', { message: redactor.redact(message) });
  } finally {
    clearInterval(ping);
    await environment.destroy().catch(() => undefined);
    busy = false;
    response.end();
  }
}

interface RunBody {
  readonly goal: string;
  readonly criteria: readonly VerifiableCriterion[];
  readonly memory: 'on' | 'off';
}

function parseRunBody(value: unknown): RunBody {
  if (typeof value !== 'object' || value === null) throw new Error('body must be a JSON object');
  const record = value as Record<string, unknown>;
  if (typeof record['goal'] !== 'string' || record['goal'].trim() === '')
    throw new Error('goal is required');
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
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(payload);
}

function spaceMemoryEnv(source: NodeJS.ProcessEnv): Environment {
  const out: Record<string, string | undefined> = { ...source };
  const backend = out['AGENT_MEMORY_BACKEND']?.trim() ?? '';
  const hasUrl = Boolean(
    out['AGENT_MEMORY_URL']?.trim() ||
    out['NEON_DATABASE_URL']?.trim() ||
    out['DATABASE_URL']?.trim(),
  );
  if (backend === '' && hasUrl) out['AGENT_MEMORY_BACKEND'] = 'neon';
  if (backend === '' && !hasUrl) {
    out['AGENT_MEMORY_BACKEND'] = 'sqlite';
    out['AGENT_MEMORY_PATH'] =
      out['AGENT_MEMORY_PATH']?.trim() || '/tmp/agent-memory/memory.sqlite';
  }
  if (backend === 'sqlite' && !out['AGENT_MEMORY_PATH']?.trim()) {
    out['AGENT_MEMORY_PATH'] = '/tmp/agent-memory/memory.sqlite';
  }
  return out;
}

function safeMemoryConfig(source: Environment): {
  readonly config: ReturnType<typeof resolveMemoryConfig>;
  readonly label: string;
  readonly warning: string;
} {
  try {
    const config = resolveMemoryConfig(source);
    if (config.kind === 'neon') {
      return {
        config,
        label: `Memory: Neon Postgres (password not shown)`,
        warning:
          'Records in Neon survive a Space restart. This page never prints the connection string.',
      };
    }
    if (config.kind === 'sqlite') {
      return {
        config,
        label: `Memory: SQLite at ${config.path}`,
        warning:
          'This file lives inside the Space container. A restart or sleep drops it. Set DATABASE_URL (or NEON_DATABASE_URL) to keep memory in Neon.',
      };
    }
    return {
      config,
      label: 'Memory: not configured',
      warning: 'Set DATABASE_URL or AGENT_MEMORY_BACKEND.',
    };
  } catch (error: unknown) {
    return {
      config: { kind: 'none' },
      label: 'Memory: configuration error',
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

function page(): string {
  const warning = escapeHtml(
    memoryOpenError ? `${memoryWarning} ${memoryOpenError}` : memoryWarning,
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Autonomous agent</title>
  <style>
    body { font: 16px/1.45 ui-sans-serif, system-ui, sans-serif; margin: 0; background: #f6f4ef; color: #1c1915; }
    main { max-width: 52rem; margin: 0 auto; padding: 1.5rem; }
    h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
    .note, .warn { background: #fff; border: 1px solid #ddd6c8; border-radius: 8px; padding: 0.8rem 1rem; }
    .warn { background: #fff6e8; }
    label { display: block; font-weight: 600; margin-top: 1rem; }
    textarea, input, select, button { font: inherit; width: 100%; box-sizing: border-box; }
    textarea { min-height: 6rem; }
    button { width: auto; margin-top: 1rem; padding: 0.5rem 1rem; }
    pre { white-space: pre-wrap; background: #1c1915; color: #f6f4ef; padding: 1rem; border-radius: 8px; min-height: 8rem; }
  </style>
</head>
<body>
<main>
  <h1>Autonomous agent</h1>
  <p>One goal, mechanical criteria, and a stream of real events. Memory stores what the run read and did. It does not train model weights.</p>
  <p class="note">${escapeHtml(memoryLabel)}</p>
  <p class="warn">${warning}</p>
  <p class="warn">Execution is this Space container, not a nested Docker sandbox. Free Spaces have no Docker daemon. Shell commands run as the Space user and do not inherit secret environment variables, but they can read other files in the container. Do not put secrets in the image, and prefer a private Space.</p>
  <form id="run">
    <label for="goal">Goal</label>
    <textarea id="goal" name="goal">Create /workspace/hello.txt containing exactly AGENT_ALIVE</textarea>
    <label for="criteria">Mechanical criteria, one per line</label>
    <textarea id="criteria" name="criteria">file_contains:/workspace/hello.txt|AGENT_ALIVE</textarea>
    <label for="memory">Retrieval</label>
    <select id="memory" name="memory">
      <option value="on">on — retrieve records from earlier runs</option>
      <option value="off">off — write records, do not read them</option>
    </select>
    <button type="submit">Run goal</button>
  </form>
  <h2>Events</h2>
  <pre id="log">Waiting.</pre>
</main>
<script>
  const log = document.getElementById('log');
  document.getElementById('run').addEventListener('submit', async (event) => {
    event.preventDefault();
    log.textContent = '';
    const goal = document.getElementById('goal').value;
    const criteria = document.getElementById('criteria').value;
    const memory = document.getElementById('memory').value;
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal, criteria, memory }),
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
      const parts = buffer.split('\\n\\n');
      buffer = parts.pop() || '';
      for (const part of parts) append(part);
    }
    if (buffer.trim()) append(buffer);
  });
  function append(part) {
    const dataLine = part.split('\\n').find((line) => line.startsWith('data: '));
    if (!dataLine) return;
    let payload;
    try { payload = JSON.parse(dataLine.slice(6)); } catch { return; }
    const lines = payload.lines || payload.summary || payload.efficiency || payload.comparison || [];
    if (payload.message) lines.push(payload.message);
    if (lines.length) log.textContent += lines.join('\\n') + '\\n';
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
