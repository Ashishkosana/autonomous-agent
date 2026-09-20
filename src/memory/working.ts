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
