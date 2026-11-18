import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createAgentClient } from "../packages/agent-client/src/index.mjs";
import { fixture, serverFixture, node, plan, finish, completeHuman } from "./helpers.mjs";

const cancel = (f, id, more = {}) => {
  const impact = f.app.cancellation(id);
  return f.app.cancelTask(id, { version: impact.task.version, impactHash: impact.impactHash, reason: "No longer needed", ...more });
};
const archive = (f, id, archived = true) => f.app.archiveTask(id, { version: f.app.get("tasks", id).version, archived });
const manual = (key) => node(key, { executorType: "HUMAN", roleId: null, files: [] });

test("cancelling an unplanned requirement records a reason and prevents future planning", (t) => {
  const f = fixture(t), draft = f.app.createDraft({ projectId: f.p.id, title: "Abandoned", description: "Do not plan" });
  assert.throws(() => cancel(f, draft.id, { reason: " " }), { code: "VALIDATION_ERROR" });
  assert.equal(f.app.get("tasks", draft.id).status, "DRAFT");
  cancel(f, draft.id);
  assert.equal(f.app.get("tasks", draft.id).cancellation.reason, "No longer needed");
  assert.equal(f.app.claim(f.pm.agent.id, { taskId: draft.id }).run, null);
  assert.equal(f.app.cancellation(draft.id).reason, "TASK_CLOSED");
});

test("cancellation never releases locks or skips stopping a running or uncertain writer", (t) => {
  const f = fixture(t), p = plan(f, [node("live")]), id = p.tasks[0].id;
  const run = f.app.claim(f.dev.agent.id, { taskId: id });
  assert.equal(f.app.cancellation(p.draft.id).runs[0].id, run.run.id);
  assert.throws(() => cancel(f, id), { code: "STOP_CONFIRMATION_REQUIRED" });
  f.app.requestStop(run.run.id);
  assert.throws(() => cancel(f, p.draft.id), { code: "STOP_CONFIRMATION_REQUIRED" });
  assert.ok(f.app.list("locks").total > 0);
  f.app.store.put("runs", { ...f.app.get("runs", run.run.id), status: "QUARANTINED" });
  assert.throws(() => cancel(f, id), { code: "STOP_CONFIRMATION_REQUIRED" });
  f.app.confirmStopped(run.run.id, { confirmStopped: true });
  cancel(f, id);
  assert.equal(f.app.get("tasks", id).status, "CANCELLED");
  assert.equal(f.app.get("runs", run.run.id).status, "INTERRUPTED");
  assert.equal(f.app.list("locks").total, 0);
  assert.equal(f.app.claim(f.dev.agent.id, { taskId: id }).run, null);
});

test("single work cancellation includes transitive dependents, preserves unrelated work, and needs a revised plan", (t) => {
  const f = fixture(t), p = plan(f, [node("a"), node("b", { deps: ["a"] }), node("c", { deps: ["b"] }), node("other")]);
  const impact = f.app.cancellation(p.tasks[0].id);
  assert.deepEqual(new Set(impact.tasks.map(t => t.id)), new Set(p.tasks.slice(0, 3).map(t => t.id)));
  cancel(f, p.tasks[0].id);
  assert.ok(p.tasks.slice(0, 3).every(t => f.app.get("tasks", t.id).status === "CANCELLED"));
  assert.equal(f.app.get("tasks", p.tasks[3].id).status, "READY");
  finish(f, f.app.claim(f.dev.agent.id, { taskId: p.tasks[3].id }));
  assert.equal(f.app.get("tasks", p.draft.id).status, "BLOCKED");
  assert.equal(f.app.get("tasks", p.draft.id).blockReason, "TASK_CANCELLED");
  assert.equal(f.app.inbox(f.p.id).acceptances.length, 0);
  f.app.requestPlanRevision(p.plan.id, { version: f.app.get("plans", p.plan.id).version, reason: "Replace cancelled scope" });
  assert.equal(f.app.get("tasks", p.draft.id).status, "DRAFT");
});

test("cancellation is bound to the reviewed impact, not just the selected task version", (t) => {
  const f = fixture(t), p = plan(f, [node("a"), node("b", { deps: ["a"] })]);
  const impact = f.app.cancellation(p.tasks[0].id);
  f.app.updateTaskMetadata(p.tasks[1].id, { version: p.tasks[1].version, tags: ["changed"] });
  assert.throws(() => f.app.cancelTask(p.tasks[0].id, { version: impact.task.version, impactHash: impact.impactHash, reason: "Old preview" }), { code: "CANCELLATION_CHANGED" });
  assert.equal(f.app.get("tasks", p.tasks[0].id).status, "READY");
});

test("whole requirement cancellation supersedes approval and acceptance but preserves completed human work", (t) => {
  const f = fixture(t), p = plan(f, [manual("finished"), node("verified")]);
  f.app.startHuman(p.tasks[0].id, { version: p.tasks[0].version }); completeHuman(f, p.tasks[0].id, { summary: "Done" });
  finish(f, f.app.claim(f.dev.agent.id, { taskId: p.tasks[1].id }));
  const acceptance = f.app.inbox(f.p.id).acceptances[0]; assert.ok(acceptance);
  cancel(f, p.draft.id);
  assert.equal(f.app.get("tasks", p.tasks[0].id).status, "DONE");
  assert.equal(f.app.get("tasks", p.tasks[1].id).status, "CANCELLED");
  assert.equal(f.app.get("plans", p.plan.id).status, "SUPERSEDED");
  assert.equal(f.app.get("acceptances", acceptance.id).status, "SUPERSEDED");
  assert.throws(() => f.app.accept(acceptance.id, { version: acceptance.version, targetHash: acceptance.targetHash }));
  assert.throws(() => f.app.requestPlanRevision(p.plan.id, { version: f.app.get("plans", p.plan.id).version, reason: "Reopen" }), { code: "PLAN_STALE" });
  assert.throws(() => cancel(f, p.tasks[0].id), { code: "TASK_CLOSED" });
});

test("single verified work cancellation invalidates pending whole-plan acceptance", (t) => {
  const f = fixture(t), p = plan(f, [node("verified")]); finish(f, f.app.claim(f.dev.agent.id, { taskId: p.tasks[0].id }));
  const acceptance = f.app.inbox(f.p.id).acceptances[0]; cancel(f, p.tasks[0].id);
  assert.equal(f.app.get("acceptances", acceptance.id).status, "SUPERSEDED");
  assert.equal(f.app.get("tasks", p.draft.id).status, "BLOCKED");
});

test("archiving a closed requirement groups its children and restoring preserves independent archives and status", (t) => {
  const f = fixture(t), p = plan(f, [node("one"), node("two")]);
  assert.throws(() => archive(f, p.draft.id), { code: "TASK_NOT_CLOSED" });
  cancel(f, p.draft.id); archive(f, p.tasks[0].id); archive(f, p.draft.id);
  assert.equal(f.app.taskBoard(f.p.id).columns.reduce((n,c) => n + c.total, 0), 0);
  assert.equal(f.app.taskHistory(f.p.id, { archive: "only" }).total, 3);
  assert.throws(() => archive(f, p.tasks[1].id, false), { code: "RESTORE_PARENT_FIRST" });
  archive(f, p.draft.id, false);
  assert.ok(f.app.get("tasks", p.tasks[0].id).archivedAt);
  assert.equal(f.app.get("tasks", p.tasks[1].id).archivedAt, null);
  assert.equal(f.app.get("tasks", p.draft.id).status, "CANCELLED");
  assert.equal(f.app.claim(f.dev.agent.id).run, null);
  assert.equal(f.app.taskHistory(f.p.id, { archive: "only" }).total, 1);
  archive(f, p.tasks[0].id, false);
  assert.equal(f.app.taskHistory(f.p.id, { archive: "only" }).total, 0);
});

test("archived projects expose history without being restored and deny record mutation", (t) => {
  const f = fixture(t), p = plan(f, [node("one")]); cancel(f, p.draft.id); archive(f, p.draft.id);
  f.app.updateProject(f.p.id, { version: f.app.get("projects", f.p.id).version, archived: true });
  assert.equal(f.app.taskHistory(f.p.id, { archive: "all" }).total, 2);
  assert.throws(() => archive(f, p.draft.id, false), { code: "PROJECT_ARCHIVED" });
  assert.throws(() => cancel(f, p.draft.id), { code: "PROJECT_ARCHIVED" });
  assert.throws(() => f.app.updateTaskMetadata(p.tasks[0].id, { version: f.app.get("tasks", p.tasks[0].id).version, tags: ["edit"] }), { code: "PROJECT_ARCHIVED" });
});

test("human HTTP archive, history, and cancellation remain scoped and preserve old receipts", async (t) => {
  const f = await serverFixture(t), p = plan(f, [manual("one")]);
  f.app.startHuman(p.tasks[0].id, { version: p.tasks[0].version }); completeHuman(f, p.tasks[0].id, { summary: "Retained receipt" });
  const id = p.tasks[0].id, runId = f.app.get("tasks", id).latestRunId;
  const foreign = await f.human(`/tasks/${id}/archive?projectId=other`, { version: f.app.get("tasks", id).version, archived: true }); assert.equal(foreign.status, 404);
  const saved = await f.human(`/tasks/${id}/archive?projectId=${f.p.id}`, { version: f.app.get("tasks", id).version, archived: true }); assert.equal(saved.status, 200);
  const rows = await f.human(`/tasks/history?projectId=${f.p.id}&archive=only`); assert.equal(rows.body.items[0].id, id);
  assert.equal((await f.human(`/tasks?projectId=${f.p.id}`)).body.items.some(t => t.id === id), false);
  assert.equal((await f.human(`/tasks?projectId=${f.p.id}&parentId=${p.draft.id}`)).body.items.some(t => t.id === id), true);
  assert.equal(f.app.get("runs", runId).artifact.summary, "Retained receipt");
  const denied = await f.human(`/tasks/${p.draft.id}/cancel?projectId=other`, {}); assert.equal(denied.status, 404);
  assert.equal((await f.human(`/tasks/history?projectId=${f.p.id}&archive=invalid`)).status, 400);
  const other = f.app.createProject({ name: "Other", root: fs.mkdtempSync(path.join(f.root, "history-other-")) });
  assert.equal(f.app.taskHistory(other.id, { archive: "all" }).total, 0);
  const client = createAgentClient({ baseUrl: f.url, credential: f.dev.credential });
  await assert.rejects(client.request(`/tasks/${id}/cancel`, { version: 1, reason: "Agent cannot cancel" }), { code: "NOT_FOUND" });
});

test("a planning run must stop before cancellation and a submitted plan cannot revive a cancelled requirement", (t) => {
  const f = fixture(t), draft = f.app.createDraft({ projectId: f.p.id, title: "Planning cancellation", description: "Planning is active" });
  const run = f.app.claim(f.pm.agent.id, { taskId: draft.id });
  assert.throws(() => cancel(f, draft.id), { code: "STOP_CONFIRMATION_REQUIRED" });
  f.app.requestStop(run.run.id); f.app.confirmStopped(run.run.id, { confirmStopped: true }); cancel(f, draft.id);
  assert.equal(f.app.get("tasks", draft.id).status, "CANCELLED");
  const next = f.app.createDraft({ projectId: f.p.id, title: "Submitted cancellation", description: "Ready for approval" });
  const planning = f.app.claim(f.pm.agent.id, { taskId: next.id });
  const submitted = f.app.submitPlan(f.pm.agent.id, planning.run.id, { generation: planning.generation, idempotencyKey: "submit-once", plan: { summary: "Will not be approved", nodes: [node("unused")] } });
  cancel(f, next.id);
  assert.throws(() => f.app.approvePlan(submitted.plan.id, { version: f.app.get("plans", submitted.plan.id).version }), { code: "PLAN_NOT_SUBMITTED" });
  assert.equal(f.app.list("tasks", { parentId: next.id }).total, 0);
});

test("a running downstream execution blocks cancelling its already verified dependency", (t) => {
  const f = fixture(t), p = plan(f, [node("upstream"), node("downstream", { deps: ["upstream"] })]);
  finish(f, f.app.claim(f.dev.agent.id, { taskId: p.tasks[0].id }));
  const running = f.app.claim(f.dev.agent.id, { taskId: p.tasks[1].id });
  assert.equal(f.app.cancellation(p.tasks[0].id).runs[0].id, running.run.id);
  assert.throws(() => cancel(f, p.tasks[0].id), { code: "STOP_CONFIRMATION_REQUIRED" });
  assert.equal(f.app.get("tasks", p.tasks[0].id).status, "VERIFIED");
  assert.ok(f.app.list("locks").total > 0);
});

test("cancelled bugs leave the repair queue and support archive history pagination", (t) => {
  const f = fixture(t);
  const bug = f.app.createBug({ projectId: f.p.id, title: "Obsolete bug", description: "Withdraw repair", roleId: "role-dev", files: ["bug.txt"] });
  cancel(f, bug.id); assert.equal(f.app.listBugs(f.p.id, { status: "CANCELLED" }).total, 1);
  assert.equal(f.app.claim(f.dev.agent.id, { taskId: bug.id, kind: "BUG" }).run, null);
  archive(f, bug.id); assert.equal(f.app.listBugs(f.p.id).total, 0);
  for (let i = 0; i < 51; i++) {
    const draft = f.app.createDraft({ projectId: f.p.id, title: `History ${i}`, description: "Closed history" });
    cancel(f, draft.id); archive(f, draft.id);
  }
  const page = f.app.taskHistory(f.p.id, { archive: "only", limit: 50 });
  assert.equal(page.total, 52); assert.equal(page.items.length, 50); assert.equal(page.nextCursor, 50);
  const last = f.app.taskHistory(f.p.id, { archive: "only", limit: 50, offset: 50 });
  assert.equal(last.items.length, 2); assert.equal(last.nextCursor, null);
  assert.equal(new Set([...page.items, ...last.items].map(t => t.id)).size, 52);
  assert.equal(f.app.taskHistory(f.p.id, { archive: "only", search: "Obsolete bug" }).items[0].id, bug.id);
});
