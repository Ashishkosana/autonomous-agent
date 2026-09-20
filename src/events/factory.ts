import { asEventId, type Clock, type GoalId, type IdGenerator, type RunId } from '../domain/ids.js';
import {
  EVENT_SCHEMA_VERSION,
  type AgentEvent,
  type AgentEventPayloads,
  type AgentEventType,
  type EventCorrelation,
} from './contracts.js';

/**
 * Builds correctly-stamped events for one run. Sequence numbers are assigned
 * here so that ordering is a property of the run, not of the transport.
 */
export class RunEventFactory {
  private sequence = 0;

  constructor(
    private readonly runId: RunId,
    private readonly goalId: GoalId | undefined,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  create<TType extends AgentEventType>(
    type: TType,
    payload: AgentEventPayloads[TType],
    correlation: EventCorrelation = {},
  ): AgentEvent<TType> {
    this.sequence += 1;
    const event: AgentEvent<TType> = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: asEventId(this.ids.next('evt')),
      sequence: this.sequence,
      timestamp: this.clock.now(),
      runId: this.runId,
      type,
      correlation,
      payload,
      ...(this.goalId !== undefined ? { goalId: this.goalId } : {}),
    };
    return event;
  }

  get lastSequence(): number {
    return this.sequence;
  }
}
