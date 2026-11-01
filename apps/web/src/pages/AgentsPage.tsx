// Agent list. Agent DTOs are registered by the runtime, so every field except
// `id`/`status` is rendered defensively.
import type { Agent } from "../api/types.ts";
import { useApi } from "../api/useApi.ts";
import { EmptyState, ErrorState, LoadingState } from "../components/StateViews.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { formatDateTime } from "../format.ts";
import { useLang, useT } from "../i18n/index.tsx";

export function AgentsPage({ refetchKey }: { refetchKey: number }) {
  const t = useT();
  const { lang } = useLang();
  const { data, error, loading, refresh } = useApi<{ items: Agent[] }>("/agents", { refetchKey });

  if (error) return <ErrorState failure={error} onRetry={refresh} />;
  if (!data) return <LoadingState />;

  const agents = data.items ?? [];

  return (
    <section className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">{t("agents.title")}</h1>
          <p className="page__subtitle">{t("agents.columnStatus")}</p>
        </div>
        <button type="button" className="button button--ghost" onClick={refresh} disabled={loading}>
          {t("common.refresh")}
        </button>
      </header>

      {agents.length === 0 ? (
        <EmptyState title={t("agents.emptyTitle")} hint={t("agents.emptyHint")} />
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t("agents.columnName")}</th>
                  <th scope="col">{t("agents.columnStatus")}</th>
                  <th scope="col">{t("agents.columnRole")}</th>
                  <th scope="col">{t("agents.columnLastSeen")}</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.id}>
                    <td className="cell-title">
                      <span>{agent.name ?? agent.id}</span>
                      <span className="cell-meta mono">{agent.id}</span>
                    </td>
                    <td>
                      <StatusBadge group="agent" value={agent.status} />
                    </td>
                    <td className="mono">{agent.role ?? agent.function ?? t("common.none")}</td>
                    <td className="muted">{formatDateTime(agent.lastSeenAt, lang) ?? t("common.none")}</td>
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
