import type { OutcomeVerdict } from '../domain/outcome.js';

/**
 * Decisive checks only. An empty list is `inconclusive` — absence of a
 * mechanical check is not success and not failure. A mix of pass and fail
 * is `partial`, never collapsed into `failure`.
 */
export function verdictFromDecisive(passed: number, total: number): OutcomeVerdict {
  if (total <= 0) return 'inconclusive';
  if (passed === total) return 'success';
  if (passed === 0) return 'failure';
  return 'partial';
}
