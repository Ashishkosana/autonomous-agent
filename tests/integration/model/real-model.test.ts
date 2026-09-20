import { expect, it } from 'vitest';
import { parseFail, parseOk } from '../../../src/domain/parse.js';
import type { ModelProvider } from '../../../src/models/contracts.js';
import { createModelProvider } from '../../../src/models/config.js';
import { ResilientModelProvider } from '../../../src/models/resilient-provider.js';
import { describeTool } from '../../../src/tools/contracts.js';
import { SystemClock } from '../../../src/domain/system-clock.js';
import { SequentialIdGenerator } from '../../support/deterministic.js';
import type { FakeExecutionEnvironment } from '../../support/fake-execution-environment.js';
import {
  APPROACH_B_CONTENT,
  REPORT_PATH,
  REQUIRED_MARKER,
  buildScenario,
} from '../../support/runtime-scenario.js';
import { echoTool, writeFileTool } from '../../support/tools.js';
import {
  MODEL_CONFIG,
  MODEL_SUMMARY,
  configureRealModelTimeouts,
  describeRealModel,
  recordEvidence,
} from './gate.js';

/**
 * REAL-MODEL VERIFICATION. Runs only when an endpoint is configured through
 * the environment; see gate.ts. These tests prove that the adapter works
 * against a live OpenAI-compatible server and that a real model can drive
 * the autonomous loop end to end. Assertions are about *form* (valid
 * structured output, a valid tool action, a terminal run status with
 * telemetry), not about the model's cleverness — a weak free model may
 * legitimately fail the goal, and that outcome is recorded, not hidden.
 */
configureRealModelTimeouts();

/** Real clock: latencies and the duration limit must be measurements, not fixtures. */
const clock = new SystemClock();

function realProvider(): ModelProvider {
  if (!MODEL_CONFIG) throw new Error('gate should have skipped this file');
  return new ResilientModelProvider(
    createModelProvider(MODEL_CONFIG, { clock, ids: new SequentialIdGenerator() }),
    { maxRetries: 2, maxReasks: 1 },
  );
}

const apiKey = process.env['AGENT_MODEL_API_KEY'];

function assertNoKey(value: unknown): void {
  if (!apiKey) return;
  expect(JSON.stringify(value)).not.toContain(apiKey);
}

describeRealModel('real model — adapter smoke', () => {
  it('generates text and reports usage/latency', async () => {
    const response = await realProvider().generate({
      purpose: 'other',
      messages: [{ role: 'user', content: 'Reply with exactly the single word: pong' }],
      maxOutputTokens: 20,
    });
    recordEvidence('generate', {
      text: response.text,
      usage: response.usage,
      latencyMs: response.latencyMs,
      finishReason: response.finishReason,
    });
    expect(response.text.toLowerCase()).toContain('pong');
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);
    assertNoKey(response);
  });

  it('returns validated structured output', async () => {
    const response = await realProvider().structuredGenerate({
      purpose: 'other',
      messages: [
        {
          role: 'user',
          content:
            'List three primary colours as a JSON object of the form {"colours": ["...", "...", "..."]}.',
        },
      ],
      schema: {
        type: 'object',
        properties: { colours: { type: 'array', items: { type: 'string' } } },
        required: ['colours'],
      },
      parse: (raw) => {
        const colours = (raw as { colours?: unknown })?.colours;
        return Array.isArray(colours) &&
          colours.length === 3 &&
          colours.every((c) => typeof c === 'string')
          ? parseOk({ colours: colours as string[] })
          : parseFail('colours must be an array of exactly three strings');
      },
    });
    recordEvidence('structured', {
      parsed: response.parsed,
      raw: response.raw,
      usage: response.usage,
    });
    expect(response.parsed.ok).toBe(true);
    assertNoKey(response);
  });

  it('proposes a valid tool action for a concrete task', async () => {
    const response = await realProvider().requestToolAction({
      purpose: 'select_action',
      messages: [
        {
          role: 'system',
          content:
            'You are an autonomous agent. Choose exactly one tool call that completes the task.',
        },
        {
          role: 'user',
          content: `TASK: create the file ${REPORT_PATH} containing exactly this text:\n\n${APPROACH_B_CONTENT}`,
        },
      ],
      tools: [describeTool(writeFileTool), describeTool(echoTool)],
    });
    recordEvidence('tool-action', { proposal: response.proposal, usage: response.usage });
    expect(response.proposal.kind).toBe('tool');
    if (response.proposal.kind === 'tool') {
      expect(response.proposal.toolName).toBe('fs.write');
      expect(response.proposal.rationale.length).toBeGreaterThan(0);
      expect((response.proposal.input as { path?: unknown }).path).toBe(REPORT_PATH);
    }
    assertNoKey(response);
  });
});

describeRealModel('real model — drives the autonomous loop (E-000 goal)', () => {
  it('reaches a terminal status within limits with complete model-call telemetry', async () => {
    const scenario = await buildScenario({
      turns: [],
      model: realProvider(),
      clock,
      resilience: { maxRetries: 2, maxReasks: 1 },
      limits: { maxIterations: 4, maxToolCalls: 4, maxModelCalls: 12, maxDurationMs: 170_000 },
    });
    const startedMs = clock.monotonicMs();
    const outcome = await scenario.run();
    const runDurationMs = Math.round(clock.monotonicMs() - startedMs);
    const report = await (scenario.environment as FakeExecutionEnvironment)
      .readFile(REPORT_PATH)
      .catch(() => null);

    const started = scenario.events.ofType('MODEL_CALL_STARTED');
    const completed = scenario.events.ofType('MODEL_CALL_COMPLETED');
    const failed = scenario.events.ofType('MODEL_CALL_FAILED');
    const events = scenario.events;
    recordEvidence('e000-loop', {
      status: outcome.state.status,
      terminationReason: outcome.state.terminationReason,
      runDurationMs,
      usage: outcome.state.usage,
      modelCalls: { started: started.length, completed: completed.length, failed: failed.length },
      failedKinds: failed.map((e) => e.payload.errorKind),
      modelCallLatenciesMs: completed.map((e) => e.payload.latencyMs),
      eventTypes: events.events.map((e) => e.type),
      // The story of the run, from event payloads only (never prompts or completions).
      plans: [
        ...events.ofType('PLAN_CREATED').map((e) => ({
          version: e.payload.version,
          strategy: e.payload.strategySummary,
          informedByMemoryRecordIds: e.payload.informedByMemoryRecordIds,
        })),
        ...events
          .ofType('PLAN_UPDATED')
          .map((e) => ({ version: e.payload.version, reason: e.payload.reason })),
      ],
      decisions: events.ofType('DECISION_CREATED').map((e) => e.payload.summary),
      toolsSelected: events.ofType('TOOL_SELECTED').map((e) => ({
        toolName: e.payload.toolName,
        attempt: e.payload.attempt,
      })),
      toolFailures: events.ofType('TOOL_FAILED').map((e) => ({
        toolName: e.payload.toolName,
        errorCode: e.payload.errorCode,
        message: e.payload.message,
      })),
      evaluations: events.ofType('EVALUATION_COMPLETED').map((e) => ({
        verdict: e.payload.verdict,
        checks: `${e.payload.checksPassed}/${e.payload.checksTotal}`,
        summary: e.payload.summary,
      })),
      strategyChanges: events.ofType('STRATEGY_CHANGED').map((e) => e.payload.reason),
      lessons: events.ofType('LESSON_CREATED').map((e) => e.payload.statement),
      memoryWritten: events.ofType('MEMORY_WRITTEN').map((e) => e.payload.kind),
      reportWritten: report !== null,
      reportHasRequiredSection: report?.includes(REQUIRED_MARKER) ?? false,
      report,
      goalCompleted: outcome.state.status === 'completed',
    });

    expect(['completed', 'failed', 'gave_up', 'limit_reached']).toContain(outcome.state.status);
    expect(started.length).toBeGreaterThan(0);
    // At least one call must have actually been answered by the model; an unreachable endpoint is not evidence.
    expect(completed.length).toBeGreaterThan(0);
    expect(started.length).toBe(completed.length + failed.length);
    expect(outcome.state.usage.modelCalls).toBe(started.length);
    // Real latencies were measured, not fixtures.
    expect(completed.every((e) => e.payload.latencyMs > 0)).toBe(true);
    for (const event of completed) {
      expect(event.payload.provider).toBe(MODEL_SUMMARY?.providerLabel);
      expect(event.payload.model).toBe(MODEL_SUMMARY?.model);
    }
    assertNoKey(scenario.events.events);
    assertNoKey(await scenario.store.query({}));
    if (report !== null) assertNoKey(report);
  });
});
