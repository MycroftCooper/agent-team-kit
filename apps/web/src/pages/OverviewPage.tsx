// Overview: project meta, task counts by status, running runs, blocked tasks,
// awaiting acceptance and the most recent events (all from
// `GET /api/v1/projects/:id/overview`).
import { TASK_STATUSES } from "@atk/contracts";
import type { Overview } from "../api/types.ts";
import { useApi } from "../api/useApi.ts";
import { EventList } from "../components/EventList.tsx";
import { ErrorState, LoadingState, SectionHeader } from "../components/StateViews.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { TaskTable } from "../components/TaskTable.tsx";
import { useT } from "../i18n/index.tsx";

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span className="metric__label">{label}</span>
      <span className="metric__value mono">{value}</span>
    </div>
  );
}

export function OverviewPage({ projectId, refetchKey }: { projectId: string; refetchKey: number }) {
  const t = useT();
  const { data, error, loading, refresh } = useApi<Overview>(`/projects/${encodeURIComponent(projectId)}/overview`, { refetchKey });

  if (error) return <ErrorState failure={error} onRetry={refresh} />;
  if (!data) return <LoadingState />;

  const counts = data.counts ?? { tasksByStatus: {}, runsRunning: 0, awaitingAcceptance: 0 };
  const tasksByStatus = counts.tasksByStatus ?? {};
  const blocked = data.blocked ?? [];
  const awaiting = data.awaitingAcceptance ?? [];
  const events = data.recentEvents ?? [];
  const project = data.project;
  const totalTasks = Object.values(tasksByStatus).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  const awaitingCount = counts.awaitingAcceptance ?? awaiting.length;

  return (
    <section className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">{t("overview.title")}</h1>
          <p className="page__subtitle">{t("overview.subtitle")}</p>
        </div>
        <button type="button" className="button button--ghost" onClick={refresh} disabled={loading}>
          {t("common.refresh")}
        </button>
      </header>

      <section className="card card--project" aria-label={t("app.projectLabel")}>
        <div className="project-meta">
          <span className="project-meta__name">{project?.name ?? t("common.unknown")}</span>
          <dl className="kv">
            <div className="kv__row">
              <dt>{t("overview.repoLabel")}</dt>
              <dd className="mono">{project?.repoPath ?? t("common.none")}</dd>
            </div>
            <div className="kv__row">
              <dt>{t("overview.branchLabel")}</dt>
              <dd className="mono">{project?.defaultBranch ?? t("common.none")}</dd>
            </div>
          </dl>
        </div>
      </section>

      <div className="metrics">
        <MetricCard label={t("overview.metric.tasks")} value={totalTasks} />
        <MetricCard label={t("overview.metric.runningRuns")} value={counts.runsRunning ?? 0} />
        <MetricCard label={t("overview.metric.awaitingAcceptance")} value={awaitingCount} />
        <MetricCard label={t("overview.metric.blocked")} value={blocked.length} />
      </div>

      <div className="grid grid--2">
        <section className="card">
          <SectionHeader title={t("overview.distributionTitle")} />
          <ul className="status-list">
            {TASK_STATUSES.map((status) => (
              <li key={status} className="status-list__row">
                <StatusBadge group="task" value={status} />
                <span className="status-list__count mono">{tasksByStatus[status] ?? 0}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <SectionHeader title={t("overview.eventsTitle")} />
          <EventList events={events} />
        </section>
      </div>

      <div className="grid grid--2">
        <section className="card">
          <SectionHeader title={t("overview.blockedTitle")} />
          {blocked.length === 0 ? <p className="muted">{t("common.none")}</p> : <TaskTable tasks={blocked} variant="compact" />}
        </section>

        <section className="card">
          <SectionHeader title={t("overview.awaitingTitle")} />
          {awaiting.length === 0 ? <p className="muted">{t("common.none")}</p> : <TaskTable tasks={awaiting} variant="compact" />}
        </section>
      </div>
    </section>
  );
}
