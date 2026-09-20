import { describe, expect, it } from 'vitest';
import { asEvaluationId, asObservationId } from '../src/domain/ids.js';
import type { Observation } from '../src/domain/observation.js';
import type {
  EvaluationCheck,
  EvaluationResult,
  EvaluationScope,
  Evaluator,
} from '../src/evaluation/contracts.js';
import { ToolRegistry, invokeTool } from '../src/tools/registry.js';
import { CORRELATION, makeAction, makeGoal, makeHarness, makePlan } from './support/fixtures.js';
import { writeFileTool } from './support/tools.js';

/**
 * A deliberately small, rule-based evaluator used only to prove the contract:
 * it inspects the workspace for the evidence the task promised, ignoring
 * whether the tool reported success.
 */
const fileEvidenceEvaluator: Evaluator = {
  name: 'file-evidence',
  async evaluate(scope: EvaluationScope): Promise<EvaluationResult> {
    const checks: EvaluationCheck[] = [];
    const gaps: string[] = [];
    const last = scope.observations.at(-1);
    const toolStatus = last ? last.toolResult.status : 'none';

    const path = (scope.action?.input as { path?: string } | undefined)?.path;
    if (scope.environment && path) {
      const exists = await scope.environment.fileExists(path);
      checks.push({
        name: 'file exists',
        passed: exists,
        method: 'artifact_inspection',
        evidence: exists ? `${path} exists` : `${path} does not exist`,
      });
      if (exists) {
        const content = await scope.environment.readFile(path);
        const nonEmpty = content.trim().length > 0;
        checks.push({
          name: 'file is non-empty',
          passed: nonEmpty,
          method: 'artifact_inspection',
          evidence: `${path} has ${content.length} bytes`,
        });
        if (!nonEmpty) gaps.push('The report file exists but contains no content');
      } else {
        gaps.push('The report file was not created');
      }
    }

    const passed = checks.filter((c) => c.passed).length;
    const verdict =
      checks.length === 0 ? 'inconclusive' : passed === checks.length ? 'success' : 'failure';

    return {
      evaluationId: asEvaluationId('eval-1'),
      correlation: scope.correlation,
      verdict,
      checks,
      gaps,
      summary: `${passed}/${checks.length} checks passed`,
      toolStatus,
      derivedFrom: {
        observationIds: scope.observations.map((o) => o.observationId),
        ...(scope.action ? { actionIds: [scope.action.actionId] } : {}),
      },
      evaluatedAt: '2026-01-01T00:00:01.000Z',
    };
  },
};

describe('evaluation is independent of tool success', () => {
  it('a tool call that returns ok can still yield a failure verdict', async () => {
    const harness = makeHarness();
    const registry = new ToolRegistry().register(writeFileTool);
    const action = makeAction({ input: { path: '/workspace/report.md', content: '   ' } });

    const toolResult = await invokeTool(
      registry,
      action.toolName,
      action.input,
      harness.toolContext(),
    );
    expect(toolResult.status).toBe('ok');

    const observation: Observation = {
      observationId: asObservationId('obs-1'),
      actionId: action.actionId,
      correlation: CORRELATION,
      toolResult,
      artifacts: [],
      summary: 'wrote report.md',
      observedAt: harness.clock.now(),
    };

    const evaluation = await fileEvidenceEvaluator.evaluate({
      goal: makeGoal(),
      ...(makePlan().tasks[0] ? { task: makePlan().tasks[0] } : {}),
      action,
      observations: [observation],
      correlation: CORRELATION,
      environment: harness.environment,
    });

    expect(evaluation.toolStatus).toBe('ok');
    expect(evaluation.verdict).toBe('failure');
    expect(evaluation.checks.map((c) => [c.name, c.passed])).toEqual([
      ['file exists', true],
      ['file is non-empty', false],
    ]);
    expect(evaluation.gaps).toEqual(['The report file exists but contains no content']);
    expect(evaluation.checks.every((c) => c.method === 'artifact_inspection')).toBe(true);
  });

  it('a genuine result yields success with evidence for every check', async () => {
    const harness = makeHarness();
    const registry = new ToolRegistry().register(writeFileTool);
    const action = makeAction({
      input: { path: '/workspace/report.md', content: '# Findings\n...' },
    });
    const toolResult = await invokeTool(
      registry,
      action.toolName,
      action.input,
      harness.toolContext(),
    );

    const evaluation = await fileEvidenceEvaluator.evaluate({
      goal: makeGoal(),
      action,
      observations: [
        {
          observationId: asObservationId('obs-1'),
          actionId: action.actionId,
          correlation: CORRELATION,
          toolResult,
          artifacts: [],
          summary: 'wrote report.md',
          observedAt: harness.clock.now(),
        },
      ],
      correlation: CORRELATION,
      environment: harness.environment,
    });

    expect(evaluation.verdict).toBe('success');
    expect(evaluation.gaps).toEqual([]);
    for (const check of evaluation.checks) expect(check.evidence.length).toBeGreaterThan(0);
  });

  it('records provenance back to the observation and action it judged', async () => {
    const harness = makeHarness();
    const action = makeAction();
    const evaluation = await fileEvidenceEvaluator.evaluate({
      goal: makeGoal(),
      action,
      observations: [],
      correlation: CORRELATION,
      environment: harness.environment,
    });
    expect(evaluation.derivedFrom.actionIds).toEqual([action.actionId]);
    expect(evaluation.toolStatus).toBe('none');
    expect(evaluation.verdict).toBe('failure');
  });
});
