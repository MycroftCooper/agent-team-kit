// Task board: list and kanban views over the same query, status filter from the
// contract enum, client-side text search (the backend also supports `q`, but
// filtering locally keeps typing from firing a request per keystroke).
import { TASK_STATUSES } from "@atk/contracts";
import type { Task } from "../api/types.ts";
import { buildQuery } from "../api/client.ts";
import { useApi } from "../api/useApi.ts";
import { EmptyState, ErrorState, LoadingState } from "../components/StateViews.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { TaskTable } from "../components/TaskTable.tsx";
import { countByStatus, filterTasks } from "../domain/tasks.ts";
import { priorityMeta } from "../domain/status.ts";
import { useT } from "../i18n/index.tsx";
import { routeToHash } from "../router.ts";
import { useState } from "react";

type ViewMode = "list" | "kanban";

const ALL_STATUSES = "ALL";

export function TasksPage({ projectId, refetchKey }: { projectId: string | null; refetchKey: number }) {
  const t = useT();
  const [view, setView] = useState<ViewMode>("list");
  const [status, setStatus] = useState<string>(ALL_STATUSES);
  const [query, setQuery] = useState("");

  const path = `/tasks${buildQuery({
    projectId: projectId ?? undefined,
    status: status === ALL_STATUSES ? undefined : status,
    limit: 200,
  })}`;
  const { data, error, loading, refresh } = useApi<{ items: Task[] }>(path, { refetchKey });

  if (error) return <ErrorState failure={error} onRetry={refresh} />;
  if (!data) return <LoadingState />;

  const tasks = filterTasks(data.items ?? [], query);
  const byStatus = countByStatus(data.items ?? []);

  return (
    <section className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">{t("tasks.title")}</h1>
          <p className="page__subtitle">{t("tasks.count", { n: tasks.length })}</p>
        </div>
        <button type="button" className="button button--ghost" onClick={refresh} disabled={loading}>
          {t("common.refresh")}
        </button>
      </header>

      {projectId === null ? (
        <div className="notice">
          <strong>{t("tasks.noProjectTitle")}</strong>
          <span>{t("tasks.noProjectHint")}</span>
        </div>
      ) : null}

      <div className="toolbar">
        <div className="segmented" role="group" aria-label={t("tasks.viewGroupLabel")}>
          <button
            type="button"
            className={view === "list" ? "segmented__button is-active" : "segmented__button"}
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            {t("tasks.viewList")}
          </button>
          <button
            type="button"
            className={view === "kanban" ? "segmented__button is-active" : "segmented__button"}
            aria-pressed={view === "kanban"}
            onClick={() => setView("kanban")}
          >
            {t("tasks.viewKanban")}
          </button>
        </div>

        <label className="field">
          <span className="field__label">{t("tasks.filterStatus")}</span>
          <select className="field__control" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value={ALL_STATUSES}>{t("common.all")}</option>
            {TASK_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`status.task.${value}`)}
              </option>
            ))}
          </select>
        </label>

        <label className="field field--grow">
          <span className="field__label">{t("tasks.filterSearch")}</span>
          <input
            className="field__control"
            type="search"
            value={query}
            placeholder={t("tasks.searchPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      {tasks.length === 0 ? (
        <EmptyState title={t("tasks.emptyTitle")} hint={t("tasks.emptyHint")} />
      ) : view === "list" ? (
        <div className="card">
          <TaskTable tasks={tasks} />
        </div>
      ) : (
        <div className="kanban" aria-label={t("tasks.viewKanban")}>
          {TASK_STATUSES.map((column) => {
            const columnTasks = tasks.filter((task) => task.status === column);
            return (
              <section key={column} className="kanban__column">
                <header className="kanban__header">
                  <StatusBadge group="task" value={column} />
                  <span className="kanban__count mono">{byStatus[column] ?? 0}</span>
                </header>
                {columnTasks.length === 0 ? (
                  <p className="muted kanban__empty">{t("tasks.columnEmpty")}</p>
                ) : (
                  <ul className="kanban__list">
                    {columnTasks.map((task) => {
                      const meta = priorityMeta(task.priority);
                      return (
                        <li key={task.id}>
                          <a className="kanban-card" href={routeToHash({ name: "task", id: task.id })}>
                            <span className="kanban-card__title">{task.title}</span>
                            <span className="kanban-card__meta">
                              <span className="mono">{task.id}</span>
                              <span className={meta.tone === "warning" ? "priority priority--attention" : "priority"}>
                                {t(meta.key, meta.params)}
                              </span>
                            </span>
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
