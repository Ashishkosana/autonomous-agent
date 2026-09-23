import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseAgentArgs } from '../src/cli/args.js';
import { parseDotEnv } from '../src/cli/dotenv.js';
import {
  configuredSecrets,
  formatStartupBanner,
  resolveCliStartup,
  type CliStartup,
} from '../src/cli/config.js';
import { AGENT_HELP } from '../src/cli/help.js';
import { formatRunSummary, TerminalEventRenderer } from '../src/cli/render.js';
import { runLocalDockerAgent } from '../src/composition/local-docker-run.js';
import { SystemClock } from '../src/domain/system-clock.js';
import { UniqueIdGenerator } from '../src/domain/unique-ids.js';
import { SubscribableEventSink } from '../src/events/subscriber.js';
import { createEmbeddingProvider, createModelProvider } from '../src/models/config.js';
import { SecretRedactor } from '../src/models/redaction.js';
import { LOCAL_SANDBOX_IMAGE } from '../src/sandbox/local/sandbox-spec.js';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  const parsedEnv = parseDotEnv(readFileSync(envPath, 'utf8'));
  for (const [key, value] of Object.entries(parsedEnv)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const parsed = parseAgentArgs(process.argv.slice(2));
if (parsed.kind === 'help') {
  process.stdout.write(AGENT_HELP);
  process.exit(0);
}
if (parsed.kind === 'error') {
  process.stderr.write(`${parsed.message}\n\n${AGENT_HELP}`);
  process.exit(1);
}

let startup: CliStartup;
try {
  startup = resolveCliStartup(parsed.args, process.env, process.cwd());
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const redactor = new SecretRedactor(configuredSecrets(startup.model, startup.embedding));
const write = (line: string): void => {
  process.stdout.write(`${redactor.redact(line)}\n`);
};
const writeError = (line: string): void => {
  process.stderr.write(`${redactor.redact(line)}\n`);
};

write(formatStartupBanner(startup, `Docker (${LOCAL_SANDBOX_IMAGE})`));
write('');
if (startup.verifiableCriteria.length === 0) {
  write(
    'No mechanical success criterion was given. The run can still act, and the evaluator will report inconclusive rather than success.',
  );
  write('');
}

if (startup.memoryPath !== ':memory:') mkdirSync(dirname(startup.memoryPath), { recursive: true });

const events = new SubscribableEventSink((error) => {
  const message = error instanceof Error ? error.message : String(error);
  writeError(`event listener failed: ${message}`);
});
const renderer = new TerminalEventRenderer(write);
events.subscribe((event) => renderer.handle(event));

const clock = new SystemClock();
const ids = new UniqueIdGenerator();
let cleanup = async (): Promise<void> => {};
let stopRequested = false;
process.once('SIGINT', () => {
  stopRequested = true;
  writeError('Interrupted. Destroying the sandbox.');
  void cleanup().finally(() => {
    process.exit(130);
  });
});

try {
  const embeddings =
    startup.embedding.kind === 'none'
      ? undefined
      : createEmbeddingProvider(startup.embedding, { clock, ids });
  const outcome = await runLocalDockerAgent({
    goalStatement: startup.goalStatement,
    constraints: startup.constraints,
    verifiableCriteria: startup.verifiableCriteria,
    memoryRetrieval: startup.memoryRetrieval,
    memoryPath: startup.memoryPath,
    model: createModelProvider(startup.model, { clock, ids }),
    ...(embeddings ? { embeddings } : {}),
    events,
    limits: startup.limits,
    clock,
    ids,
    registerCleanup: (fn) => {
      cleanup = fn;
    },
    onIndexFailure: (message) => {
      writeError(`Memory index: ${message}`);
    },
  });
  if (stopRequested) {
    // The signal handler destroys the sandbox and exits.
  } else {
    for (const line of formatRunSummary(outcome.state)) write(line);
    process.exit(outcome.state.status === 'completed' ? 0 : 2);
  }
} catch (error: unknown) {
  if (!stopRequested) {
    writeError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
