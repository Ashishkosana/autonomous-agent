import { asEvaluationId, type Clock, type IdGenerator } from '../../src/domain/ids.js';
import type {
  EvaluationCheck,
  EvaluationResult,
  EvaluationScope,
  Evaluator,
} from '../../src/evaluation/contracts.js';

export interface ArtifactRequirement {
  readonly path: string;
  /** Text the artifact must contain to satisfy the goal. */
  readonly requiredMarker: string;
}

/**
 * Rule-based evaluator for runtime tests. It never looks at the tool result
 * to decide the verdict: it inspects the artifact in the execution
 * environment and checks the requirement itself. This is what makes
 * "tool ok, task failed" a real outcome in the scenarios.
 */
export class ArtifactRequirementEvaluator implements Evaluator {
  readonly name = 'artifact-requirement';

  constructor(
    private readonly requirement: ArtifactRequirement,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async evaluate(scope: EvaluationScope): Promise<EvaluationResult> {
    const { path, requiredMarker } = this.requirement;
    const checks: EvaluationCheck[] = [];
    const gaps: string[] = [];
    const environment = scope.environment;
    if (!environment) throw new Error('ArtifactRequirementEvaluator needs an environment');

    const exists = await environment.fileExists(path);
    checks.push({
      name: 'artifact exists',
      passed: exists,
      method: 'artifact_inspection',
      evidence: exists ? `${path} exists` : `${path} does not exist`,
    });
    if (!exists) {
      gaps.push(`${path} has not been created`);
    } else {
      const content = await environment.readFile(path);
      const satisfied = content.includes(requiredMarker);
      checks.push({
        name: 'artifact satisfies requirement',
        passed: satisfied,
        method: 'artifact_inspection',
        evidence: satisfied
          ? `${path} contains "${requiredMarker}"`
          : `${path} (${content.length} bytes) does not contain "${requiredMarker}"`,
      });
      if (!satisfied) gaps.push(`Artifact is missing the required "${requiredMarker}" section`);
    }

    const passed = checks.filter((c) => c.passed).length;
    const last = scope.observations.at(-1);
    return {
      evaluationId: asEvaluationId(this.ids.next('eval')),
      correlation: scope.correlation,
      verdict: passed === checks.length ? 'success' : 'failure',
      checks,
      gaps,
      summary: `${passed}/${checks.length} checks passed`,
      toolStatus: last ? last.toolResult.status : 'none',
      derivedFrom: {
        observationIds: scope.observations.map((o) => o.observationId),
        ...(scope.action ? { actionIds: [scope.action.actionId] } : {}),
      },
      evaluatedAt: this.clock.now(),
    };
  }
}
