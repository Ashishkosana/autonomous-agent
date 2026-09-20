import { afterAll, beforeAll, expect, it } from 'vitest';
import type { RunOutcome } from '../../../src/agent/runtime/agent-runtime.js';
import type { ExperienceRecord, LessonRecord } from '../../../src/memory/records.js';
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
  describeCloudflare,
  realSandbox,
  recordEvidence,
  uniqueSandboxId,
  type RealSandbox,
} from './gate.js';

/**
 * REAL CLOUDFLARE EXECUTION (credential-gated).
 *
 * The Phase 2 recovery scenario — scripted model, rule-based evaluator, the
 * real autonomous runtime — with FakeExecutionEnvironment replaced by
 * CloudflareSandboxEnvironment. Intelligence is deterministic; the file is
 * really written inside a Cloudflare container and the evaluator really reads
 * it back from there.
 */
configureIntegrationTimeouts();

describeCloudflare('Cloudflare Sandbox · autonomous loop with deterministic intelligence', () => {
  let sandbox: RealSandbox;
  let scenario: Scenario;
  let outcome: RunOutcome;

  beforeAll(async () => {
    sandbox = realSandbox(uniqueSandboxId('agent-p3-loop'));
    // Prove the artifact does not pre-exist in this container.
    expect(await sandbox.environment.fileExists(REPORT_PATH)).toBe(false);

    scenario = await buildScenario({
      environment: sandbox.environment,
      // Real round-trips take real time; the run must not be cut off by the wall-clock limit.
      limits: { maxDurationMs: 600_000 },
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
    outcome = await scenario.run();
  });

  afterAll(async () => {
    recordEvidence('autonomous-loop', {
      sandboxId: sandbox?.sandboxId,
      status: outcome?.state.status,
      usage: outcome?.state.usage,
      events: scenario?.events.events.map((e) => ({
        sequence: e.sequence,
        type: e.type,
        ...(e.type === 'TOOL_COMPLETED' ||
        e.type === 'EVALUATION_COMPLETED' ||
        e.type === 'FAILURE_DETECTED'
          ? { payload: e.payload }
          : {}),
      })),
    });
    await sandbox?.environment.destroy().catch(() => undefined);
  });

  it('completes the goal after one autonomous recovery, exactly as with the fake environment', () => {
    expect(outcome.state.status).toBe('completed');
    expect(outcome.state.usage.iterations).toBe(2);
    expect(outcome.state.usage.toolCalls).toBe(2);
    expect(outcome.state.usage.retries).toBe(1);
    expect(outcome.state.usage.strategyChanges).toBe(1);
  });

  it('the tool succeeded twice but the evaluator failed the first attempt by inspecting the real file', () => {
    expect(scenario.events.ofType('TOOL_COMPLETED')).toHaveLength(2);
    expect(scenario.events.ofType('TOOL_FAILED')).toHaveLength(0);
    const verdicts = scenario.events.ofType('EVALUATION_COMPLETED').map((e) => e.payload.verdict);
    expect(verdicts).toEqual(['failure', 'success']);
    const failure = scenario.events.ofType('FAILURE_DETECTED')[0];
    expect(failure?.payload.source).toBe('evaluation');
    expect(failure?.payload.summary).toContain(REQUIRED_MARKER);
  });

  it('the final artifact lives in the Cloudflare container and satisfies the requirement', async () => {
    expect(sandbox.environment.descriptor.provider).toBe('cloudflare-sandbox');
    const content = await sandbox.environment.readFile(REPORT_PATH);
    expect(content).toBe(APPROACH_B_CONTENT);
    const viaShell = await sandbox.environment.runCommand(
      `grep -c '${REQUIRED_MARKER}' ${REPORT_PATH}`,
    );
    expect(viaShell.stdout.trim()).toBe('1');
  });

  it('emits the same causal event order as the Phase 2 fake-environment run', () => {
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

  it('persisted the same learning records', async () => {
    const experiences = (await scenario.store.query({
      kinds: ['experience'],
    })) as ExperienceRecord[];
    const lessons = (await scenario.store.query({ kinds: ['lesson'] })) as LessonRecord[];
    expect(experiences.map((e) => e.outcome)).toEqual(['failure', 'success']);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.provenance.memoryRecordIds).toContain(SEED_KNOWLEDGE_ID);
  });
});
