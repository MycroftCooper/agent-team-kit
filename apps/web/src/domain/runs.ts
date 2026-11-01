// Pure logic for the M5 Runs pages: list ordering, id/time formatting, and the
// event timeline (snapshot + live SSE frames, ordered by seq and deduplicated).
//
// No React, no DOM, no fetch — everything here is covered by node:test.
import type { AtkEvent, Run } from "../api/types.ts";
import type { MessageKey } from "../i18n/en.ts";

/** One rendered timeline row: a persisted event (snapshot) or a live SSE frame. */
export type TimelineEntry = {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  happenedAt: string | null;
};

/** Structural shape of a live frame (matches `StreamEvent` from useEventStream). */
export type TimelineFrame = {
  seq: number | null;
  type?: string | null;
  data?: unknown;
};

/** The events endpoint caps `limit` at 1000 (backend `parseIntegerParam`). */
export const EVENTS_PAGE_SIZE = 1000;
/** Bounded history walk: 5 pages = 5000 events, enough for any realistic run. */
export const EVENTS_MAX_PAGES = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Payloads are JSON objects in the contract; anything else renders as empty. */
export function payloadOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

export function payloadRunId(payload: unknown): string | null {
  return readString(payloadOf(payload), "runId");
}

/** A run's timeline = events whose aggregate is the run, or whose payload names it. */
export function belongsToRun(event: Pick<AtkEvent, "aggregateId" | "payload"> | null | undefined, runId: string): boolean {
  if (!event) return false;
  if (String(event.aggregateId ?? "") === runId) return true;
  return payloadRunId(event.payload) === runId;
}

export function frameBelongsToRun(frame: TimelineFrame, runId: string): boolean {
  return payloadRunId(frame.data) === runId;
}

function seqOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

export function eventToEntry(event: AtkEvent): TimelineEntry | null {
  const seq = seqOf(event.seq);
  if (seq === null) return null;
  return {
    seq,
    type: String(event.type ?? "message"),
    payload: payloadOf(event.payload),
    happenedAt: typeof event.happenedAt === "string" ? event.happenedAt : null,
  };
}

export function frameToEntry(frame: TimelineFrame): TimelineEntry | null {
  const seq = seqOf(frame.seq);
  if (seq === null) return null;
  return {
    seq,
    type: String(frame.type ?? "message"),
    payload: payloadOf(frame.data),
    happenedAt: null,
  };
}

/** Snapshot history for one run, ascending by seq, de-duplicated. */
export function timelineFromEvents(events: readonly AtkEvent[], runId: string): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const event of events) {
    if (!belongsToRun(event, runId)) continue;
    const entry = eventToEntry(event);
    if (entry) entries.push(entry);
  }
  return sortAndDedupe(entries);
}

/** Live frames for one run (a single SSE connection carries every aggregate). */
export function timelineFromFrames(frames: readonly TimelineFrame[], runId: string): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const frame of frames) {
    if (!frameBelongsToRun(frame, runId)) continue;
    const entry = frameToEntry(frame);
    if (entry) entries.push(entry);
  }
  return sortAndDedupe(entries);
}

/**
 * Ascending by seq; the first entry wins for a duplicated seq. A reconnect may
 * replay frames the snapshot already contains — the seq must appear once only.
 */
export function sortAndDedupe(entries: readonly TimelineEntry[]): TimelineEntry[] {
  const bySeq = new Map<number, TimelineEntry>();
  for (const entry of entries) {
    if (!bySeq.has(entry.seq)) bySeq.set(entry.seq, entry);
  }
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

/** Merge any number of timelines (snapshot first, live frames after). */
export function mergeTimeline(...groups: readonly (readonly TimelineEntry[])[]): TimelineEntry[] {
  return sortAndDedupe(groups.flat());
}

export function timelineLastSeq(entries: readonly TimelineEntry[]): number | null {
  let last: number | null = null;
  for (const entry of entries) {
    if (last === null || entry.seq > last) last = entry.seq;
  }
  return last;
}

export type StreamNotice = { key: MessageKey; tone: "info" | "danger" };

/**
 * The reconnect story shown above the timeline. `live` shows nothing; a gap shows
 * "snapshot reloaded"; a dropped socket says it is reconnecting with
 * `Last-Event-ID`; an unavailable stream says the timeline may be stale. The UI
 * never claims to be live when it is not.
 */
export function streamNotice(connection: string | null | undefined): StreamNotice | null {
  switch (connection) {
    case "resyncing":
      return { key: "runs.streamResynced", tone: "info" };
    case "connecting":
    case "reconnecting":
      return { key: "runs.streamReconnecting", tone: "info" };
    case "offline":
      return { key: "runs.streamOffline", tone: "danger" };
    default:
      return null;
  }
}

// ------------------------------------------------------------------- display ---

/** Short form for lists: a long run id is truncated with an ellipsis. */
export function shortRunId(id: string | null | undefined, length = 14): string {
  const value = String(id ?? "").trim();
  if (value === "") return "";
  return value.length <= length ? value : `${value.slice(0, Math.max(1, length))}…`;
}

export const RUN_ACTIVE_STATUSES = ["QUEUED", "STARTING", "RUNNING"] as const;

/** Active runs first (running before starting before queued), then newest first. */
const RUN_LIST_RANK: Record<string, number> = { RUNNING: 0, STARTING: 1, QUEUED: 2 };

export function sortRuns(runs: readonly Run[]): Run[] {
  const rank = (status: string | undefined): number => RUN_LIST_RANK[String(status ?? "")] ?? 3;
  return [...runs].sort((left, right) => {
    const byRank = rank(left.status) - rank(right.status);
    if (byRank !== 0) return byRank;
    const leftTime = String(left.createdAt ?? left.startedAt ?? "");
    const rightTime = String(right.createdAt ?? right.startedAt ?? "");
    return rightTime.localeCompare(leftTime);
  });
}

export type DurationParts = { hours: number; minutes: number; seconds: number; totalSeconds: number };
export type DurationText = { key: MessageKey; params: { h: number; m: number; s: number } };

export function splitDuration(ms: number | null | undefined): DurationParts | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    totalSeconds,
  };
}

/** Localized duration label: picks hours/minutes/seconds template. */
export function describeDuration(ms: number | null | undefined): DurationText | null {
  const parts = splitDuration(ms);
  if (parts === null) return null;
  const params = { h: parts.hours, m: parts.minutes, s: parts.seconds };
  if (parts.hours > 0) return { key: "runs.duration.hours", params };
  if (parts.minutes > 0) return { key: "runs.duration.minutes", params };
  return { key: "runs.duration.seconds", params };
}

/** Wall-clock duration of a run; `null` while it is still running. */
export function runDurationMs(run: Pick<Run, "startedAt" | "endedAt"> | null | undefined): number | null {
  const started = Date.parse(String(run?.startedAt ?? ""));
  const ended = Date.parse(String(run?.endedAt ?? ""));
  if (Number.isNaN(started) || Number.isNaN(ended) || ended < started) return null;
  return ended - started;
}

// ------------------------------------------------------------------ fetching ---

/** `GET /events` paging: the endpoint filters by `afterSeq`, not by aggregate. */
export function buildEventsQuery(afterSeq: number | null, limit = EVENTS_PAGE_SIZE): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (typeof afterSeq === "number" && Number.isInteger(afterSeq) && afterSeq >= 0) {
    params.set("afterSeq", String(afterSeq));
  }
  return `/events?${params.toString()}`;
}

/**
 * Decide whether another events page is worth requesting. `truncated` means the
 * page cap stopped us while a full page was returned (older events exist).
 */
export function planNextEventsPage(input: { count: number; limit: number; pageIndex: number; maxPages: number }): {
  hasMore: boolean;
  truncated: boolean;
} {
  const limit = Math.max(1, Math.floor(input.limit));
  const fullPage = input.count >= limit;
  const hasMore = fullPage && input.pageIndex + 1 < input.maxPages;
  return { hasMore, truncated: fullPage && !hasMore };
}

// ------------------------------------------------------------- payload views ---

export type RunLogFields = { stream: string | null; text: string; level: string | null; truncated: boolean };

/** `run.log` payload: `{ runId, sessionId, stream, text }` or the log variant. */
export function runLogFields(payload: unknown): RunLogFields | null {
  const record = payloadOf(payload);
  const text = readString(record, "text") ?? readString(record, "message");
  if (text === null) return null;
  return {
    stream: readString(record, "stream"),
    text,
    level: readString(record, "level"),
    truncated: record.truncated === true,
  };
}

export type RunStatusChange = { from: string | null; to: string | null };

/** `run.updated` payload: `{ previousStatus, status }`. */
export function runStatusChange(payload: unknown): RunStatusChange | null {
  const record = payloadOf(payload);
  const to = readString(record, "status");
  const from = readString(record, "previousStatus");
  if (to === null && from === null) return null;
  return { from, to };
}
