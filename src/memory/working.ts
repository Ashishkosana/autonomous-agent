import type { Goal } from '../domain/goal.js';
import type { RunId, TaskId } from '../domain/ids.js';
import type { Observation } from '../domain/observation.js';
import type { Plan } from '../domain/plan.js';
import type { RetrievalResult } from './retrieval.js';

/**
 * Working memory is the run's scratchpad: the current goal, plan, task and
 * recent observations. It is deliberately not a persistent store. Anything
 * worth keeping is promoted into knowledge/experience/decision/lesson records
 * by the learner.
 */
export interface WorkingMemorySnapshot {
  readonly runId: RunId;
  readonly goal: Goal;
  readonly plan?: Plan;
  readonly currentTaskId?: TaskId;
  readonly observations: readonly Observation[];
  /** Retrievals performed so far in this run, so the planner can avoid repeating them. */
  readonly retrievals: readonly RetrievalResult[];
  /** Free-form notes the agent chooses to keep for the remainder of the run. */
  readonly notes: readonly string[];
}

export interface WorkingMemory {
  readonly runId: RunId;
  getGoal(): Goal;
  getPlan(): Plan | undefined;
  setPlan(plan: Plan): void;
  getCurrentTaskId(): TaskId | undefined;
  setCurrentTaskId(taskId: TaskId | undefined): void;
  addObservation(observation: Observation): void;
  addRetrieval(result: RetrievalResult): void;
  addNote(note: string): void;
  snapshot(): WorkingMemorySnapshot;
}

/**
 * The only working-memory implementation: process-local state that lives
 * exactly as long as the run. This is not a test adapter — working memory is
 * ephemeral by definition, so an in-process structure *is* the design.
 */
export class RunWorkingMemory implements WorkingMemory {
  readonly runId: RunId;
  private plan: Plan | undefined;
  private currentTaskId: TaskId | undefined;
  private readonly observations: Observation[] = [];
  private readonly retrievals: RetrievalResult[] = [];
  private readonly notes: string[] = [];

  constructor(private readonly goal: Goal) {
    this.runId = goal.runId;
  }

  getGoal(): Goal {
    return this.goal;
  }

  getPlan(): Plan | undefined {
    return this.plan;
  }

  setPlan(plan: Plan): void {
    this.plan = plan;
  }

  getCurrentTaskId(): TaskId | undefined {
    return this.currentTaskId;
  }

  setCurrentTaskId(taskId: TaskId | undefined): void {
    this.currentTaskId = taskId;
  }

  addObservation(observation: Observation): void {
    this.observations.push(observation);
  }

  addRetrieval(result: RetrievalResult): void {
    this.retrievals.push(result);
  }

  addNote(note: string): void {
    this.notes.push(note);
  }

  snapshot(): WorkingMemorySnapshot {
    return {
      runId: this.runId,
      goal: this.goal,
      observations: [...this.observations],
      retrievals: [...this.retrievals],
      notes: [...this.notes],
      ...(this.plan ? { plan: this.plan } : {}),
      ...(this.currentTaskId ? { currentTaskId: this.currentTaskId } : {}),
    };
  }
}
