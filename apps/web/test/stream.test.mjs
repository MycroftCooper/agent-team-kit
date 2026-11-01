// SSE framing + reconnect policy. The stream is read with fetch/ReadableStream
// (not EventSource), so these pure functions are the whole wire-format contract.
import test from "node:test";
import assert from "node:assert/strict";

import {
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  RESYNC_EVENT_TYPE,
  advanceLastSeq,
  classifyFrame,
  normaliseNewlines,
  parseSseBuffer,
  parseSseFrame,
  reconnectDelayMs,
} from "../src/api/stream.ts";

test("normaliseNewlines handles CRLF and lone CR", () => {
  assert.equal(normaliseNewlines("a\r\nb\rc\n"), "a\nb\nc\n");
});

test("parses a complete frame from the contract example", () => {
  const frame = parseSseFrame('id: 1049\nevent: task.updated\ndata: {"taskId":"TK-128"}');
  assert.equal(frame.id, 1049);
  assert.equal(frame.type, "task.updated");
  assert.deepEqual(frame.data, { taskId: "TK-128" });
  assert.equal(frame.comment, null);
});

test("splits multiple frames and keeps the incomplete tail", () => {
  const buffer = 'id: 1\nevent: task.updated\ndata: {"taskId":"T-1"}\n\nid: 2\nevent: task.updated\ndata: {"taskId":"T-2"}\n\nid: 3\nevent: ta';
  const { frames, rest } = parseSseBuffer(buffer);
  assert.equal(frames.length, 2);
  assert.deepEqual(
    frames.map((frame) => frame.id),
    [1, 2],
  );
  assert.equal(rest, "id: 3\nevent: ta");
});

test("a trailing partial frame completes on the next chunk", () => {
  const first = parseSseBuffer("id: 7\nevent: run.up");
  assert.equal(first.frames.length, 0);
  const second = parseSseBuffer(`${first.rest}dated\ndata: {"runId":"R-1"}\n\n`);
  assert.equal(second.frames.length, 1);
  assert.equal(second.frames[0].id, 7);
  assert.equal(second.frames[0].type, "run.updated");
  assert.deepEqual(second.frames[0].data, { runId: "R-1" });
});

test("heartbeat comment frames are parsed but ignored by the UI", () => {
  const { frames } = parseSseBuffer(": keep-alive 1730000000000\n\n");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, null);
  assert.equal(frames[0].data, null);
  assert.equal(classifyFrame(frames[0]), "ignore");
  assert.match(frames[0].comment, /keep-alive/);
});

test("CRLF frames parse identically", () => {
  const { frames } = parseSseBuffer('id: 5\r\nevent: approval.recorded\r\ndata: {"approvalId":"A-1"}\r\n\r\n');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].id, 5);
  assert.equal(frames[0].type, "approval.recorded");
});

test("multi-line data fields are joined", () => {
  const { frames } = parseSseBuffer('id: 9\nevent: task.updated\ndata: {"a":1,\ndata: "b":2}\n\n');
  assert.deepEqual(frames[0].data, { a: 1, b: 2 });
});

test("non-JSON data keeps the raw text instead of throwing", () => {
  const { frames } = parseSseBuffer("id: 2\nevent: task.updated\ndata: not-json\n\n");
  assert.equal(frames[0].data, "not-json");
});

test("classifies the resync frame before generic event types", () => {
  assert.equal(RESYNC_EVENT_TYPE, "system.resync-required");
  const frame = parseSseFrame("event: system.resync-required\ndata: {}");
  assert.equal(classifyFrame(frame), "resync");
});

test("classifies normal events and empty frames", () => {
  assert.equal(classifyFrame(parseSseFrame('event: task.created\ndata: {"taskId":"T-1"}')), "event");
  assert.equal(classifyFrame(parseSseFrame("")), "ignore");
  assert.equal(classifyFrame({ id: null, type: null, data: null, comment: null }), "ignore");
});

test("advanceLastSeq only moves on frames carrying an id", () => {
  assert.equal(advanceLastSeq(null, { id: 4, type: "task.updated", data: {}, comment: null }), 4);
  assert.equal(advanceLastSeq(4, { id: null, type: "task.updated", data: {}, comment: null }), 4);
  assert.equal(advanceLastSeq(null, { id: null, type: null, data: null, comment: "keep-alive" }), null);
});

test("reconnect backoff is exponential and capped at 30s", () => {
  assert.equal(RECONNECT_BASE_MS, 1000);
  assert.equal(RECONNECT_MAX_MS, 30000);
  const expected = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
  expected.forEach((delay, attempt) => {
    assert.equal(reconnectDelayMs(attempt), delay, `attempt ${attempt}`);
  });
  assert.equal(reconnectDelayMs(20), 30000);
  assert.equal(reconnectDelayMs(-1), 1000);
  assert.equal(reconnectDelayMs(Number.NaN), 1000);
});

test("reconnect backoff accepts custom bounds", () => {
  assert.equal(reconnectDelayMs(3, { baseMs: 500, maxMs: 2000 }), 2000);
  assert.equal(reconnectDelayMs(0, { baseMs: 500, maxMs: 2000 }), 500);
});
