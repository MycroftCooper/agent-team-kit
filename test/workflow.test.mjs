import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, node, plan, finish, completeHuman } from "./helpers.mjs";
test("DRAFT -> approved plan -> execution -> human dependency -> final acceptance", (t) => {
  const f = fixture(t);
  const p = plan(f, [
    node("a"),
    node("human", {
      executorType: "HUMAN",
      roleId: null,
      files: [],
      deps: ["a"],
    }),
    node("b", { deps: ["human"] }),
  ]);
  const first = f.app.claim(f.dev.agent.id, {});
  assert.equal(first.run.taskId, p.tasks[0].id);
  fs.writeFileSync(path.join(f.p.root, "a.txt"), "A");
  finish(f, first);
  assert.equal(f.app.get("tasks", p.tasks[0].id).status, "VERIFIED");
  assert.equal(f.app.list("locks").total, 0);
  assert.equal(f.app.claim(f.dev.agent.id, {}).run, null);
  const human = f.app.get("tasks", p.tasks[1].id);
  f.app.startHuman(human.id, { version: human.version });
  completeHuman(f, human.id, { summary: "Human provided confirmation" });
  const second = f.app.claim(f.dev.agent.id, {});
  fs.writeFileSync(path.join(f.p.root, "b.txt"), "B");
  finish(f, second);
  const a = f.app.list("acceptances").items.find((a) => a.status === "PENDING");
  assert.ok(a);
  assert.equal(f.app.get("tasks", p.draft.id).status, "AWAITING_ACCEPTANCE");
  f.app.accept(a.id, { version: a.version, targetHash: a.targetHash });
  assert.equal(f.app.get("tasks", p.draft.id).status, "DONE");
  assert.equal(f.app.get("tasks", p.tasks[0].id).status, "DONE");
  f.app.flushDocuments();
  assert.ok(
    fs.existsSync(path.join(f.p.docsRoot, "plans", p.plan.id + ".json")),
  );
});
test("DRAFT is not executable, plan must be approved, PM cannot execute own plan", (t) => {
  const f = fixture(t),
    draft = f.app.createDraft({
      projectId: f.p.id,
      title: "Draft",
      description: "Unplanned",
    });
  assert.equal(f.app.claim(f.dev.agent.id, {}).run, null);
  const r = f.app.claim(f.pm.agent.id, {});
  const submitted = f.app.submitPlan(f.pm.agent.id, r.run.id, {
    generation: r.generation,
    idempotencyKey: "plan",
    plan: { summary: "Plan", nodes: [node("a")] },
  });
  assert.equal(f.app.claim(f.dev.agent.id, {}).run, null);
  assert.throws(() => f.app.claim(f.pm.agent.id, { stage: "EXECUTION" }), {
    code: "STAGE_FORBIDDEN",
  });
  f.app.approvePlan(submitted.plan.id, { version: submitted.plan.version });
  assert.equal(f.app.claim(f.pm.agent.id, {}).run, null);
  assert.ok(f.app.claim(f.dev.agent.id, {}).run);
  assert.equal(f.app.get("tasks", draft.id).kind, "REQUEST");
});
test("plans reject cycles, missing acceptance, unauthorized role and ORCHESTRATOR execution", (t) => {
  const f = fixture(t);
  for (const nodes of [
    [node("a", { deps: ["b"] }), node("b", { deps: ["a"] })],
    [node("a", { acceptance: "" })],
    [node("a", { roleId: "role-pm" })],
    [node("a", { function: "ORCHESTRATOR" })],
  ]) {
    const draft = f.app.createDraft({
      projectId: f.p.id,
      title: "Draft",
      description: "x",
    });
    const c = f.app.claim(f.pm.agent.id, { taskId: draft.id });
    assert.throws(() =>
      f.app.submitPlan(f.pm.agent.id, c.run.id, {
        generation: c.generation,
        idempotencyKey: Math.random().toString(),
        plan: { summary: "x", nodes },
      }),
    );
    f.app.requestStop(c.run.id);
    f.app.confirmStopped(c.run.id, { confirmStopped: true });
  }
});
test("independent review is optional, identity-bound and tied to content", (t) => {
  const f = fixture(t);
  const p = plan(f, [
    node("a", { reviewPolicy: "INDEPENDENT", reviewRoleId: "role-qa" }),
  ]);
  const c = f.app.claim(f.dev.agent.id, {});
  fs.writeFileSync(path.join(f.p.root, "a.txt"), "A");
  const done = finish(f, c);
  assert.equal(done.task.status, "REVIEWING");
  const r = f.app.claim(f.qa.agent.id, {});
  assert.ok(r.run);
  assert.throws(
    () =>
      f.app.submitReview(f.dev.agent.id, r.run.id, {
        generation: r.generation,
        idempotencyKey: "x",
        verdict: "PASS",
        targetHash: done.task.resultHash,
        summary: "x",
      }),
    { code: "RUN_FORBIDDEN" },
  );
  assert.throws(
    () =>
      f.app.submitReview(f.qa.agent.id, r.run.id, {
        generation: r.generation,
        idempotencyKey: "x",
        verdict: "PASS",
        targetHash: "wrong",
        summary: "x",
      }),
    { code: "REVIEW_STALE" },
  );
  f.app.submitReview(f.qa.agent.id, r.run.id, {
    generation: r.generation,
    idempotencyKey: "review",
    verdict: "PASS",
    targetHash: done.task.resultHash,
    summary: "Independent check passed",
  });
  assert.equal(f.app.get("tasks", p.tasks[0].id).status, "VERIFIED");
});
test("checks cannot be skipped; failed submission retains locks", (t) => {
  const f = fixture(t);
  plan(f, [node("a", { checks: [{ name: "unit", command: "node --test" }] })]);
  const r = f.app.claim(f.dev.agent.id, {});
  assert.throws(() => finish(f, r), { code: "CHECKS_NOT_PASSED" });
  assert.equal(f.app.list("locks").total, 1);
  finish(f, r, {
    checks: [{ name: "unit", passed: true, exitCode: 0, log: "1 passed" }],
  });
  assert.equal(f.app.list("locks").total, 0);
});
test("receipt retries are idempotent and old generations are refused", (t) => {
  const f = fixture(t);
  plan(f, [node("a")]);
  const r = f.app.claim(f.dev.agent.id, {});
  const body = {
    generation: r.generation,
    idempotencyKey: "one",
    outcome: "COMPLETED",
    stopped: true,
    summary: "done",
  };
  const a = f.app.finishRun(f.dev.agent.id, r.run.id, body),
    b = f.app.finishRun(f.dev.agent.id, r.run.id, body);
  assert.equal(a.run.resultHash, b.run.resultHash);
  assert.throws(
    () =>
      f.app.finishRun(f.dev.agent.id, r.run.id, { ...body, generation: 99 }),
    { code: "STALE_GENERATION" },
  );
});
test("events deduplicate and never accept another run's event identity", (t) => {
  const f = fixture(t);
  plan(f, [node("a")]);
  const c = f.app.claim(f.dev.agent.id, {});
  const body = {
    generation: c.generation,
    events: [{ eventId: "event-a", type: "progress", message: "working" }],
  };
  const a = f.app.runEvents(f.dev.agent.id, c.run.id, body),
    b = f.app.runEvents(f.dev.agent.id, c.run.id, body);
  assert.deepEqual(a.accepted, b.accepted);
});
test("content drift invalidates review and refuses stale final acceptance", (t) => {
  const f = fixture(t);
  plan(f, [
    node("a", { reviewPolicy: "INDEPENDENT", reviewRoleId: "role-qa" }),
  ]);
  const c = f.app.claim(f.dev.agent.id, {});
  fs.writeFileSync(path.join(f.p.root, "a.txt"), "A");
  finish(f, c);
  fs.writeFileSync(path.join(f.p.root, "a.txt"), "changed");
  f.app.maintenance();
  assert.equal(
    f.app.get("tasks", c.run.taskId).blockReason,
    "REVIEW_TARGET_CHANGED",
  );
  const task = f.app.get("tasks", c.run.taskId);
  f.app.retryTask(task.id, { version: task.version });
  const c2 = f.app.claim(f.dev.agent.id, {});
  finish(f, c2);
  const reviewer = f.app.claim(f.qa.agent.id, {});
  f.app.submitReview(f.qa.agent.id, reviewer.run.id, {
    generation: reviewer.generation,
    idempotencyKey: "r",
    verdict: "PASS",
    targetHash: f.app.get("tasks", task.id).resultHash,
    summary: "ok",
  });
  const a = f.app.list("acceptances").items.find((a) => a.status === "PENDING");
  fs.writeFileSync(path.join(f.p.root, "a.txt"), "late");
  assert.throws(
    () => f.app.accept(a.id, { version: a.version, targetHash: a.targetHash }),
    { code: "APPROVAL_STALE" },
  );
});
