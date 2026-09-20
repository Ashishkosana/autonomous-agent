import { afterAll, beforeAll, expect, it } from 'vitest';
import type { RunOutcome } from '../../../src/agent/runtime/agent-runtime.js';
import type {
  DecisionRecord,
  ExperienceRecord,
  LessonRecord,
} from '../../../src/memory/records.js';
import type { LocalLinuxEnvironment } from '../../../src/sandbox/local/local-linux-environment.js';
import {
  APPROACH_A_CONTENT,
  APPROACH_B_CONTENT,
  REPORT_PATH,
  REQUIRED_MARKER,
  SEED_KNOWLEDGE_ID,
  buildScenario,
  planTurn,
  reviseTurn,
  seqOf,
  writeReport,
  type Scenario,
} from '../../support/runtime-scenario.js';
import {
  configureIntegrationTimeouts,
  describeLocalDocker,
  recordEvidence,
  startSandbox,
} from './gate.js';

/**
 * E-003 — REAL AUTONOMOUS EXECUTION IN A LOCAL LINUX SANDBOX (Docker-gated).
 *
 * The Phase 2 recovery scenario (E-000) with FakeExecutionEnvironment replaced
 * by LocalLinuxEnvironment: scripted model, rule-based evaluator, the real
 * AgentRuntime, and a real disposable container. The file is really written
 * inside Linux; the evaluator really reads it back from there; the runtime
 * detects the failure, revises the plan, retries and completes — with no
 * human input between `run()` starting and returning.
 *
 * Local equivalent of E-002 (Cloudflare, deferred).
 */
configureIntegrationTimeouts();

describeLocalDocker('E-003 · autonomous recovery in a real local Linux sandbox', () => {
  let env: LocalLinuxEnvironment;
  let scenario: Scenario;
  let outcome: RunOutcome;
  let runStartedAt = 0;
  let runFinishedAt = 0;
  const modelCallTimes: number[] = [];

  beforeAll(async () => {
    env = await startSandbox('agent-e003');
    expect(await env.fileExists(REPORT_PATH)).toBe(false);

    scenario = await buildScenario({
      environment: env,
      limits: { maxDurationMs: 600_000 },
      // Every model answer is fixed BEFORE the run starts; nothing is supplied during it.
      turns: [
        planTurn([SEED_KNOWLEDGE_ID]),
        { proposal: writeReport(APPROACH_A_CONTENT, 'Write the report body directly') },
        reviseTurn({ strategyChanged: true }),
        {
          proposal: writeReport(
            APPROACH_B_CONTENT,
            'Rewrite the report and append the required Sources section',
          ),
        },
      ],
    });
    const provider = scenario.provider;
    const originalRequestToolAction = provider.requestToolAction.bind(provider);
    provider.requestToolAction = async (request) => {
      modelCallTimes.push(Date.now());
      return originalRequestToolAction(request);
    };

    runStartedAt = Date.now();
    outcome = await scenario.run();
    runFinishedAt = Date.now();
  });

  afterAll(async () => {
    recordEvidence('e-003-autonomous-loop', {
      container: env?.containerName,
      status: outcome?.state.status,
      usage: outcome?.state.usage,
      wallClockMs: runFinishedAt - runStartedAt,
      events: scenario?.events.events.map((e) => ({
        sequence: e.sequence,
        type: e.type,
        timestamp: e.timestamp,
        ...(e.type === 'TOOL_COMPLETED' ||
        e.type === 'EVALUATION_COMPLETED' ||
        e.type === 'FAILURE_DETECTED' ||
        e.type === 'STRATEGY_CHANGED' ||
        e.type === 'LESSON_CREATED'
          ? { payload: e.payload }
          : {}),
      })),
    });
    await env?.destroy().catch(() => undefined);
  });

  it('completes the goal after one autonomous recovery, exactly as E-000 did with the fake', () => {
    expect(outcome.state.status).toBe('completed');
    expect(outcome.state.usage).toMatchObject({
      iterations: 2,
      toolCalls: 2,
      retries: 1,
      strategyChanges: 1,
    });
  });

  it('the tool succeeded twice; the evaluator failed attempt 1 by inspecting the REAL file in the container', () => {
    expect(scenario.events.ofType('TOOL_COMPLETED')).toHaveLength(2);
    expect(scenario.events.ofType('TOOL_FAILED')).toHaveLength(0);
    expect(scenario.events.ofType('EVALUATION_COMPLETED').map((e) => e.payload.verdict)).toEqual([
      'failure',
      'success',
    ]);
    const failure = scenario.events.ofType('FAILURE_DETECTED')[0];
    expect(failure?.payload.source).toBe('evaluation');
    expect(failure?.payload.summary).toContain(REQUIRED_MARKER);
  });

  it('the artifact exists inside the Linux sandbox, written by the non-root agent user, and satisfies the requirement', async () => {
    expect(env.descriptor.provider).toBe('local-linux');
    expect(await env.readFile(REPORT_PATH)).toBe(APPROACH_B_CONTENT);
    const viaShell = await env.runCommand(
      `grep -c '${REQUIRED_MARKER}' ${REPORT_PATH}; stat -c '%U' ${REPORT_PATH}`,
    );
    expect(viaShell.stdout).toBe('1\nagent\n');
  });

  it('no human supplied the second action: all model calls happened inside run(), from turns fixed beforehand', () => {
    expect(modelCallTimes).toHaveLength(2);
    for (const t of modelCallTimes) {
      expect(t).toBeGreaterThanOrEqual(runStartedAt);
      expect(t).toBeLessThanOrEqual(runFinishedAt);
    }
    // The runtime, not a person, produced the recovery: failure detection, plan revision and
    // retry are runtime-sourced events that precede the second tool selection.
    const s = (type: string, nth = 0) => seqOf(scenario.events, type, nth);
    expect(s('FAILURE_DETECTED')).toBeLessThan(s('TOOL_SELECTED', 1));
    expect(s('PLAN_UPDATED')).toBeLessThan(s('TOOL_SELECTED', 1));
    expect(s('RETRY_STARTED')).toBeLessThan(s('TOOL_SELECTED', 1));
    expect(scenario.provider.requests.length).toBeGreaterThan(0);
  });

  it('emits the same causal event order as E-000 (fake) and E-002 (Cloudflare, deferred)', () => {
    const s = (type: string, nth = 0) => seqOf(scenario.events, type, nth);
    const order = [
      s('GOAL_RECEIVED'),
      s('MEMORY_RETRIEVED'),
      s('PLAN_CREATED'),
      s('TOOL_SELECTED', 0),
      s('TOOL_STARTED', 0),
      s('TOOL_COMPLETED', 0),
      s('EVALUATION_COMPLETED', 0),
      s('FAILURE_DETECTED'),
      s('STRATEGY_CHANGED'),
      s('PLAN_UPDATED'),
      s('RETRY_STARTED'),
      s('TOOL_SELECTED', 1),
      s('TOOL_STARTED', 1),
      s('TOOL_COMPLETED', 1),
      s('EVALUATION_COMPLETED', 1),
      s('LESSON_CREATED'),
      s('GOAL_COMPLETED'),
    ];
    for (const seq of order) expect(seq).toBeGreaterThan(0);
    for (let i = 1; i < order.length; i += 1) expect(order[i]).toBeGreaterThan(order[i - 1] ?? 0);
    const seqs = scenario.events.events.map((e) => e.sequence);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it('persisted decisions, experiences and a lesson whose provenance reaches the seeded knowledge', async () => {
    const decisions = (await scenario.store.query({ kinds: ['decision'] })) as DecisionRecord[];
    const experiences = (await scenario.store.query({
      kinds: ['experience'],
    })) as ExperienceRecord[];
    const lessons = (await scenario.store.query({ kinds: ['lesson'] })) as LessonRecord[];
    expect(decisions).toHaveLength(2);
    expect(experiences.map((e) => e.outcome)).toEqual(['failure', 'success']);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.provenance.memoryRecordIds).toContain(SEED_KNOWLEDGE_ID);
  });
});
