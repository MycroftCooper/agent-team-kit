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

function assertInvalid(res, fieldPattern) {
  assert.equal(res.status, 400, res.text);
  assert.equal(validateErrorBody(res.json).ok, true);
  assert.equal(res.json.error.code, "VALIDATION_ERROR");
  assert.match(JSON.stringify(res.json.error.details), fieldPattern);
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

test("GET /events validates every filter with a field-naming 400", async (t) => {
  const ctx = await withServer(t);
  const read = readHeaders();
  assertInvalid(await request(ctx.base, { path: "/api/v1/events?aggregateId=not%20an%20id", headers: read }), /aggregateId/);
  assertInvalid(await request(ctx.base, { path: "/api/v1/events?aggregateType=", headers: read }), /aggregateType/);
  assertInvalid(await request(ctx.base, { path: "/api/v1/events?type=NOPE", headers: read }), /type/);
  assertInvalid(await request(ctx.base, { path: "/api/v1/events?limit=0", headers: read }), /limit/);
  assertInvalid(await request(ctx.base, { path: "/api/v1/events?limit=1001", headers: read }), /limit/);
  assertInvalid(await request(ctx.base, { path: "/api/v1/events?afterSeq=-1", headers: read }), /afterSeq/);
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
