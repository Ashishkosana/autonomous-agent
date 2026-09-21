import { MemoryStoreError } from './errors.js';
import { SqliteMemoryStore } from './sqlite/sqlite-memory-store.js';
import type { MemoryStore } from './store.js';

/**
 * Configuration-driven memory backend selection, mirroring `models/config.ts`:
 * the runtime never names a database; the operator names a backend and a
 * location, and the composition root opens it.
 *
 * Environment variables (prefixed `AGENT_MEMORY_`):
 *
 *   AGENT_MEMORY_BACKEND   `sqlite` (unset → no persistent memory configured)
 *   AGENT_MEMORY_PATH      SQLite file path; `:memory:` for a store that dies with the process
 */
export type MemoryStoreConfig =
  { readonly kind: 'none' } | { readonly kind: 'sqlite'; readonly path: string };

export const MEMORY_ENV = {
  backend: 'AGENT_MEMORY_BACKEND',
  path: 'AGENT_MEMORY_PATH',
} as const;

export type Environment = Readonly<Record<string, string | undefined>>;

export function resolveMemoryConfig(env: Environment): MemoryStoreConfig {
  const backend = clean(env[MEMORY_ENV.backend]);
  if (!backend) return { kind: 'none' };
  if (backend !== 'sqlite') {
    throw new MemoryStoreError(
      `${MEMORY_ENV.backend}="${backend}" is not a known memory backend (known: sqlite)`,
      'configuration',
    );
  }
  const path = clean(env[MEMORY_ENV.path]);
  if (!path) {
    throw new MemoryStoreError(
      `${MEMORY_ENV.backend}=sqlite requires ${MEMORY_ENV.path} (a file path, or :memory:)`,
      'configuration',
    );
  }
  return { kind: 'sqlite', path };
}

/** Opens the configured store. Callers own the handle and must `close()` it. */
export function openMemoryStore(
  config: Exclude<MemoryStoreConfig, { kind: 'none' }>,
): MemoryStore & { close(): void } {
  switch (config.kind) {
    case 'sqlite':
      return SqliteMemoryStore.open({ path: config.path });
  }
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
