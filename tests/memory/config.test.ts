import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEMORY_ENV, openMemoryStore, resolveMemoryConfig } from '../../src/memory/config.js';
import { MemoryStoreError } from '../../src/memory/errors.js';
import {
  STORAGE_ENV,
  openPersistentStorage,
  resolveStorageConfig,
} from '../../src/storage/config.js';
import { StorageError } from '../../src/storage/errors.js';
import { knowledge } from '../support/memory-store-contract.js';

describe('memory and storage configuration', () => {
  it('no backend configured means no persistent memory/storage — never a silent default file', () => {
    expect(resolveMemoryConfig({})).toEqual({ kind: 'none' });
    expect(resolveStorageConfig({})).toEqual({ kind: 'none' });
    expect(resolveMemoryConfig({ [MEMORY_ENV.backend]: '  ' })).toEqual({ kind: 'none' });
  });

  it('sqlite needs a path; unknown backends are configuration errors that name the variable', () => {
    expect(() => resolveMemoryConfig({ [MEMORY_ENV.backend]: 'sqlite' })).toThrowError(
      new RegExp(MEMORY_ENV.path),
    );
    const unknown = (() => {
      try {
        resolveMemoryConfig({ [MEMORY_ENV.backend]: 'postgres' });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(unknown).toBeInstanceOf(MemoryStoreError);
    expect((unknown as MemoryStoreError).kind).toBe('configuration');
    expect(
      resolveMemoryConfig({ [MEMORY_ENV.backend]: 'sqlite', [MEMORY_ENV.path]: ' /tmp/m.sqlite ' }),
    ).toEqual({ kind: 'sqlite', path: '/tmp/m.sqlite' });
  });

  it('filesystem storage needs a root; unknown backends are configuration errors', () => {
    expect(() => resolveStorageConfig({ [STORAGE_ENV.backend]: 'filesystem' })).toThrowError(
      new RegExp(STORAGE_ENV.root),
    );
    expect(() => resolveStorageConfig({ [STORAGE_ENV.backend]: 's3' })).toThrowError(StorageError);
    expect(
      resolveStorageConfig({ [STORAGE_ENV.backend]: 'filesystem', [STORAGE_ENV.root]: '/tmp/s' }),
    ).toEqual({ kind: 'filesystem', root: '/tmp/s' });
  });

  it('opens real backends from resolved config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'));
    try {
      const store = openMemoryStore({ kind: 'sqlite', path: join(dir, 'm.sqlite') });
      await store.put(knowledge);
      expect(await store.count()).toBe(1);
      store.close();
      const storage = await openPersistentStorage({
        kind: 'filesystem',
        root: join(dir, 'objects'),
      });
      expect(storage.provider).toBe('local-filesystem');
      await storage.putObject('k', 'v');
      expect(await storage.headObject('k')).toMatchObject({ sizeBytes: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
