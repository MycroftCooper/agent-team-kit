import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createService } from "../apps/backend/src/service.mjs";
import { createAgentClient } from "../packages/agent-client/src/index.mjs";
import { fixture, serverFixture, node, plan, finish } from "./helpers.mjs";

function secondProject(f) {
  return f.app.createProject({ name: "Project B", root: fs.mkdtempSync(path.join(f.root, "project-b-")) });
}

test("project-owned credentials cannot claim, inspect or be assigned work in another project sharing their squad", async (t) => {
  const f = await serverFixture(t), p2 = secondProject(f);
  const work = plan(f, [node("own")]);
  const other = f.app.createAgent({ projectId: p2.id, name: "Other developer", roleId: "role-dev" });
  const otherPlan = plan({ ...f, p: p2 }, [node("other")]);
  const client = createAgentClient({ baseUrl: f.url, credential: f.dev.credential });
  const otherClient = createAgentClient({ baseUrl: f.url, credential: other.credential });
  assert.equal((await otherClient.doctor()).identity.projectId, p2.id);
  await assert.rejects(client.claim({ projectId: p2.id, waitMs: 0 }), { code: "PROJECT_FORBIDDEN" });
  assert.equal((await client.claim({ taskId: otherPlan.tasks[0].id, waitMs: 0 })).run, null);
  await assert.rejects(client.request(`/plans/${otherPlan.plan.id}`), { code: "PROJECT_FORBIDDEN" });
  const foreignRun = await otherClient.claim({ waitMs: 0 });
  assert.equal(foreignRun.spec.taskId, otherPlan.tasks[0].id);
  for (const action of ["", "/artifact"]) await assert.rejects(client.request(`/runs/${foreignRun.run.id}${action}`), { code: "PROJECT_FORBIDDEN" });
  await assert.rejects(client.request(`/project-resources/${p2.id}`), { code: "PROJECT_FORBIDDEN" });
  const choices = f.app.taskAssignment(work.tasks[0].id).choices;
  assert.equal(choices.some((a) => a.id === other.agent.id), false);
  assert.throws(() => f.app.assignTask(work.tasks[0].id, { version: work.tasks[0].version, agentId: other.agent.id }), { code: "ASSIGNEE_FORBIDDEN" });
  assert.equal((await f.human(`/agents?projectId=${f.p.id}`)).body.items.some((a) => a.id === other.agent.id), false);
  assert.equal((await f.human(`/agents/${other.agent.id}?projectId=${f.p.id}`)).status, 404);
  assert.equal((await f.human(`/agents/${other.agent.id}/revoke?projectId=${f.p.id}`, {})).status, 404);
  assert.equal(f.app.get("agents", other.agent.id).revoked, false);
  assert.equal((await f.human("/agents")).status, 400);
  assert.equal((await f.human(`/agents/${f.dev.agent.id}?projectId=${f.p.id}`, { projectId: p2.id, version: f.app.get("agents", f.dev.agent.id).version }, "PATCH")).body.error.code, "PROJECT_IMMUTABLE");
  assert.equal((await f.human("/agents", { name: "Missing owner", roleId: "role-dev" })).status, 400);
});

test("collaboration snapshots include all current runs and progress, without foreign identities or payloads", async (t) => {
  const f = await serverFixture(t), p2 = secondProject(f);
  const other = f.app.createAgent({ projectId: p2.id, name: "Private B agent", roleId: "role-dev" });
  const work = plan(f, [node("one"), node("two", { deps: ["one"] })]);
  const claimed = f.app.claim(f.dev.agent.id, {});
  f.app.runEvents(f.dev.agent.id, claimed.run.id, { generation: claimed.generation, events: [{ eventId: "long-progress", type: "progress", message: "Working ".repeat(70) }] });
  const snapshot = (await f.human(`/collaboration?projectId=${f.p.id}`)).body;
  assert.equal(snapshot.project.id, f.p.id);
  assert.equal(snapshot.agents.length, 3);
  assert.equal(snapshot.selectedPlanId, work.plan.id);
  assert.ok(snapshot.latestSeq > 0 && snapshot.serverNow > 0);
  assert.equal(snapshot.runs.find((r) => r.id === claimed.run.id).latestProgress.message.length, 240);
  assert.ok(snapshot.events.some((e) => e.type === "run.created" && e.taskId === work.tasks[0].id));
  assert.ok(snapshot.tasks.some((v) => v.id === work.tasks[1].id && v.waiting.code === "DEPENDENCIES"));
  assert.equal(JSON.stringify(snapshot).includes(other.agent.id), false);
  assert.equal(JSON.stringify(snapshot).includes("credentialHash"), false);
  assert.equal(f.app.overview(f.p.id).agents.some((a) => a.id === other.agent.id), false);
  assert.equal((await f.human(`/collaboration?projectId=${p2.id}&planId=${work.plan.id}`)).status, 404);
  finish(f, claimed);
  const next = f.app.collaboration(f.p.id);
  assert.equal(next.tasks.find((v) => v.id === work.tasks[1].id).waiting, null);
});

test("project SSE carries project agent events and shared config but excludes another project's agent events", async (t) => {
  const f = await serverFixture(t), p2 = secondProject(f), seq = f.app.store.latestSeq();
  const foreign = f.app.createAgent({ projectId: p2.id, name: "Not visible here", roleId: "role-dev" });
  const own = f.app.createAgent({ projectId: f.p.id, name: "Visible here", roleId: "role-dev" });
  const team = f.app.get("teams", f.p.teamId);
  f.app.updateTeam(team.id, { version: team.version, name: "Shared configuration updated" });
  const controller = new AbortController();
  const response = await fetch(`${f.url}/api/v1/events/stream?projectId=${f.p.id}&after=${seq}`, { headers: { "x-atk-token": f.session.token }, signal: controller.signal });
  const reader = response.body.getReader();
  let text = "";
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    while (!text.includes(own.agent.id) || !text.includes("team.updated")) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      text += new TextDecoder().decode(value);
    }
    assert.equal(text.includes(foreign.agent.id), false);
  } finally { clearTimeout(timeout); await reader.cancel(); controller.abort(); }
});

test("unambiguous legacy ownership is backfilled without interrupting a run or releasing its locks", (t) => {
  const f = fixture();
  let app = f.app;
  t.after(() => { app.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  plan(f, [node("work")]);
  const run = app.claim(f.dev.agent.id, {});
  const current = app.get("agents", f.dev.agent.id);
  app.store.put("agents", { ...current, projectId: null });
  app.close();
  app = createService({ dataDir: f.data });
  assert.equal(app.get("agents", f.dev.agent.id).projectId, f.p.id);
  assert.equal(app.get("runs", run.run.id).status, "RUNNING");
  assert.equal(app.list("locks").total, 1);
  finish({ ...f, app }, run);
  assert.equal(app.list("locks").total, 0);
});

test("ambiguous legacy identities retain recovery access and require explicit binding after unresolved runs stop", (t) => {
  const f = fixture();
  let app = f.app;
  t.after(() => { app.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const p2 = secondProject(f);
  plan(f, [node("work")]);
  const claimed = app.claim(f.dev.agent.id, {});
  const record = app.get("runs", claimed.run.id);
  app.store.put("runs", { ...record, id: "historical-other-project-run", projectId: p2.id, status: "COMPLETED" });
  app.store.put("agents", { ...app.get("agents", f.dev.agent.id), projectId: null });
  app.close(); app = createService({ dataDir: f.data });
  assert.equal(app.get("agents", f.dev.agent.id).projectId, null);
  assert.throws(() => app.claim(f.dev.agent.id, {}), { code: "AGENT_PROJECT_REQUIRED" });
  assert.doesNotThrow(() => app.authorizeAgentProject(f.dev.agent.id, f.p.id, { runId: claimed.run.id }));
  assert.throws(() => app.bindAgent(f.dev.agent.id, { projectId: f.p.id, version: app.get("agents", f.dev.agent.id).version }), { code: "AGENT_BUSY" });
  app.requestStop(claimed.run.id); app.confirmStopped(claimed.run.id, { confirmStopped: true });
  const bound = app.bindAgent(f.dev.agent.id, { projectId: f.p.id, version: app.get("agents", f.dev.agent.id).version });
  assert.equal(bound.projectId, f.p.id);
  assert.equal(app.get("runs", "historical-other-project-run").projectId, p2.id);
  assert.throws(() => app.authorizeAgentProject(f.dev.agent.id, p2.id), { code: "PROJECT_FORBIDDEN" });
  assert.equal(app.agentMigrations().some((a) => a.id === f.dev.agent.id), false);
});
