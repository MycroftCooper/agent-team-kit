// F12 (M6.2): the Run timeline must be fetched per aggregate from the server
// (`GET /events?aggregateId=<runId>&limit=&afterSeq=`) instead of paging the
// global log and filtering in the browser.
//
// This suite is written against the new contract and was RED before the
// implementation (the helpers did not exist yet). It covers:
//  * the 1000-event scenario: every request is aggregate-filtered, no duplicates,
//    stable ascending order, stops at the last page;
//  * interleaved SSE frames: only the selected run is appended and live/history
//    overlaps are de-duplicated by seq;
//  * gap filling after `system.resync-required`: refetch from afterSeq=0 while
//    the UI reports a "catching up" state;
//  * truncation / pruned-history warnings (bilingual keys asserted);
//  * a mock-fetch integration run through the real HTTP client.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { apiGet, resetSession } from "../src/api/client.ts";
import {
  RUN_EVENTS_MAX_PAGES,
  RUN_EVENTS_PAGE_LIMIT,
  buildRunEventsQuery,
  detectHistoryGap,
  frameBelongsToRun,
  historyWarningKey,
  isCatchingUp,
  loadRunHistory,
  mergeTimeline,
  timelineFromEvents,
  timelineFromFrames,
} from "../src/domain/runs.ts";
import { en } from "../src/i18n/en.ts";
import { zhCN } from "../src/i18n/zh-CN.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_ID = "RUN-1a2b3c4d5e6f";
const OTHER_RUN_ID = "RUN-ffff9999aaaa";

const iso = (seq) => new Date(Date.UTC(2026, 10, 2, 3, 0, seq % 60)).toISOString();

const event = (seq, type = "run.log", extra = {}) => ({
  schemaVersion: 1,
  seq,
  projectId: "P-1",
  aggregateType: "run",
  aggregateId: RUN_ID,
  type,
  payload: { runId: RUN_ID, stream: "stdout", text: `line ${seq}` },
  happenedAt: iso(seq),
  ...extra,
});

const page = (items, hasMore, nextAfterSeq) => ({
  items,
  hasMore,
  ...(nextAfterSeq === undefined ? {} : { nextAfterSeq }),
});

test("events are queried per aggregateId with limit/afterSeq", () => {
  assert.equal(RUN_EVENTS_PAGE_LIMIT, 500, "the per-run page size must stay below the server cap (1000)");
  assert.equal(RUN_EVENTS_MAX_PAGES, 20);
  assert.equal(buildRunEventsQuery({ runId: RUN_ID }), `/events?aggregateId=${RUN_ID}&limit=500`);
  assert.equal(
    buildRunEventsQuery({ runId: RUN_ID, afterSeq: 41 }),
    `/events?aggregateId=${RUN_ID}&limit=500&afterSeq=41`,
  );
  assert.equal(
    buildRunEventsQuery({ runId: RUN_ID, afterSeq: 41, limit: 2 }),
    `/events?aggregateId=${RUN_ID}&limit=2&afterSeq=41`,
  );
  assert.equal(buildRunEventsQuery({ runId: "RUN 1" }), "/events?aggregateId=RUN+1&limit=500");
  assert.equal(buildRunEventsQuery({ runId: RUN_ID, afterSeq: -3 }), `/events?aggregateId=${RUN_ID}&limit=500`);
  assert.doesNotMatch(buildRunEventsQuery({ runId: RUN_ID, afterSeq: null }), /afterSeq/);
});

test("1000 events: only aggregate-filtered pages are requested, no duplicates, stable order", async () => {
  const all = Array.from({ length: 1000 }, (_, index) => event(index + 1, index === 0 ? "run.created" : "run.log"));
  const requests = [];
  const fetchPage = async (query) => {
    requests.push(query);
    const afterSeq = Number(new URL(query, "http://127.0.0.1").searchParams.get("afterSeq") ?? 0);
    const limit = Number(new URL(query, "http://127.0.0.1").searchParams.get("limit") ?? RUN_EVENTS_PAGE_LIMIT);
    const items = all.filter((row) => row.seq > afterSeq).slice(0, limit);
    const hasMore = all.some((row) => row.seq > Number(items[items.length - 1]?.seq ?? 0));
    return page(items, hasMore, items.length > 0 ? Number(items[items.length - 1].seq) : undefined);
  };

  const history = await loadRunHistory({ runId: RUN_ID, fetchPage });
  assert.equal(history.items.length, 1000);
  assert.deepEqual(
    history.items.map((row) => row.seq),
    Array.from({ length: 1000 }, (_, index) => index + 1),
  );
  assert.equal(history.items.length, new Set(history.items.map((row) => row.seq)).size, "no duplicate seq in history");
  assert.equal(history.truncated, false);
  assert.equal(history.incomplete, false);
  assert.equal(history.pages, 2, "1000 events at 500 per page = two requests");
  assert.equal(history.nextAfterSeq, 1000);

  assert.equal(requests.length, 2);
  for (const query of requests) {
    assert.match(query, /^\/events\?aggregateId=RUN-1a2b3c4d5e6f&limit=500/);
    assert.doesNotMatch(query, /^\/events\?limit=/, "never fall back to the global log");
  }
  assert.match(requests[1], /&afterSeq=500$/);
});

test("history stops at the last page when the server says hasMore=false", async () => {
  let calls = 0;
  const fetchPage = async () => {
    calls += 1;
    return page([event(1, "run.created"), event(2)], false);
  };
  const history = await loadRunHistory({ runId: RUN_ID, fetchPage });
  assert.equal(calls, 1);
  assert.deepEqual(history.items.map((row) => row.seq), [1, 2]);
  assert.equal(history.truncated, false);
});

test("a page cap while the server still has more raises the truncation warning", async () => {
  let calls = 0;
  const fetchPage = async () => {
    calls += 1;
    const start = (calls - 1) * 4 + 1;
    const items = [start, start + 1, start + 2, start + 3].map((seq) => event(seq));
    return page(items, true, start + 3);
  };
  const history = await loadRunHistory({ runId: RUN_ID, fetchPage, limit: 4, maxPages: 3 });
  assert.equal(calls, 3, "the page cap must stop the walk");
  assert.equal(history.truncated, true, "truncation must be reported, never silently swallowed");
  assert.equal(history.items.length, 12);
  assert.ok(en["runs.timelineTruncated"], "en must warn that only the first events were loaded");
  assert.ok(zhCN["runs.timelineTruncated"], "zh-CN must warn that only the first events were loaded");
  assert.match(zhCN["runs.timelineTruncated"], /仅加载了前/);
});

test("history whose first retained event is not run.created is flagged incomplete", async () => {
  const fetchPage = async () => page([event(41, "run.updated"), event(42)], false);
  const history = await loadRunHistory({ runId: RUN_ID, fetchPage });
  assert.equal(history.incomplete, true, "pruned history must be flagged instead of shown as complete");
  assert.equal(history.items[0].seq, 41);
  assert.equal(history.exact, false, "no earliestSeq from this server: heuristic mode");
  assert.ok(en["runs.timelineHistoryIncomplete"], "en must warn that earlier events are gone");
  assert.ok(zhCN["runs.timelineHistoryIncomplete"], "zh-CN must warn that earlier events are gone");
  assert.match(zhCN["runs.timelineHistoryIncomplete"], /历史不完整/);
  assert.match(zhCN["runs.timelineHistoryIncomplete"], /裁剪/, "the heuristic warning must say the server may have pruned events");

  const empty = await loadRunHistory({ runId: RUN_ID, fetchPage: async () => page([], false) });
  assert.equal(empty.incomplete, false, "an empty timeline is not evidence of pruned history");
  assert.deepEqual(empty.items, []);
});

test("earliestSeq drives an exact pruned-history warning (WP1 M6.2)", async () => {
  // Server only retains from seq 41; this run's first retained event is 41 and its
  // run.created is gone -> 40 events were pruned before the retained window.
  const fetchPage = async () => ({ ...page([event(41, "run.updated"), event(42)], false), earliestSeq: 41 });
  const history = await loadRunHistory({ runId: RUN_ID, fetchPage });
  assert.equal(history.earliestSeq, 41);
  assert.equal(history.exact, true);
  assert.equal(history.incomplete, true);
  assert.equal(history.prunedEvents, 40, "earliestSeq - 1 events were pruned");
  assert.ok(en["runs.timelineHistoryIncompleteExact"], "en must state the exact pruning point");
  assert.ok(zhCN["runs.timelineHistoryIncompleteExact"], "zh-CN must state the exact pruning point");
  assert.match(zhCN["runs.timelineHistoryIncompleteExact"], /最早保留 seq 为 \{\{earliestSeq\}\}/);
  assert.match(en["runs.timelineHistoryIncompleteExact"], /\{\{earliestSeq\}\}/);

  // The run's events all start after the retained window: nothing of THIS run was
  // pruned, so the exact rule does not fire (heuristic still flags the missing create).
  const notPruned = await loadRunHistory({
    runId: RUN_ID,
    fetchPage: async () => ({ ...page([event(41, "run.updated")], false), earliestSeq: 7 }),
  });
  assert.equal(notPruned.exact, false);
  assert.equal(notPruned.prunedEvents, null);
  assert.equal(notPruned.incomplete, true, "missing run.created still warns (second signal)");

  // No false positive on an empty timeline or a fully retained one.
  const empty = await loadRunHistory({
    runId: RUN_ID,
    fetchPage: async () => ({ ...page([], false), earliestSeq: 3 }),
  });
  assert.equal(empty.incomplete, false, "an empty run timeline must not claim pruning");
  assert.equal(empty.prunedEvents, null);

  const intact = await loadRunHistory({
    runId: RUN_ID,
    fetchPage: async () => ({ ...page([event(1, "run.created"), event(2)], false), earliestSeq: 1 }),
  });
  assert.equal(intact.exact, false, "earliestSeq === 1 means nothing was pruned");
  assert.equal(intact.incomplete, false);

  const heuristicOnly = detectHistoryGap({
    entries: timelineFromEvents([event(9, "run.updated")], RUN_ID),
    truncated: false,
    earliestSeq: null,
  });
  assert.deepEqual(heuristicOnly, { incomplete: true, truncated: false, prunedEvents: null, exact: false });

  // Both signals fire -> exactly one warning, the exact one.
  assert.equal(historyWarningKey({ prunedEvents: 6, incomplete: true, truncated: false }), "runs.timelineHistoryIncompleteExact");
  assert.equal(historyWarningKey({ prunedEvents: null, incomplete: true, truncated: false }), "runs.timelineHistoryIncomplete");
  assert.equal(historyWarningKey({ prunedEvents: null, incomplete: false, truncated: true }), "runs.timelineTruncated");
  assert.equal(historyWarningKey({ prunedEvents: null, incomplete: false, truncated: false }), null);
});

test("interleaved SSE frames: only the selected run is appended and overlaps are de-duplicated", async () => {
  const history = await loadRunHistory({
    runId: RUN_ID,
    fetchPage: async () => page([event(1, "run.created"), event(2), event(3)], false),
  });
  const snapshot = timelineFromEvents(history.items, RUN_ID);

  const liveFrames = [
    { seq: 3, type: "run.log", data: { runId: RUN_ID, text: "overlap" } }, // already in history
    { seq: 4, type: "run.log", data: { runId: RUN_ID, text: "live" } },
    { seq: 5, type: "run.log", data: { runId: OTHER_RUN_ID, text: "other run" } },
    { seq: 6, type: "task.updated", data: { taskId: "T-1" } },
    { seq: 7, type: "run.log", data: { aggregateId: RUN_ID, text: "aggregate-only frame" } },
  ];
  const live = timelineFromFrames(liveFrames, RUN_ID);
  const merged = mergeTimeline(snapshot, live);

  assert.deepEqual(
    merged.map((entry) => entry.seq),
    [1, 2, 3, 4, 7],
    "history/live overlap renders once; other aggregates are ignored",
  );
  assert.equal(merged.length, new Set(merged.map((entry) => entry.seq)).size);
  assert.equal(frameBelongsToRun({ seq: 7, type: "run.log", data: { aggregateId: RUN_ID } }, RUN_ID), true);
  assert.equal(frameBelongsToRun({ seq: 5, type: "run.log", data: { runId: OTHER_RUN_ID } }, RUN_ID), false);
});

test("gap filling: after resync the history is reloaded from afterSeq=0 while catching up", async () => {
  const requests = [];
  let attempt = 0;
  const fetchPage = async (query) => {
    requests.push(query);
    attempt += 1;
    const items = attempt === 1 ? [event(1, "run.created"), event(2)] : [event(1, "run.created"), event(2), event(3), event(4)];
    return page(items, false);
  };
  const first = await loadRunHistory({ runId: RUN_ID, fetchPage });
  assert.deepEqual(first.items.map((row) => row.seq), [1, 2]);

  // system.resync-required: the live buffer is cleared and the snapshot reloaded.
  assert.equal(isCatchingUp({ loading: true, connection: "resyncing", entryCount: 2 }), true);
  assert.equal(isCatchingUp({ loading: false, connection: "reconnecting", entryCount: 2 }), true);
  assert.equal(isCatchingUp({ loading: false, connection: "live", entryCount: 2 }), false);
  assert.equal(isCatchingUp({ loading: true, connection: "live", entryCount: 0 }), false, "no data yet = initial load, not gap filling");
  assert.ok(en["runs.timelineFilling"], "en must show the catching-up state");
  assert.ok(zhCN["runs.timelineFilling"], "zh-CN must show the catching-up state");
  assert.match(zhCN["runs.timelineFilling"], /补洞中/);

  const second = await loadRunHistory({ runId: RUN_ID, fetchPage });
  assert.deepEqual(second.items.map((row) => row.seq), [1, 2, 3, 4], "the refetch fills the gap without loss");
  assert.match(requests[1], /aggregateId=/, "the refetch is still aggregate-filtered");
});

test("mock fetch: the real client walks aggregate-filtered pages (1000 events)", async () => {
  const all = Array.from({ length: 1000 }, (_, index) => event(index + 1, index === 0 ? "run.created" : "run.log"));
  const requestedUrls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    if (String(url).endsWith("/api/v1/session")) {
      return new Response(JSON.stringify({ token: "tok", csrf: "csrf" }), { status: 200 });
    }
    const parsed = new URL(String(url), "http://127.0.0.1");
    const aggregateId = parsed.searchParams.get("aggregateId");
    const afterSeq = Number(parsed.searchParams.get("afterSeq") ?? 0);
    const limit = Number(parsed.searchParams.get("limit") ?? 100);
    const matching = all.filter((row) => row.aggregateId === aggregateId && row.seq > afterSeq);
    const items = matching.slice(0, limit);
    const nextAfterSeq = items.length > 0 ? Number(items[items.length - 1].seq) : undefined;
    return new Response(JSON.stringify({ items, hasMore: matching.length > items.length, nextAfterSeq }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  resetSession();
  try {
    const history = await loadRunHistory({
      runId: RUN_ID,
      fetchPage: (query) => apiGet(query),
    });
    assert.equal(history.items.length, 1000);
    assert.deepEqual(
      history.items.map((row) => row.seq),
      Array.from({ length: 1000 }, (_, index) => index + 1),
    );
    assert.equal(history.truncated, false);
    assert.equal(history.incomplete, false);

    const eventRequests = requestedUrls.filter((url) => url.includes("/events"));
    assert.equal(eventRequests.length, 2);
    for (const url of eventRequests) {
      assert.match(url, new RegExp(`aggregateId=${RUN_ID}`), "every page must be aggregate-filtered");
      assert.doesNotMatch(url, /\/events\?limit=/, "no global-log page request may remain");
    }
  } finally {
    globalThis.fetch = original;
    resetSession();
  }
});

test("the hook and page use the aggregate query, not the global event scan (regression guard)", () => {
  const hook = readFileSync(path.join(ROOT, "src", "api", "useRunEvents.ts"), "utf8");
  assert.match(hook, /loadRunHistory/, "the hook must delegate to the tested loader");
  assert.match(hook, /buildRunEventsQuery|aggregateId/, "the hook must request per-aggregate pages");
  assert.doesNotMatch(hook, /buildEventsQuery|EVENTS_MAX_PAGES/, "the global-log scan must be gone");
  assert.doesNotMatch(hook, /\/events\?limit=/, "no hardcoded global event query");

  const page = readFileSync(path.join(ROOT, "src", "pages", "RunDetailPage.tsx"), "utf8");
  assert.match(page, /useRunEvents\(runId/, "the detail page must pass the run id to the hook");
  assert.match(page, /catchingUp/, "the page must surface the catching-up state");
  assert.match(page, /incomplete/, "the page must surface an incomplete-history warning");

  const timeline = readFileSync(path.join(ROOT, "src", "components", "RunTimeline.tsx"), "utf8");
  assert.match(timeline, /timeline-filling/, "the UI must render a 补洞中 state");
  assert.match(timeline, /timeline-history-incomplete/, "the UI must render the pruned-history warning");
  assert.match(timeline, /runs\.timelineTruncated/, "the UI must render the truncation warning");
});
