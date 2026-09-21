/**
 * Failure vocabulary for memory stores. Backends map their own failures onto
 * these kinds so callers reason about "what went wrong" without knowing the
 * database.
 *
 * - `invalid_record`  the caller handed in a record that violates the shape
 *                     every backend relies on (missing id, unknown kind, ...)
 * - `corrupt_record`  a stored row could not be turned back into a record —
 *                     the store refuses to return partial data
 * - `conflict`        the record id already belongs to a record written by a
 *                     different run — an id collision, never a legitimate
 *                     update (a record may be revised only while it keeps
 *                     the runId of the run that wrote it)
 * - `configuration`   the store cannot be opened as configured (bad path,
 *                     schema from a newer version, ...)
 * - `unavailable`     the backend refused or the handle is closed
 */
export type MemoryStoreErrorKind =
  'invalid_record' | 'corrupt_record' | 'conflict' | 'configuration' | 'unavailable';

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
