import { describe, expect, it } from 'vitest';
import { StorageError } from '../../src/storage/errors.js';
import type { PersistentStorage } from '../../src/storage/persistent-storage.js';

/**
 * Behaviour every PersistentStorage must exhibit. Run over each real backend
 * (local filesystem today; an object store later) so callers cannot tell them
 * apart except by `provider`.
 */
export interface StorageHarness {
  readonly storage: PersistentStorage;
  close(): Promise<void> | void;
}

const text = (body: Uint8Array) => new TextDecoder().decode(body);

export function describePersistentStorageContract(
  name: string,
  open: () => Promise<StorageHarness> | StorageHarness,
): void {
  describe(`PersistentStorage contract · ${name}`, () => {
    it('stores a string body and returns the same bytes with metadata', async () => {
      const h = await open();
      try {
        await h.storage.putObject('reports/run-1/report.md', '# Report\n\nÜnïcödé ✓\n', {
          contentType: 'text/markdown',
          custom: { runId: 'run-1', artifactId: 'art-1' },
        });
        const object = await h.storage.getObject('reports/run-1/report.md');
        expect(object).not.toBeNull();
        expect(text(object!.body)).toBe('# Report\n\nÜnïcödé ✓\n');
        expect(object!.metadata).toMatchObject({
          key: 'reports/run-1/report.md',
          sizeBytes: new TextEncoder().encode('# Report\n\nÜnïcödé ✓\n').byteLength,
          contentType: 'text/markdown',
          custom: { runId: 'run-1', artifactId: 'art-1' },
        });
        expect(Date.parse(object!.metadata.updatedAt)).not.toBeNaN();
        expect(h.storage.provider.length).toBeGreaterThan(0);
      } finally {
        await h.close();
      }
    });

    it('stores binary bodies exactly, including zero bytes', async () => {
      const h = await open();
      try {
        const bytes = new Uint8Array([0, 1, 2, 255, 0, 128, 10, 13]);
        await h.storage.putObject('bin/blob', bytes);
        const object = await h.storage.getObject('bin/blob');
        expect([...object!.body]).toEqual([...bytes]);
        expect(object!.metadata.sizeBytes).toBe(8);
        expect(object!.metadata.contentType).toBeUndefined();
        expect(object!.metadata.custom).toEqual({});
      } finally {
        await h.close();
      }
    });

    it('head returns metadata without the body; missing keys are null, not errors', async () => {
      const h = await open();
      try {
        expect(await h.storage.headObject('nothing/here')).toBeNull();
        expect(await h.storage.getObject('nothing/here')).toBeNull();
        await h.storage.putObject('a/b', 'x');
        expect(await h.storage.headObject('a/b')).toMatchObject({ key: 'a/b', sizeBytes: 1 });
      } finally {
        await h.close();
      }
    });

    it('put overwrites in place and delete is idempotent', async () => {
      const h = await open();
      try {
        await h.storage.putObject('k', 'first', { custom: { v: '1' } });
        await h.storage.putObject('k', 'second, longer', { custom: { v: '2' } });
        const object = await h.storage.getObject('k');
        expect(text(object!.body)).toBe('second, longer');
        expect(object!.metadata.custom).toEqual({ v: '2' });
        await h.storage.deleteObject('k');
        expect(await h.storage.getObject('k')).toBeNull();
        await h.storage.deleteObject('k');
        expect(await h.storage.listObjects('')).toEqual([]);
      } finally {
        await h.close();
      }
    });

    it('lists by prefix in key order and honours the limit', async () => {
      const h = await open();
      try {
        for (const key of ['runs/2/b', 'runs/1/z', 'runs/1/a', 'other/x', 'runs/10/c']) {
          await h.storage.putObject(key, key);
        }
        const keys = (prefix: string, limit?: number) =>
          h.storage.listObjects(prefix, limit).then((list) => list.map((m) => m.key));
        expect(await keys('runs/')).toEqual(['runs/1/a', 'runs/1/z', 'runs/10/c', 'runs/2/b']);
        expect(await keys('runs/1/')).toEqual(['runs/1/a', 'runs/1/z']);
        expect(await keys('runs/1')).toEqual(['runs/1/a', 'runs/1/z', 'runs/10/c']);
        expect(await keys('runs/', 2)).toEqual(['runs/1/a', 'runs/1/z']);
        expect(await keys('')).toHaveLength(5);
        expect(await keys('missing/')).toEqual([]);
      } finally {
        await h.close();
      }
    });

    it('refuses keys that could escape or alias: traversal, absolute, empty segments, odd characters', async () => {
      const h = await open();
      try {
        const bad = [
          '',
          '/abs',
          'a//b',
          'a/',
          '../escape',
          'a/../b',
          'a/./b',
          '.hidden',
          'a b',
          'a\\b',
          'a\0b',
          'ünï',
          'x'.repeat(600),
        ];
        for (const key of bad) {
          for (const op of [
            () => h.storage.putObject(key, 'x'),
            () => h.storage.getObject(key),
            () => h.storage.headObject(key),
            () => h.storage.deleteObject(key),
          ]) {
            const error = await op().then(
              () => undefined,
              (e: unknown) => e,
            );
            expect(error, JSON.stringify(key)).toBeInstanceOf(StorageError);
            expect((error as StorageError).kind).toBe('invalid_key');
          }
        }
        expect(await h.storage.listObjects('')).toEqual([]);
        const listError = await h.storage.listObjects('../x').then(
          () => undefined,
          (e: unknown) => e,
        );
        expect((listError as StorageError).kind).toBe('invalid_key');
      } finally {
        await h.close();
      }
    });
  });
}
