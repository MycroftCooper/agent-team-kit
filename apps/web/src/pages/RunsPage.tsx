// Runs list (M5, read-only): one row per execution attempt. Live runs sort first;
// every row links to the detail page with its event timeline.
import type { Run } from "../api/types.ts";
import { useApi } from "../api/useApi.ts";
import { EmptyState, ErrorState, LoadingState } from "../components/StateViews.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { shortRunId, sortRuns } from "../domain/runs.ts";
import { formatDateTime } from "../format.ts";
import { useLang, useT } from "../i18n/index.tsx";
import { routeToHash } from "../router.ts";

export function RunsPage({ refetchKey }: { refetchKey: number }) {
  const t = useT();
  const { lang } = useLang();
  const { data, error, loading, refresh } = useApi<{ items: Run[] }>("/runs?limit=200", { refetchKey });

  if (error) return <ErrorState failure={error} onRetry={refresh} />;
  if (!data) return <LoadingState />;

  const runs = sortRuns(data.items ?? []);

  return (
    <section className="page" data-testid="runs-page">
      <header className="page__header">
        <div>
          <h1 className="page__title">{t("runs.title")}</h1>
          <p className="page__subtitle">{t("runs.subtitle")}</p>
        </div>
        <button type="button" className="button button--ghost" onClick={refresh} disabled={loading}>
          {t("common.refresh")}
        </button>
      </header>

      <p className="notice notice--muted">{t("runs.readOnlyNote")}</p>

      {runs.length === 0 ? (
        <EmptyState title={t("runs.emptyTitle")} hint={t("runs.emptyHint")} />
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="table" data-testid="runs-table">
              <caption className="sr-only">{t("runs.count", { n: runs.length })}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("runs.columnRun")}</th>
                  <th scope="col">{t("runs.columnStatus")}</th>
                  <th scope="col">{t("runs.columnAttempt")}</th>
                  <th scope="col">{t("runs.columnExitCode")}</th>
                  <th scope="col">{t("runs.columnFunction")}</th>
                  <th scope="col">{t("runs.columnTask")}</th>
                  <th scope="col">{t("runs.columnStarted")}</th>
                  <th scope="col">{t("runs.columnEnded")}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} data-testid={`run-row-${run.id}`}>
                    <td className="cell-title">
                      <a className="link mono" href={routeToHash({ name: "run", id: run.id })} title={t("runs.open", { id: run.id })}>
                        {shortRunId(run.id)}
                      </a>
                      <span className="cell-meta mono">{run.agentId ?? t("common.none")}</span>
                    </td>
                    <td>
                      <StatusBadge group="run" value={run.status} />
                    </td>
                    <td className="mono">{run.attempt ?? t("common.none")}</td>
                    <td className="mono">
                      {typeof run.exitCode === "number" ? run.exitCode : t("runs.exitCodeNone")}
                    </td>
                    <td>
                      <StatusBadge group="function" value={run.function} />
                    </td>
                    <td>
                      <a className="link mono" href={routeToHash({ name: "task", id: run.taskId })} title={t("runs.openTask", { id: run.taskId })}>
                        {run.taskId}
                      </a>
                    </td>
                    <td className="muted">{formatDateTime(run.startedAt ?? run.createdAt, lang) ?? t("common.none")}</td>
                    <td className="muted">{formatDateTime(run.endedAt, lang) ?? t("common.none")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
