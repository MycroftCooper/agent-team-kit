import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fixture, serverFixture, node, plan, finish, completeHuman } from "./helpers.mjs";
const action = (f, id) => f.app.get("tasks", id).humanActions[0];
const human = (key, more = {}) => node(key, { executorType: "HUMAN", roleId: null, files: [], ...more });

test("drafts expose plan approval only for the submitted current plan, without bypassing approval", (t) => {
  const f = fixture(t), draft = f.app.createDraft({ projectId: f.p.id, title: "Plan me", description: "A real requirement" });
  assert.equal(action(f, draft.id).reason, "PLAN_NOT_SUBMITTED");
  const claimed = f.app.claim(f.pm.agent.id, { taskId: draft.id });
  const submitted = f.app.submitPlan(f.pm.agent.id, claimed.run.id, { generation: claimed.generation, idempotencyKey: crypto.randomUUID(), plan: { summary: "One human task", nodes: [human("one")] } });
  const a = action(f, draft.id);
  assert.equal(a.type, "APPROVE_PLAN"); assert.equal(a.enabled, true); assert.equal(a.planVersion, submitted.plan.version);
  assert.equal(f.app.list("tasks", { parentId: draft.id }).total, 0);
  f.app.approvePlan(a.planId, { version: a.planVersion });
  assert.equal(f.app.get("tasks", draft.id).status, "READY");
  assert.equal(f.app.list("tasks", { parentId: draft.id }).total, 1);
  assert.deepEqual(f.app.get("tasks", draft.id).humanActions, []);
});

test("human moves respect dependencies and bind completion to a live run and task version", (t) => {
  const f = fixture(t), p = plan(f, [node("upstream"), human("manual", { deps: ["upstream"] })]);
  const h = p.tasks[1];
  assert.equal(action(f, h.id).reason, "DEPENDENCIES");
  finish(f, f.app.claim(f.dev.agent.id, { taskId: p.tasks[0].id }));
  assert.equal(action(f, h.id).enabled, true);
  const before = f.app.get("tasks", h.id); f.app.startHuman(h.id, { version: before.version });
  const current = f.app.get("tasks", h.id), a = action(f, h.id);
  assert.equal(a.type, "COMPLETE_HUMAN"); assert.equal(a.runId, current.humanRun.id); assert.equal(a.generation, current.humanRun.generation);
  assert.throws(() => f.app.finishHuman(h.id, { summary: "Unbound old client" }), { code: "VERSION_CONFLICT" });
  assert.throws(() => f.app.finishHuman(h.id, { version: current.version, summary: "Missing run" }), { code: "STALE_HUMAN_RUN" });
  const changed = f.app.updateTaskMetadata(h.id, { version: current.version, tags: ["changed"] });
  assert.throws(() => f.app.finishHuman(h.id, { version: current.version, runId: a.runId, generation: a.generation, summary: "Stale version" }), { code: "VERSION_CONFLICT" });
  const done = completeHuman(f, changed.id, { summary: "Actually completed" });
  assert.equal(done.task.status, "DONE"); assert.deepEqual(f.app.get("tasks", h.id).humanActions, []);
});

test("an old human form cannot complete a restarted execution even with the new task version", (t) => {
  const f = fixture(t), p = plan(f, [human("manual")]), id = p.tasks[0].id;
  f.app.startHuman(id, { version: f.app.get("tasks", id).version });
  const old = f.app.get("tasks", id);
  f.app.requestStop(old.humanRun.id);
  assert.equal(action(f, id).reason, "STOP_CONFIRMATION_REQUIRED");
  f.app.confirmStopped(old.humanRun.id, { confirmStopped: true });
  f.app.retryTask(id, { version: f.app.get("tasks", id).version });
  f.app.startHuman(id, { version: f.app.get("tasks", id).version });
  const current = f.app.get("tasks", id);
  assert.notEqual(old.humanRun.id, current.humanRun.id);
  assert.throws(() => f.app.finishHuman(id, { version: current.version, runId: old.humanRun.id, generation: old.humanRun.generation, summary: "Old form" }), { code: "STALE_HUMAN_RUN" });
  assert.equal(f.app.get("runs", current.humanRun.id).status, "RUNNING");
});

test("retry is unavailable for an uncertain run and agent execution/review cannot be moved by humans", (t) => {
  const f = fixture(t), p = plan(f, [node("worker", { reviewPolicy: "INDEPENDENT", reviewRoleId: "role-qa" })]);
  const claimed = f.app.claim(f.dev.agent.id, { taskId: p.tasks[0].id });
  assert.deepEqual(f.app.get("tasks", p.tasks[0].id).humanActions, []);
  f.app.store.put("runs", { ...f.app.get("runs", claimed.run.id), leaseUntil: 0 });
  f.app.maintenance({ documents: false, drift: false });
  assert.equal(action(f, p.tasks[0].id).reason, "STOP_CONFIRMATION_REQUIRED");
  assert.throws(() => f.app.retryTask(p.tasks[0].id, { version: f.app.get("tasks", p.tasks[0].id).version }), { code: "TASK_BUSY" });
  f.app.confirmStopped(claimed.run.id, { confirmStopped: true });
  const a = action(f, p.tasks[0].id); assert.equal(a.type, "RETRY_TASK"); assert.equal(a.enabled, true);
  f.app.retryTask(p.tasks[0].id, { version: a.taskVersion });
  const next = f.app.claim(f.dev.agent.id, { taskId: p.tasks[0].id }); finish(f, next);
  assert.equal(f.app.get("tasks", p.tasks[0].id).status, "REVIEWING"); assert.deepEqual(f.app.get("tasks", p.tasks[0].id).humanActions, []);
});

test("only the parent requirement exposes final acceptance, and file drift still fails the actual command", (t) => {
  const f = fixture(t), p = plan(f, [node("output")]);
  const run = f.app.claim(f.dev.agent.id, { taskId: p.tasks[0].id });
  fs.writeFileSync(path.join(f.p.root, "output.txt"), "frozen"); finish(f, run);
  assert.deepEqual(f.app.get("tasks", p.tasks[0].id).humanActions, []);
  const a = action(f, p.draft.id); assert.equal(a.type, "ACCEPT_PLAN"); assert.equal(a.enabled, true);
  fs.writeFileSync(path.join(f.p.root, "output.txt"), "changed");
  assert.throws(() => f.app.accept(a.acceptanceId, { version: a.acceptanceVersion, targetHash: a.targetHash }), { code: "APPROVAL_STALE" });
  assert.equal(f.app.get("tasks", p.draft.id).status, "AWAITING_ACCEPTANCE");
});

test("scoped human commands reject another project and board/list/detail share the same action projection", async (t) => {
  const f = await serverFixture(t), p = plan(f, [human("manual")]);
  const id = p.tasks[0].id, row = f.app.get("tasks", id);
  const board = f.app.taskBoard(f.p.id).columns.flatMap(c => c.items).find(t => t.id === id);
  assert.deepEqual(board.humanActions, row.humanActions);
  assert.deepEqual(f.app.list("tasks", { projectId: f.p.id }).items.find(t => t.id === id).humanActions, row.humanActions);
  const denied = await f.human(`/tasks/${id}/human-start?projectId=other`, { version: row.version }); assert.equal(denied.status, 404);
  const started = await f.human(`/tasks/${id}/human-start?projectId=${f.p.id}`, { version: row.version }); assert.equal(started.status, 200);
  const active = f.app.get("tasks", id);
  const completed = await f.human(`/tasks/${id}/human-complete?projectId=${f.p.id}`, { version: active.version, runId: active.humanRun.id, generation: active.humanRun.generation, summary: "Finished through HTTP", checks: [] });
  assert.equal(completed.status, 200); assert.equal(completed.body.task.status, "DONE");
});
