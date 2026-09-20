/**
 * Object/file storage that survives sandbox termination. Used for artifacts,
 * reports, raw content, and exported memory. The concrete backend (Cloudflare
 * R2 is the natural candidate) is chosen in Phase 4 and recorded in an ADR.
 */

export interface StoredObjectMetadata {
  readonly key: string;
  readonly sizeBytes: number;
  readonly contentType?: string;
  readonly updatedAt: string;
  readonly custom: Readonly<Record<string, string>>;
}

export interface PutObjectOptions {
  readonly contentType?: string;
  readonly custom?: Readonly<Record<string, string>>;
}

export interface StoredObject {
  readonly metadata: StoredObjectMetadata;
  readonly body: Uint8Array;
}

export interface PersistentStorage {
  readonly provider: string;
  putObject(key: string, body: Uint8Array | string, options?: PutObjectOptions): Promise<void>;
  getObject(key: string): Promise<StoredObject | null>;
  headObject(key: string): Promise<StoredObjectMetadata | null>;
  deleteObject(key: string): Promise<void>;
  listObjects(prefix: string, limit?: number): Promise<readonly StoredObjectMetadata[]>;
}
