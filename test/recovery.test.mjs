import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, node, plan, finish } from "./helpers.mjs";

test("a revised plan's acceptance is retired and cannot change the new planning state", (t) => {
  const f = fixture(t), p = plan(f, [node("a")]);
  const worker = f.app.claim(f.dev.agent.id, {});
  fs.writeFileSync(path.join(f.p.root, "a.txt"), "delivery");
  finish(f, worker);
  const a = f.app.inbox(f.p.id).acceptances[0];
  f.app.requestPlanRevision(p.plan.id, { version: p.plan.version, reason: "Change scope" });
  assert.equal(f.app.get("acceptances", a.id).status, "SUPERSEDED");
  assert.equal(f.app.inbox(f.p.id).acceptances.length, 0);
  // Existing installations may still have STALE records from older revisions.
  f.app.store.put("acceptances", { ...f.app.get("acceptances", a.id), status: "STALE" });
  assert.throws(() => f.app.revalidateAcceptance(a.id), { code: "APPROVAL_STALE" });
  assert.equal(f.app.get("tasks", p.draft.id).status, "DRAFT");
  assert.equal(f.app.inbox(f.p.id).acceptances.length, 0);
  assert.ok(f.app.claim(f.pm.agent.id, { taskId: p.draft.id }).run);
});

for (const empty of [true, false]) {
  test(`final acceptance checks directory scope locks (${empty ? "empty" : "populated"} directory)`, (t) => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.p.root, "src"));
    if (!empty) fs.writeFileSync(path.join(f.p.root, "src/first.txt"), "delivery");
    const p = plan(f, [node("a", { files: ["src/"] })]);
    finish(f, f.app.claim(f.dev.agent.id, { taskId: p.tasks[0].id }));
    const a = f.app.inbox(f.p.id).acceptances[0];
    const other = plan(f, [node("b", { files: ["src/new.txt"] })]);
    const writer = f.app.claim(f.dev.agent.id, { taskId: other.tasks[0].id });
    assert.throws(() => f.app.accept(a.id, { version: a.version, targetHash: a.targetHash }), { code: "FILE_LOCKED" });
    assert.equal(f.app.get("acceptances", a.id).status, "PENDING");
    f.app.requestStop(writer.run.id);
    f.app.acknowledgeStop(f.dev.agent.id, writer.run.id, { generation: writer.generation, stopped: true });
    f.app.accept(a.id, { version: a.version, targetHash: a.targetHash });
    assert.equal(f.app.get("tasks", p.draft.id).status, "DONE");
  });
}

test("rework specifications identify the rejected output and provide review feedback on demand", (t) => {
  const f = fixture(t);
  plan(f, [node("a", { reviewPolicy: "INDEPENDENT", reviewRoleId: "role-qa" })]);
  const worker = f.app.claim(f.dev.agent.id, {});
  fs.writeFileSync(path.join(f.p.root, "a.txt"), "candidate");
  const delivered = finish(f, worker);
  const reviewer = f.app.claim(f.qa.agent.id, {});
  f.app.submitReview(f.qa.agent.id, reviewer.run.id, {
    generation: reviewer.generation, idempotencyKey: "reject", targetHash: delivered.task.resultHash,
    verdict: "CHANGES_REQUESTED", summary: "Handle empty input", findings: [{ path: "a.txt", message: "Empty input crashes" }],
  });
  const retry = f.app.claim(f.dev.agent.id, {});
  assert.equal(retry.spec.rework.summary, "Handle empty input");
  assert.equal(retry.spec.rework.targetHash, delivered.task.resultHash);
  assert.equal(retry.spec.rework.reviewRef, `/api/agent/v1/runs/${reviewer.run.id}/artifact`);
  assert.equal(retry.spec.rework.previousOutputRef, `/api/agent/v1/runs/${worker.run.id}/artifact`);
  assert.equal(f.app.artifact(reviewer.run.id).review.findings[0].message, "Empty input crashes");
  assert.equal(retry.spec.rework.findings, undefined, "large findings stay on demand");
});

test("drift in human delivery can be requeued and accepted without replacing the plan", (t) => {
  const f = fixture(t), p = plan(f, [node("human", { executorType: "HUMAN", files: ["manual.txt"] })]);
  let task = p.tasks[0];
  f.app.startHuman(task.id, { version: task.version });
  fs.writeFileSync(path.join(f.p.root, "manual.txt"), "confirmed");
  f.app.finishHuman(task.id, { summary: "Confirmed" });
  const a = f.app.inbox(f.p.id).acceptances[0];
  fs.writeFileSync(path.join(f.p.root, "manual.txt"), "changed");
  f.app.maintenance();
  f.app.revalidateAcceptance(a.id);
  task = f.app.get("tasks", task.id);
  assert.equal(task.status, "BLOCKED");
  assert.equal(task.blockReason, "FINAL_TARGET_CHANGED");
  f.app.retryTask(task.id, { version: task.version });
  task = f.app.inbox(f.p.id).humanTasks[0];
  f.app.startHuman(task.id, { version: task.version });
  assert.throws(() => f.app.revalidateAcceptance(a.id), { code: "PLAN_BUSY" });
  f.app.finishHuman(task.id, { summary: "Reconfirmed changed output" });
  const next = f.app.inbox(f.p.id).acceptances[0];
  assert.notEqual(next.id, a.id);
  assert.equal(f.app.get("acceptances", a.id).status, "SUPERSEDED");
  f.app.accept(next.id, { version: next.version, targetHash: next.targetHash });
  assert.equal(f.app.get("tasks", p.draft.id).status, "DONE");
  assert.throws(() => f.app.revalidateAcceptance(a.id), { code: "APPROVAL_FINAL" });
});

test("legal downstream edits keep earlier human completion valid", (t) => {
  const f = fixture(t), p = plan(f, [
    node("human", { executorType: "HUMAN", files: ["shared.txt"] }),
    node("worker", { files: ["shared.txt"], deps: ["human"] }),
  ]);
  const human = p.tasks[0];
  f.app.startHuman(human.id, { version: human.version });
  fs.writeFileSync(path.join(f.p.root, "shared.txt"), "human");
  f.app.finishHuman(human.id, { summary: "Confirmed" });
  const worker = f.app.claim(f.dev.agent.id, {});
  fs.writeFileSync(path.join(f.p.root, "shared.txt"), "worker");
  finish(f, worker);
  fs.writeFileSync(path.join(f.p.root, "shared.txt"), "drift");
  f.app.revalidateAcceptance(f.app.inbox(f.p.id).acceptances[0].id);
  assert.equal(f.app.get("tasks", human.id).status, "DONE");
  assert.equal(f.app.get("tasks", worker.run.taskId).status, "BLOCKED");
});
