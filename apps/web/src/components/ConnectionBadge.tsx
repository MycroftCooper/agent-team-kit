// Backend/event-stream connection indicator in the top bar.
import type { ConnectionState } from "../api/useEventStream.ts";
import { useT } from "../i18n/index.tsx";

const TONE: Record<ConnectionState, string> = {
  live: "success",
  connecting: "info",
  reconnecting: "warning",
  resyncing: "warning",
  offline: "danger",
};

const LABEL_KEY: Record<ConnectionState, string> = {
  live: "connection.live",
  connecting: "connection.connecting",
  reconnecting: "connection.reconnecting",
  resyncing: "connection.resyncing",
  offline: "connection.offline",
};

export function ConnectionBadge({ state }: { state: ConnectionState }) {
  const t = useT();
  const label = t(LABEL_KEY[state]);
  const title = `${t("connection.label")}: ${label}`;
  return (
    <span className={`badge badge--${TONE[state]}`} role="status" aria-live="polite" title={title} data-connection={state}>
      <span className="badge__dot" aria-hidden="true" />
      {label}
    </span>
  );
}
