import type { TaskNode } from '../types.js';
import { TaskStatus } from '../types.js';
import { randomBytes } from 'crypto';

/**
 * Task DAG — mission tasks with explicit dependencies.
 *
 * Replaces the legacy priority-queue semantics where tasks matter: a planner
 * emits a graph, the executor runs ready nodes in dependency order.
 */

export function taskId(): string {
  return `tsk_${randomBytes(4).toString('hex')}`;
}

export class TaskGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskGraphError';
    Object.setPrototypeOf(this, TaskGraphError.prototype);
  }
}

/** Validate a task graph: unique ids, deps exist, no cycles. */
export function validateTaskGraph(tasks: TaskNode[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const t of tasks) {
    if (!t.id) errors.push('task missing id');
    if (ids.has(t.id)) errors.push(`duplicate task id: ${t.id}`);
    ids.add(t.id);
    if (!t.title || t.title.trim() === '') errors.push(`task ${t.id}: empty title`);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!ids.has(dep)) errors.push(`task ${t.id}: unknown dependency '${dep}'`);
      if (dep === t.id) errors.push(`task ${t.id}: self-dependency`);
    }
  }
  if (errors.length === 0) {
    const cycle = findCycle(tasks);
    if (cycle) errors.push(`dependency cycle: ${cycle.join(' → ')}`);
  }
  return errors;
}

/** Detect a cycle; returns the cycle path or null. */
export function findCycle(tasks: TaskNode[]): string[] | null {
  const deps = new Map(tasks.map(t => [t.id, t.dependsOn]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    if (done.has(id)) return null;
    if (visiting.has(id)) {
      const idx = stack.indexOf(id);
      return [...stack.slice(idx), id];
    }
    visiting.add(id);
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    visiting.delete(id);
    done.add(id);
    return null;
  };

  for (const t of tasks) {
    const c = visit(t.id);
    if (c) return c;
  }
  return null;
}

/**
 * Compute the ready set: pending tasks whose dependencies are all completed.
 * A failed/cancelled dependency blocks dependents forever (they stay pending
 * until the graph is repaired or the mission fails).
 */
export function readyTasks(tasks: TaskNode[]): TaskNode[] {
  const byId = new Map(tasks.map(t => [t.id, t]));
  return tasks.filter(t => {
    if (t.status !== TaskStatus.PENDING) return false;
    return t.dependsOn.every(d => byId.get(d)?.status === TaskStatus.COMPLETED);
  });
}

/** True if every task is in a terminal state. */
export function graphComplete(tasks: TaskNode[]): boolean {
  return tasks.every(t =>
    t.status === TaskStatus.COMPLETED || t.status === TaskStatus.FAILED || t.status === TaskStatus.CANCELLED
  );
}

/** Tasks permanently blocked by failed dependencies. */
export function blockedTasks(tasks: TaskNode[]): TaskNode[] {
  const byId = new Map(tasks.map(t => [t.id, t]));
  return tasks.filter(t => {
    if (t.status !== TaskStatus.PENDING) return false;
    return t.dependsOn.some(d => {
      const dep = byId.get(d);
      return dep && (dep.status === TaskStatus.FAILED || dep.status === TaskStatus.CANCELLED);
    });
  });
}
