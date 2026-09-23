import type {
  AnyAgentEvent,
  EventListener,
  EventSink,
  EventSource,
  Unsubscribe,
} from './contracts.js';

/**
 * In-process fan-out for one run. `AgentRuntime` emits here; the CLI renderer
 * and a later Flame UI subscribe to the same objects. Nothing in this bus
 * invents, filters, or rewrites events. A listener that throws is reported
 * and does not stop the run or the other listeners.
 */
export class SubscribableEventSink implements EventSink, EventSource {
  private readonly listeners = new Set<EventListener>();

  constructor(private readonly onListenerError: (error: unknown) => void = reportListenerError) {}

  emit(event: AnyAgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error: unknown) {
        this.onListenerError(error);
      }
    }
  }

  subscribe(listener: EventListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function reportListenerError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`event listener failed: ${message}\n`);
}
