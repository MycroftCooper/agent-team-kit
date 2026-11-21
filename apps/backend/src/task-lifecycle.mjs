import { requireThat, requiredString } from "../../../packages/contracts/src/index.mjs";
import { sha } from "../../../packages/project-files/src/index.mjs";

const closed = (task) => ["DONE", "CANCELLED"].includes(task.status);
const summary = ({ id, title, status, version, kind }) => ({ id, title, status, version, kind });

// Cancellation and archiving change records, never infer that an external writer stopped.
export function createTaskLifecycle({ store, get, put, expected, working, emit, at, refreshSource }) {
  function cancellation(id) {
    const task = get("tasks", id), project = get("projects", task.projectId);
    const source = task.kind === "WORK" ? get("tasks", task.parentId) : task;
    const candidates = task.kind === "REQUEST" ? store.all("tasks", { parentId: task.id })
      : task.kind === "WORK" ? store.all("tasks", { planId: task.planId }) : [];
    const ids = new Set([task.id]);
    if (task.kind === "REQUEST") candidates.filter((t) => !closed(t)).forEach((t) => ids.add(t.id));
    if (task.kind === "WORK") {
      let added;
      do {
        added = false;
        for (const t of candidates) if (!closed(t) && !ids.has(t.id) && t.deps?.some((dep) => ids.has(dep))) {
          ids.add(t.id); added = true;
        }
      } while (added);
    }
    const tasks = [task, ...candidates.filter((t) => t.id !== task.id && ids.has(t.id))];
    const runs = working().filter((r) => ids.has(r.taskId));
    const reason = project.archived ? "PROJECT_ARCHIVED" : task.archivedAt ? "TASK_ARCHIVED"
      : closed(task) ? "TASK_CLOSED" : runs.length ? "STOP_CONFIRMATION_REQUIRED" : null;
    const impactHash = sha({ source: summary(source), tasks: tasks.map(summary).sort((a, b) => a.id.localeCompare(b.id)),
      runs: runs.map(({ id, generation, status }) => ({ id, generation, status })).sort((a, b) => a.id.localeCompare(b.id)) });
    return { task: summary(task), source: summary(source), tasks: tasks.map(summary),
      runs: runs.map(({ id, taskId, status, stage, generation, spec }) => ({ id, taskId, status, stage, generation, title: spec?.title })),
      impactHash, enabled: !reason, reason };
  }
  return {
    cancellation,
    cancelTask(id, body) {
      return store.tx(() => {
        const task = get("tasks", id);
        expected(task, body.version);
        const impact = cancellation(id);
        requireThat(impact.enabled, impact.reason, "Stop all affected executions and review the task before cancelling", 409);
        requireThat(body.impactHash === impact.impactHash, "CANCELLATION_CHANGED", "Cancellation affects different work now. Review it again.", 409);
        const reason = requiredString(body.reason, "reason");
        requireThat(reason.length <= 2000, "VALIDATION_ERROR", "Cancellation reason must be at most 2000 characters");
        for (const row of impact.tasks) {
          put("tasks", { ...get("tasks", row.id), status: "CANCELLED", blockReason: null,
            cancellation: { at: at(), reason, rootTaskId: task.id } });
          emit("task.cancelled", task.projectId, row.id, { rootTaskId: task.id, reason });
        }
        if (task.kind !== "BUG") {
          for (const a of store.all("acceptances", { parentId: impact.source.id }))
            if (["PENDING", "STALE"].includes(a.status)) put("acceptances", { ...a, status: "SUPERSEDED" });
          if (task.kind === "REQUEST") {
            for (const p of store.all("plans", { parentId: task.id }))
              if (p.status !== "SUPERSEDED") put("plans", { ...p, status: "SUPERSEDED" });
          } else refreshSource(task.planId);
        }
        return { task: get("tasks", id), affected: impact.tasks.map((t) => t.id) };
      });
    },
    archiveTask(id, body) {
      return store.tx(() => {
        const task = get("tasks", id), p = get("projects", task.projectId);
        expected(task, body.version);
        requireThat(!p.archived, "PROJECT_ARCHIVED", "This project is archived; history is read-only", 409);
        requireThat(typeof body.archived === "boolean", "VALIDATION_ERROR", "archived must be a boolean");
        requireThat(closed(task), "TASK_NOT_CLOSED", "Only completed or cancelled tasks can be archived", 409);
        requireThat(Boolean(task.archivedAt) !== body.archived, "ARCHIVE_STATE_CHANGED", "The task archive state changed", 409);
        if (!body.archived && task.parentId)
          requireThat(!get("tasks", task.parentId).archivedAt, "RESTORE_PARENT_FIRST", "Restore the parent requirement first", 409);
        const family = task.kind === "REQUEST" ? store.all("tasks", { parentId: id }) : [];
        const tasks = body.archived ? [task, ...family.filter((t) => !t.archivedAt)]
          : [task, ...family.filter((t) => t.archiveBatchId === id)];
        const ids = new Set(tasks.map((t) => t.id));
        requireThat(tasks.every(closed) && !working().some((r) => ids.has(r.taskId)),
          "TASK_BUSY", "Close all affected work and stop its executions first", 409);
        for (const t of tasks) {
          put("tasks", { ...t, archivedAt: body.archived ? at() : null, archiveBatchId: body.archived ? id : null });
          emit(body.archived ? "task.archived" : "task.restored", task.projectId, t.id, { rootTaskId: id });
        }
        return { task: get("tasks", id), affected: [...ids] };
      });
    },
  };
}
