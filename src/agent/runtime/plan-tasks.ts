import type { TaskId } from '../../domain/ids.js';
import type { Plan, PlanTask, PlanTaskStatus } from '../../domain/plan.js';

const DONE: readonly PlanTaskStatus[] = ['completed', 'skipped'];

/** The first task that is not done and whose dependencies are all completed. */
export function nextTask(plan: Plan): PlanTask | undefined {
  const completed = new Set(
    plan.tasks.filter((t) => t.status === 'completed').map((t) => t.taskId),
  );
  return plan.tasks.find(
    (task) => !DONE.includes(task.status) && task.dependsOn.every((dep) => completed.has(dep)),
  );
}

export function allTasksDone(plan: Plan): boolean {
  return plan.tasks.every((task) => DONE.includes(task.status));
}

/** Same plan identity, one task's status changed. Status changes are not plan revisions. */
export function withTaskStatus(plan: Plan, taskId: TaskId, status: PlanTaskStatus): Plan {
  return {
    ...plan,
    tasks: plan.tasks.map((task) => (task.taskId === taskId ? { ...task, status } : task)),
  };
}

export function withRemainingTasksSkipped(plan: Plan): Plan {
  return {
    ...plan,
    tasks: plan.tasks.map((task) =>
      DONE.includes(task.status) ? task : { ...task, status: 'skipped' as const },
    ),
  };
}
