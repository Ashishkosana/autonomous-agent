import type { ActionId, DecisionId, IsoTimestamp, PlanId } from './ids.js';
import type { Provenance, RunCorrelation } from './provenance.js';

/**
 * A concrete request to run one tool with one input. Proposed by the model,
 * validated and dispatched by the runtime. The model never executes anything.
 */
export interface Action {
  readonly actionId: ActionId;
  readonly correlation: RunCorrelation;
  readonly planId: PlanId;
  /** The decision record that justified this action, when one was recorded. */
  readonly decisionId?: DecisionId;
  readonly toolName: string;
  readonly input: unknown;
  /** 1 for a first attempt; incremented on retries. */
  readonly attempt: number;
  /** The action this one is retrying, if any. */
  readonly retryOf?: ActionId;
  /** Concise, human-readable intent. Not model chain-of-thought. */
  readonly intent: string;
  readonly derivedFrom: Provenance;
  readonly requestedAt: IsoTimestamp;
}
