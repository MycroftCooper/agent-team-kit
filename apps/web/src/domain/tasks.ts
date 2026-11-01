// Task list helpers shared by the list and kanban views. Pure so the filtering
// rules can be tested without a DOM (and so both views filter identically).
import type { Task } from "../api/types.ts";

/** Case-insensitive substring match over the id and the title. */
export function matchesQuery(task: Pick<Task, "id" | "title">, query: string | null | undefined): boolean {
  const needle = String(query ?? "")
    .trim()
    .toLowerCase();
  if (needle === "") return true;
  return String(task.title ?? "").toLowerCase().includes(needle) || String(task.id ?? "").toLowerCase().includes(needle);
}

export function filterTasks(tasks: readonly Task[], query: string | null | undefined): Task[] {
  return tasks.filter((task) => matchesQuery(task, query));
}

/** Kanban column counts, including statuses the backend did not mention. */
export function countByStatus(tasks: readonly Task[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    const status = String(task.status ?? "");
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}
