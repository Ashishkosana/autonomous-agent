/**
 * Failure vocabulary for persistent object storage.
 *
 * - `invalid_key`    the key cannot name an object in any backend (empty,
 *                    traversal, forbidden characters) — refused before I/O
 * - `configuration`  the storage cannot be opened as configured
 * - `unavailable`    the backend refused the operation
 */
export type StorageErrorKind = 'invalid_key' | 'configuration' | 'unavailable';

export class StorageError extends Error {
  constructor(
    message: string,
    readonly kind: StorageErrorKind,
    readonly key?: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StorageError';
  }
}
