import type { Action } from '../../domain/action.js';
import {
  asRetrievalId,
  type LessonId,
  type MemoryRecordId,
  type TaskId,
} from '../../domain/ids.js';
import type { Plan, PlanTask } from '../../domain/plan.js';
import type { EvaluationResult } from '../../evaluation/contracts.js';
import type { Evaluator } from '../../evaluation/contracts.js';
import type { EventCorrelation } from '../../events/contracts.js';
import {
  PERSISTENT_MEMORY_KINDS,
  type DecisionOutcome,
  type DecisionRecord,
  type PersistentMemoryRecord,
} from '../../memory/records.js';
import type { MemoryRetriever, RetrievalResult } from '../../memory/retrieval.js';
import type { MemoryStore } from '../../memory/store.js';
import type { ExecutionEnvironment } from '../../sandbox/execution-environment.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { ActionSelector, Executor, Learner, Planner, TaskAttempt } from '../contracts.js';
import { nextTask, withRemainingTasksSkipped, withTaskStatus } from './plan-tasks.js';
import type { RunSession } from './run-session.js';
import type { RunState } from '../../domain/run.js';

export interface RuntimeComponents {
  readonly session: RunSession;
  readonly planner: Planner;
  readonly selector: ActionSelector;
  readonly executor: Executor;
  readonly evaluator: Evaluator;
  readonly learner: Learner;
  readonly memoryStore: MemoryStore;
  readonly retriever: MemoryRetriever;
  readonly tools: ToolRegistry;
  readonly environment: ExecutionEnvironment;
}

export interface RuntimeOptions {
  /** Maximum memory records retrieved per search. */
  readonly retrievalLimit?: number;
}

export interface RunOutcome {
  readonly state: RunState;
  readonly finalPlan: Plan | undefined;
  /** Every persistent record this run wrote, in write order. */
  readonly writtenRecordIds: readonly MemoryRecordId[];
  readonly lessonIds: readonly LessonId[];
}

/**
 * The autonomous control loop. It owns orchestration and termination; every
 * other component only proposes, executes, judges or records.
 *
 *   receive goal → retrieve memory → plan
 *   loop:
 *     stop if a run limit is reached
 *     pick the next task; if none, the goal is complete
 *     ask the selector for an action (or finish / give up)
 *     execute → observe → evaluate → learn → write memory
 *     on failure: diagnose + revise plan (strategy may change), then the next
 *     iteration retries the same task with the revised plan
 */
export class AgentRuntime {
  private plan: Plan | undefined;
  private readonly retrievals: RetrievalResult[] = [];
  private readonly attempts = new Map<TaskId, TaskAttempt[]>();
  private readonly written: MemoryRecordId[] = [];
  private readonly lessons: LessonId[] = [];
  private readonly retrievalLimit: number;

  constructor(
    private readonly c: RuntimeComponents,
    options: RuntimeOptions = {},
  ) {
    this.retrievalLimit = options.retrievalLimit ?? 5;
  }

  async run(): Promise<RunOutcome> {
    const { session } = this.c;
    session.markRunning();
    session.emit('GOAL_RECEIVED', { statement: session.goal.statement });

    try {
      await this.retrieveMemory(session.goal.statement);
      await this.createInitialPlan();
      await this.loop();
    } catch (error: unknown) {
      if (!session.isFinished()) {
        const reason = describeUnrecoverable(error);
        session.emit('GOAL_FAILED', {
          reason,
          iterations: session.usage.snapshot.iterations,
          cause: 'unrecoverable',
        });
        session.finish('failed', reason);
      }
    }

    return {
      state: session.state(),
      finalPlan: this.plan,
      writtenRecordIds: [...this.written],
      lessonIds: [...this.lessons],
    };
  }

  // ---------------------------------------------------------------- phases

  private async retrieveMemory(text: string): Promise<void> {
    const { session, retriever } = this.c;
    const retrievalId = asRetrievalId(session.ids.next('ret'));
    const query = {
      retrievalId,
      text,
      kinds: PERSISTENT_MEMORY_KINDS,
      limit: this.retrievalLimit,
      correlation: session.correlation(),
    };
    session.emit(
      'MEMORY_SEARCH_STARTED',
      { retrievalId, queryText: text, kinds: query.kinds },
      { retrievalId },
    );
    const result = await retriever.retrieve(query);
    session.usage.increment('memoryReads');
    const recordIds = result.hits.map((h) => h.record.recordId);
    session.emit(
      'MEMORY_RETRIEVED',
      {
        retrievalId,
        hitCount: result.hits.length,
        recordIds,
        kinds: [...new Set(result.hits.map((h) => h.record.kind))],
        durationMs: result.durationMs,
      },
      { retrievalId, memoryRecordIds: recordIds },
    );
    this.retrievals.push(result);
    session.working.addRetrieval(result);
  }

  private async createInitialPlan(): Promise<void> {
    const { session, planner, tools } = this.c;
    const plan = await planner.createPlan({
      goal: session.goal,
      working: session.working.snapshot(),
      retrievals: this.retrievals,
      availableTools: tools.describeAll(),
    });
    this.setPlan(plan);
    session.emit(
      'PLAN_CREATED',
      {
        planId: plan.planId,
        version: plan.version,
        strategyId: plan.strategy.strategyId,
        strategySummary: plan.strategy.summary,
        taskCount: plan.tasks.length,
        informedByRetrievalIds: plan.informedBy.retrievalIds ?? [],
        informedByMemoryRecordIds: plan.informedBy.memoryRecordIds ?? [],
      },
      {
        planId: plan.planId,
        strategyId: plan.strategy.strategyId,
        ...(plan.informedBy.memoryRecordIds
          ? { memoryRecordIds: plan.informedBy.memoryRecordIds }
          : {}),
      },
    );
  }

  private async loop(): Promise<void> {
    const { session } = this.c;
    while (!session.isFinished()) {
      const breach = session.usage.breach();
      if (breach) {
        const reason = `Run limit ${breach.limit} reached (${breach.value}/${breach.max})`;
        session.emit('RUN_LIMIT_REACHED', {
          limit: breach.limit,
          value: breach.value,
          max: breach.max,
        });
        session.finish('limit_reached', reason);
        return;
      }

      const plan = this.requirePlan();
      const task = nextTask(plan);
      if (!task) {
        this.completeGoal('All planned tasks were completed and confirmed by evaluation');
        return;
      }

      session.usage.increment('iterations');
      session.working.setCurrentTaskId(task.taskId);
      if (task.status === 'pending') this.setPlan(withTaskStatus(plan, task.taskId, 'in_progress'));
      await this.iterate({ ...task, status: 'in_progress' });
    }
  }

  private async iterate(task: PlanTask): Promise<void> {
    const { session, selector, tools } = this.c;
    const previous = this.attempts.get(task.taskId) ?? [];
    const selection = await selector.selectNext({
      goal: session.goal,
      plan: this.requirePlan(),
      task,
      previousAttempts: previous,
      working: session.working.snapshot(),
      retrievals: this.retrievals,
      availableTools: tools.describeAll(),
    });

    switch (selection.kind) {
      case 'give_up':
        session.emit('GOAL_FAILED', {
          reason: selection.reason,
          iterations: session.usage.snapshot.iterations,
          cause: 'gave_up',
        });
        session.finish('gave_up', selection.reason);
        return;
      case 'finish':
        await this.verifyFinishClaim(selection.summary);
        return;
      case 'act':
        await this.attempt(task, previous, selection.action, selection.decision);
        return;
    }
  }

  private async attempt(
    task: PlanTask,
    previous: readonly TaskAttempt[],
    action: Action,
    decision: DecisionRecord | undefined,
  ): Promise<void> {
    const { session, executor, evaluator, learner, environment } = this.c;
    const correlation: EventCorrelation = {
      taskId: task.taskId,
      planId: action.planId,
      actionId: action.actionId,
      ...(decision ? { decisionId: decision.decisionId } : {}),
    };

    if (decision) {
      session.emit(
        'DECISION_CREATED',
        {
          decisionId: decision.decisionId,
          summary: decision.summary,
          optionCount: decision.optionsConsidered.length,
          ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
        },
        correlation,
      );
    }

    const lastAttempt = previous.at(-1);
    if (action.retryOf && lastAttempt) {
      session.usage.increment('retries');
      session.emit(
        'RETRY_STARTED',
        {
          retryOfActionId: action.retryOf,
          attempt: action.attempt,
          changedApproach:
            lastAttempt.action.toolName !== action.toolName ||
            JSON.stringify(lastAttempt.action.input) !== JSON.stringify(action.input),
        },
        correlation,
      );
    }

    session.emit(
      'TOOL_SELECTED',
      { toolName: action.toolName, intent: action.intent, attempt: action.attempt },
      correlation,
    );

    const observation = await executor.execute(action);
    session.working.addObservation(observation);

    const evaluation = await evaluator.evaluate({
      goal: session.goal,
      task,
      action,
      observations: [...previous.map((a) => a.observation), observation],
      correlation: action.correlation,
      environment,
    });
    this.emitEvaluation(evaluation, { ...correlation, observationId: observation.observationId });

    const attempt: TaskAttempt = {
      action,
      observation,
      evaluation,
      ...(decision ? { decision } : {}),
    };
    this.attempts.set(task.taskId, [...previous, attempt]);

    const learning = await learner.learn({
      correlation: action.correlation,
      task,
      attempt,
      previousAttempts: previous,
    });
    const recordCorrelation = { ...correlation, evaluationId: evaluation.evaluationId };
    if (decision) {
      await this.writeRecord(
        {
          ...decision,
          outcome: decisionOutcome(evaluation),
          lessonIds: learning.lessons.map((l) => l.lessonId),
        },
        recordCorrelation,
      );
    }
    await this.writeRecord(learning.experience, recordCorrelation);
    for (const lesson of learning.lessons) {
      this.lessons.push(lesson.lessonId);
      session.emit(
        'LESSON_CREATED',
        {
          lessonId: lesson.lessonId,
          statement: lesson.statement,
          confidence: lesson.confidence,
          derivedFromEvaluationIds: lesson.provenance.evaluationIds ?? [],
        },
        { ...recordCorrelation, lessonId: lesson.lessonId },
      );
      await this.writeRecord(lesson, { ...recordCorrelation, lessonId: lesson.lessonId });
    }

    if (evaluation.verdict === 'success') {
      this.setPlan(withTaskStatus(this.requirePlan(), task.taskId, 'completed'));
      return;
    }
    await this.handleFailure(evaluation, correlation);
  }

  /**
   * The model claimed the goal is done. The claim is checked by the evaluator
   * at goal level; a rejected claim is treated like any other failure.
   */
  private async verifyFinishClaim(summary: string): Promise<void> {
    const { session, evaluator, environment } = this.c;
    const plan = this.requirePlan();
    const evaluation = await evaluator.evaluate({
      goal: session.goal,
      observations: session.working.snapshot().observations,
      correlation: { runId: session.runId, goalId: session.goal.goalId },
      environment,
    });
    this.emitEvaluation(evaluation, { planId: plan.planId });
    if (evaluation.verdict === 'success') {
      this.setPlan(withRemainingTasksSkipped(plan));
      this.completeGoal(summary);
      return;
    }
    await this.handleFailure(evaluation, { planId: plan.planId });
  }

  /** Failure → FAILURE_DETECTED → planner diagnoses and revises → PLAN_UPDATED (+ STRATEGY_CHANGED). */
  private async handleFailure(
    evaluation: EvaluationResult,
    correlation: EventCorrelation,
  ): Promise<void> {
    const { session, planner, tools } = this.c;
    const previousPlan = this.requirePlan();

    session.emit(
      'FAILURE_DETECTED',
      {
        summary: evaluation.gaps.join('; ') || evaluation.summary,
        source: evaluation.toolStatus === 'error' ? 'tool' : 'evaluation',
      },
      { ...correlation, evaluationId: evaluation.evaluationId },
    );

    const revised = await planner.revisePlan({
      goal: session.goal,
      working: session.working.snapshot(),
      retrievals: this.retrievals,
      availableTools: tools.describeAll(),
      previousPlan,
      triggeringEvaluations: [evaluation],
    });

    if (revised.strategy.strategyId !== previousPlan.strategy.strategyId) {
      session.usage.increment('strategyChanges');
      session.emit(
        'STRATEGY_CHANGED',
        {
          previousStrategyId: previousPlan.strategy.strategyId,
          newStrategyId: revised.strategy.strategyId,
          reason: revised.strategy.changeReason ?? revised.revisionReason ?? '',
          summary: revised.strategy.summary,
        },
        {
          planId: revised.planId,
          strategyId: revised.strategy.strategyId,
          evaluationId: evaluation.evaluationId,
        },
      );
    }

    session.emit(
      'PLAN_UPDATED',
      {
        planId: revised.planId,
        previousPlanId: previousPlan.planId,
        version: revised.version,
        reason: revised.revisionReason ?? 'revised after failure',
        taskCount: revised.tasks.length,
      },
      {
        planId: revised.planId,
        strategyId: revised.strategy.strategyId,
        evaluationId: evaluation.evaluationId,
      },
    );
    this.setPlan(revised);
  }

  // -------------------------------------------------------------- helpers

  private emitEvaluation(evaluation: EvaluationResult, correlation: EventCorrelation): void {
    this.c.session.emit(
      'EVALUATION_COMPLETED',
      {
        evaluationId: evaluation.evaluationId,
        verdict: evaluation.verdict,
        checksPassed: evaluation.checks.filter((c) => c.passed).length,
        checksTotal: evaluation.checks.length,
        gapCount: evaluation.gaps.length,
        summary: evaluation.summary,
        toolStatus: evaluation.toolStatus,
      },
      { ...correlation, evaluationId: evaluation.evaluationId },
    );
  }

  private async writeRecord(
    record: PersistentMemoryRecord,
    correlation: EventCorrelation,
  ): Promise<void> {
    const { session, memoryStore } = this.c;
    await memoryStore.put(record);
    session.usage.increment('memoryWrites');
    this.written.push(record.recordId);
    session.emit(
      'MEMORY_WRITTEN',
      { recordId: record.recordId, kind: record.kind, summary: record.summary },
      { ...correlation, memoryRecordIds: [record.recordId] },
    );
  }

  private completeGoal(summary: string): void {
    const { session } = this.c;
    session.working.setCurrentTaskId(undefined);
    session.emit('GOAL_COMPLETED', {
      summary,
      iterations: session.usage.snapshot.iterations,
    });
    session.finish('completed', summary);
  }

  private setPlan(plan: Plan): void {
    this.plan = plan;
    this.c.session.working.setPlan(plan);
  }

  private requirePlan(): Plan {
    if (!this.plan) throw new Error('Runtime has no plan; createInitialPlan must run first');
    return this.plan;
  }
}

/**
 * Termination reasons must let a reader answer "why did the run stop?". Errors
 * that carry validation messages (PlannerError, SelectorError) contribute
 * them — they name missing or malformed fields, never model text.
 */
function describeUnrecoverable(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const details = (error as { errors?: unknown }).errors;
  if (Array.isArray(details) && details.length > 0 && details.every((d) => typeof d === 'string')) {
    return `${message}: ${details.join('; ')}`;
  }
  return message;
}

function decisionOutcome(evaluation: EvaluationResult): DecisionOutcome {
  switch (evaluation.verdict) {
    case 'success':
      return 'succeeded';
    case 'inconclusive':
      return 'inconclusive';
    case 'failure':
    case 'partial':
      return 'failed';
  }
}
