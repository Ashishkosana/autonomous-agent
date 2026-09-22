import { describe, expect, it } from 'vitest';
import { asObservationId } from '../../src/domain/ids.js';
import { OUTCOME_VERDICTS, verdictAsOutcome } from '../../src/domain/outcome.js';
import { DeterministicEvaluator } from '../../src/evaluation/deterministic-evaluator.js';
import { verdictFromDecisive } from '../../src/evaluation/verdict.js';
import { CORRELATION, makeAction, makeGoal, makeHarness } from '../support/fixtures.js';

function observation(toolName: string, output: unknown, status: 'ok' | 'error' = 'ok') {
  return {
    observationId: asObservationId('obs-1'),
    actionId: makeAction().actionId,
    correlation: CORRELATION,
    toolResult:
      status === 'ok'
        ? {
            status: 'ok' as const,
            toolName,
            actionId: makeAction().actionId,
            output,
            startedAt: 't',
            finishedAt: 't',
            durationMs: 1,
          }
        : {
            status: 'error' as const,
            toolName,
            actionId: makeAction().actionId,
            error: { code: 'execution_failed' as const, message: 'no', retryable: false },
            startedAt: 't',
            finishedAt: 't',
            durationMs: 1,
          },
    artifacts: [],
    summary: toolName,
    observedAt: 't',
  };
}

describe('canonical outcomes', () => {
  it('keeps partial and inconclusive distinct from failure', () => {
    for (const verdict of OUTCOME_VERDICTS) {
      expect(verdictAsOutcome(verdict)).toBe(verdict);
    }
    expect(verdictFromDecisive(1, 2)).toBe('partial');
    expect(verdictFromDecisive(0, 0)).toBe('inconclusive');
    expect(verdictFromDecisive(0, 2)).toBe('failure');
    expect(verdictFromDecisive(2, 2)).toBe('success');
  });
});

describe('DeterministicEvaluator', () => {
  const harness = () => makeHarness();

  it('does not treat a successful tool call as task success when nothing is checkable', async () => {
    const h = harness();
    const evaluator = new DeterministicEvaluator(h.ids, h.clock);
    const result = await evaluator.evaluate({
      goal: makeGoal(),
      action: makeAction(),
      observations: [observation('fs.write', { path: '/workspace/report.md' })],
      correlation: CORRELATION,
      environment: h.environment,
    });
    expect(result.verdict).toBe('inconclusive');
    expect(result.evaluatorName).toBe('deterministic');
    expect(result.checks.find((check) => check.name === 'tool status')?.decisive).toBe(false);
    expect(result.gaps.some((gap) => gap.includes('not mechanically verifiable'))).toBe(true);
  });

  it('passes file_contains only when the marker is in the sandbox file', async () => {
    const h = harness();
    await h.environment.writeFile('/workspace/report.md', '# Report\n\n## Sources\n');
    const evaluator = new DeterministicEvaluator(h.ids, h.clock);
    const goal = makeGoal();
    const result = await evaluator.evaluate({
      goal: {
        ...goal,
        successCriteria: ['file_contains:/workspace/report.md|## Sources'],
      },
      action: makeAction(),
      observations: [observation('fs.write', {})],
      correlation: CORRELATION,
      environment: h.environment,
    });
    expect(result.verdict).toBe('success');
    expect(
      result.checks.filter((check) => check.decisive !== false).every((check) => check.passed),
    ).toBe(true);
  });

  it('returns partial when one decisive check passes and another fails', async () => {
    const h = harness();
    await h.environment.writeFile('/workspace/report.md', 'no marker');
    const evaluator = new DeterministicEvaluator(h.ids, h.clock);
    const goal = makeGoal();
    const result = await evaluator.evaluate({
      goal: {
        ...goal,
        successCriteria: [],
        verifiableCriteria: [
          { kind: 'file_exists', path: '/workspace/report.md' },
          { kind: 'file_contains', path: '/workspace/report.md', marker: '## Sources' },
        ],
      },
      action: makeAction(),
      observations: [observation('fs.write', {})],
      correlation: CORRELATION,
      environment: h.environment,
    });
    expect(result.verdict).toBe('partial');
  });

  it('checks JSON, HTTP status, and a sandbox command without calling a model', async () => {
    const h = harness();
    await h.environment.writeFile('/workspace/out.json', '{"ok":true}');
    const evaluator = new DeterministicEvaluator(h.ids, h.clock);
    const goal = makeGoal();
    const result = await evaluator.evaluate({
      goal: {
        ...goal,
        successCriteria: [],
        verifiableCriteria: [
          { kind: 'json_file', path: '/workspace/out.json', requiredKeys: ['ok'] },
          { kind: 'http_status', status: 200 },
          { kind: 'tool_succeeded', toolName: 'web.fetch' },
        ],
      },
      action: makeAction({ toolName: 'web.fetch' }),
      observations: [observation('web.fetch', { status: 200, text: 'hi' })],
      correlation: CORRELATION,
      environment: h.environment,
    });
    expect(result.verdict).toBe('success');
    expect(result.checks.map((check) => check.method)).toContain('tool_result');
    expect(result.checks.map((check) => check.method)).toContain('artifact_inspection');
  });

  it('fails a command criterion when the sandbox command does not exit 0', async () => {
    const h = harness();
    const evaluator = new DeterministicEvaluator(h.ids, h.clock);
    const goal = makeGoal();
    const result = await evaluator.evaluate({
      goal: {
        ...goal,
        successCriteria: ['command_exits_zero:false'],
      },
      observations: [],
      correlation: CORRELATION,
      environment: h.environment,
    });
    expect(result.verdict).toBe('failure');
    expect(result.checks.some((check) => check.method === 'command_check' && !check.passed)).toBe(
      true,
    );
  });
});
