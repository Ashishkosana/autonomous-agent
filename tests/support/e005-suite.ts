import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunOutcome } from '../../src/agent/runtime/agent-runtime.js';
import { SystemClock } from '../../src/domain/system-clock.js';
import type { ExperienceRecord, LessonRecord } from '../../src/memory/records.js';
import type { ToolActionProposal } from '../../src/models/contracts.js';
import type { ExecutionEnvironment } from '../../src/sandbox/execution-environment.js';
import { createStandardToolRegistry } from '../../src/tools/standard-tools.js';
import { buildScenario, seqOf, type Scenario } from './runtime-scenario.js';

/**
 * E-005 — REAL CODE EXECUTION, TOOL SUCCESS ≠ TASK SUCCESS.
 *
 * The model is scripted; everything else is real: the standard `code.run`
 * tool writes a Python program into the sandbox and python3 executes it. The
 * first program has an off-by-one bug — it exits 0, the tool call is `ok`,
 * and the file it wrote exists — yet the evaluator, reading the real file,
 * rejects it. The runtime detects the failure, revises the plan, and the
 * corrected program satisfies the goal. No exit code was ever consulted to
 * decide success.
 */

export const E005_RESULT_PATH = '/workspace/out/result.txt';
export const E005_REQUIRED = '5050';
export const E005_GOAL = `Write a Python program that computes the sum of the integers 1..100 and saves the result to ${E005_RESULT_PATH}; the file must contain ${E005_REQUIRED}`;

const program = (upper: number) =>
  [
    'import os',
    `total = sum(range(1, ${upper}))`,
    `os.makedirs(os.path.dirname(${JSON.stringify(E005_RESULT_PATH)}), exist_ok=True)`,
    `with open(${JSON.stringify(E005_RESULT_PATH)}, 'w') as f:`,
    '    f.write(str(total) + "\\n")',
    'print("wrote", total)',
    '',
  ].join('\n');

/** Off by one: range(1, 100) stops at 99 → 4950. Runs cleanly, exit 0. */
export const BUGGY_PROGRAM = program(100);
/** Correct: range(1, 101) → 5050. */
export const FIXED_PROGRAM = program(101);

const runProgram = (source: string, rationale: string): ToolActionProposal => ({
  kind: 'tool',
  toolName: 'code.run',
  input: { language: 'python', source },
  rationale,
});

export const E005_TURNS = [
  {
    structured: {
      strategySummary: 'Compute the sum with a short Python script and write it to the result file',
      tasks: [
        {
          description: 'Write and run a Python program that saves the sum to the result file',
          expectedEvidence: [`${E005_RESULT_PATH} exists`, `contains ${E005_REQUIRED}`],
        },
      ],
      citedMemoryRecordIds: [],
    },
  },
  { proposal: runProgram(BUGGY_PROGRAM, 'Sum the range and write the file in one script') },
  {
    structured: {
      strategySummary: 'Fix the range bound so the sum includes 100, then rerun',
      strategyChanged: true,
      changeReason: 'The program ran but the file holds the wrong total; the range excluded 100',
      revisionReason: 'Evaluation: result file does not contain 5050',
      tasks: [
        {
          taskId: 'task-1',
          description: 'Rerun the program with range(1, 101) so 100 is included',
          expectedEvidence: [`${E005_RESULT_PATH} contains ${E005_REQUIRED}`],
        },
      ],
      citedMemoryRecordIds: [],
    },
  },
  { proposal: runProgram(FIXED_PROGRAM, 'Use an inclusive upper bound of 101') },
];

export interface E005Options {
  readonly title: string;
  readonly open: () => Promise<ExecutionEnvironment>;
  readonly onEvidence?: (data: unknown) => void;
  /** Extra assertions on the real environment after the run. */
  readonly inspect?: (env: ExecutionEnvironment) => Promise<Record<string, unknown>>;
}

export function describeE005(options: E005Options): void {
  describe(`E-005 · real code execution, tool ok ≠ task ok — ${options.title}`, () => {
    let env: ExecutionEnvironment;
    let scenario: Scenario;
    let outcome: RunOutcome;
    let inspection: Record<string, unknown> = {};

    beforeAll(async () => {
      env = await options.open();
      expect(await env.fileExists(E005_RESULT_PATH)).toBe(false);
      scenario = await buildScenario({
        environment: env,
        clock: new SystemClock(),
        goalStatement: E005_GOAL,
        seed: [],
        requirement: { path: E005_RESULT_PATH, requiredMarker: E005_REQUIRED },
        tools: createStandardToolRegistry({ options: { defaultTimeoutMs: 30_000 } }),
        limits: { maxDurationMs: 600_000 },
        turns: E005_TURNS,
      });
      outcome = await scenario.run();
      inspection = (await options.inspect?.(env)) ?? {};
    }, 180_000);

    afterAll(() => {
      options.onEvidence?.({
        status: outcome?.state.status,
        usage: outcome?.state.usage,
        inspection,
        events: scenario?.events.events.map((e) => ({
          sequence: e.sequence,
          type: e.type,
          ...(e.type === 'COMMAND_FINISHED' ||
          e.type === 'FILE_CREATED' ||
          e.type === 'TOOL_COMPLETED' ||
          e.type === 'EVALUATION_COMPLETED' ||
          e.type === 'FAILURE_DETECTED' ||
          e.type === 'STRATEGY_CHANGED' ||
          e.type === 'LESSON_CREATED'
            ? { payload: e.payload }
            : {}),
        })),
      });
    });

    it('completes after one autonomous recovery: two real program executions, one strategy change', () => {
      expect(outcome.state.status).toBe('completed');
      expect(outcome.state.usage).toMatchObject({
        iterations: 2,
        toolCalls: 2,
        retries: 1,
        strategyChanges: 1,
      });
    });

    it('both programs really ran with exit 0 — the tool reported ok twice — and yet attempt 1 failed evaluation', () => {
      const finished = scenario.events.ofType('COMMAND_FINISHED').map((e) => e.payload);
      expect(finished).toHaveLength(2);
      expect(finished.map((p) => p.exitCode)).toEqual([0, 0]);
      expect(
        finished.every((p) => /python3 \/workspace\/\.agent\/code\/act-\d+\.py/.test(p.command)),
      ).toBe(true);
      expect(scenario.events.ofType('TOOL_COMPLETED')).toHaveLength(2);
      expect(scenario.events.ofType('TOOL_FAILED')).toHaveLength(0);
      expect(scenario.events.ofType('EVALUATION_COMPLETED').map((e) => e.payload.verdict)).toEqual([
        'failure',
        'success',
      ]);
      const failure = scenario.events.ofType('FAILURE_DETECTED')[0]?.payload;
      expect(failure?.source).toBe('evaluation');
      expect(failure?.summary).toContain(E005_REQUIRED);
      const stdout = scenario.events.ofType('COMMAND_OUTPUT').map((e) => e.payload.chunk);
      expect(stdout).toEqual(['wrote 4950\n', 'wrote 5050\n']);
    });

    it('the evaluator judged the real file, not the exit code: the file first held 4950 and finally holds 5050', async () => {
      expect(await env.readFile(E005_RESULT_PATH)).toBe('5050\n');
      const experiences = (await scenario.store.query({
        kinds: ['experience'],
      })) as ExperienceRecord[];
      expect(experiences.map((e) => e.outcome)).toEqual(['failure', 'success']);
      const evaluations = scenario.events.ofType('EVALUATION_COMPLETED');
      expect(evaluations[0]?.payload.toolStatus).toBe('ok');
      expect(evaluations[0]?.payload.verdict).toBe('failure');
    });

    it('program sources are real artifacts in the sandbox, linked to their actions', async () => {
      const created = scenario.events.ofType('FILE_CREATED').map((e) => e.payload.path);
      expect(created).toHaveLength(2);
      for (const path of created) {
        expect(await env.fileExists(path)).toBe(true);
      }
      expect(await env.readFile(created[0] ?? '')).toBe(BUGGY_PROGRAM);
      expect(await env.readFile(created[1] ?? '')).toBe(FIXED_PROGRAM);
    });

    it('causal order: exit-0 completion → evaluation failure → strategy change → replan → retry → success → lesson', () => {
      const s = (type: string, nth = 0) => seqOf(scenario.events, type, nth);
      const order = [
        s('GOAL_RECEIVED'),
        s('PLAN_CREATED'),
        s('TOOL_SELECTED', 0),
        s('FILE_CREATED', 0),
        s('COMMAND_STARTED', 0),
        s('COMMAND_FINISHED', 0),
        s('TOOL_COMPLETED', 0),
        s('EVALUATION_COMPLETED', 0),
        s('FAILURE_DETECTED'),
        s('STRATEGY_CHANGED'),
        s('PLAN_UPDATED'),
        s('RETRY_STARTED'),
        s('TOOL_SELECTED', 1),
        s('COMMAND_FINISHED', 1),
        s('TOOL_COMPLETED', 1),
        s('EVALUATION_COMPLETED', 1),
        s('LESSON_CREATED'),
        s('GOAL_COMPLETED'),
      ];
      for (const seq of order) expect(seq).toBeGreaterThan(0);
      for (let i = 1; i < order.length; i += 1) expect(order[i]).toBeGreaterThan(order[i - 1] ?? 0);
      const toolEvents = scenario.events.events.filter(
        (e) => e.type.startsWith('COMMAND_') || e.type.startsWith('FILE_'),
      );
      expect(toolEvents.every((e) => e.correlation.actionId !== undefined)).toBe(true);
    });

    it('the lesson links to the failing and succeeding experience', async () => {
      const lessons = (await scenario.store.query({ kinds: ['lesson'] })) as LessonRecord[];
      expect(lessons).toHaveLength(1);
      expect(lessons[0]?.provenance.evaluationIds?.length).toBeGreaterThan(0);
    });
  });
}
