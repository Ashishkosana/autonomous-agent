import { asMemoryRecordId, type MemoryRecordId } from '../../src/domain/ids.js';
import type { RunLimits } from '../../src/domain/run.js';
import type { Evaluator } from '../../src/evaluation/contracts.js';
import type { KnowledgeRecord, PersistentMemoryRecord } from '../../src/memory/records.js';
import type { ToolActionProposal } from '../../src/models/contracts.js';
import type { ExecutionEnvironment } from '../../src/sandbox/execution-environment.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { createAutonomousRun } from '../../src/agent/runtime/create-run.js';
import type { RunOutcome } from '../../src/agent/runtime/agent-runtime.js';
import {
  ArtifactRequirementEvaluator,
  type ArtifactRequirement,
} from './artifact-requirement-evaluator.js';
import { FixedClock, SequentialIdGenerator } from './deterministic.js';
import { FakeExecutionEnvironment } from './fake-execution-environment.js';
import { InMemoryEventBus } from './in-memory-event-bus.js';
import { InMemoryMemoryStore } from './in-memory-memory-store.js';
import { KeywordOnlyRetriever } from './keyword-only-retriever.js';
import { ScriptedModelProvider } from './scripted-model-provider.js';
import { echoTool, writeFileTool } from './tools.js';

/**
 * Deterministic end-to-end scenario: one goal, a scripted "model", a fake
 * sandbox, an in-memory store, and a rule-based evaluator. Everything the
 * runtime does is reproducible and observable through `events` and `store`.
 */

export const REPORT_PATH = '/workspace/report.md';
export const REQUIRED_MARKER = '## Sources';
export const GOAL_STATEMENT = `Produce a research report at ${REPORT_PATH} that includes a Sources section`;

export const SEED_KNOWLEDGE_ID: MemoryRecordId = asMemoryRecordId('seed-knowledge-1');

/** Knowledge from a hypothetical earlier run; retrievable by keyword overlap with the goal. */
export const seedKnowledge: KnowledgeRecord = {
  recordId: SEED_KNOWLEDGE_ID,
  kind: 'knowledge',
  runId: asRunIdLoose('run-0'),
  createdAt: '2025-12-31T00:00:00.000Z',
  summary: 'Research report format: a report needs a Sources section listing its references',
  tags: ['report', 'format'],
  provenance: {},
  title: 'Research report format',
  content: 'A research report must end with a "## Sources" section listing every source used.',
  sources: [{ url: 'https://example.test/report-style', retrievedAt: '2025-12-31T00:00:00.000Z' }],
  confidence: 0.9,
};

function asRunIdLoose(value: string) {
  return value as KnowledgeRecord['runId'];
}

/** Approach A: writes the report without the required section. Tool succeeds, task does not. */
export const APPROACH_A_CONTENT = '# Report\n\nFindings: the runtime loop works.\n';
/** Approach B: includes the section the evaluator requires. */
export const APPROACH_B_CONTENT = `# Report\n\nFindings: the runtime loop works.\n\n${REQUIRED_MARKER}\n- https://example.test/report-style\n`;

export const writeReport = (content: string, rationale: string): ToolActionProposal => ({
  kind: 'tool',
  toolName: 'fs.write',
  input: { path: REPORT_PATH, content },
  rationale,
});

export const planTurn = (citedMemoryRecordIds: string[] = []) => ({
  structured: {
    strategySummary: 'Write the report in a single pass from what is already known',
    tasks: [
      {
        description: 'Write the research report file',
        expectedEvidence: [`${REPORT_PATH} exists`, `contains ${REQUIRED_MARKER}`],
      },
    ],
    citedMemoryRecordIds,
  },
});

export const reviseTurn = ({
  strategyChanged,
  keepTaskId = 'task-1',
}: {
  strategyChanged: boolean;
  keepTaskId?: string;
}) => ({
  structured: {
    strategySummary: strategyChanged
      ? 'Write the report with an explicit Sources section, as required'
      : 'Write the report in a single pass from what is already known',
    strategyChanged,
    ...(strategyChanged
      ? { changeReason: 'The first draft omitted the required Sources section' }
      : {}),
    revisionReason: 'Evaluation found the artifact missing its Sources section',
    tasks: [
      {
        taskId: keepTaskId,
        description: 'Write the research report file including a Sources section',
        expectedEvidence: [`${REPORT_PATH} exists`, `contains ${REQUIRED_MARKER}`],
      },
    ],
    citedMemoryRecordIds: [SEED_KNOWLEDGE_ID],
  },
});

export const DEFAULT_LIMITS: RunLimits = {
  maxIterations: 10,
  maxToolCalls: 10,
  maxModelCalls: 30,
  maxTotalTokens: 100_000,
  maxDurationMs: 60_000,
};

export interface ScenarioTurn {
  readonly text?: string;
  readonly structured?: unknown;
  readonly proposal?: ToolActionProposal;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface ScenarioOptions {
  readonly turns: readonly ScenarioTurn[];
  readonly limits?: Partial<RunLimits>;
  readonly seed?: readonly PersistentMemoryRecord[];
  readonly requirement?: ArtifactRequirement;
  readonly evaluator?: (ids: SequentialIdGenerator, clock: FixedClock) => Evaluator;
  readonly goalStatement?: string;
  /** Defaults to a fresh FakeExecutionEnvironment; integration tests pass a real one. */
  readonly environment?: ExecutionEnvironment;
}

export interface Scenario {
  readonly ids: SequentialIdGenerator;
  readonly clock: FixedClock;
  readonly events: InMemoryEventBus;
  readonly store: InMemoryMemoryStore;
  readonly environment: ExecutionEnvironment;
  readonly provider: ScriptedModelProvider;
  run(): Promise<RunOutcome>;
}

export async function buildScenario(options: ScenarioOptions): Promise<Scenario> {
  const ids = new SequentialIdGenerator();
  const clock = new FixedClock();
  const events = new InMemoryEventBus();
  const store = new InMemoryMemoryStore();
  const environment = options.environment ?? new FakeExecutionEnvironment();
  const provider = new ScriptedModelProvider(options.turns, ids);
  for (const record of options.seed ?? [seedKnowledge]) await store.put(record);

  const evaluator = options.evaluator
    ? options.evaluator(ids, clock)
    : new ArtifactRequirementEvaluator(
        options.requirement ?? { path: REPORT_PATH, requiredMarker: REQUIRED_MARKER },
        ids,
        clock,
      );

  const { runtime } = createAutonomousRun({
    goalStatement: options.goalStatement ?? GOAL_STATEMENT,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    ids,
    clock,
    events,
    model: provider,
    tools: new ToolRegistry().register(writeFileTool).register(echoTool),
    environment,
    evaluator,
    memoryStore: store,
    retriever: new KeywordOnlyRetriever(store, clock),
  });

  return { ids, clock, events, store, environment, provider, run: () => runtime.run() };
}

/** Sequence number of the n-th event (0-based) of a type, or -1 if absent. */
export function seqOf(events: InMemoryEventBus, type: string, nth = 0): number {
  const matches = events.events.filter((e) => e.type === type);
  return matches[nth]?.sequence ?? -1;
}
