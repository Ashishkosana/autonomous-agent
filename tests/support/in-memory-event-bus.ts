import type {
  AgentEventType,
  AnyAgentEvent,
  EventListener,
  EventSink,
  EventSource,
  Unsubscribe,
} from '../../src/events/contracts.js';

/** Test-only sink + source. Keeps every event so tests can assert on the stream. */
export class InMemoryEventBus implements EventSink, EventSource {
  readonly events: AnyAgentEvent[] = [];
  private readonly listeners = new Set<EventListener>();

  emit(event: AnyAgentEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: EventListener): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  ofType<T extends AgentEventType>(type: T): Extract<AnyAgentEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<AnyAgentEvent, { type: T }> => e.type === type);
  }
}
