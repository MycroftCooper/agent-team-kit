// M6: server-side event aggregate filters and health.switchReadiness.
import assert from "node:assert/strict";
import test from "node:test";

import { validateErrorBody } from "@atk/contracts";

import { createFakeStore } from "./fake-store.mjs";
import { request, startServer, readHeaders } from "./helpers.mjs";

function seededStore() {
  const store = createFakeStore({
    projects: [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }],
    tasks: [
      { id: "T-1", projectId: "P-1", title: "One", description: "d", functionRequired: "WORKER", roleRequired: "BE", priority: 2, deps: [], status: "READY", version: 0 },
      { id: "T-2", projectId: "P-1", title: "Two", description: "d", functionRequired: "WORKER", roleRequired: "BE", priority: 2, deps: [], status: "READY", version: 0 },
    ],
  });
  const at = "2026-11-02T05:00:00.000Z";
  const append = (aggregateType, aggregateId, type) =>
    store.appendEvent({ projectId: "P-1", aggregateType, aggregateId, type, payload: { at } });
  append("task", "T-1", "task.updated");
  append("task", "T-1", "task.updated");
  append("task", "T-2", "task.updated");
  append("run", "R-1", "run.created");
  append("run", "R-1", "run.updated");
  append("run", "R-1", "run.log");
  append("review", "REV-1", "review.requested");
  return store;
}

async function withServer(t, store = seededStore()) {
  const ctx = await startServer({ store });
  t.after(() => ctx.server.close());
  return ctx;
}

function assertInvalid(res, fieldPattern, expectedField) {
  assert.equal(res.status, 400, res.text);
  assert.equal(validateErrorBody(res.json).ok, true);
  assert.equal(res.json.error.code, "VALIDATION_ERROR");
  assert.match(JSON.stringify(res.json.error.details), fieldPattern);
  if (expectedField !== undefined) assert.equal(res.json.error.details.field, expectedField, res.text);
}

test("GET /events filters by aggregateId, aggregateType and type", async (t) => {
  const ctx = await withServer(t);
  const read = readHeaders();

  const all = await request(ctx.base, { path: "/api/v1/events", headers: read });
  assert.equal(all.status, 200);
  assert.equal(all.json.hasMore, false);
  assert.equal(all.json.items.length, 7);
  assert.equal(all.json.nextAfterSeq, undefined);

  const byTask = await request(ctx.base, { path: "/api/v1/events?aggregateId=T-1", headers: read });
  assert.equal(byTask.status, 200);
  assert.equal(byTask.json.items.length, 2);
  assert.ok(byTask.json.items.every((event) => event.aggregateId === "T-1"));

  const byRun = await request(ctx.base, { path: "/api/v1/events?aggregateType=run", headers: read });
  assert.equal(byRun.json.items.length, 3);
  assert.ok(byRun.json.items.every((event) => event.aggregateType === "run"));

  const byType = await request(ctx.base, { path: "/api/v1/events?type=run.log", headers: read });
  assert.equal(byType.json.items.length, 1);
  assert.equal(byType.json.items[0].aggregateId, "R-1");

  const combined = await request(ctx.base, { path: "/api/v1/events?aggregateType=run&aggregateId=R-1&type=run.updated", headers: read });
  assert.equal(combined.json.items.length, 1);
  assert.equal(combined.json.items[0].type, "run.updated");
});

test("GET /events paginates with nextAfterSeq and hasMore", async (t) => {
  const ctx = await withServer(t);
  const read = readHeaders();

  const page1 = await request(ctx.base, { path: "/api/v1/events?aggregateId=R-1&limit=2", headers: read });
  assert.equal(page1.status, 200);
  assert.equal(page1.json.items.length, 2);
  assert.equal(page1.json.hasMore, true);
  assert.equal(page1.json.nextAfterSeq, page1.json.items[1].seq);

  const page2 = await request(ctx.base, { path: `/api/v1/events?aggregateId=R-1&limit=2&afterSeq=${page1.json.nextAfterSeq}`, headers: read });
  assert.equal(page2.json.items.length, 1);
  assert.equal(page2.json.hasMore, false);
  assert.equal(page2.json.nextAfterSeq, undefined);
  assert.ok(page2.json.items[0].seq > page1.json.nextAfterSeq);
});

test("GET /events defaults to 100 items and reports hasMore", async (t) => {
  const store = createFakeStore({ projects: [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }] });
  for (let index = 0; index < 130; index += 1) {
    store.appendEvent({ projectId: "P-1", aggregateType: "task", aggregateId: "T-1", type: "task.updated", payload: { index } });
  }
  const ctx = await withServer(t, store);
  const res = await request(ctx.base, { path: "/api/v1/events", headers: readHeaders() });
  assert.equal(res.status, 200);
  assert.equal(res.json.items.length, 100);
  assert.equal(res.json.hasMore, true);
  assert.equal(res.json.nextAfterSeq, res.json.items[99].seq);

  const next = await request(ctx.base, { path: `/api/v1/events?afterSeq=${res.json.nextAfterSeq}`, headers: readHeaders() });
  assert.equal(next.json.items.length, 30);
  assert.equal(next.json.hasMore, false);
});

test("GET /events never loses a seq when the last page is short (QA-007)", async (t) => {
  // 3 remaining, limit=2: fetch limit+1 must NOT make the store claim completion.
  const three = createFakeStore({ projects: [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }] });
  for (let index = 0; index < 3; index += 1) {
    three.appendEvent({ projectId: "P-1", aggregateType: "task", aggregateId: "T-1", type: "task.updated", payload: { index } });
  }
  const ctx3 = await withServer(t, three);
  const page1 = await request(ctx3.base, { path: "/api/v1/events?limit=2", headers: readHeaders() });
  assert.deepEqual(page1.json.items.map((event) => event.seq), [1, 2]);
  assert.equal(page1.json.hasMore, true);
  assert.equal(page1.json.nextAfterSeq, 2);
  const page2 = await request(ctx3.base, { path: `/api/v1/events?limit=2&afterSeq=${page1.json.nextAfterSeq}`, headers: readHeaders() });
  assert.deepEqual(page2.json.items.map((event) => event.seq), [3]);
  assert.equal(page2.json.hasMore, false);
  assert.equal(page2.json.nextAfterSeq, undefined);

  // 4 remaining, limit=2: nextAfterSeq must be the last RETURNED item (2), not
  // the store's limit+1 page (3), otherwise seq 3 is skipped.
  const four = createFakeStore({ projects: [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }] });
  for (let index = 0; index < 4; index += 1) {
    four.appendEvent({ projectId: "P-1", aggregateType: "task", aggregateId: "T-1", type: "task.updated", payload: { index } });
  }
  const ctx4 = await withServer(t, four);
  const first = await request(ctx4.base, { path: "/api/v1/events?limit=2", headers: readHeaders() });
  assert.deepEqual(first.json.items.map((event) => event.seq), [1, 2]);
  assert.equal(first.json.nextAfterSeq, 2);
  const second = await request(ctx4.base, { path: `/api/v1/events?limit=2&afterSeq=${first.json.nextAfterSeq}`, headers: readHeaders() });
  assert.deepEqual(second.json.items.map((event) => event.seq), [3, 4]);
  assert.equal(second.json.hasMore, false);
  assert.deepEqual([...first.json.items, ...second.json.items].map((event) => event.seq), [1, 2, 3, 4]);

  // Default page size 100 with 105 events: 100 + 5, no gaps.
  const many = createFakeStore({ projects: [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }] });
  for (let index = 0; index < 105; index += 1) {
    many.appendEvent({ projectId: "P-1", aggregateType: "task", aggregateId: "T-1", type: "task.updated", payload: { index } });
  }
  const ctxMany = await withServer(t, many);
  const defaultFirst = await request(ctxMany.base, { path: "/api/v1/events", headers: readHeaders() });
  assert.equal(defaultFirst.json.items.length, 100);
  assert.equal(defaultFirst.json.hasMore, true);
  assert.equal(defaultFirst.json.nextAfterSeq, 100);
  const defaultSecond = await request(ctxMany.base, { path: `/api/v1/events?afterSeq=${defaultFirst.json.nextAfterSeq}`, headers: readHeaders() });
  assert.equal(defaultSecond.json.items.length, 5);
  assert.equal(defaultSecond.json.hasMore, false);
  assert.deepEqual(
    [...defaultFirst.json.items, ...defaultSecond.json.items].map((event) => event.seq),
    Array.from({ length: 105 }, (_, index) => index + 1),
  );

  // limit=1000 boundary: 1001 events -> 1000 + 1.
  const boundary = createFakeStore({ projects: [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }] });
  for (let index = 0; index < 1001; index += 1) {
    boundary.appendEvent({ projectId: "P-1", aggregateType: "task", aggregateId: "T-1", type: "task.updated", payload: { index } });
  }
  const ctxBoundary = await withServer(t, boundary);
  const boundaryFirst = await request(ctxBoundary.base, { path: "/api/v1/events?limit=1000", headers: readHeaders() });
  assert.equal(boundaryFirst.json.items.length, 1000);
  assert.equal(boundaryFirst.json.hasMore, true);
  assert.equal(boundaryFirst.json.nextAfterSeq, 1000);
  const boundarySecond = await request(ctxBoundary.base, { path: `/api/v1/events?limit=1000&afterSeq=${boundaryFirst.json.nextAfterSeq}`, headers: readHeaders() });
  assert.equal(boundarySecond.json.items.length, 1);
  assert.equal(boundarySecond.json.hasMore, false);
  assert.deepEqual(
    [...boundaryFirst.json.items, ...boundarySecond.json.items].map((event) => event.seq),
    Array.from({ length: 1001 }, (_, index) => index + 1),
  );
});

test("GET /events validates every filter with a field-naming 400", async (t) => {
  const ctx = await withServer(t);
  const read = readHeaders();
  assertInvalid(await request(ctx.base, { path: "/api/v1/events?aggregateId=not%20an%20id", headers: read }), /aggregateId/, "aggregateId");
  assertInvalid(await request(ctx.base, { path: "/api/v1/events?aggregateType=", headers: read }), /aggregateType/, "aggregateType");
  assertInvalid(await request(ctx.base, { path: "/api/v1/events?type=NOPE", headers: read }), /type/, "type");
  assertInvalid(await request(ctx.base, { path: "/api/v1/events?limit=0", headers: read }), /limit/, "limit");
  assertInvalid(await request(ctx.base, { path: "/api/v1/events?limit=1001", headers: read }), /limit/, "limit");
  assertInvalid(await request(ctx.base, { path: "/api/v1/events?afterSeq=-1", headers: read }), /afterSeq/, "afterSeq");
});

test("GET /system/health exposes switchReadiness and omits it for old stores", async (t) => {
  const store = createFakeStore();
  const ctx = await withServer(t, store);
  const health = await request(ctx.base, { path: "/api/v1/system/health" });
  assert.equal(health.status, 200);
  assert.deepEqual(health.json.switchReadiness, { ok: true, blockers: [] });

  store._setSwitchReadiness({ ok: false, blockers: [{ code: "reviews-pending", count: 2 }] });
  const blocked = await request(ctx.base, { path: "/api/v1/system/health" });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.json.switchReadiness.ok, false);
  assert.deepEqual(blocked.json.switchReadiness.blockers, [{ code: "reviews-pending", count: 2 }]);

  // A store that predates verifySwitchReadiness must not make health fail.
  delete store.verifySwitchReadiness;
  const oldStore = await request(ctx.base, { path: "/api/v1/system/health" });
  assert.equal(oldStore.status, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(oldStore.json, "switchReadiness"), false);
});
