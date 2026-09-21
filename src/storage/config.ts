import type { Clock } from '../domain/ids.js';
import { StorageError } from './errors.js';
import { FilesystemStorage } from './local/filesystem-storage.js';
import type { PersistentStorage } from './persistent-storage.js';

/**
 * Configuration-driven object-storage selection.
 *
 * Environment variables (prefixed `AGENT_STORAGE_`):
 *
 *   AGENT_STORAGE_BACKEND  `filesystem` (unset → no persistent storage configured)
 *   AGENT_STORAGE_ROOT     directory for the filesystem backend
 */
export type PersistentStorageConfig =
  { readonly kind: 'none' } | { readonly kind: 'filesystem'; readonly root: string };

export const STORAGE_ENV = {
  backend: 'AGENT_STORAGE_BACKEND',
  root: 'AGENT_STORAGE_ROOT',
} as const;

export type Environment = Readonly<Record<string, string | undefined>>;

export function resolveStorageConfig(env: Environment): PersistentStorageConfig {
  const backend = clean(env[STORAGE_ENV.backend]);
  if (!backend) return { kind: 'none' };
  if (backend !== 'filesystem') {
    throw new StorageError(
      `${STORAGE_ENV.backend}="${backend}" is not a known storage backend (known: filesystem)`,
      'configuration',
    );
  }
  const root = clean(env[STORAGE_ENV.root]);
  if (!root) {
    throw new StorageError(
      `${STORAGE_ENV.backend}=filesystem requires ${STORAGE_ENV.root} (a directory path)`,
      'configuration',
    );
  }
  return { kind: 'filesystem', root };
}

export async function openPersistentStorage(
  config: Exclude<PersistentStorageConfig, { kind: 'none' }>,
  clock?: Clock,
): Promise<PersistentStorage> {
  switch (config.kind) {
    case 'filesystem':
      return FilesystemStorage.open({ root: config.root, ...(clock ? { clock } : {}) });
  }
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
