import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { formatEfficiencyLines } from '../../src/agent/runtime/efficiency.js';
import { resolveCliStartup, configuredSecrets } from '../../src/cli/config.js';
import { formatRunSummary, renderEvent } from '../../src/cli/render.js';
import { parseAgentArgs } from '../../src/cli/args.js';
import { runSpaceAgent } from '../../src/composition/space-run.js';
import type { RunLimits } from '../../src/domain/run.js';
import { SystemClock } from '../../src/domain/system-clock.js';
import { UniqueIdGenerator } from '../../src/domain/unique-ids.js';
import { SubscribableEventSink } from '../../src/events/subscriber.js';
import { openMemoryStore, resolveMemoryConfig, type Environment } from '../../src/memory/config.js';
import type { OpenedMemory } from '../../src/memory/opened-memory.js';
import { createEmbeddingProvider, createModelProvider } from '../../src/models/config.js';
import { SecretRedactor } from '../../src/models/redaction.js';
import { SpaceProcessEnvironment } from '../../src/sandbox/space/space-process-environment.js';
import { createSpaceApp, type PreparedSpaceRun, type SpaceRunRequest } from './app.js';

/**
 * Hugging Face Space and Railway entrypoint. This file is a composition root:
 * it reads the environment and passes the values in. `src/` does not.
 *
 * One process serves health, the page, and the run API. Execution is
 * `SpaceProcessEnvironment` (this container). There is no nested Docker daemon.
 *
 * Memory is Neon when a connection string is set, otherwise a SQLite file
 * under /tmp that disappears when the container restarts.
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

const app = createSpaceApp({
  memory,
  memoryLabel,
  memoryWarning: memoryOpenError ? `${memoryWarning} ${memoryOpenError}` : memoryWarning,
  memoryBackend: memory?.kind ?? memoryConfig.config.kind,
  startRun,
});

const server = createServer((request, response) => {
  void app(request, response);
});
server.requestTimeout = 0;
server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(
    `autonomous-agent listening on ${PORT}\n${memoryLabel}\nlearning=durable-memory fineTuning=false nestedDocker=false\n`,
  );
});

async function startRun(body: SpaceRunRequest): Promise<PreparedSpaceRun> {
  if (!memory) throw new Error('memory is not open');
  const parsed = parseAgentArgs([body.goal]);
  if (parsed.kind !== 'run') throw new Error('goal is empty');
  const startup = resolveCliStartup(
    { ...parsed.args, verifiableCriteria: body.criteria, memoryRetrieval: body.memory },
    env,
    '/tmp',
  );
  const opened = memory;
  return {
    async execute(send) {
      const redactor = new SecretRedactor(
        configuredSecrets(startup.model, startup.embedding, startup.memory),
      );
      const id = randomBytes(4).toString('hex');
      const environment = await SpaceProcessEnvironment.start({
        // Real files live here. `/workspace/...` in the goal and in tool
        // commands is mapped onto this directory.
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
          memory: opened,
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
      } finally {
        await environment.destroy().catch(() => undefined);
      }
    },
  };
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
        label: 'Memory: Neon Postgres (password not shown)',
        warning:
          'Records in Neon survive a restart. This page never prints the connection string. Learning is durable memory, not model fine-tuning.',
      };
    }
    if (config.kind === 'sqlite') {
      return {
        config,
        label: `Memory: SQLite at ${config.path}`,
        warning:
          'This file lives inside the container. A restart or sleep drops it. Set DATABASE_URL (or NEON_DATABASE_URL) to keep memory in Neon. Learning is durable memory, not model fine-tuning.',
      };
    }
    return {
      config: { kind: 'none' },
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
