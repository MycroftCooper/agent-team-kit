import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "../apps/backend/src/server.mjs";
import { createAgentClient } from "../packages/agent-client/src/index.mjs";
import { fixture, node, plan } from "./helpers.mjs";
import { readBrowserAccess } from "../packages/platform/src/index.mjs";
async function serverFixture(t) {
  const f = fixture();
  const server = createServer({
    service: f.app,
    logger: { error: console.error },
  });
  const info = await server.listen({ port: 0 });
  t.after(async () => {
    await server.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const session = await fetch(info.url + "/api/v1/session", {
    headers: { "x-atk-access": readBrowserAccess(f.data) },
  }).then((r) =>
    r.json(),
  );
  async function human(route, body, method = body === undefined ? "GET" : "POST") {
    const r = await fetch(info.url + "/api/v1" + route, {
      method,
      headers: {
        "content-type": "application/json",
        "x-atk-token": session.token,
        "x-atk-csrf": session.csrf,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  }
  return { ...f, server, ...info, session, human };
}
test("browser session and CSRF are distinct from agent credentials", async (t) => {
  const f = await serverFixture(t);
  assert.throws(() => createServer({ dataDir: f.data }), {
    code: "INSTANCE_ACTIVE",
  });
  assert.equal((await fetch(f.url + "/api/v1/projects")).status, 401);
  for (const headers of [
    {},
    { "x-atk-access": "incorrect" },
    { authorization: `Bearer ${f.pm.credential}` },
    { "x-atk-access": f.pm.credential, "sec-fetch-site": "same-origin" },
  ]) {
    const locked = await fetch(f.url + "/api/v1/session", { headers });
    assert.equal(locked.status, 401);
    const body = await locked.json();
    assert.equal(body.error.code, "UI_LOCKED");
    assert.equal(body.token, undefined);
    assert.equal(body.csrf, undefined);
  }
  assert.equal(
    (
      await fetch(f.url + "/api/v1/session", {
        headers: { origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  const rejected = await fetch(f.url + "/api/v1/tasks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-atk-token": f.session.token,
    },
    body: JSON.stringify({}),
  });
  assert.equal(rejected.status, 403);
  const response = await fetch(f.url + "/api/v1/plans/x/approve", {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.pm.credential}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(response.status, 401);
  const agents = await f.human("/agents");
  assert.ok(!JSON.stringify(agents.body).includes(f.pm.credential));
  assert.ok(!JSON.stringify(agents.body).includes("credentialHash"));
});

test("human assignment reserves execution for one eligible worker without bypassing dependencies", async (t) => {
  const f = await serverFixture(t);
  const { tasks } = plan(f, [
    node("human", { executorType: "HUMAN", files: [] }),
    node("worker", { deps: ["human"], reviewPolicy: "INDEPENDENT", reviewRoleId: "role-qa" }),
  ]);
  const manual = tasks[0], task = tasks[1], route = "/tasks/" + task.id + "/assignment";
  const other = f.app.createAgent({ name: "Second worker", roleId: "role-dev", teamId: "team-default" });
  const team = f.app.createTeam({ name: "Other team", roleIds: ["role-dev"] });
  const outsider = f.app.createAgent({ name: "Outside worker", roleId: "role-dev", teamId: team.id });
  const options = await f.human(route);
  assert.deepEqual(new Set(options.body.choices.map((a) => a.id)), new Set([f.dev.agent.id, other.agent.id]));
  for (const agentId of [f.pm.agent.id, f.qa.agent.id, outsider.agent.id]) {
    const response = await f.human(route, { version: task.version, agentId }, "PATCH");
    assert.equal(response.body.error.code, "ASSIGNEE_FORBIDDEN");
  }
  const unauthorized = await fetch(f.url + "/api/v1" + route, {
    method: "PATCH",
    headers: { authorization: `Bearer ${f.dev.credential}`, "content-type": "application/json" },
    body: JSON.stringify({ version: task.version, agentId: f.dev.agent.id }),
  });
  assert.equal(unauthorized.status, 401);
  const assigned = await f.human(route, { version: task.version, agentId: f.dev.agent.id }, "PATCH");
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.assignedAgentId, f.dev.agent.id);
  assert.equal((await f.human(route, { version: task.version, agentId: null }, "PATCH")).body.error.code, "VERSION_CONFLICT");
  assert.equal(f.app.claim(other.agent.id, { taskId: task.id }).run, null);
  assert.equal(f.app.claim(f.dev.agent.id, { taskId: task.id }).waiting[0].reason, "DEPENDENCIES");
  f.app.startHuman(manual.id, { version: manual.version });
  f.app.finishHuman(manual.id, { stopped: true, outcome: "COMPLETED", summary: "Ready", checks: [] });
  assert.equal(f.app.claim(other.agent.id, { taskId: task.id }).run, null);
  const run = f.app.claim(f.dev.agent.id, { taskId: task.id });
  assert.equal(run.run.agentId, f.dev.agent.id);
  const busy = await f.human(route, { version: f.app.get("tasks", task.id).version, agentId: other.agent.id }, "PATCH");
  assert.equal(busy.body.error.code, "TASK_BUSY");
  f.app.finishRun(f.dev.agent.id, run.run.id, {
    generation: run.generation, idempotencyKey: "assigned-delivery",
    stopped: true, outcome: "COMPLETED", summary: "Assigned work done", checks: [],
  });
  assert.equal(f.app.claim(f.qa.agent.id, { taskId: task.id }).run.agentId, f.qa.agent.id);
  assert.equal(f.app.store.events({ entityId: task.id }).filter((e) => e.type === "task.assignment_changed").length, 1);
});

test("revoked assignment waits for a human to clear it; no other agent takes over automatically", async (t) => {
  const f = await serverFixture(t);
  const { tasks: [task] } = plan(f, [node("reserved")]);
  const other = f.app.createAgent({ name: "Available worker", roleId: "role-dev", teamId: "team-default" });
  const route = "/tasks/" + task.id + "/assignment";
  const assigned = (await f.human(route, { version: task.version, agentId: f.dev.agent.id }, "PATCH")).body;
  f.app.revokeAgent(f.dev.agent.id);
  assert.equal(f.app.claim(other.agent.id, { taskId: task.id }).run, null);
  assert.equal(f.app.taskDispatch(task.id).code, "ASSIGNEE_UNAVAILABLE");
  const cleared = await f.human(route, { version: assigned.version, agentId: null }, "PATCH");
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.assignedAgentId, null);
  assert.equal(f.app.claim(other.agent.id, { taskId: task.id }).run.agentId, other.agent.id);
});

test("board separates drafts from ready tasks and paginates each column independently", async (t) => {
  const f = await serverFixture(t);
  const { tasks } = plan(f, [node("manual", { executorType: "HUMAN", files: [] }), node("worker")]);
  for (let i = 0; i < 23; i++)
    f.app.createDraft({ projectId: f.p.id, title: "Queue item " + i, description: "Pending planning" });
  const route = "/tasks/board?projectId=" + f.p.id;
  const { body: first } = await f.human(route);
  assert.deepEqual(first.columns.slice(0, 2).map((c) => [c.key, c.total]), [["draft", 23], ["queue", 3]]);
  assert.equal(first.columns[0].items.length, 20);
  assert.ok(first.columns[0].items.every((task) => task.status === "DRAFT"));
  assert.ok(first.columns[1].items.every((task) => task.status === "READY"));
  assert.equal(first.columns[0].nextCursor, 20);
  const { body: later } = await f.human(route + "&cursor.draft=20");
  assert.equal(later.columns[0].items.length, 3);
  assert.equal(later.columns[0].previousCursor, 0);
  assert.equal(later.columns[1].offset, 0);
  const { body: owners } = await f.human(route + "&group=owner");
  assert.deepEqual(owners.columns.map((c) => c.total), [1, 1, 24]);
  assert.deepEqual(owners.columns[0].items.map((task) => task.id), [tasks[0].id]);
  const { body: filtered } = await f.human(route + "&group=owner&owner=REQUEST&q=Queue%20item%2022");
  assert.equal(filtered.columns.length, 1);
  assert.equal(filtered.columns[0].total, 1);
  const { body: view } = await f.human(route + "&group=swimlane&hidden=closed&cursor.REQUEST.draft=10&progress=1");
  assert.deepEqual(view.lanes.map((lane) => lane.key), ["HUMAN", "AGENT", "REQUEST"]);
  assert.equal(view.lanes[0].columns[1].items[0].id, tasks[0].id);
  assert.equal(view.lanes[0].columns[0].offset, 0);
  assert.equal(view.lanes[2].columns[0].offset, 10);
  assert.ok(view.lanes.every((lane) => !lane.columns.some((column) => column.key === "closed")));
  const { body: parents } = await f.human(route + "&children=0&q=Feature&progress=1");
  const readyParents = parents.columns.find((column) => column.key === "queue");
  assert.equal(readyParents.total, 1);
  assert.deepEqual(readyParents.items[0].subtaskProgress, { total: 2, verified: 0 });
  const { body: sorted } = await f.human(`/tasks?projectId=${f.p.id}&children=0&sort=title&direction=desc&q=Queue%20item&limit=3`);
  assert.equal(sorted.total, 23);
  assert.deepEqual(sorted.items.map((task) => task.title), ["Queue item 9", "Queue item 8", "Queue item 7"]);
});

test("doctor validates credentials without checking in or claiming work", async (t) => {
  const f = await serverFixture(t);
  const { agent, credential } = f.app.createAgent({
    name: "Unconnected worker", roleId: "role-dev", teamId: "team-default",
  });
  const before = f.app.get("agents", agent.id);
  const client = createAgentClient({ baseUrl: f.url, credential });
  const result = await client.doctor();
  assert.equal(result.identity.id, agent.id);
  assert.equal(result.identity.lastSeen, null);
  assert.equal(JSON.stringify(result).includes(credential), false);
  assert.deepEqual(f.app.get("agents", agent.id), before);
  assert.equal(f.app.list("runs").total, 0);
  await assert.rejects(createAgentClient({ baseUrl: f.url, credential: "wrong" }).doctor(), { code: "UNAUTHENTICATED" });
  await assert.rejects(createAgentClient({
    baseUrl: f.url, credential, fetchImpl: () => Promise.reject(new TypeError("Connection refused")),
  }).doctor(), { code: "SERVICE_UNREACHABLE" });
  await client.connect();
  assert.ok((await client.doctor()).identity.lastSeen);
  f.app.revokeAgent(agent.id);
  await assert.rejects(client.doctor(), { code: "UNAUTHENTICATED" });
});

test("task deadlines and tags are versioned, filter together, and do not change execution", async (t) => {
  const f = await serverFixture(t);
  const { plan: approved, tasks: [task] } = plan(f, [node("deadline")]);
  const run = f.app.claim(f.dev.agent.id, { taskId: task.id });
  const route = "/tasks/" + task.id + "/metadata?projectId=" + f.p.id;
  const running = f.app.get("tasks", task.id);
  assert.equal((await f.human(route, { version: running.version, dueDate: "2026-02-30" }, "PATCH")).body.error.code, "INVALID_DUE_DATE");
  const { body: updated, status } = await f.human(route, {
    version: running.version, dueDate: "2026-11-06", tags: ["UI", " UI ", "人工"],
  }, "PATCH");
  assert.equal(status, 200);
  assert.deepEqual(updated.tags, ["UI", "人工"]);
  assert.equal(updated.status, "RUNNING");
  assert.equal(f.app.get("plans", approved.id).version, approved.version);
  assert.equal(f.app.list("locks").total, 1);
  assert.equal((await f.human(route, { version: running.version, tags: [] }, "PATCH")).body.error.code, "VERSION_CONFLICT");

  const prefix = "?projectId=" + f.p.id;
  const { body: tags } = await f.human("/tasks/tags" + prefix);
  assert.deepEqual(tags.items, ["UI", "人工"]);
  const { body: matching } = await f.human("/tasks" + prefix + "&due=overdue&day=2026-11-07&tag=UI");
  assert.deepEqual(matching.items.map((item) => item.id), [task.id]);
  const { body: board } = await f.human("/tasks/board" + prefix + "&group=swimlane&due=on&day=2026-11-06&tag=UI");
  assert.deepEqual(board.lanes.find((lane) => lane.key === "AGENT").columns.find((col) => col.key === "running").items.map((item) => item.id), [task.id]);
  const { body: week } = await f.human("/tasks" + prefix + "&due=week&day=2026-10-31");
  assert.deepEqual(week.items.map((item) => item.id), [task.id]);
  assert.equal((await f.human("/tasks" + prefix + "&due=overdue")).status, 400);
  assert.equal((await f.human("/tasks" + prefix + "&due=none&tag=UI")).body.total, 0);
  f.app.finishRun(f.dev.agent.id, run.run.id, {
    generation: run.generation, idempotencyKey: "metadata-during-execution", stopped: true,
    outcome: "COMPLETED", summary: "Execution still completes", checks: [],
  });
  assert.equal((await f.human("/tasks" + prefix + "&due=overdue&day=2026-11-07")).body.total, 0);
  const latest = f.app.get("tasks", task.id);
  const { body: cleared } = await f.human(route, { version: latest.version, dueDate: null, tags: [] }, "PATCH");
  assert.equal(cleared.dueDate, null);
  assert.deepEqual(cleared.tags, []);
  assert.deepEqual((await f.human("/tasks/tags" + prefix)).body.items, []);
});

test("claim diagnostics distinguish readiness, locks, missing contact and capacity without making a claim", async (t) => {
  const f = await serverFixture(t);
  plan(f, [
    node("first"),
    node("second"),
    node("same", { files: ["first.txt"] }),
    node("dependent", { deps: ["first"] }),
  ]);
  const tasks = f.app.list("tasks").items;
  const route = (name) => "/tasks/" + tasks.find((task) => task.title === "Task " + name).id;
  const diagnostic = async (name) => (await f.human(route(name) + "/dispatch")).body;
  const worker = f.app.createAgent({ name: "Other worker", roleId: "role-dev", teamId: "team-default" });
  f.app.revokeAgent(f.dev.agent.id);
  assert.equal((await diagnostic("dependent")).code, "DEPENDENCIES");
  assert.equal((await diagnostic("second")).code, "NO_RECENT_AGENT");
  f.app.connect(worker.agent.id);
  assert.equal((await diagnostic("second")).code, "WAITING_FOR_CLAIM");
  const first = tasks.find((task) => task.title === "Task first");
  const claim = f.app.claim(worker.agent.id, { taskId: first.id });
  assert.equal((await diagnostic("same")).code, "FILE_LOCKED");
  const before = f.app.list("runs").total;
  assert.equal((await diagnostic("second")).code, "AGENT_CAPACITY");
  assert.equal(f.app.list("runs").total, before);
  assert.equal((await f.human(route("second"))).body.waiting, null);
  assert.equal((await f.human(route("second") + "?projectId=wrong")).status, 404);
  assert.equal((await f.human("/runs/" + claim.run.id + "/artifact?projectId=wrong")).status, 404);
  f.app.revokeAgent(worker.agent.id);
  assert.equal((await diagnostic("second")).code, "NO_MATCHING_AGENT");
  assert.equal(f.app.list("locks").total, 1);
});

test("HTTP clients race atomically, report receipts and replay idempotently", async (t) => {
  const f = await serverFixture(t);
  plan(f, [node("a")]);
  const extra = f.app.createAgent({
    name: "extra",
    roleId: "role-dev",
    teamId: "team-default",
  });
  const a = createAgentClient({ baseUrl: f.url, credential: f.dev.credential }),
    b = createAgentClient({ baseUrl: f.url, credential: extra.credential });
  const results = await Promise.all([
    a.claim({ waitMs: 0 }),
    b.claim({ waitMs: 0 }),
  ]);
  assert.equal(results.filter((r) => r.run).length, 1);
  const r = results.find((r) => r.run),
    client = r.run.agentId === f.dev.agent.id ? a : b;
  fs.writeFileSync(path.join(f.p.root, "a.txt"), "done");
  const output = await client.submit(r.run.id, "result", {
    generation: r.generation,
    idempotencyKey: "one",
    stopped: true,
    outcome: "COMPLETED",
    summary: "complete",
  });
  assert.equal(output.persisted, true);
  const second = await client.submit(r.run.id, "result", {
    generation: r.generation,
    idempotencyKey: "one",
    stopped: true,
    outcome: "COMPLETED",
    summary: "complete",
  });
  assert.equal(second.run.resultHash, output.run.resultHash);
});

test("a real submitted plan needs private web authorization and rework feedback is readable by its worker", async (t) => {
  const f = await serverFixture(t),
    dev = createAgentClient({ baseUrl: f.url, credential: f.dev.credential });
  const draft = f.app.createDraft({ projectId: f.p.id, title: "Protected approval", description: "x" });
  const planning = f.app.claim(f.pm.agent.id, { taskId: draft.id });
  const submitted = f.app.submitPlan(f.pm.agent.id, planning.run.id, {
    generation: planning.generation, idempotencyKey: "protected-plan",
    plan: { summary: "Protected plan", nodes: [node("a", { reviewPolicy: "INDEPENDENT", reviewRoleId: "role-qa" })] },
  });
  const blocked = await fetch(`${f.url}/api/v1/plans/${submitted.plan.id}/approve`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.pm.credential}` },
    body: JSON.stringify({ version: submitted.plan.version }),
  });
  assert.equal(blocked.status, 401);
  assert.equal(f.app.get("plans", submitted.plan.id).status, "SUBMITTED");
  const approved = await f.human(`/plans/${submitted.plan.id}/approve`, { version: submitted.plan.version });
  assert.equal(approved.status, 200);
  const worker = await dev.claim({ taskId: approved.body.tasks[0].id, waitMs: 0 });
  const delivered = await dev.submit(worker.run.id, "result", {
    generation: worker.generation, stopped: true, outcome: "COMPLETED", summary: "Candidate",
  });
  const reviewer = f.app.claim(f.qa.agent.id, {});
  f.app.submitReview(f.qa.agent.id, reviewer.run.id, {
    generation: reviewer.generation, idempotencyKey: "feedback", targetHash: delivered.task.resultHash,
    verdict: "CHANGES_REQUESTED", summary: "Fix empty input", findings: [{ message: "Empty input crashes" }],
  });
  const retry = await dev.claim({ waitMs: 0 });
  const feedback = await dev.request(retry.spec.rework.reviewRef.replace("/api/agent/v1", ""));
  assert.equal(feedback.review.findings[0].message, "Empty input crashes");
});
test("long poll waits without work and returns on a new eligible DRAFT", async (t) => {
  const f = await serverFixture(t),
    client = createAgentClient({ baseUrl: f.url, credential: f.pm.credential });
  const started = Date.now();
  const waiting = client.claim({ waitMs: 2000 });
  setTimeout(
    () =>
      f.app.createDraft({
        projectId: f.p.id,
        title: "new",
        description: "New work",
      }),
    150,
  );
  const result = await waiting;
  assert.ok(result.run);
  assert.ok(Date.now() - started >= 100);
});
test("SSE replays events by seq and marks invalid cursors for resync", async (t) => {
  const f = await serverFixture(t);
  const controller = new AbortController();
  const response = await fetch(f.url + "/api/v1/events/stream", {
    headers: { "x-atk-token": f.session.token, "last-event-id": "0" },
    signal: controller.signal,
  });
  const reader = response.body.getReader(),
    text = new TextDecoder().decode((await reader.read()).value);
  assert.ok(text.includes("id:"));
  controller.abort();
  await reader.cancel().catch(() => {});
  const abort = new AbortController(),
    invalid = await fetch(f.url + "/api/v1/events/stream", {
      headers: { "x-atk-token": f.session.token, "last-event-id": "99999999" },
      signal: abort.signal,
    });
  const chunk = new TextDecoder().decode(
    (await invalid.body.getReader().read()).value,
  );
  assert.ok(chunk.includes("system.resync-required"));
  abort.abort();
});
