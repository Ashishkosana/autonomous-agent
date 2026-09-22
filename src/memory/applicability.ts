/**
 * Structured preconditions say when a memory was true. They are recorded at
 * write time and checked deterministically against the current environment.
 * There is no learned applicability model: a missing probe answer is
 * `unknown`, and a failed check is `violated`. Neither one changes the
 * retrieval score.
 */

export type Precondition =
  | { readonly kind: 'file_exists'; readonly path: string }
  | { readonly kind: 'tool_available'; readonly toolName: string }
  | { readonly kind: 'environment_provider'; readonly provider: string };

export type PreconditionStatus = 'holds' | 'violated' | 'unknown';

export interface PreconditionCheck {
  readonly precondition: Precondition;
  readonly status: PreconditionStatus;
  readonly evidence: string;
}

export interface ApplicabilityReport {
  /** `unknown` when the record stated no preconditions. */
  readonly status: PreconditionStatus;
  readonly checks: readonly PreconditionCheck[];
}

export interface ApplicabilityProbe {
  fileExists(path: string): Promise<boolean>;
  readonly toolNames?: readonly string[];
  readonly environmentProvider?: string;
}

export function preconditionsFromToolCall(
  toolName: string,
  input: unknown,
): readonly Precondition[] {
  if (toolName !== 'fs.read' && toolName !== 'fs.delete') return [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return [];
  const path = (input as { path?: unknown }).path;
  if (typeof path !== 'string' || path.trim() === '') return [];
  return [{ kind: 'file_exists', path }];
}

export async function assessPreconditions(
  preconditions: readonly Precondition[] | undefined,
  probe: ApplicabilityProbe,
): Promise<ApplicabilityReport> {
  if (!preconditions || preconditions.length === 0) {
    return { status: 'unknown', checks: [] };
  }
  const checks: PreconditionCheck[] = [];
  for (const precondition of preconditions) {
    checks.push(await checkOne(precondition, probe));
  }
  const status: PreconditionStatus = checks.some((check) => check.status === 'violated')
    ? 'violated'
    : checks.some((check) => check.status === 'unknown')
      ? 'unknown'
      : 'holds';
  return { status, checks };
}

async function checkOne(
  precondition: Precondition,
  probe: ApplicabilityProbe,
): Promise<PreconditionCheck> {
  switch (precondition.kind) {
    case 'file_exists': {
      const exists = await probe.fileExists(precondition.path);
      return {
        precondition,
        status: exists ? 'holds' : 'violated',
        evidence: exists
          ? `${precondition.path} exists`
          : `${precondition.path} does not exist in this environment`,
      };
    }
    case 'tool_available': {
      if (!probe.toolNames) {
        return {
          precondition,
          status: 'unknown',
          evidence: `tool list unavailable; cannot check ${precondition.toolName}`,
        };
      }
      const available = probe.toolNames.includes(precondition.toolName);
      return {
        precondition,
        status: available ? 'holds' : 'violated',
        evidence: available
          ? `${precondition.toolName} is available`
          : `${precondition.toolName} is not in the tool list`,
      };
    }
    case 'environment_provider': {
      if (!probe.environmentProvider) {
        return {
          precondition,
          status: 'unknown',
          evidence: 'environment provider unavailable',
        };
      }
      const holds = probe.environmentProvider === precondition.provider;
      return {
        precondition,
        status: holds ? 'holds' : 'violated',
        evidence: holds
          ? `environment is ${precondition.provider}`
          : `environment is ${probe.environmentProvider}, record assumed ${precondition.provider}`,
      };
    }
  }
}
