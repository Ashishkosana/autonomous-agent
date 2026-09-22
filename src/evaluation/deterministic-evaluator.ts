import type { Clock, IdGenerator } from '../domain/ids.js';
import { asEvaluationId } from '../domain/ids.js';
import type { EvaluationCheck, EvaluationResult, EvaluationScope, Evaluator } from './contracts.js';
import { collectCriteria, type VerifiableCriterion } from '../domain/criteria.js';
import { verdictFromDecisive } from './verdict.js';

/**
 * Production evaluator. Every decisive check is a deterministic inspection of
 * the sandbox, the tool result, or caller-supplied criteria. Prose success
 * criteria that do not match the criterion grammar are reported as gaps and
 * do not count as passes. A model judge is intentionally not invoked.
 *
 * The tool-status check is always recorded and is never decisive by itself:
 * "tool ok, task failed" stays visible. `{kind:'tool_succeeded'}` is the
 * criterion that makes tool success decisive.
 */
export class DeterministicEvaluator implements Evaluator {
  readonly name = 'deterministic';

  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async evaluate(scope: EvaluationScope): Promise<EvaluationResult> {
    const { criteria, uncheckedProse } = collectCriteria(
      scope.goal.verifiableCriteria,
      scope.goal.successCriteria,
    );
    const checks: EvaluationCheck[] = [toolStatusCheck(scope)];
    for (const criterion of criteria) {
      checks.push(await runCriterion(criterion, scope));
    }

    const decisive = checks.filter((check) => check.decisive !== false);
    const passed = decisive.filter((check) => check.passed).length;
    const verdict = verdictFromDecisive(passed, decisive.length);
    const gaps = [
      ...checks
        .filter((check) => check.decisive !== false && !check.passed)
        .map((check) => check.evidence),
      ...uncheckedProse.map((line) => `not mechanically verifiable: ${line}`),
    ];
    if (decisive.length === 0) {
      gaps.unshift('no mechanically verifiable success criterion was configured');
    }

    const last = scope.observations.at(-1);
    return {
      evaluationId: asEvaluationId(this.ids.next('eval')),
      correlation: scope.correlation,
      verdict,
      evaluatorName: this.name,
      checks,
      gaps,
      summary: `${passed}/${decisive.length} decisive checks passed`,
      toolStatus: last ? last.toolResult.status : 'none',
      derivedFrom: {
        observationIds: scope.observations.map((observation) => observation.observationId),
        ...(scope.action ? { actionIds: [scope.action.actionId] } : {}),
      },
      evaluatedAt: this.clock.now(),
    };
  }
}

function toolStatusCheck(scope: EvaluationScope): EvaluationCheck {
  const last = scope.observations.at(-1);
  if (!last) {
    return {
      name: 'tool status',
      passed: false,
      decisive: false,
      method: 'tool_result',
      evidence: 'no tool observation',
    };
  }
  const ok = last.toolResult.status === 'ok';
  return {
    name: 'tool status',
    passed: ok,
    decisive: false,
    method: 'tool_result',
    evidence: ok
      ? `${last.toolResult.toolName} returned ok (not decisive by itself)`
      : `${last.toolResult.toolName} returned error (not decisive by itself)`,
  };
}

async function runCriterion(
  criterion: VerifiableCriterion,
  scope: EvaluationScope,
): Promise<EvaluationCheck> {
  switch (criterion.kind) {
    case 'file_exists':
      return fileExists(criterion.path, scope);
    case 'file_contains':
      return fileContains(criterion.path, criterion.marker, scope);
    case 'json_file':
      return jsonFile(criterion.path, criterion.requiredKeys, scope);
    case 'command_exits_zero':
      return commandExitsZero(criterion.command, scope);
    case 'http_status':
      return httpStatus(criterion.status, scope);
    case 'tool_succeeded':
      return toolSucceeded(criterion.toolName, scope);
  }
}

async function fileExists(path: string, scope: EvaluationScope): Promise<EvaluationCheck> {
  if (!scope.environment) return missingEnvironment('file exists', path);
  const exists = await scope.environment.fileExists(path);
  return {
    name: 'file exists',
    passed: exists,
    method: 'artifact_inspection',
    evidence: exists ? `${path} exists` : `${path} does not exist`,
  };
}

async function fileContains(
  path: string,
  marker: string,
  scope: EvaluationScope,
): Promise<EvaluationCheck> {
  if (!scope.environment) return missingEnvironment('file contains', path);
  if (!(await scope.environment.fileExists(path))) {
    return {
      name: 'file contains',
      passed: false,
      method: 'artifact_inspection',
      evidence: `${path} does not exist`,
    };
  }
  const content = await scope.environment.readFile(path);
  const found = content.includes(marker);
  return {
    name: 'file contains',
    passed: found,
    method: 'artifact_inspection',
    evidence: found
      ? `${path} contains the required marker`
      : `${path} (${content.length} bytes) does not contain the required marker`,
  };
}

async function jsonFile(
  path: string,
  requiredKeys: readonly string[] | undefined,
  scope: EvaluationScope,
): Promise<EvaluationCheck> {
  if (!scope.environment) return missingEnvironment('json file', path);
  if (!(await scope.environment.fileExists(path))) {
    return {
      name: 'json file',
      passed: false,
      method: 'artifact_inspection',
      evidence: `${path} does not exist`,
    };
  }
  const content = await scope.environment.readFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      name: 'json file',
      passed: false,
      method: 'artifact_inspection',
      evidence: `${path} is not valid JSON`,
    };
  }
  if (!requiredKeys || requiredKeys.length === 0) {
    return {
      name: 'json file',
      passed: true,
      method: 'artifact_inspection',
      evidence: `${path} is valid JSON`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      name: 'json file',
      passed: false,
      method: 'artifact_inspection',
      evidence: `${path} is JSON but not an object`,
    };
  }
  const missing = requiredKeys.filter((key) => !(key in (parsed as Record<string, unknown>)));
  return {
    name: 'json file',
    passed: missing.length === 0,
    method: 'artifact_inspection',
    evidence:
      missing.length === 0
        ? `${path} has keys ${requiredKeys.join(', ')}`
        : `${path} is missing keys ${missing.join(', ')}`,
  };
}

async function commandExitsZero(command: string, scope: EvaluationScope): Promise<EvaluationCheck> {
  if (!scope.environment) return missingEnvironment('command exits 0', command);
  const result = await scope.environment.runCommand(command);
  const passed = result.exitCode === 0 && !result.timedOut;
  return {
    name: 'command exits 0',
    passed,
    method: 'command_check',
    evidence: passed
      ? `command exited 0`
      : `command exit ${result.exitCode === null ? 'none' : result.exitCode}${result.timedOut ? ' (timed out)' : ''}`,
  };
}

function httpStatus(expected: number, scope: EvaluationScope): EvaluationCheck {
  const last = scope.observations.at(-1);
  const output = last && last.toolResult.status === 'ok' ? last.toolResult.output : undefined;
  const status =
    typeof output === 'object' && output !== null && !Array.isArray(output)
      ? (output as { status?: unknown }).status
      : undefined;
  if (typeof status !== 'number') {
    return {
      name: 'http status',
      passed: false,
      method: 'tool_result',
      evidence: 'latest observation has no numeric HTTP status',
    };
  }
  return {
    name: 'http status',
    passed: status === expected,
    method: 'tool_result',
    evidence: `HTTP status ${status}, expected ${expected}`,
  };
}

function toolSucceeded(toolName: string | undefined, scope: EvaluationScope): EvaluationCheck {
  const last = scope.observations.at(-1);
  if (!last) {
    return {
      name: 'tool succeeded',
      passed: false,
      method: 'tool_result',
      evidence: 'no tool observation',
    };
  }
  const nameOk = toolName === undefined || last.toolResult.toolName === toolName;
  const passed = last.toolResult.status === 'ok' && nameOk;
  return {
    name: 'tool succeeded',
    passed,
    method: 'tool_result',
    evidence: passed
      ? `${last.toolResult.toolName} succeeded`
      : `${last.toolResult.toolName} status ${last.toolResult.status}${nameOk ? '' : `; expected ${toolName}`}`,
  };
}

function missingEnvironment(name: string, subject: string): EvaluationCheck {
  return {
    name,
    passed: false,
    method: 'artifact_inspection',
    evidence: `no execution environment to check ${subject}`,
  };
}
