import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asArtifactId, asGoalId, asRunId } from '../../src/domain/ids.js';
import type { ArtifactRef } from '../../src/domain/artifact.js';
import { archiveArtifacts, archiveKey } from '../../src/storage/archive.js';
import { StorageError } from '../../src/storage/errors.js';
import { FilesystemStorage } from '../../src/storage/local/filesystem-storage.js';
import { FixedClock } from '../support/deterministic.js';
import { FakeExecutionEnvironment } from '../support/fake-execution-environment.js';
import { describePersistentStorageContract } from '../support/persistent-storage-contract.js';

describePersistentStorageContract('FilesystemStorage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-storage-contract-'));
  const storage = await FilesystemStorage.open({ root: dir, clock: new FixedClock() });
  return { storage, close: () => rmSync(dir, { recursive: true, force: true }) };
});

describe('FilesystemStorage specifics', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-storage-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('objects survive the handle: a second FilesystemStorage on the same root sees them', async () => {
    const first = await FilesystemStorage.open({ root: join(dir, 'store') });
    await first.putObject('runs/r1/report.md', '# kept', { custom: { runId: 'r1' } });
    const second = await FilesystemStorage.open({ root: join(dir, 'store') });
    const object = await second.getObject('runs/r1/report.md');
    expect(new TextDecoder().decode(object!.body)).toBe('# kept');
    expect(object!.metadata.custom).toEqual({ runId: 'r1' });
  });

  it('never writes outside its root, and leaves no temp files behind', async () => {
    const root = join(dir, 'store');
    const storage = await FilesystemStorage.open({ root });
    await storage.putObject('a/b/c.txt', 'x');
    const everything = readdirSync(root, { recursive: true }) as string[];
    expect(everything.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(everything.map((f) => f.split('\\').join('/')).sort()).toEqual([
      'metadata',
      'metadata/a',
      'metadata/a/b',
      'metadata/a/b/c.txt.json',
      'objects',
      'objects/a',
      'objects/a/b',
      'objects/a/b/c.txt',
    ]);
    expect(readdirSync(dir)).toEqual(['store']);
    expect(storage.root).toBe(resolve(root));
  });

  it('metadata that names a different key is refused rather than trusted', async () => {
    const root = join(dir, 'store');
    const storage = await FilesystemStorage.open({ root });
    await storage.putObject('honest', 'x');
    writeFileSync(
      join(root, 'metadata', 'honest.json'),
      JSON.stringify({ key: 'someone-else', sizeBytes: 1, updatedAt: 'now', custom: {} }),
    );
    const error = await storage.headObject('honest').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
  });

  it('an unusable root is a configuration error', async () => {
    writeFileSync(join(dir, 'file'), 'not a directory');
    const error = await FilesystemStorage.open({ root: join(dir, 'file') }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).kind).toBe('configuration');
  });
});

describe('archiveArtifacts: sandbox artifacts are promoted to persistent storage', () => {
  const clock = new FixedClock();
  const ref = (path: string, id = 'art-1'): ArtifactRef => ({
    artifactId: asArtifactId(id),
    kind: 'report',
    location: { storage: 'sandbox', path },
    correlation: { runId: asRunId('run-7'), goalId: asGoalId('goal-7') },
    description: 'the report',
    contentType: 'text/markdown',
    producedBy: {},
    createdAt: clock.now(),
  });

  it('copies each artifact independently, rewrites its location, emits ARTIFACT_STORED, and reports failures without aborting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-archive-'));
    try {
      const environment = new FakeExecutionEnvironment();
      await environment.writeFile('/workspace/report.md', '# Report\n\n## Sources\n- x\n');
      const storage = await FilesystemStorage.open({ root: dir, clock });
      const emitted: unknown[] = [];
      const results = await archiveArtifacts(
        environment,
        [
          ref('/workspace/report.md'),
          ref('/workspace/missing.md', 'art-2'),
          { ...ref('/workspace/x', 'art-3'), location: { storage: 'persistent', key: 'k' } },
        ],
        storage,
        { prefix: 'artifacts', clock, emit: (payload) => emitted.push(payload) },
      );
      expect(results.map((r) => r.status)).toEqual(['stored', 'failed', 'skipped']);
      const stored = results[0]!;
      expect(stored.status === 'stored' && stored.stored.location).toEqual({
        storage: 'persistent',
        key: 'artifacts/run-7/art-1/report.md',
      });
      const object = await storage.getObject('artifacts/run-7/art-1/report.md');
      expect(new TextDecoder().decode(object!.body)).toContain('## Sources');
      expect(object!.metadata.custom).toMatchObject({
        artifactId: 'art-1',
        runId: 'run-7',
        sandboxPath: '/workspace/report.md',
      });
      expect(emitted).toEqual([
        {
          artifactId: 'art-1',
          sandboxPath: '/workspace/report.md',
          storageProvider: 'local-filesystem',
          key: 'artifacts/run-7/art-1/report.md',
          sizeBytes: object!.metadata.sizeBytes,
        },
      ]);
      expect(existsSync(join(dir, 'objects', 'artifacts', 'run-7', 'art-1', 'report.md'))).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives keys that always satisfy the key grammar, whatever the sandbox path looks like', () => {
    const odd = ref('/tmp/weird dir/..hidden name?.txt');
    expect(
      archiveKey('artifacts', odd, odd.location.storage === 'sandbox' ? odd.location.path : ''),
    ).toBe('artifacts/run-7/art-1/hidden_name_.txt');
    expect(archiveKey('a', ref('/'), '/')).toBe('a/run-7/art-1/artifact');
  });
});
