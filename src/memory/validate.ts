import { MemoryStoreError } from './errors.js';
import { PERSISTENT_MEMORY_KINDS, type PersistentMemoryRecord } from './records.js';

/**
 * The invariants every MemoryStore relies on for indexing and retrieval,
 * checked at the boundary so that a backend never has to trust its caller.
 * Field-level schemas of the individual kinds are OPEN and deliberately not
 * checked here — only the shared base that stores index on.
 */
export function assertStorableRecord(record: unknown): asserts record is PersistentMemoryRecord {
  const problems = storableRecordProblems(record);
  if (problems.length > 0) {
    const id = (record as { recordId?: unknown } | null)?.recordId;
    throw new MemoryStoreError(
      `Refusing to store memory record: ${problems.join('; ')}`,
      'invalid_record',
      typeof id === 'string' ? id : undefined,
    );
  }
}

export function storableRecordProblems(record: unknown): string[] {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return ['record is not an object'];
  }
  const r = record as Record<string, unknown>;
  const problems: string[] = [];
  if (!nonEmptyString(r['recordId'])) problems.push('recordId must be a non-empty string');
  if (!PERSISTENT_MEMORY_KINDS.includes(r['kind'] as never)) {
    problems.push(`kind must be one of ${PERSISTENT_MEMORY_KINDS.join(', ')}`);
  }
  if (!nonEmptyString(r['runId'])) problems.push('runId must be a non-empty string');
  if (r['goalId'] !== undefined && !nonEmptyString(r['goalId'])) {
    problems.push('goalId must be a non-empty string when present');
  }
  if (r['taskId'] !== undefined && !nonEmptyString(r['taskId'])) {
    problems.push('taskId must be a non-empty string when present');
  }
  if (!nonEmptyString(r['createdAt']) || Number.isNaN(Date.parse(r['createdAt'] as string))) {
    problems.push('createdAt must be an ISO-8601 timestamp');
  }
  if (typeof r['summary'] !== 'string') problems.push('summary must be a string');
  if (!Array.isArray(r['tags']) || !r['tags'].every((t) => typeof t === 'string')) {
    problems.push('tags must be an array of strings');
  }
  if (typeof r['provenance'] !== 'object' || r['provenance'] === null) {
    problems.push('provenance must be an object');
  }
  return problems;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
