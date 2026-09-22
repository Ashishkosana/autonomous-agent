/**
 * One outcome vocabulary for every evaluated attempt.
 *
 * `success`, `partial`, `failure`, and `inconclusive` mean the same thing on
 * an evaluation, an experience record, and a decision record. Nothing in the
 * agent maps `partial` or `inconclusive` onto `failure`. `pending` exists
 * only for a decision that has not been evaluated yet.
 *
 * The contract is documented in `docs/agent-mathematics.md` (Outcome semantics).
 */
export const OUTCOME_VERDICTS = ['success', 'partial', 'failure', 'inconclusive'] as const;

export type OutcomeVerdict = (typeof OUTCOME_VERDICTS)[number];

/** A decision before evaluation is `pending`; afterwards it uses `OutcomeVerdict` unchanged. */
export type DecisionOutcome = 'pending' | OutcomeVerdict;

export function isOutcomeVerdict(value: string): value is OutcomeVerdict {
  return (OUTCOME_VERDICTS as readonly string[]).includes(value);
}

/**
 * Identity on purpose. Callers go through this function so a future edit
 * cannot quietly collapse a verdict while looking like a mapping.
 */
export function verdictAsOutcome(verdict: OutcomeVerdict): OutcomeVerdict {
  switch (verdict) {
    case 'success':
    case 'partial':
    case 'failure':
    case 'inconclusive':
      return verdict;
  }
}
