// SSE contract tests (m1-contracts §3): frame shape/id, Last-Event-ID replay,
// resync on a gap, keep-alive heartbeats and timer cleanup on disconnect.
import assert from "node:assert/strict";
import test from "node:test";

import { encodeSseFrame, parseSseFrame } from "@atk/contracts";

import { closeSse, openSse, startServer, waitForFrame } from "./helpers.mjs";

function appendTaskEvent(store, taskId = "T-1") {
  return store.appendEvent({
    projectId: "P-1",
    aggregateType: "task",
    aggregateId: taskId,
    type: "task.updated",
    payload: { taskId, status: "RUNNING" },
  });
}

test("encodeSseFrame output matches the parser round-trip used by the hub", () => {
  const frame = encodeSseFrame({
    seq: 12,
    type: "task.updated",
    payload: { taskId: "T-1", status: "REVIEWING", version: 3 },
  });
  assert.equal(frame, 'id: 12\nevent: task.updated\ndata: {"taskId":"T-1","status":"REVIEWING","version":3}\n\n');
  assert.deepEqual(parseSseFrame(frame), {
    seq: 12,
    type: "task.updated",
    payload: { taskId: "T-1", status: "REVIEWING", version: 3 },
    comment: null,
  });
});

test("an event appended to the store is pushed to a connected client with id = seq", async (t) => {
  const { server, store, base } = await startServer();
  t.after(() => server.close());
  const client = await openSse(base);
  t.after(() => closeSse(client));

  assert.equal(client.status, 200);
  assert.match(client.headers["content-type"], /text\/event-stream/);
  await waitForFrame(client, (frame) => String(frame.comment ?? "").startsWith("connected"));

  const event = appendTaskEvent(store);
  const { frame } = await waitForFrame(client, (candidate) => candidate.type === "task.updated");
  assert.equal(frame.seq, event.seq);
  assert.equal(frame.seq, 1);
  assert.deepEqual(frame.payload, event.payload);
});

test("a fresh connection without Last-Event-ID does not replay history", async (t) => {
  const { server, store, base } = await startServer();
  t.after(() => server.close());
  appendTaskEvent(store);
  appendTaskEvent(store, "T-2");

  const client = await openSse(base);
  t.after(() => closeSse(client));
  await waitForFrame(client, (frame) => String(frame.comment ?? "").startsWith("connected"));
  assert.equal(client.frames.filter((frame) => frame.type === "task.updated").length, 0);

  appendTaskEvent(store, "T-3");
  const { frame } = await waitForFrame(client, (candidate) => candidate.type === "task.updated");
  assert.equal(frame.seq, 3, "first live frame is the newly appended event");
});

test("Last-Event-ID replays the missed events", async (t) => {
  const { server, store, base } = await startServer();
  t.after(() => server.close());
  appendTaskEvent(store, "T-1");
  appendTaskEvent(store, "T-2");
  appendTaskEvent(store, "T-3");

  const client = await openSse(base, { lastEventId: 1 });
  t.after(() => closeSse(client));

  const second = await waitForFrame(client, (frame) => frame.type === "task.updated" && frame.seq === 2);
  const third = await waitForFrame(client, (frame) => frame.type === "task.updated" && frame.seq === 3);
  assert.equal(second.frame.payload.taskId, "T-2");
  assert.equal(third.frame.payload.taskId, "T-3");
});

test("a pruned event log produces system.resync-required instead of a silent gap", async (t) => {
  const { server, store, base } = await startServer();
  t.after(() => server.close());
  appendTaskEvent(store, "T-1");
  appendTaskEvent(store, "T-2");
  appendTaskEvent(store, "T-3");
  appendTaskEvent(store, "T-4");
  // Simulate retention: sequences 1..2 are gone, oldest available is 3.
  store._dropEventsBefore(3);

  const client = await openSse(base, { lastEventId: 1 });
  t.after(() => closeSse(client));
  const { frame } = await waitForFrame(client, (candidate) => candidate.type === "system.resync-required");
  assert.equal(frame.seq, 4, "resync frame carries the current latest seq");
  assert.equal(frame.payload.lastEventId, 1);
  assert.equal(frame.payload.oldestAvailable, 3);
  assert.equal(frame.payload.latest, 4);
  assert.equal(frame.payload.reason, "gap");
  assert.equal(client.frames.filter((candidate) => candidate.type === "task.updated").length, 0);
});

test("an invalid Last-Event-ID asks the client to resync", async (t) => {
  const { server, store, base } = await startServer();
  t.after(() => server.close());
  appendTaskEvent(store);
  const client = await openSse(base, { lastEventId: "not-a-number" });
  t.after(() => closeSse(client));
  const { frame } = await waitForFrame(client, (candidate) => candidate.type === "system.resync-required");
  assert.equal(frame.payload.reason, "invalid-last-event-id");
  assert.equal(frame.payload.latest, 1);
});

test("keep-alive comments are emitted on the configured heartbeat interval", async (t) => {
  // startServer uses an 80ms heartbeat so the test does not wait 25s; the
  // production default is 25_000ms and covered by contract constants.
  const { server, base } = await startServer();
  t.after(() => server.close());
  const client = await openSse(base);
  t.after(() => closeSse(client));
  const { frame } = await waitForFrame(client, (candidate) => String(candidate.comment ?? "").startsWith("keep-alive"));
  assert.match(String(frame.comment), /^keep-alive \d+$/);
});

test("closing the server clears SSE timers and ends client streams", async (t) => {
  const { server, base } = await startServer();
  const client = await openSse(base);
  await waitForFrame(client, (frame) => String(frame.comment ?? "").startsWith("connected"));
  assert.equal(server.stats().sseClients, 1);

  const closed = server.close();
  await closed;
  assert.equal(server.stats().sseClients, 0);
  closeSse(client);
  // If either interval survived, node:test would keep the process alive and
  // this suite would hang; reaching this line is the evidence it did not.
  t.diagnostic("server.close() resolved with SSE client connected");
});
