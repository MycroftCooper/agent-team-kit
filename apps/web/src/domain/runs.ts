// F12 (M6.2): the Run timeline is fetched per aggregate from the server
// (`GET /events?aggregateId=<runId>&limit=&afterSeq=`). The old global-log scan
// (page everything, filter in the browser) is gone — it silently truncated once
// the log outgrew the page budget.
//
// The same module still merges the history with live SSE frames: ordered by seq,
// de-duplicated by seq only (never by (type, happenedAt) — two different events
// can share a type and a timestamp).
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

/** The events endpoint caps `limit` at 1000; 500 keeps per-run pages cheap. */
export const RUN_EVENTS_PAGE_LIMIT = 500;
/** Safety net for a runaway pagination loop (a single run should never hit it). */
export const RUN_EVENTS_MAX_PAGES = 20;

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
  const payload = payloadOf(frame.data);
  // SSE frames carry the event payload only; `runId` is the M5 field and
  // `aggregateId` is accepted defensively for newer/relayed frames.
  return payloadRunId(payload) === runId || readString(payload, "aggregateId") === runId;
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

// ------------------------------------------------------ per-run event history ---

/** One aggregate-filtered page (`GET /events?aggregateId=…`). */
export type RunEventPage = {
  items?: AtkEvent[];
  hasMore?: boolean;
  nextAfterSeq?: number | null;
  /**
   * Optional WP1/M6.2 field: the global oldest retained seq (null on an empty db).
   * When present the history warning becomes exact instead of heuristic.
   */
  earliestSeq?: number | null;
};

export type RunHistory = {
  items: AtkEvent[];
  pages: number;
  /** The page cap stopped us while the server still had more. */
  truncated: boolean;
  /** Earlier events for this run are gone (heuristic or exact `earliestSeq`). */
  incomplete: boolean;
  /** Global number of pruned events, when the server confirmed pruning. */
  prunedEvents: number | null;
  /** Global oldest retained seq from the server (null = empty db / older backend). */
  earliestSeq: number | null;
  /** True when the warning is driven by the exact `earliestSeq` instead of the heuristic. */
  exact: boolean;
  nextAfterSeq: number | null;
};

/** Build the per-aggregate page query; `afterSeq` is the resume cursor. */
export function buildRunEventsQuery(input: { runId: string; afterSeq?: number | null; limit?: number }): string {
  const params = new URLSearchParams();
  params.set("aggregateId", input.runId);
  params.set("limit", String(input.limit ?? RUN_EVENTS_PAGE_LIMIT));
  const afterSeq = input.afterSeq ?? null;
  if (typeof afterSeq === "number" && Number.isInteger(afterSeq) && afterSeq >= 0) {
    params.set("afterSeq", String(afterSeq));
  }
  return `/events?${params.toString()}`;
}

function eventSeq(event: AtkEvent): number | null {
  return typeof event.seq === "number" && Number.isInteger(event.seq) && event.seq >= 1 ? event.seq : null;
}

/**
 * Decide whether the timeline is incomplete. Two data sources drive this:
 *
 *  1. exact (WP1 M6.2): `earliestSeq` is the global oldest retained seq.
 *     `earliestSeq != null && earliestSeq > firstReturnedSeq - 1` means the
 *     server pruned events before the first one we received; `prunedEvents` then
 *     reports how many (earliestSeq - 1). Empty timelines never trigger it.
 *  2. heuristic fallback (older backend / missing created event): a run's first
 *     persisted event is `run.created`; anything else is a second signal.
 *
 * Only one warning is shown: the exact one wins when both fire.
 */
export function detectHistoryGap(input: {
  entries: readonly TimelineEntry[];
  truncated: boolean;
  earliestSeq?: number | null;
}): { incomplete: boolean; truncated: boolean; prunedEvents: number | null; exact: boolean } {
  const first = input.entries[0] ?? null;
  const firstSeq = first === null ? null : first.seq;
  const missingCreated = first !== null && first.type !== "run.created";

  const earliestSeq = input.earliestSeq ?? null;
  const knownEarliest =
    typeof earliestSeq === "number" && Number.isInteger(earliestSeq) && earliestSeq > 1 ? earliestSeq : null;

  // Lead's precise rule: the first retained event is at or after the pruning
  // point, so events before it were deleted server-side.
  const exactPruned = knownEarliest !== null && firstSeq !== null && knownEarliest > firstSeq - 1;
  const prunedEvents = exactPruned && knownEarliest !== null ? knownEarliest - 1 : null;

  return {
    incomplete: prunedEvents !== null || missingCreated,
    truncated: Boolean(input.truncated),
    prunedEvents,
    exact: prunedEvents !== null,
  };
}

/** Which warning the timeline must show; the caller only ever renders one. */
export function historyWarningKey(input: {
  prunedEvents: number | null;
  incomplete: boolean;
  truncated: boolean;
}): MessageKey | null {
  if (input.prunedEvents !== null) return "runs.timelineHistoryIncompleteExact";
  if (input.incomplete) return "runs.timelineHistoryIncomplete";
  if (input.truncated) return "runs.timelineTruncated";
  return null;
}

/**
 * Gap filling is shown only when a timeline is already on screen and the data is
 * being caught up — an initial load has its own loading state, and an empty
 * timeline must not flash a "catching up" banner.
 */
export function isCatchingUp(input: {
  loading: boolean;
  connection: string | null | undefined;
  entryCount: number;
}): boolean {
  if (input.entryCount <= 0) return false;
  if (input.loading) return true;
  return input.connection === "resyncing" || input.connection === "reconnecting" || input.connection === "connecting";
}

/**
 * Walk the aggregate-filtered pages for one run:
 *  * every request carries `aggregateId`, so the browser never pages the global log;
 *  * `afterSeq` advances by `nextAfterSeq` (or the last seq of the page);
 *  * entries are de-duplicated by seq and returned in ascending order;
 *  * `truncated` is raised when the page cap stops us although the server still
 *    has more — the UI then warns instead of pretending the history is complete.
 */
export async function loadRunHistory(input: {
  runId: string;
  fetchPage: (query: string) => Promise<RunEventPage | null | undefined>;
  limit?: number;
  maxPages?: number;
}): Promise<RunHistory> {
  const limit = Math.max(1, Math.floor(input.limit ?? RUN_EVENTS_PAGE_LIMIT));
  const maxPages = Math.max(1, Math.floor(input.maxPages ?? RUN_EVENTS_MAX_PAGES));
  const bySeq = new Map<number, AtkEvent>();

  let afterSeq: number | null = null;
  let pages = 0;
  let serverHasMore = false;
  let earliestSeq: number | null = null;

  for (;;) {
    if (pages >= maxPages) break;
    const query = buildRunEventsQuery({ runId: input.runId, afterSeq, limit });
    const page = await input.fetchPage(query);
    pages += 1;

    const pageItems = Array.isArray(page?.items) ? page.items : [];
    for (const event of pageItems) {
      if (!belongsToRun(event, input.runId)) continue;
      const seq = eventSeq(event);
      if (seq === null) continue;
      if (!bySeq.has(seq)) bySeq.set(seq, event);
    }
    if (typeof page?.earliestSeq === "number" && Number.isInteger(page.earliestSeq) && page.earliestSeq >= 0) {
      earliestSeq = page.earliestSeq;
    }
    if (pageItems.length === 0) {
      serverHasMore = false;
      break;
    }

    const lastSeq = pageItems.reduce<number | null>((last, event) => {
      const seq = eventSeq(event);
      if (seq === null) return last;
      return last === null || seq > last ? seq : last;
    }, null);
    const cursor =
      typeof page?.nextAfterSeq === "number" && Number.isInteger(page.nextAfterSeq) ? page.nextAfterSeq : lastSeq;
    serverHasMore = page?.hasMore === true;

    // A non-advancing cursor would loop forever; if the server still claims more,
    // that is unrecoverable truncation and must be reported.
    const advanced = cursor !== null && (afterSeq === null || cursor > afterSeq);
    if (!advanced) break;
    afterSeq = cursor;
    if (!serverHasMore) break;
  }

  const items = [...bySeq.values()].sort((left, right) => Number(left.seq) - Number(right.seq));
  const entries = items.map(eventToEntry).filter((entry): entry is TimelineEntry => entry !== null);
  const gap = detectHistoryGap({ entries, truncated: serverHasMore, earliestSeq });

  return {
    items,
    pages,
    truncated: gap.truncated,
    incomplete: gap.incomplete,
    prunedEvents: gap.prunedEvents,
    earliestSeq,
    exact: gap.exact,
    nextAfterSeq: afterSeq,
  };
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
