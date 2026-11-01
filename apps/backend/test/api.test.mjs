// HTTP API contract tests (m1-contracts §2): routing, DTO validation, CAS,
// error envelope shape and the read-only collections.
import assert from "node:assert/strict";
import test from "node:test";

import { validateErrorBody } from "@atk/contracts";

import { createFakeStore } from "./fake-store.mjs";
import { TEST_TOKEN, readHeaders, recordingLogger, request, startServer, writeHeaders } from "./helpers.mjs";

const PROJECT = { id: "P-1", name: "Demo project", repoPath: "C:\\work\\demo", defaultBranch: "main" };
const TASK = {
  projectId: "P-1",
  title: "Implement the endpoint",
  description: "Wire GET /api/v1/tasks and its tests",
  functionRequired: "WORKER",
  roleRequired: "BE",
  priority: 2,
  deps: [],
};

function assertErrorEnvelope(res, expectedCode, expectedStatus) {
  assert.equal(res.status, expectedStatus, `expected HTTP ${expectedStatus}, body: ${res.text}`);
  assert.ok(res.json, `expected a JSON error body, got: ${res.text}`);
  assert.deepEqual(validateErrorBody(res.json), { ok: true, errors: [] });
  assert.equal(res.json.error.code, expectedCode);
  assert.equal(res.headers["x-request-id"], res.json.error.requestId);
}

async function seededServer() {
  return startServer({
    store: createFakeStore({
      agents: [{ id: "agent-lead-01", role: "LEAD", capabilities: ["ORCHESTRATOR"], status: "IDLE" }],
      runs: [
        {
          id: "R-1",
          taskId: "T-1",
          agentId: "agent-lead-01",
          function: "WORKER",
          status: "RUNNING",
          attempt: 1,
        },
      ],
      reviews: [{ id: "RV-1", taskId: "T-1", status: "PENDING", attempt: 1 }],
      approvals: [{ id: "AP-1", taskId: "T-1", scope: "acceptance", status: "PENDING", actor: "HUMAN" }],
    }),
  });
}

test("project + task CRUD works end to end", async (t) => {
  const { server, store, base } = await seededServer();
  t.after(() => server.close());
  const write = writeHeaders(base);
  const read = readHeaders();

  const createdProject = await request(base, { method: "POST", path: "/api/v1/projects", headers: write, body: PROJECT });
  assert.equal(createdProject.status, 201, createdProject.text);
  assert.equal(createdProject.json.id, "P-1");
  assert.equal(createdProject.json.version, 0);

  const projects = await request(base, { path: "/api/v1/projects", headers: read });
  assert.equal(projects.status, 200);
  assert.equal(projects.json.items.length, 1);
  assert.equal(projects.json.items[0].name, PROJECT.name);

  const createdTask = await request(base, { method: "POST", path: "/api/v1/tasks", headers: write, body: TASK });
  assert.equal(createdTask.status, 201, createdTask.text);
  assert.equal(createdTask.json.status, "READY", "server assigns READY on create");
  assert.equal(createdTask.json.version, 0);
  assert.equal(typeof createdTask.json.id, "string");
  const taskId = createdTask.json.id;

  const list = await request(base, { path: `/api/v1/tasks?projectId=P-1`, headers: read });
  assert.equal(list.status, 200);
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].id, taskId);

  const detail = await request(base, { path: `/api/v1/tasks/${taskId}`, headers: read });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.id, taskId);
  assert.ok(Array.isArray(detail.json.allowedActions));
  assert.deepEqual(detail.json.allowedActions, ["claim", "cancel"]);

  const patched = await request(base, {
    method: "PATCH",
    path: `/api/v1/tasks/${taskId}`,
    headers: write,
    body: { expectedVersion: 0, changes: { title: "Updated title", priority: 1 } },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json.title, "Updated title");
  assert.equal(patched.json.priority, 1);
  assert.equal(patched.json.version, 1);

  // Flat PATCH body is accepted too ({ expectedVersion, title }).
  const flatPatch = await request(base, {
    method: "PATCH",
    path: `/api/v1/tasks/${taskId}`,
    headers: write,
    body: { expectedVersion: 1, description: "updated via flat body" },
  });
  assert.equal(flatPatch.status, 200, flatPatch.text);
  assert.equal(flatPatch.json.description, "updated via flat body");
  assert.equal(flatPatch.json.version, 2);

  const overview = await request(base, { path: "/api/v1/projects/P-1/overview", headers: read });
  assert.equal(overview.status, 200);
  assert.equal(overview.json.project.id, "P-1");
  assert.equal(overview.json.counts.tasksByStatus.READY, 1);
  assert.ok(Array.isArray(overview.json.blocked));
  assert.ok(Array.isArray(overview.json.awaitingAcceptance));
  assert.ok(Array.isArray(overview.json.recentEvents));

  // Events appended by the store are visible through the JSON endpoint.
  store.appendEvent({
    projectId: "P-1",
    aggregateType: "task",
    aggregateId: taskId,
    type: "task.updated",
    payload: { taskId },
  });
  const events = await request(base, { path: "/api/v1/events?afterSeq=0&limit=10", headers: read });
  assert.equal(events.status, 200);
  assert.equal(events.json.items.length, 1);
  assert.equal(events.json.items[0].seq, 1);
});

test("POST /projects and /tasks validate DTOs (400 VALIDATION_ERROR, no state change)", async (t) => {
  const { server, base } = await seededServer();
  t.after(() => server.close());
  const write = writeHeaders(base);

  const emptyProject = await request(base, { method: "POST", path: "/api/v1/projects", headers: write, body: {} });
  assertErrorEnvelope(emptyProject, "VALIDATION_ERROR", 400);
  assert.ok(Array.isArray(emptyProject.json.error.details.errors));
  assert.ok(emptyProject.json.error.details.errors.length > 0);

  const badJson = await request(base, {
    method: "POST",
    path: "/api/v1/projects",
    headers: { ...write, "content-type": "application/json" },
    body: "{not json",
  });
  assertErrorEnvelope(badJson, "VALIDATION_ERROR", 400);
  assert.match(badJson.json.error.message, /valid JSON/);

  const arrayBody = await request(base, { method: "POST", path: "/api/v1/tasks", headers: write, body: [] });
  assertErrorEnvelope(arrayBody, "VALIDATION_ERROR", 400);

  const statusOnCreate = await request(base, {
    method: "POST",
    path: "/api/v1/tasks",
    headers: write,
    body: { ...TASK, status: "DONE" },
  });
  assertErrorEnvelope(statusOnCreate, "VALIDATION_ERROR", 400);
  assert.match(statusOnCreate.json.error.message, /server-owned/);

  const badTask = await request(base, {
    method: "POST",
    path: "/api/v1/tasks",
    headers: write,
    body: { ...TASK, functionRequired: "NOPE" },
  });
  assertErrorEnvelope(badTask, "VALIDATION_ERROR", 400);
  assert.ok(badTask.json.error.details.errors.some((line) => line.includes("functionRequired")));

  // Nothing leaked into the store.
  assert.equal((await request(base, { path: "/api/v1/projects", headers: readHeaders() })).json.items.length, 0);
});

test("PATCH requires expectedVersion and surfaces CAS conflicts as 409 TASK_VERSION_CONFLICT", async (t) => {
  const { server, base } = await seededServer();
  t.after(() => server.close());
  const write = writeHeaders(base);
  const read = readHeaders();

  const task = (await request(base, { method: "POST", path: "/api/v1/tasks", headers: write, body: TASK })).json;

  const missingVersion = await request(base, {
    method: "PATCH",
    path: `/api/v1/tasks/${task.id}`,
    headers: write,
    body: { changes: { title: "nope" } },
  });
  assertErrorEnvelope(missingVersion, "VALIDATION_ERROR", 400);
  assert.match(missingVersion.json.error.message, /expectedVersion/);

  const conflict = await request(base, {
    method: "PATCH",
    path: `/api/v1/tasks/${task.id}`,
    headers: write,
    body: { expectedVersion: 42, changes: { title: "stale" } },
  });
  assertErrorEnvelope(conflict, "TASK_VERSION_CONFLICT", 409);
  assert.equal(conflict.json.error.details.currentVersion, 0);

  const notPatchable = await request(base, {
    method: "PATCH",
    path: `/api/v1/tasks/${task.id}`,
    headers: write,
    body: { expectedVersion: 0, changes: { projectId: "P-2" } },
  });
  assertErrorEnvelope(notPatchable, "VALIDATION_ERROR", 400);

  const badStatus = await request(base, {
    method: "PATCH",
    path: `/api/v1/tasks/${task.id}`,
    headers: write,
    body: { expectedVersion: 0, changes: { status: "NOT_A_STATUS" } },
  });
  assertErrorEnvelope(badStatus, "VALIDATION_ERROR", 400);

  // The task is untouched after all rejected writes.
  const after = await request(base, { path: `/api/v1/tasks/${task.id}`, headers: read });
  assert.equal(after.json.version, 0);
});

test("unknown ids, unknown API paths and unsupported methods are 404 NOT_FOUND", async (t) => {
  const { server, base } = await seededServer();
  t.after(() => server.close());
  const read = readHeaders();
  const write = writeHeaders(base);

  assertErrorEnvelope(await request(base, { path: "/api/v1/tasks/T-does-not-exist", headers: read }), "NOT_FOUND", 404);
  assertErrorEnvelope(await request(base, { path: "/api/v1/runs/R-nope", headers: read }), "NOT_FOUND", 404);
  assertErrorEnvelope(await request(base, { path: "/api/v1/projects/P-nope/overview", headers: read }), "NOT_FOUND", 404);
  assertErrorEnvelope(
    await request(base, {
      method: "PATCH",
      path: "/api/v1/tasks/T-nope",
      headers: write,
      body: { expectedVersion: 0, changes: { title: "x" } },
    }),
    "NOT_FOUND",
    404,
  );

  assertErrorEnvelope(await request(base, { path: "/api/v1/does-not-exist", headers: read }), "NOT_FOUND", 404);
  // Authentication comes before routing: an unknown path still needs a token.
  assertErrorEnvelope(await request(base, { path: "/api/v1/does-not-exist" }), "NOT_AUTHORIZED", 403);
  // Known path, unsupported method.
  assertErrorEnvelope(await request(base, { method: "DELETE", path: "/api/v1/projects", headers: write }), "NOT_FOUND", 404);
});

test("list filters are validated and applied", async (t) => {
  const { server, base } = await seededServer();
  t.after(() => server.close());
  const write = writeHeaders(base);
  const read = readHeaders();

  await request(base, { method: "POST", path: "/api/v1/projects", headers: write, body: PROJECT });
  await request(base, { method: "POST", path: "/api/v1/tasks", headers: write, body: TASK });
  await request(base, {
    method: "POST",
    path: "/api/v1/tasks",
    headers: write,
    body: { ...TASK, title: "Second task", description: "other" },
  });

  const byTitle = await request(base, { path: "/api/v1/tasks?q=endpoint", headers: read });
  assert.equal(byTitle.json.items.length, 1);

  const ready = await request(base, { path: "/api/v1/tasks?status=READY", headers: read });
  assert.equal(ready.json.items.length, 2);

  const limited = await request(base, { path: "/api/v1/tasks?limit=1", headers: read });
  assert.equal(limited.json.items.length, 1);

  assertErrorEnvelope(await request(base, { path: "/api/v1/tasks?status=NOT_A_STATUS", headers: read }), "VALIDATION_ERROR", 400);
  assertErrorEnvelope(await request(base, { path: "/api/v1/tasks?limit=0", headers: read }), "VALIDATION_ERROR", 400);
  assertErrorEnvelope(await request(base, { path: "/api/v1/tasks?limit=abc", headers: read }), "VALIDATION_ERROR", 400);
  assertErrorEnvelope(await request(base, { path: "/api/v1/events?afterSeq=-1", headers: read }), "VALIDATION_ERROR", 400);
  assertErrorEnvelope(
    await request(base, { path: "/api/v1/runs?taskId=", headers: read }),
    "VALIDATION_ERROR",
    400,
  );
});

test("non-Task version conflicts are passed through as 409 VERSION_CONFLICT", async (t) => {
  const { server, base } = await seededServer();
  t.after(() => server.close());
  const write = writeHeaders(base);

  const first = await request(base, { method: "POST", path: "/api/v1/projects", headers: write, body: PROJECT });
  assert.equal(first.status, 201, first.text);
  const duplicate = await request(base, { method: "POST", path: "/api/v1/projects", headers: write, body: PROJECT });
  assertErrorEnvelope(duplicate, "VERSION_CONFLICT", 409);
  assert.equal(duplicate.json.error.details.currentVersion, 0);
});

test("createTask surfaces store dependency validation as 400 with details", async (t) => {
  const { server, base } = await seededServer();
  t.after(() => server.close());
  const write = writeHeaders(base);
  const res = await request(base, {
    method: "POST",
    path: "/api/v1/tasks",
    headers: write,
    body: { ...TASK, deps: ["TASK-NOPE"] },
  });
  assertErrorEnvelope(res, "VALIDATION_ERROR", 400);
  assert.deepEqual(res.json.error.details.missingDeps, ["TASK-NOPE"]);
});

test("a token passed as a query parameter is not accepted (token never goes in URLs)", async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const res = await request(base, { path: `/api/v1/tasks?token=${encodeURIComponent(TEST_TOKEN)}` });
  assertErrorEnvelope(res, "NOT_AUTHORIZED", 403);
  assert.equal(res.json.error.details.reason, "token-missing");
});

test("Idempotency-Key is accepted (recorded, not enforced) on writes", async (t) => {
  const logger = recordingLogger();
  const { server, base } = await startServer({ logger });
  t.after(() => server.close());
  const write = await request(base, {
    method: "POST",
    path: "/api/v1/projects",
    headers: { ...writeHeaders(base), "idempotency-key": "idem-123" },
    body: PROJECT,
  });
  assert.equal(write.status, 201, write.text);
  assert.ok(logger.lines.info.some((line) => line.includes("Idempotency-Key observed")));
  // Same key twice is still accepted in M1 (no dedupe yet), duplicate id collides.
  const second = await request(base, {
    method: "POST",
    path: "/api/v1/projects",
    headers: { ...writeHeaders(base), "idempotency-key": "idem-123" },
    body: { ...PROJECT, id: "P-2" },
  });
  assert.equal(second.status, 201, second.text);
});

test("read-only collections return { items } envelopes", async (t) => {
  const { server, base } = await seededServer();
  t.after(() => server.close());
  const read = readHeaders();

  for (const path of ["/api/v1/runs", "/api/v1/agents", "/api/v1/reviews", "/api/v1/approvals", "/api/v1/events"]) {
    const res = await request(base, { path, headers: read });
    assert.equal(res.status, 200, `${path}: ${res.text}`);
    assert.ok(Array.isArray(res.json.items), `${path} must return { items: [] }`);
  }
  const runs = await request(base, { path: "/api/v1/runs?taskId=T-1", headers: read });
  assert.equal(runs.json.items.length, 1);
  const run = await request(base, { path: "/api/v1/runs/R-1", headers: read });
  assert.equal(run.status, 200);
  assert.equal(run.json.id, "R-1");
  const approvals = await request(base, { path: "/api/v1/approvals?taskId=T-1", headers: read });
  assert.equal(approvals.json.items.length, 1);
});

test("known store error codes pass through unchanged (409 TASK_DEPENDENCY_BLOCKED)", async (t) => {
  const { server, store, base } = await seededServer();
  t.after(() => server.close());
  const write = writeHeaders(base);
  const task = (await request(base, { method: "POST", path: "/api/v1/tasks", headers: write, body: TASK })).json;

  store.patchTask = () => {
    const error = new Error("dependencies are not done yet");
    error.code = "TASK_DEPENDENCY_BLOCKED";
    error.details = { blockedBy: ["TASK-1"] };
    throw error;
  };
  const res = await request(base, {
    method: "PATCH",
    path: `/api/v1/tasks/${task.id}`,
    headers: write,
    body: { expectedVersion: 0, changes: { status: "RUNNING" } },
  });
  assertErrorEnvelope(res, "TASK_DEPENDENCY_BLOCKED", 409);
  assert.deepEqual(res.json.error.details.blockedBy, ["TASK-1"]);
});

test("unexpected store failures become 500 INTERNAL_ERROR without leaking internals", async (t) => {
  const { server, store, base } = await seededServer();
  t.after(() => server.close());
  store.listProjects = () => {
    throw new Error("SQLITE_IOERR: disk I/O error at C:\\secret\\atk.db");
  };
  const res = await request(base, { path: "/api/v1/projects", headers: readHeaders() });
  assertErrorEnvelope(res, "INTERNAL_ERROR", 500);
  assert.equal(res.json.error.message, "internal error");
  assert.doesNotMatch(res.text, /SQLITE|secret|atk\.db/);
});
