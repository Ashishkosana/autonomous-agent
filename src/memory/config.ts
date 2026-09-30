import { NeonDatabase } from '../adapters/neon/neon-database.js';
import { MemoryStoreError } from './errors.js';
import type { OpenedMemory } from './opened-memory.js';
import { SqliteMemoryStore } from './sqlite/sqlite-memory-store.js';
import { SqliteSemanticIndex } from './sqlite/sqlite-semantic-index.js';
import type { EmbeddingProvider } from '../models/embeddings.js';

/**
 * Configuration-driven memory backend selection, mirroring `models/config.ts`:
 * the runtime never names a database; the operator names a backend and a
 * location, and the composition root opens it.
 *
 * Environment variables:
 *
 *   AGENT_MEMORY_BACKEND     `sqlite` or `neon` (unset → no persistent memory configured)
 *   AGENT_MEMORY_PATH        SQLite file path; `:memory:` dies with the process
 *   AGENT_MEMORY_URL         optional connection-string override for `neon`
 *   NEON_DATABASE_URL        Neon connection string
 *   DATABASE_URL             connection string used when the two above are unset
 *
 * `neon` does not dual-write to SQLite. One process has one source of truth.
 * SQLite remains the local fallback when `neon` is not selected.
 */
export type MemoryStoreConfig =
  | { readonly kind: 'none' }
  | { readonly kind: 'sqlite'; readonly path: string }
  | { readonly kind: 'neon'; readonly connectionString: string };

export const MEMORY_ENV = {
  backend: 'AGENT_MEMORY_BACKEND',
  path: 'AGENT_MEMORY_PATH',
  url: 'AGENT_MEMORY_URL',
  neonDatabaseUrl: 'NEON_DATABASE_URL',
  databaseUrl: 'DATABASE_URL',
} as const;

export type Environment = Readonly<Record<string, string | undefined>>;

export function resolveMemoryConfig(env: Environment): MemoryStoreConfig {
  const backend = clean(env[MEMORY_ENV.backend]);
  if (!backend) return { kind: 'none' };
  if (backend === 'neon') {
    const connectionString =
      clean(env[MEMORY_ENV.url]) ??
      clean(env[MEMORY_ENV.neonDatabaseUrl]) ??
      clean(env[MEMORY_ENV.databaseUrl]);
    if (!connectionString) {
      throw new MemoryStoreError(
        `${MEMORY_ENV.backend}=neon requires ${MEMORY_ENV.url}, ${MEMORY_ENV.neonDatabaseUrl}, or ${MEMORY_ENV.databaseUrl}`,
        'configuration',
      );
    }
    return { kind: 'neon', connectionString };
  }
  if (backend !== 'sqlite') {
    throw new MemoryStoreError(
      `${MEMORY_ENV.backend}="${backend}" is not a known memory backend (known: sqlite, neon)`,
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

/**
 * Opens the configured backend. Callers own the handle and must `close()` it.
 * SQLite opens synchronously inside the promise; Neon connects and migrates.
 */
export async function openMemoryStore(
  config: Exclude<MemoryStoreConfig, { kind: 'none' }>,
): Promise<OpenedMemory> {
  switch (config.kind) {
    case 'sqlite':
      return openSqlite(config.path);
    case 'neon':
      return NeonDatabase.open({ connectionString: config.connectionString });
  }
}

function openSqlite(path: string): OpenedMemory {
  const store = SqliteMemoryStore.open({ path });
  let index: SqliteSemanticIndex | undefined;
  return {
    kind: 'sqlite',
    store,
    openSemanticIndex(embeddings: EmbeddingProvider) {
      index?.close();
      index = SqliteSemanticIndex.open({ path, embeddings });
      return index;
    },
    close() {
      index?.close();
      store.close();
    },
  };
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
