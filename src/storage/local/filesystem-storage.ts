import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Clock } from '../../domain/ids.js';
import { SystemClock } from '../../domain/system-clock.js';
import { StorageError } from '../errors.js';
import { assertValidKey, assertValidPrefix } from '../keys.js';
import type {
  PersistentStorage,
  PutObjectOptions,
  StoredObject,
  StoredObjectMetadata,
} from '../persistent-storage.js';

/**
 * PersistentStorage on a local directory (ADR-005). Bodies live under
 * `<root>/objects/<key>` and metadata as JSON under `<root>/metadata/<key>.json`;
 * both are written to a temporary file and renamed into place so a crash
 * mid-write never leaves a half object visible. The key grammar
 * (`../keys.ts`) is what keeps every path inside the root — and it is checked
 * again after resolution, so a bug in the grammar cannot escape either.
 *
 * This is a development backend; the same contract maps onto Cloudflare R2
 * or any object store later without touching callers.
 */
export interface FilesystemStorageOptions {
  readonly root: string;
  readonly clock?: Clock;
}

const OBJECTS = 'objects';
const METADATA = 'metadata';

export class FilesystemStorage implements PersistentStorage {
  readonly provider = 'local-filesystem';

  static async open(options: FilesystemStorageOptions): Promise<FilesystemStorage> {
    const root = resolve(options.root);
    try {
      await mkdir(join(root, OBJECTS), { recursive: true });
      await mkdir(join(root, METADATA), { recursive: true });
    } catch (error: unknown) {
      throw new StorageError(
        `Cannot open storage root "${root}": ${describe(error)}`,
        'configuration',
        undefined,
        { cause: error },
      );
    }
    return new FilesystemStorage(root, options.clock ?? new SystemClock());
  }

  private constructor(
    readonly root: string,
    private readonly clock: Clock,
  ) {}

  async putObject(
    key: string,
    body: Uint8Array | string,
    options: PutObjectOptions = {},
  ): Promise<void> {
    assertValidKey(key);
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    const metadata: StoredObjectMetadata = {
      key,
      sizeBytes: bytes.byteLength,
      ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
      updatedAt: this.clock.now(),
      custom: { ...(options.custom ?? {}) },
    };
    try {
      await atomicWrite(this.objectPath(key), bytes);
      await atomicWrite(this.metadataPath(key), JSON.stringify(metadata));
    } catch (error: unknown) {
      throw this.unavailable(`store "${key}"`, key, error);
    }
  }

  async getObject(key: string): Promise<StoredObject | null> {
    const metadata = await this.headObject(key);
    if (!metadata) return null;
    try {
      const body = new Uint8Array(await readFile(this.objectPath(key)));
      return { metadata, body };
    } catch (error: unknown) {
      if (isMissing(error)) return null;
      throw this.unavailable(`read "${key}"`, key, error);
    }
  }

  async headObject(key: string): Promise<StoredObjectMetadata | null> {
    assertValidKey(key);
    let raw: string;
    try {
      raw = await readFile(this.metadataPath(key), 'utf8');
    } catch (error: unknown) {
      if (isMissing(error)) return null;
      throw this.unavailable(`inspect "${key}"`, key, error);
    }
    const parsed = JSON.parse(raw) as StoredObjectMetadata;
    if (parsed.key !== key) {
      throw new StorageError(
        `Metadata for "${key}" names a different object ("${parsed.key}")`,
        'unavailable',
        key,
      );
    }
    return parsed;
  }

  async deleteObject(key: string): Promise<void> {
    assertValidKey(key);
    try {
      await rm(this.metadataPath(key), { force: true });
      await rm(this.objectPath(key), { force: true });
    } catch (error: unknown) {
      throw this.unavailable(`delete "${key}"`, key, error);
    }
  }

  async listObjects(prefix: string, limit?: number): Promise<readonly StoredObjectMetadata[]> {
    assertValidPrefix(prefix);
    const metadataRoot = join(this.root, METADATA);
    const keys: string[] = [];
    try {
      for (const entry of await readdir(metadataRoot, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const full = join(entry.parentPath, entry.name);
        const key = relative(metadataRoot, full).split(sep).join('/').slice(0, -'.json'.length);
        if (key.startsWith(prefix)) keys.push(key);
      }
    } catch (error: unknown) {
      throw this.unavailable(`list "${prefix}"`, undefined, error);
    }
    keys.sort();
    const selected = limit === undefined ? keys : keys.slice(0, Math.max(0, limit));
    const out: StoredObjectMetadata[] = [];
    for (const key of selected) {
      const metadata = await this.headObject(key);
      if (metadata) out.push(metadata);
    }
    return out;
  }

  private objectPath(key: string): string {
    return this.confined(join(this.root, OBJECTS, ...key.split('/')));
  }

  private metadataPath(key: string): string {
    return this.confined(join(this.root, METADATA, ...key.split('/')) + '.json');
  }

  /** Defence in depth: the key grammar already forbids traversal; this makes escaping impossible regardless. */
  private confined(path: string): string {
    const resolved = resolve(path);
    if (resolved !== this.root && !resolved.startsWith(this.root + sep)) {
      throw new StorageError(`Path "${path}" resolves outside the storage root`, 'invalid_key');
    }
    return resolved;
  }

  private unavailable(what: string, key: string | undefined, cause: unknown): StorageError {
    return new StorageError(`Storage could not ${what}: ${describe(cause)}`, 'unavailable', key, {
      cause,
    });
  }
}

async function atomicWrite(path: string, data: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (error: unknown) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'ENOENT';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
