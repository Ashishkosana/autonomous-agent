import type { PersistentMemoryRecord } from './records.js';

/**
 * The text a record is *found by* — for keyword matching and for embedding
 * alike, so that both retrieval signals see the same words. It is the fields
 * a human would search; raw tool payloads are never indexed.
 */
export function searchableText(record: PersistentMemoryRecord): string {
  const base = `${record.summary} ${record.tags.join(' ')}`;
  switch (record.kind) {
    case 'knowledge':
      return `${base} ${record.title} ${record.content}`;
    case 'experience':
      return `${base} ${record.toolName} ${record.inputSummary}`;
    case 'decision':
      return `${base} ${record.context} ${record.reason}`;
    case 'lesson':
      return `${base} ${record.statement} ${record.applicability.join(' ')}`;
  }
}
