// Application header: product, current project, connection state and the
// language toggle. Every string comes from the dictionary.
import type { ConnectionState } from "../api/useEventStream.ts";
import { useT } from "../i18n/index.tsx";
import { ConnectionBadge } from "./ConnectionBadge.tsx";
import { LangToggle } from "./LangToggle.tsx";

export function TopBar({ projectName, connection }: { projectName: string | null; connection: ConnectionState }) {
  const t = useT();
  const projectLabel = projectName ?? t("app.noProject");

  return (
    <header className="topbar" aria-label={t("topbar.ariaLabel")}>
      <div className="topbar__brand">
        <span className="topbar__mark" aria-hidden="true">
          ATK
        </span>
        <span className="topbar__name">{t("app.name")}</span>
      </div>

      <div className="topbar__project" title={projectLabel}>
        <span className="topbar__project-label">{t("app.projectLabel")}</span>
        <span className="topbar__project-name">{projectLabel}</span>
      </div>

      <div className="topbar__actions">
        <ConnectionBadge state={connection} />
        <LangToggle />
      </div>
    </header>
  );
}
