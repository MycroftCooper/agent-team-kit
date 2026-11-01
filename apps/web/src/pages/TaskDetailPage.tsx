// Task detail: summary fields, description/acceptance, dependencies, the
// server-computed `allowedActions` (display only in M1), and the task's Runs,
// Reviews and Approvals.
import type { ReactNode } from "react";
import { buildQuery } from "../api/client.ts";
import type { Approval, Review, Run, TaskDetail } from "../api/types.ts";
import { useApi } from "../api/useApi.ts";
import { EmptyState, ErrorState, InlineError, LoadingState, SectionHeader } from "../components/StateViews.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { describeError } from "../domain/errors.ts";
import { priorityMeta } from "../domain/status.ts";
import { formatDateTime } from "../format.ts";
import { useLang, useT } from "../i18n/index.tsx";
import { routeToHash } from "../router.ts";

function Kv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function TaskDetailPage({ taskId, refetchKey }: { taskId: string; refetchKey: number }) {
  const t = useT();
  const { lang } = useLang();
  const taskState = useApi<TaskDetail>(`/tasks/${encodeURIComponent(taskId)}`, { refetchKey });
  const runState = useApi<{ items: Run[] }>(`/runs${buildQuery({ taskId, limit: 50 })}`, { refetchKey });
  const reviewState = useApi<{ items: Review[] }>("/reviews", { refetchKey });
  const approvalState = useApi<{ items: Approval[] }>(`/approvals${buildQuery({ taskId })}`, { refetchKey });

  if (taskState.error) {
    const descriptor = describeError(taskState.error);
    if (descriptor.code === "NOT_FOUND") {
      return (
        <EmptyState title={t("task.notFoundTitle")} hint={t("task.notFoundHint")}>
          <a className="button button--ghost" href={routeToHash({ name: "tasks" })}>
            {t("task.back")}
          </a>
        </EmptyState>
      );
    }
    return <ErrorState failure={taskState.error} onRetry={taskState.refresh} />;
  }
  if (!taskState.data) return <LoadingState />;

  const task = taskState.data;
  const runs = runState.data?.items ?? [];
  const reviews = (reviewState.data?.items ?? []).filter((review) => review.taskId == null || review.taskId === task.id);
  const approvals = approvalState.data?.items ?? [];
  const deps = task.deps ?? [];
  const allowedActions = task.allowedActions ?? [];
  const priority = priorityMeta(task.priority);

  return (
    <section className="page">
      <a className="backlink" href={routeToHash({ name: "tasks" })}>
        {t("task.back")}
      </a>

      <header className="page__header">
        <div>
          <h1 className="page__title">{task.title}</h1>
          <div className="page__meta">
            <span className="mono">{task.id}</span>
            <StatusBadge group="task" value={task.status} />
            <span className={priority.tone === "warning" ? "priority priority--attention" : "priority"}>{t(priority.key, priority.params)}</span>
            {typeof task.version === "number" ? (
              <span className="mono">
                {t("common.version")} {task.version}
              </span>
            ) : null}
          </div>
        </div>
        <button type="button" className="button button--ghost" onClick={taskState.refresh} disabled={taskState.loading}>
          {t("common.refresh")}
        </button>
      </header>

      <p className="notice notice--muted">{t("task.readOnlyHint")}</p>

      <div className="grid grid--2">
        <section className="card">
          <SectionHeader title={t("task.summaryTitle")} />
          <dl className="kv">
            <Kv label={t("task.fieldStatus")}>
              <StatusBadge group="task" value={task.status} />
            </Kv>
            <Kv label={t("task.fieldProject")}>
              <span className="mono">{task.projectId}</span>
            </Kv>
            <Kv label={t("task.fieldRole")}>
              <span className="mono">{task.roleRequired ?? t("common.none")}</span>
            </Kv>
            <Kv label={t("task.fieldFunction")}>
              <StatusBadge group="function" value={task.functionRequired} />
            </Kv>
            <Kv label={t("task.fieldPriority")}>
              <span className={priority.tone === "warning" ? "priority priority--attention" : "priority"}>{t(priority.key, priority.params)}</span>
            </Kv>
            <Kv label={t("task.fieldVersion")}>
              <span className="mono">{task.version ?? t("common.none")}</span>
            </Kv>
            <Kv label={t("task.fieldPlan")}>
              <span className="mono">{task.planId ?? t("common.none")}</span>
            </Kv>
            <Kv label={t("task.fieldCreatedAt")}>{formatDateTime(task.createdAt, lang) ?? t("common.none")}</Kv>
            <Kv label={t("task.fieldUpdatedAt")}>{formatDateTime(task.updatedAt, lang) ?? t("common.none")}</Kv>
          </dl>
        </section>

        <section className="card">
          <SectionHeader title={t("task.fieldDescription")} />
          <p className="prose">{task.description ?? t("common.none")}</p>

          <SectionHeader title={t("task.fieldAcceptance")} />
          <p className="prose">{task.acceptance ?? t("common.none")}</p>

          <SectionHeader title={t("task.fieldDeps")} />
          {deps.length === 0 ? (
            <p className="muted">{t("task.depsNone")}</p>
          ) : (
            <ul className="inline-list">
              {deps.map((dep) => (
                <li key={dep}>
                  <a className="link mono" href={routeToHash({ name: "task", id: dep })}>
                    {dep}
                  </a>
                </li>
              ))}
            </ul>
          )}

          <SectionHeader title={t("task.allowedActionsTitle")} />
          {allowedActions.length === 0 ? (
            <p className="muted">{t("task.allowedActionsEmpty")}</p>
          ) : (
            <ul className="inline-list">
              {allowedActions.map((action) => (
                <li key={action} className="badge badge--neutral mono">
                  {action}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid grid--3">
        <section className="card">
          <SectionHeader title={t("task.runsTitle")} />
          {runState.error ? <InlineError failure={runState.error} /> : null}
          {runs.length === 0 ? (
            <p className="muted">{t("task.runsEmpty")}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t("task.runsTitle")}</th>
                    <th scope="col">{t("tasks.columnFunction")}</th>
                    <th scope="col">{t("tasks.columnStatus")}</th>
                    <th scope="col">{t("task.fieldCreatedAt")}</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id}>
                      <td className="mono">
                        <a className="link mono" href={routeToHash({ name: "run", id: run.id })} title={t("runs.open", { id: run.id })}>
                          {run.id}
                        </a>
                        {typeof run.attempt === "number" ? <span className="cell-meta">{t("task.runAttempt", { n: run.attempt })}</span> : null}
                      </td>
                      <td>
                        <StatusBadge group="function" value={run.function} />
                      </td>
                      <td>
                        <StatusBadge group="run" value={run.status} />
                      </td>
                      <td className="muted">{formatDateTime(run.startedAt ?? run.createdAt, lang) ?? t("common.none")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card">
          <SectionHeader title={t("task.reviewsTitle")} />
          {reviewState.error ? <InlineError failure={reviewState.error} /> : null}
          {reviews.length === 0 ? (
            <p className="muted">{t("task.reviewsEmpty")}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t("reviews.columnId")}</th>
                    <th scope="col">{t("reviews.columnStatus")}</th>
                    <th scope="col">{t("reviews.columnCreated")}</th>
                  </tr>
                </thead>
                <tbody>
                  {reviews.map((review) => (
                    <tr key={review.id}>
                      <td className="mono">{review.id}</td>
                      <td>
                        <StatusBadge group="review" value={review.status} />
                      </td>
                      <td className="muted">{formatDateTime(review.createdAt, lang) ?? t("common.none")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card">
          <SectionHeader title={t("task.approvalsTitle")} />
          {approvalState.error ? <InlineError failure={approvalState.error} /> : null}
          {approvals.length === 0 ? (
            <p className="muted">{t("task.approvalsEmpty")}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t("reviews.columnId")}</th>
                    <th scope="col">{t("reviews.columnStatus")}</th>
                    <th scope="col">{t("reviews.columnCreated")}</th>
                  </tr>
                </thead>
                <tbody>
                  {approvals.map((approval) => (
                    <tr key={approval.id}>
                      <td className="mono">{approval.id}</td>
                      <td>
                        <StatusBadge group="acceptance" value={approval.status} />
                      </td>
                      <td className="muted">{formatDateTime(approval.at ?? approval.createdAt, lang) ?? t("common.none")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
