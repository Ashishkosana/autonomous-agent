import type { ToolResult } from '../tools/contracts.js';
import type { ArtifactRef } from './artifact.js';
import type { ActionId, IsoTimestamp, ObservationId } from './ids.js';
import type { RunCorrelation } from './provenance.js';

/**
 * What the runtime observed after executing an action. This is raw evidence:
 * it records what happened, not whether it was good. Judgement belongs to
 * the evaluator.
 */
export interface Observation {
  readonly observationId: ObservationId;
  readonly actionId: ActionId;
  readonly correlation: RunCorrelation;
  readonly toolResult: ToolResult<unknown>;
  /** Artifacts the action produced or modified. */
  readonly artifacts: readonly ArtifactRef[];
  /** Short human-readable description of the outcome, for the dashboard. */
  readonly summary: string;
  readonly observedAt: IsoTimestamp;
}
