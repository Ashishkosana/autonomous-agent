/**
 * Failure vocabulary for memory stores. Backends map their own failures onto
 * these kinds so callers reason about "what went wrong" without knowing the
 * database.
 *
 * - `invalid_record`  the caller handed in a record that violates the shape
 *                     every backend relies on (missing id, unknown kind, ...)
 * - `corrupt_record`  a stored row could not be turned back into a record —
 *                     the store refuses to return partial data
 * - `configuration`   the store cannot be opened as configured (bad path,
 *                     schema from a newer version, ...)
 * - `unavailable`     the backend refused or the handle is closed
 */
export type MemoryStoreErrorKind =
  'invalid_record' | 'corrupt_record' | 'configuration' | 'unavailable';

export class MemoryStoreError extends Error {
  constructor(
    message: string,
    readonly kind: MemoryStoreErrorKind,
    readonly recordId?: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MemoryStoreError';
  }
}
