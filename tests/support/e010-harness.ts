import { runSpaceAgent } from '../../src/composition/space-run.js';
import type { Clock, IdGenerator } from '../../src/domain/ids.js';
import type { RunLimits } from '../../src/domain/run.js';
import { InMemoryEventBus } from './in-memory-event-bus.js';
import type { EmbeddingProvider } from '../../src/models/embeddings.js';
import type { StructuredModelRequest, ToolActionProposal } from '../../src/models/contracts.js';
import type { OpenedMemory } from '../../src/memory/opened-memory.js';
import { FixedClock } from './deterministic.js';
import { FakeExecutionEnvironment } from './fake-execution-environment.js';
import { PUBLIC_PAGE_URL, syntheticPublicPageStdout } from './public-page.js';
import { ScriptedModelProvider } from './scripted-model-provider.js';
import {
  planTurn,
  reviseTurnEchoingTask,
  REQUIRED_MARKER,
  REPORT_PATH,
} from './runtime-scenario.js';

/**
 * Same goal twice. Run 1 reads a public page through `web.fetch` and writes
 * the report after a failed evaluation. Run 2 is shown the ingested knowledge
 * and writes the report on the first action. The scripted model is not a
 * claim that a real model gets faster; it proves the measurement.
 */
export const E010_GOAL =
  'Write a short report at /workspace/report.md about written summaries, and end the file with a Sources heading that names the material used.';

export const E010_CRITERION = {
  kind: 'file_contains' as const,
  path: REPORT_PATH,
  marker: REQUIRED_MARKER,
};

export const E010_LIMITS: RunLimits = {
  maxIterations: 8,
  maxToolCalls: 12,
  maxModelCalls: 24,
  maxTotalTokens: 100_000,
  maxDurationMs: 60_000,
};

const REPORT = `# Written summaries

A written summary names the material it used.

${REQUIRED_MARKER}
- ${PUBLIC_PAGE_URL}
`;

const fetchPage: ToolActionProposal = {
  kind: 'tool',
  toolName: 'web.fetch',
  input: { url: PUBLIC_PAGE_URL },
  rationale: 'Read the public house style before writing',
};

const writeReport: ToolActionProposal = {
  kind: 'tool',
  toolName: 'fs.write',
  input: { path: REPORT_PATH, content: REPORT },
  rationale: 'Write the report with a Sources heading',
};

type MeasuredOutcome = Awaited<ReturnType<typeof runSpaceAgent>>;

export interface EfficiencyPair {
  readonly cold: MeasuredOutcome;
  readonly warm: MeasuredOutcome;
  readonly coldEvents: InMemoryEventBus;
  readonly warmEvents: InMemoryEventBus;
}

export function publicPageEnvironment(): FakeExecutionEnvironment {
  const environment = new FakeExecutionEnvironment();
  environment.setCommandScript((command) => {
    const stdout = syntheticPublicPageStdout(command);
    return {
      command,
      exitCode: 0,
      stdout: stdout ?? '',
      stderr: '',
      durationMs: 1,
      timedOut: false,
    };
  });
  return environment;
}

function planCitingPresentedKnowledge() {
  return {
    structured: (request: StructuredModelRequest<unknown>) => {
      const prompt = request.messages.map((message) => message.content).join('\n');
      const ids = [...prompt.matchAll(/\[(mem-[0-9a-f]+)\] \(knowledge\)/g)].map(
        (match) => match[1] ?? '',
      );
      if (ids.length === 0 || ids.some((id) => id === '')) {
        throw new Error('warm plan saw no presented knowledge record');
      }
      return planTurn(ids).structured;
    },
  };
}

export async function runEfficiencyPair(options: {
  readonly memory: OpenedMemory;
  readonly embeddings: EmbeddingProvider;
  readonly ids: IdGenerator;
  readonly clock?: Clock;
}): Promise<EfficiencyPair> {
  const clock = options.clock ?? new FixedClock();
  const coldEvents = new InMemoryEventBus();
  const warmEvents = new InMemoryEventBus();
  const shared = {
    goalStatement: E010_GOAL,
    verifiableCriteria: [E010_CRITERION],
    memoryRetrieval: 'on' as const,
    memory: options.memory,
    embeddings: options.embeddings,
    limits: E010_LIMITS,
    clock,
    ids: options.ids,
    resilience: { maxRetries: 0, maxReasks: 0, sleep: async () => {} },
  };
  const cold = await runSpaceAgent({
    ...shared,
    events: coldEvents,
    environment: publicPageEnvironment(),
    model: new ScriptedModelProvider(
      [
        planTurn([]),
        { proposal: fetchPage },
        reviseTurnEchoingTask({ strategyChanged: true }),
        { proposal: writeReport },
      ],
      options.ids,
    ),
  });
  const warm = await runSpaceAgent({
    ...shared,
    events: warmEvents,
    environment: publicPageEnvironment(),
    model: new ScriptedModelProvider(
      [planCitingPresentedKnowledge(), { proposal: writeReport }],
      options.ids,
    ),
  });
  return { cold, warm, coldEvents, warmEvents };
}
