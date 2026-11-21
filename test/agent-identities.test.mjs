import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, serverFixture, plan, node, finish } from "./helpers.mjs";
import { createAgentClient } from "../packages/agent-client/src/index.mjs";

const current = f => f.app.get("agents", f.dev.agent.id);
const recover = f => f.app.recoverAgent(f.dev.agent.id, { version: current(f).version });
const remove = f => f.app.deleteAgent(f.dev.agent.id, { version: current(f).version });

test("reissuing a credential and reconnecting preserves identity, settings and execution history", t => {
  const f = fixture(t); plan(f, [node("remembered")]);
  const claim = f.app.claim(f.dev.agent.id, {}); finish(f, claim);
  const before = current(f), count = f.app.store.all("agents").length;
  const result = recover(f);
  for (const field of ["id", "name", "projectId", "teamId", "roleId", "capacity", "createdAt"]) assert.equal(result.agent[field], before[field]);
  assert.equal(result.agent.lastSeen, null); assert.equal(result.agent.status, "OFFLINE");
  assert.equal(result.agent.revoked, false); assert.notEqual(result.credential, f.dev.credential);
  assert.equal(Object.hasOwn(result.agent, "credentialHash"), false);
  assert.throws(() => f.app.authenticate(f.dev.credential), { code: "UNAUTHENTICATED" });
  assert.equal(f.app.authenticate(result.credential).id, before.id);
  for (let i = 0; i < 3; i++) assert.equal(f.app.connect(before.id).agent.id, before.id);
  assert.equal(f.app.store.all("agents").length, count);
  assert.equal(f.app.get("runs", claim.run.id).agentId, before.id);
  assert.equal(f.app.get("tasks", claim.run.taskId).status, "VERIFIED");
  assert.equal(f.app.store.events({ projectId: f.p.id, limit: 1000 }).filter(e => e.type === "agent.credentials-rotated").length, 1);
});

test("an existing disabled identity can recover on the same ID and deleted identities cannot recover", t => {
  const f = fixture(t);
  // Existing disabled records can still reconnect; there is no revoke operation.
  f.app.store.put("agents", { ...current(f), revoked: true, status: "REVOKED" });
  const result = recover(f);
  assert.equal(result.agent.id, f.dev.agent.id); assert.equal(result.agent.revoked, false);
  f.app.connect(result.agent.id); remove(f);
  assert.throws(() => f.app.authenticate(result.credential), { code: "UNAUTHENTICATED" });
  const tombstone = f.app.store.get("agents", result.agent.id);
  assert.ok(tombstone.deletedAt); assert.equal(tombstone.credentialHash, null);
  assert.throws(() => f.app.recoverAgent(result.agent.id, { version: tombstone.version }), { code: "NOT_FOUND" });
  assert.throws(() => f.app.connect(result.agent.id), { code: "AGENT_DELETED" });
});

test("deletion hides the identity from paginated rosters, overview and collaboration but preserves historical references", t => {
  const f = fixture(t); const work = plan(f, [node("history")]);
  const claim = f.app.claim(f.dev.agent.id, {}); finish(f, claim);
  assert.deepEqual(remove(f), { deleted: true, id: f.dev.agent.id });
  const page = f.app.list("agents", { projectId: f.p.id, limit: 1 });
  assert.equal(page.total, 2); assert.equal(page.items.some(a => a.id === f.dev.agent.id), false);
  assert.equal(f.app.overview(f.p.id).agents.some(a => a.id === f.dev.agent.id), false);
  assert.equal(f.app.collaboration(f.p.id).agents.some(a => a.id === f.dev.agent.id), false);
  assert.throws(() => current(f), { code: "NOT_FOUND" });
  assert.equal(f.app.store.get("agents", f.dev.agent.id).name, f.dev.agent.name);
  assert.equal(f.app.get("runs", claim.run.id).agentId, f.dev.agent.id);
  assert.equal(f.app.get("plans", work.plan.id).authorAgentId, f.pm.agent.id);
  assert.equal(f.app.get("tasks", work.tasks[0].id).status, "VERIFIED");
});

test("active, stopping and uncertain task executions block deletion and recovery without releasing locks", t => {
  const f = fixture(t); plan(f, [node("held")]); const claim = f.app.claim(f.dev.agent.id, {});
  for (const status of ["RUNNING", "STOP_REQUESTED", "QUARANTINED"]) {
    f.app.store.put("runs", { ...f.app.store.get("runs", claim.run.id), status });
    const before = current(f);
    assert.throws(() => recover(f), { code: "AGENT_BUSY" }); assert.throws(() => remove(f), { code: "AGENT_BUSY" });
    assert.deepEqual(current(f), before); assert.equal(f.app.list("locks").total, 1);
    assert.equal(f.app.authenticate(f.dev.credential).id, f.dev.agent.id);
  }
  f.app.confirmStopped(claim.run.id, { confirmStopped: true });
  assert.equal(recover(f).agent.id, f.dev.agent.id);
});

test("human lifecycle endpoints are versioned and project scoped; agent credentials cannot rotate or delete identities", async t => {
  const f = await serverFixture(t), id = f.dev.agent.id;
  const other = f.app.createProject({ name: "Other", root: fs.mkdtempSync(path.join(f.root, "other-")) });
  const before = current(f);
  assert.equal((await f.human(`/agents/${id}/revoke?projectId=${f.p.id}`, {})).status, 404);
  assert.deepEqual(current(f), before);
  for (const [action, method] of [["/recover", "POST"], ["", "DELETE"]]) {
    assert.equal((await f.human(`/agents/${id}${action}?projectId=${other.id}`, { version: current(f).version }, method)).status, 404);
    assert.equal((await f.human(`/agents/${id}${action}`, { version: current(f).version }, method)).status, 404);
    const response = await fetch(f.url + `/api/agent/v1/agents/${id}${action}?projectId=${f.p.id}`, { method, headers: { authorization: "Bearer " + f.dev.credential, "content-type": "application/json" }, body: JSON.stringify({ version: current(f).version }) });
    assert.equal(response.status, 404);
    assert.equal((await f.human(`/agents/${id}${action}?projectId=${f.p.id}`, { version: 0 }, method)).status, 409);
  }
  const route = `/agents/${id}?projectId=${f.p.id}`;
  const recovered = await f.human(`/agents/${id}/recover?projectId=${f.p.id}`, { version: current(f).version });
  assert.equal(recovered.status, 200); assert.equal(recovered.body.agent.id, id);
  const client = createAgentClient({ baseUrl: f.url, credential: recovered.body.credential });
  assert.equal((await client.doctor()).identity.id, id); await client.connect();
  assert.equal((await f.human(route, { version: current(f).version }, "DELETE")).status, 200);
  assert.equal((await f.human(route)).status, 404);
  await assert.rejects(client.doctor(), { code: "UNAUTHENTICATED" });
});

test("an agent-owned active CI run also blocks identity recovery and deletion", async t => {
  const f = fixture(t);
  const definition = { schemaVersion: 1, id: "held", name: "Held CI", steps: [{ id: "check", name: "Check", cli: "node", args: ["-e", "setTimeout(()=>{},60000)"] }] };
  const flow = f.app.automations.apply(f.p.id, "held", { definition, expectedRevision: null });
  const run = await f.app.automations.start(f.p.id, "held", { revision: flow.revision, idempotencyKey: crypto.randomUUID() }, { type: "agent", agentId: f.dev.agent.id });
  assert.throws(() => recover(f), { code: "AGENT_BUSY" }); assert.throws(() => remove(f), { code: "AGENT_BUSY" });
  f.app.automations.stop(f.p.id, run.runId);
  for (let i = 0; i < 200 && ["STARTING", "RUNNING", "STOPPING"].includes(f.app.automations.detail(f.p.id, run.runId).status); i++) await delay(50);
  assert.equal(f.app.automations.detail(f.p.id, run.runId).status, "CANCELED");
  assert.equal(recover(f).agent.id, f.dev.agent.id);
});
