import type { MemoryRecordId } from '../domain/ids.js';
import type { AnyAgentEvent } from '../events/contracts.js';

/**
 * Exposure counted from the event stream. This is instrumentation, not
 * confirmation: a record that was cited is not thereby the cause of the
 * action, and task success does not increment a confirmed counter.
 */
export interface MemoryExposure {
  readonly retrieved: number;
  readonly presented: number;
  readonly cited: number;
}

export function exposureFromEvents(
  events: readonly AnyAgentEvent[],
): ReadonlyMap<MemoryRecordId, MemoryExposure> {
  const counts = new Map<MemoryRecordId, { retrieved: number; presented: number; cited: number }>();
  const bump = (id: MemoryRecordId, field: keyof MemoryExposure) => {
    const current = counts.get(id) ?? { retrieved: 0, presented: 0, cited: 0 };
    current[field] += 1;
    counts.set(id, current);
  };
  for (const event of events) {
    if (event.type === 'MEMORY_RETRIEVED') {
      for (const id of event.payload.recordIds) bump(id, 'retrieved');
    } else if (event.type === 'MEMORY_PRESENTED') {
      for (const id of event.payload.recordIds) bump(id, 'presented');
    } else if (event.type === 'PLAN_CREATED') {
      for (const id of event.payload.informedByMemoryRecordIds) bump(id, 'cited');
    } else if (event.type === 'PLAN_UPDATED') {
      for (const id of event.payload.informedByMemoryRecordIds ?? []) bump(id, 'cited');
    }
  }
  return counts;
}
