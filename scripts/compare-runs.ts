import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareStoredRuns } from '../src/agent/runtime/efficiency.js';
import { resolveCliMemory } from '../src/cli/config.js';
import { parseDotEnv } from '../src/cli/dotenv.js';
import { openMemoryStore } from '../src/memory/config.js';
import type { OpenedMemory } from '../src/memory/opened-memory.js';

/**
 * Prints the efficiency comparison for the two latest stored runs of one goal.
 * Does not start a model or a sandbox. Uses the same memory backend as
 * `npm run agent` (SQLite by default, Neon when AGENT_MEMORY_BACKEND=neon).
 */

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  const parsedEnv = parseDotEnv(readFileSync(envPath, 'utf8'));
  for (const [key, value] of Object.entries(parsedEnv)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const goal = process.argv.slice(2).join(' ').trim();
if (goal === '' || goal === '--help' || goal === '-h') {
  process.stdout.write(
    `Compare the two latest stored runs of one goal.

Usage
  npm run compare -- "the same goal you already ran twice"

This reads durable memory. It does not fine-tune model weights and it does not
call the model. Neon is used when AGENT_MEMORY_BACKEND=neon; otherwise the CLI
SQLite file is used.
`,
  );
  process.exit(goal === '' ? 1 : 0);
}

let memory: OpenedMemory | undefined;
try {
  const selected = resolveCliMemory(process.env, process.cwd());
  memory =
    selected.kind === 'neon'
      ? await openMemoryStore({ kind: 'neon', connectionString: selected.connectionString })
      : await openMemoryStore({ kind: 'sqlite', path: selected.path });
  const compared = await compareStoredRuns(memory, goal);
  for (const line of compared.lines) process.stdout.write(`${line}\n`);
  process.exitCode = compared.comparison ? 0 : 2;
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
} finally {
  await memory?.close();
}
