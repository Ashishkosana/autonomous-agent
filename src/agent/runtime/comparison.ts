import type { VerifiableCriterion } from '../../domain/criteria.js';
import type { RunLimits } from '../../domain/run.js';

/**
 * The knobs a later memory-on / memory-off experiment must freeze.
 * This module does not run the experiment and does not estimate an effect.
 */
export interface ComparableRunSpec {
  readonly goalStatement: string;
  readonly constraints: readonly string[];
  readonly successCriteria: readonly string[];
  readonly verifiableCriteria: readonly VerifiableCriterion[];
  readonly limits: RunLimits;
  readonly model: {
    readonly provider: string;
    readonly model: string;
    readonly temperature?: number;
  };
  readonly toolNames: readonly string[];
  readonly evaluatorName: string;
  readonly retrieval: {
    readonly limit: number;
    readonly semanticThreshold?: number;
    readonly keywordWeight?: number;
    readonly semanticWeight?: number;
    readonly kindDiversity?: boolean;
  };
  readonly memory: 'on' | 'off';
  /** Caller-defined label for a frozen store snapshot. Not interpreted here. */
  readonly memorySnapshotLabel?: string;
}

export interface ComparisonMismatch {
  readonly field: string;
  readonly left: string;
  readonly right: string;
}

/**
 * Everything except the memory arm and the snapshot label must match.
 * Returns the mismatches; an empty list means the pair is comparable.
 */
export function comparisonMismatches(
  left: ComparableRunSpec,
  right: ComparableRunSpec,
): readonly ComparisonMismatch[] {
  const mismatches: ComparisonMismatch[] = [];
  const check = (field: string, a: unknown, b: unknown) => {
    const leftText = JSON.stringify(a);
    const rightText = JSON.stringify(b);
    if (leftText !== rightText) mismatches.push({ field, left: leftText, right: rightText });
  };
  check('goalStatement', left.goalStatement, right.goalStatement);
  check('constraints', left.constraints, right.constraints);
  check('successCriteria', left.successCriteria, right.successCriteria);
  check('verifiableCriteria', left.verifiableCriteria, right.verifiableCriteria);
  check('limits', left.limits, right.limits);
  check('model', left.model, right.model);
  check('toolNames', [...left.toolNames].sort(), [...right.toolNames].sort());
  check('evaluatorName', left.evaluatorName, right.evaluatorName);
  check('retrieval', left.retrieval, right.retrieval);
  return mismatches;
}
