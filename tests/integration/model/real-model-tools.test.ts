import { afterAll, describe, expect, it } from 'vitest';
import type { RunOutcome } from '../../../src/agent/runtime/agent-runtime.js';
import { SystemClock } from '../../../src/domain/system-clock.js';
import { createModelProvider } from '../../../src/models/config.js';
import type { ModelProvider } from '../../../src/models/contracts.js';
import { ResilientModelProvider } from '../../../src/models/resilient-provider.js';
import type { LocalLinuxEnvironment } from '../../../src/sandbox/local/local-linux-environment.js';
import { createStandardToolRegistry } from '../../../src/tools/standard-tools.js';
import { SequentialIdGenerator } from '../../support/deterministic.js';
import { E005_GOAL, E005_REQUIRED, E005_RESULT_PATH } from '../../support/e005-suite.js';
import { chooseRealEnvironment } from '../../support/real-environment.js';
import { buildScenario, type Scenario } from '../../support/runtime-scenario.js';
import {
  MODEL_CONFIG,
  MODEL_SUMMARY,
  configureRealModelTimeouts,
  describeRealModel,
  recordEvidence,
} from './gate.js';

/**
 * E-006 — REAL MODEL × REAL TOOLS × REAL LINUX.
 *
 * The E-005 goal (a Python program must leave 5050 in a file) with nothing
 * scripted: a live model chooses among the nine standard tools, the chosen
 * tool really runs inside a Linux environment, the evaluator reads the real
 * file. Assertions are about honesty of the machinery (terminal status,
 * complete telemetry, tool events correlated to actions, no vacuous
 * success); whether the model reaches the goal is recorded as evidence.
 *
 * This is also the first measurement of the real tool catalogue's prompt
 * cost (architectural observation #4 from E-004).
 */
configureRealModelTimeouts();

const clock = new SystemClock();
const RUNS = Math.max(1, Number(process.env['AGENT_E006_RUNS'] ?? '1') || 1);

function realProvider(): ModelProvider {
  if (!MODEL_CONFIG) throw new Error('gate should have skipped this file');
  return new ResilientModelProvider(
    createModelProvider(MODEL_CONFIG, { clock, ids: new SequentialIdGenerator() }),
    { maxRetries: 2, maxReasks: 1 },
  );
}

const environmentChoice = await chooseRealEnvironment();
if ('unavailable' in environmentChoice)
  console.warn(`[skip] E-006 NOT RUN — ${environmentChoice.unavailable}`);

const opened: LocalLinuxEnvironment[] = [];
afterAll(async () => {
  await Promise.all(opened.map((e) => e.destroy().catch(() => undefined)));
});

describeRealModel('E-006 · real model drives the real tool set in real Linux', () => {
  describe.skipIf('unavailable' in environmentChoice)('runs', () => {
    for (let run = 1; run <= RUNS; run += 1) {
      it(`run ${run}/${RUNS}: terminal status, complete telemetry, real tool execution, honest verdict`, async () => {
        if ('unavailable' in environmentChoice) return;
        const env = await environmentChoice.open(`e006-${run}`);
        opened.push(env);
        const registry = createStandardToolRegistry({ options: { defaultTimeoutMs: 60_000 } });
        const descriptors = registry.describeAll();

        const scenario: Scenario = await buildScenario({
          turns: [],
          model: realProvider(),
          clock,
          environment: env,
          tools: registry,
          goalStatement: E005_GOAL,
          seed: [],
          requirement: { path: E005_RESULT_PATH, requiredMarker: E005_REQUIRED },
          resilience: { maxRetries: 2, maxReasks: 1 },
          limits: {
            maxIterations: 6,
            maxToolCalls: 8,
            maxModelCalls: 24,
            maxTotalTokens: 400_000,
            maxDurationMs: 840_000,
          },
        });

        const startedMs = clock.monotonicMs();
        const outcome: RunOutcome = await scenario.run();
        const runDurationMs = Math.round(clock.monotonicMs() - startedMs);
        const resultFile = await env.readFile(E005_RESULT_PATH).catch(() => null);
        const events = scenario.events;
        const started = events.ofType('MODEL_CALL_STARTED');
        const completed = events.ofType('MODEL_CALL_COMPLETED');
        const failed = events.ofType('MODEL_CALL_FAILED');
        const selectCalls = completed.filter((e) => e.payload.purpose === 'select_action');
        const planCalls = completed.filter(
          (e) => e.payload.purpose === 'create_plan' || e.payload.purpose === 'revise_plan',
        );

        recordEvidence(`e006-run-${run}`, {
          environment: environmentChoice.label,
          status: outcome.state.status,
          terminationReason: outcome.state.terminationReason,
          runDurationMs,
          usage: outcome.state.usage,
          toolMode: MODEL_SUMMARY?.toolMode,
          structuredMode: MODEL_SUMMARY?.structuredMode,
          catalogue: {
            toolCount: descriptors.length,
            toolNames: descriptors.map((d) => d.name),
            descriptorsJsonChars: JSON.stringify(descriptors).length,
            selectActionInputTokens: selectCalls.map((e) => e.payload.inputTokens),
            planInputTokens: planCalls.map((e) => e.payload.inputTokens),
            usageReported: completed.every((e) => e.payload.usageReported),
          },
          modelCalls: {
            started: started.length,
            completed: completed.length,
            failed: failed.length,
          },
          failedKinds: failed.map((e) => `${e.payload.purpose}:${e.payload.errorKind}`),
          modelCallLatenciesMs: completed.map((e) => e.payload.latencyMs),
          plans: [
            ...events.ofType('PLAN_CREATED').map((e) => ({
              version: e.payload.version,
              strategy: e.payload.strategySummary,
              tasks: e.payload.taskCount,
            })),
            ...events.ofType('PLAN_UPDATED').map((e) => ({
              version: e.payload.version,
              reason: e.payload.reason,
              tasks: e.payload.taskCount,
            })),
          ],
          decisions: events.ofType('DECISION_CREATED').map((e) => e.payload.summary),
          toolsSelected: events.ofType('TOOL_SELECTED').map((e) => ({
            toolName: e.payload.toolName,
            attempt: e.payload.attempt,
            intent: e.payload.intent,
          })),
          commands: events.ofType('COMMAND_FINISHED').map((e) => ({
            command: e.payload.command,
            exitCode: e.payload.exitCode,
            timedOut: e.payload.timedOut,
          })),
          commandOutput: events
            .ofType('COMMAND_OUTPUT')
            .map((e) => `${e.payload.stream}: ${e.payload.chunk.slice(0, 300)}`),
          filesWritten: events.ofType('FILE_CREATED').map((e) => e.payload.path),
          toolFailures: events.ofType('TOOL_FAILED').map((e) => ({
            toolName: e.payload.toolName,
            errorCode: e.payload.errorCode,
            message: e.payload.message,
          })),
          evaluations: events.ofType('EVALUATION_COMPLETED').map((e) => ({
            verdict: e.payload.verdict,
            toolStatus: e.payload.toolStatus,
            checks: `${e.payload.checksPassed}/${e.payload.checksTotal}`,
            summary: e.payload.summary,
          })),
          failuresDetected: events
            .ofType('FAILURE_DETECTED')
            .map((e) => `${e.payload.source}: ${e.payload.summary}`),
          strategyChanges: events.ofType('STRATEGY_CHANGED').map((e) => e.payload.reason),
          lessons: events.ofType('LESSON_CREATED').map((e) => e.payload.statement),
          resultFile,
          goalCompleted: outcome.state.status === 'completed',
          eventTypes: events.events.map((e) => e.type),
        });

        expect(['completed', 'failed', 'gave_up', 'limit_reached']).toContain(outcome.state.status);
        expect(completed.length).toBeGreaterThan(0);
        expect(started.length).toBe(completed.length + failed.length);
        expect(outcome.state.usage.modelCalls).toBe(started.length);
        expect(completed.every((e) => e.payload.latencyMs > 0)).toBe(true);
        // Every tool-originated event is tied to the action that caused it.
        const toolEvents = events.events.filter(
          (e) => e.type.startsWith('COMMAND_') || e.type.startsWith('FILE_'),
        );
        expect(toolEvents.every((e) => e.correlation.actionId !== undefined)).toBe(true);
        // A completed goal must be backed by the real file, never by a tool's say-so.
        if (outcome.state.status === 'completed') {
          expect(resultFile).not.toBeNull();
          expect(resultFile).toContain(E005_REQUIRED);
          expect(events.ofType('EVALUATION_COMPLETED').at(-1)?.payload.verdict).toBe('success');
        } else {
          // Task-level evaluations may pass while the goal is unfinished (limits); the
          // goal itself must not have been declared complete.
          expect(events.ofType('GOAL_COMPLETED')).toHaveLength(0);
        }
      }, 900_000);
    }
  });
});
