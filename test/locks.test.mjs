import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, node, plan, finish } from "./helpers.mjs";
import { createService } from "../apps/backend/src/service.mjs";
test("different files execute concurrently while same file and directories wait", (t) => {
  const f = fixture(t);
  const p = plan(f, [
    node("a", { files: ["src/"] }),
    node("b", { files: ["src/x.txt"] }),
    node("c"),
  ]);
  const second = f.app.createAgent({
    name: "second",
    roleId: "role-dev",
    teamId: "team-default",
  });
  const c1 = f.app.claim(f.dev.agent.id, { taskId: p.tasks[0].id });
  const projection = f.app.get("tasks", p.tasks[1].id);
  assert.equal(projection.waiting.code, "FILE_LOCKED");
  assert.equal(projection.waiting.holders[0].agentName, "dev");
  assert.equal(projection.waiting.holders[0].runId, c1.run.id);
  assert.ok(c1.run);
  const c2 = f.app.claim(second.agent.id, {});
  assert.equal(f.app.get("tasks", c2.run.taskId).nodeKey, "c");
  finish(f, c1);
  const third = f.app.createAgent({
    name: "third",
    roleId: "role-dev",
    teamId: "team-default",
  });
  const c3 = f.app.claim(third.agent.id, {});
  assert.equal(f.app.get("tasks", c3.run.taskId).nodeKey, "b");
});
test("a duplicate claim cannot share a run; full scope is required", (t) => {
  const f = fixture(t);
  const p = plan(f, [node("a", { files: ["a.txt", "b.txt"] })]);
  assert.throws(() => f.app.claim(f.dev.agent.id, { files: ["a.txt"] }), {
    code: "SCOPE_MISMATCH",
  });
  assert.equal(f.app.list("locks").total, 0);
  const r = f.app.claim(f.dev.agent.id, {});
  assert.equal(f.app.list("locks").total, 2);
  const b = f.app.createAgent({
    name: "b",
    roleId: "role-dev",
    teamId: "team-default",
  });
  assert.equal(f.app.claim(b.agent.id, { taskId: p.tasks[0].id }).run, null);
  finish(f, r);
  assert.equal(f.app.list("locks").total, 0);
});
test("case aliases cannot bypass locks and path escape is refused", (t) => {
  const f = fixture(t);
  plan(f, [
    node("a", { files: ["File.txt"] }),
    node("b", { files: ["file.TXT"] }),
  ]);
  const b = f.app.createAgent({
    name: "b",
    roleId: "role-dev",
    teamId: "team-default",
  });
  f.app.claim(f.dev.agent.id, {});
  const result = f.app.claim(b.agent.id, {});
  assert.equal(result.run, null);
  assert.equal(result.waiting[0].reason, "FILE_LOCKED");
  const draft = f.app.createDraft({
      projectId: f.p.id,
      title: "Unsafe",
      description: "x",
    }),
    c = f.app.claim(f.pm.agent.id, { taskId: draft.id });
  assert.throws(
    () =>
      f.app.submitPlan(f.pm.agent.id, c.run.id, {
        generation: c.generation,
        idempotencyKey: "escape",
        plan: { summary: "bad", nodes: [node("e", { files: ["../outside"] })] },
      }),
    { code: "INVALID_PATH" },
  );
});
test("lease loss quarantines locks across restart; confirmed stop keeps edits", (t) => {
  const f = fixture(t);
  plan(f, [node("a")]);
  const c = f.app.claim(f.dev.agent.id, {});
  fs.writeFileSync(path.join(f.p.root, "a.txt"), "keep this");
  f.app.store.put("runs", { ...f.app.get("runs", c.run.id), leaseUntil: 0 });
  f.app.maintenance();
  assert.equal(f.app.get("runs", c.run.id).status, "QUARANTINED");
  assert.equal(f.app.list("locks").items[0].status, "QUARANTINED");
  f.app.close();
  const reopened = createService({ dataDir: f.data });
  try {
    assert.equal(reopened.list("locks").total, 1);
    reopened.confirmStopped(c.run.id, { confirmStopped: true });
    assert.equal(reopened.list("locks").total, 0);
    assert.equal(
      fs.readFileSync(path.join(f.p.root, "a.txt"), "utf8"),
      "keep this",
    );
  } finally {
    reopened.close();
  }
});
test("approved downstream edits preserve upstream VERIFIED history", (t) => {
  const f = fixture(t);
  const p = plan(f, [
    node("a", { files: ["shared.txt"] }),
    node("b", { files: ["shared.txt"], deps: ["a"] }),
  ]);
  const a = f.app.claim(f.dev.agent.id, {});
  fs.writeFileSync(path.join(f.p.root, "shared.txt"), "one");
  finish(f, a);
  const b = f.app.claim(f.dev.agent.id, {});
  fs.writeFileSync(path.join(f.p.root, "shared.txt"), "two");
  finish(f, b);
  assert.equal(f.app.get("tasks", p.tasks[0].id).status, "VERIFIED");
  const target = f.app
    .list("acceptances")
    .items.find((a) => a.status === "PENDING");
  f.app.accept(target.id, {
    version: target.version,
    targetHash: target.targetHash,
  });
  assert.equal(f.app.get("tasks", p.draft.id).status, "DONE");
});
test("new files inside a directory invalidate its review target", (t) => {
  const f = fixture(t);
  plan(f, [
    node("a", {
      files: ["src/"],
      reviewPolicy: "INDEPENDENT",
      reviewRoleId: "role-qa",
    }),
  ]);
  const c = f.app.claim(f.dev.agent.id, {});
  fs.mkdirSync(path.join(f.p.root, "src"));
  fs.writeFileSync(path.join(f.p.root, "src", "first.txt"), "one");
  finish(f, c);
  fs.writeFileSync(path.join(f.p.root, "src", "new.txt"), "two");
  f.app.maintenance();
  assert.equal(f.app.get("tasks", c.run.taskId).status, "BLOCKED");
});
