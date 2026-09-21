import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RunOutcome } from '../../../src/agent/runtime/agent-runtime.js';
import { SystemClock } from '../../../src/domain/system-clock.js';
import { UniqueIdGenerator } from '../../../src/domain/unique-ids.js';
import type { AnyAgentEvent } from '../../../src/events/contracts.js';
import { PERSISTENT_MEMORY_KINDS } from '../../../src/memory/records.js';
import { SqliteMemoryStore } from '../../../src/memory/sqlite/sqlite-memory-store.js';
import { createModelProvider } from '../../../src/models/config.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StructuredModelRequest,
  StructuredModelResponse,
  ToolActionProposal,
  ToolActionRequest,
  ToolActionResponse,
} from '../../../src/models/contracts.js';
import { ResilientModelProvider } from '../../../src/models/resilient-provider.js';
import type { LocalLinuxEnvironment } from '../../../src/sandbox/local/local-linux-environment.js';
import { archiveArtifacts } from '../../../src/storage/archive.js';
import { FilesystemStorage } from '../../../src/storage/local/filesystem-storage.js';
import { createStandardToolRegistry } from '../../../src/tools/standard-tools.js';
import { chooseRealEnvironment } from '../../support/real-environment.js';
import {
  GOAL_STATEMENT,
  REPORT_PATH,
  REQUIRED_MARKER,
  buildScenario,
} from '../../support/runtime-scenario.js';
import {
  MODEL_CONFIG,
  MODEL_SUMMARY,
  configureRealModelTimeouts,
  describeRealModel,
  recordEvidence,
} from './gate.js';

/**
 * E-007b — DOES A REAL MODEL USE WHAT A PREVIOUS RUN REMEMBERED?
 *
 * E-007 proved the plumbing with a scripted model. Here nothing is scripted:
 * a live model runs the E-000 goal twice against one SQLite memory file.
 *
 *   Run 1  empty memory, fresh Linux sandbox → whatever the model does, its
 *          experience/decision/lesson records are persisted; the sandbox is destroyed.
 *   Run 2  fresh sandbox, same goal → the retriever finds Run 1's records, the planner
 *          is shown them; we record whether the plan cites them and whether the first
 *          attempt already satisfies the evaluator.
 *
 * Assertions are about honesty of the machinery (terminal statuses, Run 2
 * retrieved only Run 1 records, complete telemetry). Whether memory changed
 * the model's behaviour is EVIDENCE, recorded per pair — never asserted,
 * because a 3B model may ignore what it is shown, and that is a finding too.
 *
 * Only the filesystem tool family is registered (the goal needs nothing
 * else), which keeps the catalogue cost and the model's tool confusion out
 * of the comparison.
 */
configureRealModelTimeouts();

const clock = new SystemClock();
const PAIRS = Math.max(1, Number(process.env['AGENT_E007B_PAIRS'] ?? '1') || 1);

/**
 * Records every request (so the evidence shows what the planner was told) and
 * every tool proposal (so the evidence shows what the model actually asked
 * to write, in order — the sandbox file only ever holds the last write).
 */
class RecordingModelProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  readonly proposals: ToolActionProposal[] = [];
  constructor(private readonly inner: ModelProvider) {}
  get descriptor() {
    return this.inner.descriptor;
  }
  generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return this.inner.generate(request);
  }
  structuredGenerate<T>(request: StructuredModelRequest<T>): Promise<StructuredModelResponse<T>> {
    this.requests.push(request);
    return this.inner.structuredGenerate(request);
  }
  async requestToolAction(request: ToolActionRequest): Promise<ToolActionResponse> {
    this.requests.push(request);
    const response = await this.inner.requestToolAction(request);
    this.proposals.push(response.proposal);
    return response;
  }
}

/** The text a `fs.write` proposal would put in the file, if that is what was proposed. */
function proposedWriteContent(proposal: ToolActionProposal | undefined): string | null {
  if (!proposal || proposal.kind !== 'tool' || proposal.toolName !== 'fs.write') return null;
  const input = proposal.input as { content?: unknown } | null;
  return typeof input?.content === 'string' ? input.content : null;
}

function realProvider(): RecordingModelProvider {
  if (!MODEL_CONFIG) throw new Error('gate should have skipped this file');
  return new RecordingModelProvider(
    new ResilientModelProvider(
      createModelProvider(MODEL_CONFIG, { clock, ids: new UniqueIdGenerator() }),
      { maxRetries: 2, maxReasks: 1 },
    ),
  );
}

const environmentChoice = await chooseRealEnvironment();
if ('unavailable' in environmentChoice)
  console.warn(`[skip] E-007b NOT RUN — ${environmentChoice.unavailable}`);

const opened: LocalLinuxEnvironment[] = [];
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(opened.map((e) => e.destroy().catch(() => undefined)));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface RunSummary {
  readonly runId: string;
  readonly environmentId: string;
  readonly status: string;
  readonly terminationReason?: string;
  readonly usage: Record<string, number>;
  readonly durationMs: number;
  readonly retrieved: {
    readonly hitCount: number;
    readonly recordIds: readonly string[];
    readonly kinds: readonly string[];
  };
  readonly plan: {
    readonly strategy: string;
    readonly taskCount: number;
    readonly informedByMemoryRecordIds: readonly string[];
  };
  readonly plannerPromptMemorySection: string;
  readonly written: Record<string, readonly string[]>;
  readonly lessonStatements: readonly string[];
  readonly firstAttempt: {
    readonly toolName?: string;
    readonly contentHadRequiredMarker: boolean | null;
    readonly verdict?: string;
  };
  /** Every tool proposal in order: tool name and, for fs.write, whether the content had the marker. */
  readonly proposals: readonly { readonly tool: string; readonly hadMarker: boolean | null }[];
  readonly evaluations: readonly string[];
  readonly reportHasRequiredMarker: boolean;
  readonly goalCompleted: boolean;
  readonly modelCalls: {
    readonly started: number;
    readonly completed: number;
    readonly failed: number;
  };
  readonly archived: readonly string[];
  readonly eventTypes: readonly string[];
}

async function performRun(
  label: string,
  store: SqliteMemoryStore,
  storage: FilesystemStorage,
): Promise<RunSummary> {
  if ('unavailable' in environmentChoice) throw new Error('unreachable');
  const env = await environmentChoice.open(label);
  opened.push(env);
  expect(await env.fileExists(REPORT_PATH)).toBe(false);
  const provider = realProvider();
  const startedMs = clock.monotonicMs();
  const scenario = await buildScenario({
    turns: [],
    model: provider,
    clock,
    ids: new UniqueIdGenerator(),
    store,
    seed: [],
    environment: env,
    tools: createStandardToolRegistry({ families: ['filesystem'] }),
    goalStatement: GOAL_STATEMENT,
    requirement: { path: REPORT_PATH, requiredMarker: REQUIRED_MARKER },
    resilience: { maxRetries: 2, maxReasks: 1 },
    limits: {
      maxIterations: 4,
      maxToolCalls: 6,
      maxModelCalls: 16,
      maxTotalTokens: 300_000,
      maxDurationMs: 600_000,
    },
  });
  const outcome: RunOutcome = await scenario.run();
  const durationMs = clock.monotonicMs() - startedMs;
  const events: readonly AnyAgentEvent[] = scenario.events.events;

  const reportHasRequiredMarker =
    (await env.fileExists(REPORT_PATH)) &&
    (await env.readFile(REPORT_PATH)).includes(REQUIRED_MARKER);
  const artifacts = scenario.session.working
    .snapshot()
    .observations.flatMap((o) => o.artifacts ?? []);
  const archived = await archiveArtifacts(env, artifacts, storage, {
    prefix: 'artifacts',
    clock,
    emit: (payload, correlation) => scenario.session.emit('ARTIFACT_STORED', payload, correlation),
  });
  await env.destroy();

  const written: Record<string, string[]> = {};
  for (const id of outcome.writtenRecordIds) {
    const record = await store.get(id);
    if (record) (written[record.kind] ??= []).push(id);
  }
  const lessonStatements: string[] = [];
  for (const lesson of await store.query({ kinds: ['lesson'], runId: scenario.session.runId })) {
    if (lesson.kind === 'lesson') lessonStatements.push(lesson.statement);
  }

  const retrieved = events.find((e) => e.type === 'MEMORY_RETRIEVED');
  const plan = events.find((e) => e.type === 'PLAN_CREATED');
  const planRequest = provider.requests.find((r) => r.purpose === 'create_plan');
  const planPrompt = planRequest?.messages.map((m) => m.content).join('\n') ?? '';
  const memorySection = planPrompt.slice(planPrompt.indexOf('RELEVANT MEMORY'));
  const firstSelected = events.find((e) => e.type === 'TOOL_SELECTED');
  const firstEvaluation = events.find((e) => e.type === 'EVALUATION_COMPLETED');
  // What the model proposed to write first — not the file at end of run, which
  // only holds the last write (every attempt targets the same path).
  const firstContent = proposedWriteContent(provider.proposals.find((p) => p.kind === 'tool'));
  const modelCalls = {
    started: events.filter((e) => e.type === 'MODEL_CALL_STARTED').length,
    completed: events.filter((e) => e.type === 'MODEL_CALL_COMPLETED').length,
    failed: events.filter((e) => e.type === 'MODEL_CALL_FAILED').length,
  };

  return {
    runId: scenario.session.runId,
    environmentId: env.descriptor.environmentId,
    status: outcome.state.status,
    ...(outcome.state.terminationReason
      ? { terminationReason: outcome.state.terminationReason }
      : {}),
    usage: { ...outcome.state.usage } as Record<string, number>,
    durationMs: Math.round(durationMs),
    retrieved: {
      hitCount: retrieved?.type === 'MEMORY_RETRIEVED' ? retrieved.payload.hitCount : -1,
      recordIds: retrieved?.type === 'MEMORY_RETRIEVED' ? [...retrieved.payload.recordIds] : [],
      kinds: retrieved?.type === 'MEMORY_RETRIEVED' ? [...retrieved.payload.kinds] : [],
    },
    plan: {
      strategy: plan?.type === 'PLAN_CREATED' ? plan.payload.strategySummary : '',
      taskCount: plan?.type === 'PLAN_CREATED' ? plan.payload.taskCount : 0,
      informedByMemoryRecordIds:
        plan?.type === 'PLAN_CREATED' ? [...plan.payload.informedByMemoryRecordIds] : [],
    },
    plannerPromptMemorySection: memorySection.slice(0, 2000),
    written,
    lessonStatements,
    firstAttempt: {
      ...(firstSelected?.type === 'TOOL_SELECTED'
        ? { toolName: firstSelected.payload.toolName }
        : {}),
      contentHadRequiredMarker:
        firstContent === null ? null : firstContent.includes(REQUIRED_MARKER),
      ...(firstEvaluation?.type === 'EVALUATION_COMPLETED'
        ? { verdict: firstEvaluation.payload.verdict }
        : {}),
    },
    proposals: provider.proposals.map((p) => {
      const content = proposedWriteContent(p);
      return {
        tool: p.kind === 'tool' ? p.toolName : p.kind,
        hadMarker: content === null ? null : content.includes(REQUIRED_MARKER),
      };
    }),
    evaluations: events
      .filter((e) => e.type === 'EVALUATION_COMPLETED')
      .map((e) => (e.type === 'EVALUATION_COMPLETED' ? e.payload.verdict : '')),
    reportHasRequiredMarker,
    goalCompleted: events.some((e) => e.type === 'GOAL_COMPLETED'),
    modelCalls,
    archived: archived.flatMap((a) =>
      a.status === 'stored' && a.stored.location.storage === 'persistent'
        ? [a.stored.location.key]
        : [],
    ),
    eventTypes: events.map((e) => e.type),
  };
}

describeRealModel('E-007b · a real model runs twice against one persistent memory', () => {
  describe.skipIf('unavailable' in environmentChoice)('pairs', () => {
    for (let pair = 1; pair <= PAIRS; pair += 1) {
      it(`pair ${pair}/${PAIRS}: Run 1 persists, sandbox destroyed, Run 2 retrieves only Run 1 records; behaviour recorded`, async () => {
        if ('unavailable' in environmentChoice) return;
        const dir = mkdtempSync(join(tmpdir(), 'agent-e007b-'));
        dirs.push(dir);
        const storage = await FilesystemStorage.open({ root: join(dir, 'storage'), clock });

        const store1 = SqliteMemoryStore.open({ path: join(dir, 'memory.sqlite') });
        let run1: RunSummary;
        try {
          run1 = await performRun(`e007b-${pair}-run1`, store1, storage);
        } finally {
          store1.close();
        }

        const store2 = SqliteMemoryStore.open({ path: join(dir, 'memory.sqlite') });
        let run2: RunSummary;
        const counts: Record<string, number> = {};
        try {
          run2 = await performRun(`e007b-${pair}-run2`, store2, storage);
          for (const kind of PERSISTENT_MEMORY_KINDS)
            counts[kind] = await store2.count({ kinds: [kind] });
        } finally {
          store2.close();
        }

        const run1Ids = Object.values(run1.written).flat();
        const evidence = {
          environment: environmentChoice.label,
          model: MODEL_SUMMARY,
          run1,
          run2,
          storeCountsAfterBoth: counts,
          comparison: {
            run1Iterations: run1.usage['iterations'],
            run2Iterations: run2.usage['iterations'],
            run1FirstAttemptHadMarker: run1.firstAttempt.contentHadRequiredMarker,
            run2FirstAttemptHadMarker: run2.firstAttempt.contentHadRequiredMarker,
            run2RetrievedFromRun1: run2.retrieved.recordIds.every((id) => run1Ids.includes(id)),
            run2PlanCitedRun1Records: run2.plan.informedByMemoryRecordIds.length > 0,
            run1Completed: run1.goalCompleted,
            run2Completed: run2.goalCompleted,
          },
        };
        recordEvidence(`e007b-pair-${pair}`, evidence);

        // Honesty of the machinery — asserted.
        for (const run of [run1, run2]) {
          expect(['completed', 'failed', 'gave_up', 'limit_reached']).toContain(run.status);
          expect(run.modelCalls.started).toBe(run.modelCalls.completed + run.modelCalls.failed);
          expect(run.goalCompleted).toBe(run.status === 'completed');
          if (run.goalCompleted) expect(run.reportHasRequiredMarker).toBe(true);
        }
        expect(run1.retrieved.hitCount).toBe(0);
        expect(run1Ids.length).toBeGreaterThan(0);
        expect(run2.environmentId).not.toBe(run1.environmentId);
        for (const id of run2.retrieved.recordIds) expect(run1Ids).toContain(id);
        if (run2.retrieved.hitCount > 0) {
          expect(run2.plannerPromptMemorySection).toContain('RELEVANT MEMORY (cite record ids');
        }
        // Whether the model cited or acted on memory is evidence, not a pass condition.
      }, 1_500_000);
    }
  });
});
