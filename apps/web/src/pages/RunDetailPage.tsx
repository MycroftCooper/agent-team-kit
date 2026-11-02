// Run detail (M5, read-only): run metadata plus the event timeline that merges
// the persisted snapshot with live SSE frames.
//
// The live connection itself is owned by App (`useEventStream`, fetch +
// ReadableStream, token in the `x-atk-token` header); this page receives the
// connection state and the bounded frame buffer and merges by seq.
import { useMemo } from "react";
import type { Run } from "../api/types.ts";
import { useApi } from "../api/useApi.ts";
import type { ConnectionState, StreamEvent } from "../api/useEventStream.ts";
import { useRunEvents } from "../api/useRunEvents.ts";
import { RunTimeline } from "../components/RunTimeline.tsx";
import { EmptyState, ErrorState, LoadingState, SectionHeader } from "../components/StateViews.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { describeError } from "../domain/errors.ts";
import {
  describeDuration,
  isCatchingUp,
  mergeTimeline,
  runDurationMs,
  timelineFromEvents,
  timelineFromFrames,
} from "../domain/runs.ts";
import { formatDateTime } from "../format.ts";
import { useLang, useT } from "../i18n/index.tsx";
import { routeToHash } from "../router.ts";

export function RunDetailPage({
  runId,
  refetchKey,
  connection,
  frames,
}: {
  runId: string;
  refetchKey: number;
  connection: ConnectionState;
  frames: readonly StreamEvent[];
}) {
  const t = useT();
  const { lang } = useLang();
  const runState = useApi<Run>(`/runs/${encodeURIComponent(runId)}`, { refetchKey });
  const eventsState = useRunEvents(runId, refetchKey);

  const snapshotEntries = useMemo(() => timelineFromEvents(eventsState.items, runId), [eventsState.items, runId]);
  const liveEntries = useMemo(() => timelineFromFrames(frames, runId), [frames, runId]);
  const timeline = useMemo(() => mergeTimeline(snapshotEntries, liveEntries), [snapshotEntries, liveEntries]);
  // Gap filling keeps the already-rendered rows on screen and only says it is
  // catching up (never a white flash while the snapshot is refetched).
  const catchingUp = isCatchingUp({ loading: eventsState.loading, connection, entryCount: timeline.length });

  if (runState.error) {
    const descriptor = describeError(runState.error);
    if (descriptor.code === "NOT_FOUND") {
      return (
        <EmptyState title={t("runs.notFoundTitle")} hint={t("runs.notFoundHint")}>
          <a className="button button--ghost" href={routeToHash({ name: "runs" })}>
            {t("runs.back")}
          </a>
        </EmptyState>
      );
    }
    return <ErrorState failure={runState.error} onRetry={runState.refresh} />;
  }
  if (!runState.data) return <LoadingState />;

  const run = runState.data;
  const duration = describeDuration(runDurationMs(run));

  return (
    <section className="page" data-testid="run-detail">
      <a className="backlink" href={routeToHash({ name: "runs" })}>
        {t("runs.back")}
      </a>

      <header className="page__header">
        <div>
          <h1 className="page__title mono">{run.id}</h1>
          <p className="page__subtitle">{t("runs.detailSubtitle")}</p>
          <div className="page__meta">
            <StatusBadge group="run" value={run.status} />
            {typeof run.attempt === "number" ? <span>{t("runs.fieldAttempt")}: {run.attempt}</span> : null}
            {typeof run.exitCode === "number" ? (
              <span className="mono">
                {t("runs.fieldExitCode")}: {run.exitCode}
              </span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            runState.refresh();
            eventsState.refresh();
          }}
          disabled={runState.loading}
        >
          {t("common.refresh")}
        </button>
      </header>

      <p className="notice notice--muted">{t("runs.readOnlyNote")}</p>

      <section className="card run-info" data-testid="run-info">
        <SectionHeader title={t("runs.detailTitle")} />
        <dl className="kv">
          <div className="kv__row">
            <dt>{t("runs.fieldStatus")}</dt>
            <dd>
              <StatusBadge group="run" value={run.status} />
            </dd>
          </div>
          <div className="kv__row">
            <dt>{t("runs.fieldAttempt")}</dt>
            <dd className="mono">{run.attempt ?? t("common.none")}</dd>
          </div>
          <div className="kv__row">
            <dt>{t("runs.fieldExitCode")}</dt>
            <dd className="mono">{typeof run.exitCode === "number" ? run.exitCode : t("runs.exitCodeNone")}</dd>
          </div>
          <div className="kv__row">
            <dt>{t("runs.fieldFunction")}</dt>
            <dd>
              <StatusBadge group="function" value={run.function} />
            </dd>
          </div>
          <div className="kv__row">
            <dt>{t("runs.fieldAgent")}</dt>
            <dd className="mono">{run.agentId ?? t("common.none")}</dd>
          </div>
          <div className="kv__row">
            <dt>{t("runs.fieldTask")}</dt>
            <dd>
              <a className="link mono" href={routeToHash({ name: "task", id: run.taskId })} title={t("runs.openTask", { id: run.taskId })}>
                {run.taskId}
              </a>
            </dd>
          </div>
          <div className="kv__row">
            <dt>{t("runs.fieldVersion")}</dt>
            <dd className="mono">{run.version ?? t("common.none")}</dd>
          </div>
          <div className="kv__row">
            <dt>{t("runs.fieldCreatedAt")}</dt>
            <dd className="muted">{formatDateTime(run.createdAt, lang) ?? t("common.none")}</dd>
          </div>
          <div className="kv__row">
            <dt>{t("runs.fieldStartedAt")}</dt>
            <dd className="muted">{formatDateTime(run.startedAt, lang) ?? t("common.none")}</dd>
          </div>
          <div className="kv__row">
            <dt>{t("runs.fieldEndedAt")}</dt>
            <dd className="muted">{formatDateTime(run.endedAt, lang) ?? t("common.none")}</dd>
          </div>
          <div className="kv__row">
            <dt>{t("runs.fieldDuration")}</dt>
            <dd className="mono">{duration ? t(duration.key, duration.params) : t("common.none")}</dd>
          </div>
        </dl>
      </section>

      <RunTimeline
        entries={timeline}
        loading={eventsState.loading}
        failure={eventsState.error}
        truncated={eventsState.truncated}
        incomplete={eventsState.incomplete}
        prunedEvents={eventsState.prunedEvents}
        earliestSeq={eventsState.earliestSeq}
        catchingUp={catchingUp}
        connection={connection}
        onRetry={eventsState.refresh}
      />
    </section>
  );
}
