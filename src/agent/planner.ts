import {
  asMemoryRecordId,
  asPlanId,
  asStrategyId,
  asTaskId,
  type Clock,
  type IdGenerator,
  type MemoryRecordId,
  type TaskId,
} from '../domain/ids.js';
import {
  isRecord,
  parseFail,
  parseOk,
  readBoolean,
  readOptionalString,
  readString,
  readStringArray,
  type JsonSchema,
  type ParseResult,
} from '../domain/parse.js';
import type { Plan, PlanTask, Strategy } from '../domain/plan.js';
import { mergeProvenance, type Provenance } from '../domain/provenance.js';
import type { ModelMessage, ModelProvider } from '../models/contracts.js';
import type { Planner, PlanningInput, RevisionInput } from './contracts.js';
import {
  presentedMemory,
  renderEvaluation,
  renderGoal,
  renderMemory,
  renderPlan,
  renderTools,
  type PresentedMemory,
} from './prompting.js';

/** What the model must return when asked for a plan. */
interface TaskProposal {
  readonly taskId?: string;
  readonly description: string;
  readonly expectedEvidence: readonly string[];
}

interface PlanProposal {
  readonly strategySummary: string;
  readonly tasks: readonly TaskProposal[];
  readonly citedMemoryRecordIds: readonly string[];
}

interface RevisionProposal extends PlanProposal {
  readonly strategyChanged: boolean;
  readonly changeReason?: string;
  readonly revisionReason: string;
}

const TASK_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    taskId: { type: 'string', description: 'Existing task id to keep, omit for a new task' },
    description: { type: 'string' },
    expectedEvidence: { type: 'array', items: { type: 'string' } },
  },
  required: ['description', 'expectedEvidence'],
};

const PLAN_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    strategySummary: { type: 'string' },
    tasks: { type: 'array', items: TASK_SCHEMA },
    citedMemoryRecordIds: { type: 'array', items: { type: 'string' } },
  },
  required: ['strategySummary', 'tasks'],
};

const REVISION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    ...PLAN_SCHEMA.properties,
    strategyChanged: { type: 'boolean' },
    changeReason: { type: 'string' },
    revisionReason: { type: 'string' },
  },
  required: ['strategySummary', 'tasks', 'strategyChanged', 'revisionReason'],
};

export class PlannerError extends Error {
  constructor(
    message: string,
    readonly errors: readonly string[],
  ) {
    super(message);
    this.name = 'PlannerError';
  }
}

/**
 * Planner that asks the model for a structured plan and turns it into a
 * Plan with real provenance: only memory the model was shown can be cited,
 * and only retrievals that returned hits are recorded as having informed it.
 */
export class ModelPlanner implements Planner {
  constructor(
    private readonly model: ModelProvider,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async createPlan(input: PlanningInput): Promise<Plan> {
    const memory = presentedMemory(input.retrievals);
    const response = await this.model.structuredGenerate<PlanProposal>({
      purpose: 'create_plan',
      messages: [
        systemMessage(),
        {
          role: 'user',
          content: [
            renderGoal(input.goal),
            renderTools(input.availableTools),
            renderMemory(memory),
            'Produce a plan: a one-sentence strategy and an ordered list of tasks, each with the evidence that would prove it done.',
          ].join('\n\n'),
        },
      ],
      schema: PLAN_SCHEMA,
      parse: parsePlanProposal,
    });
    if (!response.parsed.ok) {
      throw new PlannerError('Model returned an invalid plan', response.parsed.errors);
    }
    const proposal = response.parsed.value;
    const strategy: Strategy = {
      strategyId: asStrategyId(this.ids.next('strat')),
      summary: proposal.strategySummary,
      version: 1,
    };
    return {
      planId: asPlanId(this.ids.next('plan')),
      runId: input.goal.runId,
      goalId: input.goal.goalId,
      version: 1,
      strategy,
      tasks: this.materialiseTasks(proposal.tasks, new Map()),
      informedBy: this.provenanceFor(memory, proposal.citedMemoryRecordIds, {}),
      createdAt: this.clock.now(),
    };
  }

  async revisePlan(input: RevisionInput): Promise<Plan> {
    const memory = presentedMemory(input.retrievals);
    const previous = input.previousPlan;
    const response = await this.model.structuredGenerate<RevisionProposal>({
      purpose: 'revise_plan',
      messages: [
        systemMessage(),
        {
          role: 'user',
          content: [
            renderGoal(input.goal),
            renderPlan(previous),
            'The following evaluation(s) found the current approach inadequate:',
            ...input.triggeringEvaluations.map(renderEvaluation),
            renderTools(input.availableTools),
            renderMemory(memory),
            'Diagnose why the approach fell short and revise the plan. Set strategyChanged=true only if the overall approach changes, and explain changeReason. Keep a task by echoing its taskId; omit completed tasks — they are preserved automatically.',
          ].join('\n\n'),
        },
      ],
      schema: REVISION_SCHEMA,
      parse: parseRevisionProposal,
    });
    if (!response.parsed.ok) {
      throw new PlannerError('Model returned an invalid plan revision', response.parsed.errors);
    }
    const proposal = response.parsed.value;

    const strategy: Strategy = proposal.strategyChanged
      ? {
          strategyId: asStrategyId(this.ids.next('strat')),
          summary: proposal.strategySummary,
          version: previous.strategy.version + 1,
          supersedes: previous.strategy.strategyId,
          changeReason: proposal.changeReason ?? proposal.revisionReason,
        }
      : previous.strategy;

    const existing = new Map<TaskId, PlanTask>(previous.tasks.map((t) => [t.taskId, t]));
    const completed = previous.tasks.filter((t) => t.status === 'completed');
    const revised = this.materialiseTasks(proposal.tasks, existing);

    return {
      planId: asPlanId(this.ids.next('plan')),
      runId: previous.runId,
      goalId: previous.goalId,
      version: previous.version + 1,
      strategy,
      tasks: [...completed, ...revised.filter((t) => t.status !== 'completed')],
      informedBy: this.provenanceFor(memory, proposal.citedMemoryRecordIds, {
        planIds: [previous.planId],
        evaluationIds: input.triggeringEvaluations.map((e) => e.evaluationId),
      }),
      createdAt: this.clock.now(),
      revisionReason: proposal.revisionReason,
    };
  }

  /**
   * Turn proposals into tasks. A proposal that echoes an existing, not-yet-
   * completed task id keeps that identity (so retries stay attributable to
   * the same task); anything else becomes a new task.
   */
  private materialiseTasks(
    proposals: readonly TaskProposal[],
    existing: ReadonlyMap<TaskId, PlanTask>,
  ): PlanTask[] {
    const tasks: PlanTask[] = [];
    for (const proposal of proposals) {
      const kept = proposal.taskId ? existing.get(asTaskId(proposal.taskId)) : undefined;
      if (kept && kept.status !== 'completed') {
        tasks.push({
          ...kept,
          description: proposal.description,
          expectedEvidence: proposal.expectedEvidence,
        });
        continue;
      }
      tasks.push({
        taskId: asTaskId(this.ids.next('task')),
        description: proposal.description,
        status: 'pending',
        dependsOn: [],
        expectedEvidence: proposal.expectedEvidence,
      });
    }
    return tasks;
  }

  /** Cited ids are trusted only if they were actually presented to the model. */
  private provenanceFor(
    memory: PresentedMemory,
    cited: readonly string[],
    extra: Provenance,
  ): Provenance {
    const presentedIds = new Set<MemoryRecordId>(memory.records.map((r) => r.recordId));
    const memoryRecordIds = cited.map(asMemoryRecordId).filter((id) => presentedIds.has(id));
    return mergeProvenance(
      memory.retrievalIds.length > 0 ? { retrievalIds: memory.retrievalIds } : {},
      memoryRecordIds.length > 0 ? { memoryRecordIds } : {},
      extra,
    );
  }
}

function systemMessage(): ModelMessage {
  return {
    role: 'system',
    content:
      'You are the planning component of an autonomous agent. Respond only with the requested JSON object. Be concrete; every task must have checkable evidence.',
  };
}

function parseTaskProposals(raw: unknown, errors: string[]): TaskProposal[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push('tasks must be a non-empty array');
    return [];
  }
  const tasks: TaskProposal[] = [];
  raw.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`tasks[${index}] must be an object`);
      return;
    }
    const taskErrors: string[] = [];
    const description = readString(item, 'description', taskErrors);
    const expectedEvidence = readStringArray(item, 'expectedEvidence', taskErrors);
    const taskId = readOptionalString(item, 'taskId', taskErrors);
    errors.push(...taskErrors.map((e) => `tasks[${index}].${e}`));
    tasks.push({ description, expectedEvidence, ...(taskId ? { taskId } : {}) });
  });
  return tasks;
}

export function parsePlanProposal(raw: unknown): ParseResult<PlanProposal> {
  if (!isRecord(raw)) return parseFail('plan must be an object');
  const errors: string[] = [];
  const strategySummary = readString(raw, 'strategySummary', errors);
  const tasks = parseTaskProposals(raw['tasks'], errors);
  const citedMemoryRecordIds = readStringArray(raw, 'citedMemoryRecordIds', errors, {
    optional: true,
  });
  if (errors.length > 0) return parseFail(...errors);
  return parseOk({ strategySummary, tasks, citedMemoryRecordIds });
}

export function parseRevisionProposal(raw: unknown): ParseResult<RevisionProposal> {
  const base = parsePlanProposal(raw);
  if (!base.ok || !isRecord(raw)) return base as ParseResult<RevisionProposal>;
  const errors: string[] = [];
  const strategyChanged = readBoolean(raw, 'strategyChanged', errors);
  const changeReason = readOptionalString(raw, 'changeReason', errors);
  const revisionReason = readString(raw, 'revisionReason', errors);
  if (strategyChanged && !changeReason)
    errors.push('changeReason is required when strategyChanged');
  if (errors.length > 0) return parseFail(...errors);
  return parseOk({
    ...base.value,
    strategyChanged,
    revisionReason,
    ...(changeReason ? { changeReason } : {}),
  });
}
