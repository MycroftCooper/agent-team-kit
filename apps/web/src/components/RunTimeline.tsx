// Event timeline for one Run (M5, read-only).
//
// Rows are rendered from the merged timeline (snapshot + live frames, ordered by
// seq, de-duplicated). The notices are the reconnect story the contract asks for:
// a gap (`system.resync-required`) reloads the snapshot; a dropped connection
// says it is reconnecting with `Last-Event-ID`; an unavailable stream says the
// timeline may be stale — it never pretends to be live.
import type { ConnectionState } from "../api/useEventStream.ts";
import type { ApiFailure } from "../domain/errors.ts";
import type { TimelineEntry } from "../domain/runs.ts";
import { runLogFields, runStatusChange, streamNotice, timelineLastSeq } from "../domain/runs.ts";
import { eventTypeLabelKey } from "../domain/events.ts";
import { formatDateTime } from "../format.ts";
import { useLang, useT } from "../i18n/index.tsx";
import { ErrorState, LoadingState } from "./StateViews.tsx";
import { StatusBadge } from "./StatusBadge.tsx";

export function RunTimeline({
  entries,
  loading,
  failure,
  truncated,
  connection,
  onRetry,
}: {
  entries: readonly TimelineEntry[];
  loading: boolean;
  failure: ApiFailure | null;
  truncated: boolean;
  connection: ConnectionState;
  onRetry: () => void;
}) {
  const t = useT();
  const lastSeq = timelineLastSeq(entries);
  const notice = streamNotice(connection);

  return (
    <section className="card run-timeline" data-testid="run-timeline">
      <header className="section-header">
        <div>
          <h2 className="section-header__title">{t("runs.timelineTitle")}</h2>
          <p className="muted">{t("runs.timelineHint")}</p>
        </div>
        <div className="timeline__meta">
          <span className="muted">{t("runs.timelineCount", { n: entries.length })}</span>
          {lastSeq !== null ? <span className="mono">{t("runs.timelineLastSeq", { seq: lastSeq })}</span> : null}
          {connection === "live" ? <span className="badge badge--success">{t("runs.timelineLive")}</span> : null}
        </div>
      </header>

      {notice ? (
        <p
          className={notice.tone === "danger" ? "notice notice--danger" : "notice"}
          role="status"
          data-testid="timeline-stream-notice"
          data-connection={connection}
        >
          {t(notice.key)}
        </p>
      ) : null}
      {truncated ? (
        <p className="muted" data-testid="timeline-truncated">
          {t("runs.timelineTruncated", { n: entries.length })}
        </p>
      ) : null}
      <p className="muted">{t("runs.timelineLiveHint")}</p>

      {failure ? <ErrorState failure={failure} onRetry={onRetry} /> : null}
      {loading && entries.length === 0 && !failure ? <LoadingState /> : null}
      {!failure && !loading && entries.length === 0 ? (
        <p className="muted" data-testid="timeline-empty">
          {t("runs.timelineEmpty")}
        </p>
      ) : null}

      <ol className="timeline" data-testid="run-timeline-list">
        {entries.map((entry) => (
          <TimelineRow key={entry.seq} entry={entry} />
        ))}
      </ol>
    </section>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const t = useT();
  const { lang } = useLang();
  return (
    <li className="timeline__row" data-testid={`run-timeline-entry-${entry.seq}`} data-seq={entry.seq} data-type={entry.type}>
      <span className="timeline__seq mono">#{entry.seq}</span>
      <span className="timeline__type">{t(eventTypeLabelKey(entry.type))}</span>
      <span className="timeline__time muted">{formatDateTime(entry.happenedAt, lang) ?? t("runs.timelineLive")}</span>
      <span className="timeline__body">
        <EntryBody entry={entry} />
      </span>
    </li>
  );
}

function EntryBody({ entry }: { entry: TimelineEntry }) {
  const t = useT();
  const log = entry.type === "run.log" ? runLogFields(entry.payload) : null;
  const change = entry.type === "run.updated" ? runStatusChange(entry.payload) : null;
  const payloadKeys = Object.keys(entry.payload);

  if (log) {
    return (
      <span className="timeline__log-line">
        {log.stream ? <span className="timeline__stream mono">[{log.stream}]</span> : null}
        <pre className="timeline__log mono">{log.text}</pre>
        {log.truncated ? <span className="badge badge--warning">{t("runs.logTruncated")}</span> : null}
      </span>
    );
  }
  if (change) {
    return (
      <span className="timeline__change">
        <StatusBadge group="run" value={change.from} />
        <span className="timeline__arrow" aria-hidden="true">
          →
        </span>
        <StatusBadge group="run" value={change.to} />
      </span>
    );
  }
  if (payloadKeys.length === 0) {
    return <span className="muted">{t("runs.eventNoPayload")}</span>;
  }
  return (
    <details className="timeline__details">
      <summary>{t("runs.eventPayload")}</summary>
      <pre className="mono">{JSON.stringify(entry.payload, null, 2)}</pre>
    </details>
  );
}
