// M5 Runs pages — pure logic for the list, the detail card and the live event
// timeline (ordering, de-duplication across reconnects, reconnect notices).
import test from "node:test";
import assert from "node:assert/strict";

import {
  belongsToRun,
  buildRunEventsQuery,
  describeDuration,
  eventToEntry,
  frameBelongsToRun,
  frameToEntry,
  mergeTimeline,
  payloadRunId,
  runDurationMs,
  runLogFields,
  runStatusChange,
  shortRunId,
  sortRuns,
  splitDuration,
  streamNotice,
  timelineFromEvents,
  timelineFromFrames,
  timelineLastSeq,
} from "../src/domain/runs.ts";
import { en } from "../src/i18n/en.ts";
import { zhCN } from "../src/i18n/zh-CN.ts";

const EVENT = (seq, extra = {}) => ({
  seq,
  schemaVersion: 1,
  projectId: "P-1",
  aggregateType: "run",
  aggregateId: "RUN-1",
  type: "run.updated",
  payload: { runId: "RUN-1", status: "RUNNING" },
  happenedAt: `2026-11-02T03:0${seq}:00.000Z`,
  ...extra,
});

test("shortRunId keeps short ids and truncates long ones", () => {
  assert.equal(shortRunId("RUN-1"), "RUN-1");
  assert.equal(shortRunId("RUN-1234567890abcdef"), "RUN-1234567890…");
  assert.equal(shortRunId("RUN-1234567890abcdef", 8), "RUN-1234…");
  assert.equal(shortRunId(""), "");
  assert.equal(shortRunId(null), "");
  assert.equal(shortRunId("  "), "");
});

test("sortRuns puts active runs first, then newest first", () => {
  const runs = [
    { id: "done-old", status: "COMPLETED", createdAt: "2026-11-01T00:00:00Z" },
    { id: "running", status: "RUNNING", createdAt: "2026-11-02T00:00:00Z" },
    { id: "done-new", status: "COMPLETED", createdAt: "2026-11-02T02:00:00Z" },
    { id: "queued", status: "QUEUED", createdAt: "2026-11-02T01:00:00Z" },
  ];
  assert.deepEqual(
    sortRuns(runs).map((run) => run.id),
    ["running", "queued", "done-new", "done-old"],
  );
  assert.deepEqual(sortRuns([]), []);
});

test("duration formatting picks the right template and both dictionaries have it", () => {
  assert.deepEqual(splitDuration(3665_000), { hours: 1, minutes: 1, seconds: 5, totalSeconds: 3665 });
  assert.deepEqual(splitDuration(65_000), { hours: 0, minutes: 1, seconds: 5, totalSeconds: 65 });
  assert.equal(splitDuration(-1), null);
  assert.equal(splitDuration(Number.NaN), null);
  assert.equal(splitDuration(null), null);

  const cases = [
    [7_000, "runs.duration.seconds", { h: 0, m: 0, s: 7 }],
    [65_000, "runs.duration.minutes", { h: 0, m: 1, s: 5 }],
    [3_665_000, "runs.duration.hours", { h: 1, m: 1, s: 5 }],
  ];
  for (const [ms, key, params] of cases) {
    const text = describeDuration(ms);
    assert.equal(text.key, key);
    assert.deepEqual(text.params, params);
    assert.ok(en[key], `en missing ${key}`);
    assert.ok(zhCN[key], `zh-CN missing ${key}`);
  }
  assert.equal(describeDuration(undefined), null);
});

test("runDurationMs only reports a finished, sane interval", () => {
  assert.equal(runDurationMs({ startedAt: "2026-11-02T03:00:00Z", endedAt: "2026-11-02T03:01:05Z" }), 65_000);
  assert.equal(runDurationMs({ startedAt: "2026-11-02T03:01:05Z", endedAt: "2026-11-02T03:00:00Z" }), null);
  assert.equal(runDurationMs({ startedAt: "2026-11-02T03:00:00Z", endedAt: null }), null);
  assert.equal(runDurationMs(null), null);
});

test("belongsToRun accepts the aggregate id and the payload runId", () => {
  assert.equal(belongsToRun(EVENT(1), "RUN-1"), true);
  assert.equal(belongsToRun({ aggregateId: "OTHER", payload: { runId: "RUN-1" } }, "RUN-1"), true);
  assert.equal(belongsToRun({ aggregateId: "OTHER", payload: {} }, "RUN-1"), false);
  assert.equal(belongsToRun(null, "RUN-1"), false);
  assert.equal(payloadRunId({ runId: "RUN-1" }), "RUN-1");
  assert.equal(payloadRunId({ runId: 5 }), null);
  assert.equal(payloadRunId(null), null);
});

test("SNapshot events and live frames convert into timeline entries", () => {
  assert.deepEqual(eventToEntry(EVENT(3)), {
    seq: 3,
    type: "run.updated",
    payload: { runId: "RUN-1", status: "RUNNING" },
    happenedAt: "2026-11-02T03:03:00.000Z",
  });
  assert.equal(eventToEntry({ ...EVENT(0) }), null);
  assert.equal(eventToEntry({ ...EVENT(2.5) }), null);
  assert.deepEqual(eventToEntry({ ...EVENT(4), payload: "not-an-object" }).payload, {});
  assert.deepEqual(frameToEntry({ seq: 7, type: "run.log", data: { runId: "RUN-1", text: "hi" } }), {
    seq: 7,
    type: "run.log",
    payload: { runId: "RUN-1", text: "hi" },
    happenedAt: null,
  });
  assert.equal(frameToEntry({ seq: null, type: "run.log", data: {} }), null);
  assert.equal(frameToEntry({ seq: 0, type: "run.log" }), null);
});

test("the snapshot timeline filters by run, sorts by seq and drops duplicate seqs", () => {
  const events = [EVENT(3), EVENT(1), EVENT(2), EVENT(1, { payload: { runId: "RUN-1", status: "STARTING" } }), EVENT(9, { aggregateId: "RUN-2", payload: { runId: "RUN-2" } })];
  const entries = timelineFromEvents(events, "RUN-1");
  assert.deepEqual(
    entries.map((entry) => entry.seq),
    [1, 2, 3],
  );
  // First occurrence wins for a duplicated seq (a reconnect replay is not rendered twice).
  assert.equal(entries[0].payload.status, "RUNNING");
});

test("live frames only include the selected run and stay ordered", () => {
  const frames = [
    { seq: 5, type: "run.log", data: { runId: "RUN-1", text: "later" } },
    { seq: 4, type: "run.updated", data: { runId: "RUN-1", status: "RUNNING" } },
    { seq: 6, type: "task.updated", data: { taskId: "T-1" } },
    { seq: 7, type: "run.log", data: { runId: "RUN-2", text: "other run" } },
  ];
  const entries = timelineFromFrames(frames, "RUN-1");
  assert.deepEqual(
    entries.map((entry) => entry.seq),
    [4, 5],
  );
  assert.equal(frameBelongsToRun(frames[0], "RUN-1"), true);
  assert.equal(frameBelongsToRun(frames[2], "RUN-1"), false);
});

test("merging snapshot + live frames produces one ascending sequence without duplicates", () => {
  const snapshot = timelineFromEvents([EVENT(1), EVENT(2)], "RUN-1");
  const live = timelineFromFrames(
    [
      { seq: 2, type: "run.updated", data: { runId: "RUN-1", status: "RUNNING" } },
      { seq: 3, type: "run.log", data: { runId: "RUN-1", stream: "stdout", text: "done" } },
    ],
    "RUN-1",
  );
  const merged = mergeTimeline(snapshot, live);
  assert.deepEqual(
    merged.map((entry) => entry.seq),
    [1, 2, 3],
  );
  assert.equal(merged.length, new Set(merged.map((entry) => entry.seq)).size, "same seq must render once");
  assert.equal(timelineLastSeq(merged), 3);
  assert.equal(timelineLastSeq([]), null);

  // Gap filling refetches the snapshot and merges with the retained live buffer;
  // a replay of seq 2 collapses onto the existing entry instead of duplicating.
  assert.equal(mergeTimeline(snapshot, []).length, 2);
});

test("the per-run paging query is aggregate-filtered (F12 / M6.2)", () => {
  // The global-log pagers were replaced by the aggregate-filtered loader; its
  // full contract is covered by run-timeline-query.test.mjs.
  assert.equal(typeof buildRunEventsQuery, "function");
  assert.match(buildRunEventsQuery({ runId: "RUN-1" }), /^\/events\?aggregateId=RUN-1&limit=500$/);
});

test("reconnect notices map each connection state to a translated message", () => {
  assert.equal(streamNotice("live"), null);
  assert.equal(streamNotice("resyncing").key, "runs.streamResynced");
  assert.equal(streamNotice("connecting").key, "runs.streamReconnecting");
  assert.equal(streamNotice("reconnecting").key, "runs.streamReconnecting");
  const offline = streamNotice("offline");
  assert.equal(offline.key, "runs.streamOffline");
  assert.equal(offline.tone, "danger");
  assert.equal(streamNotice("nonsense"), null);
  for (const state of ["resyncing", "connecting", "reconnecting", "offline"]) {
    const key = streamNotice(state).key;
    assert.ok(en[key], `en missing ${key}`);
    assert.ok(zhCN[key], `zh-CN missing ${key}`);
  }
});

test("run.log and run.updated payloads render readably", () => {
  assert.deepEqual(runLogFields({ runId: "RUN-1", stream: "stdout", text: "hello" }), {
    stream: "stdout",
    text: "hello",
    level: null,
    truncated: false,
  });
  assert.deepEqual(runLogFields({ runId: "RUN-1", stream: "log", level: "info", message: "started" }), {
    stream: "log",
    text: "started",
    level: "info",
    truncated: false,
  });
  assert.deepEqual(runLogFields({ runId: "RUN-1", stream: "stdout", text: "x", truncated: true }).truncated, true);
  assert.equal(runLogFields({ runId: "RUN-1" }), null);
  assert.equal(runLogFields(null), null);

  assert.deepEqual(runStatusChange({ runId: "RUN-1", previousStatus: "RUNNING", status: "COMPLETED" }), {
    from: "RUNNING",
    to: "COMPLETED",
  });
  assert.deepEqual(runStatusChange({ runId: "RUN-1", status: "RUNNING" }), { from: null, to: "RUNNING" });
  assert.equal(runStatusChange({ runId: "RUN-1" }), null);
});

test("every runs.* dictionary key exists in both languages", () => {
  const runsKeys = Object.keys(en).filter((key) => key.startsWith("runs.") || key === "nav.runs");
  assert.ok(runsKeys.length >= 50, `expected a complete runs dictionary, found ${runsKeys.length}`);
  for (const key of runsKeys) {
    assert.ok(en[key], `en missing ${key}`);
    assert.ok(zhCN[key], `zh-CN missing ${key}`);
  }
  for (const key of ["runs.title", "runs.timelineTitle", "runs.streamResynced", "runs.readOnlyNote", "nav.runs"]) {
    assert.ok(en[key], `en missing ${key}`);
    assert.ok(zhCN[key], `zh-CN missing ${key}`);
  }
});
