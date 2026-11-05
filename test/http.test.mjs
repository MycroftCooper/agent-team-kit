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
  async function human(route, body) {
    const r = await fetch(info.url + "/api/v1" + route, {
      method: body === undefined ? "GET" : "POST",
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
