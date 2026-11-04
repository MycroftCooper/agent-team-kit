import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture, node, plan, finish } from "./helpers.mjs";
import { openStore } from "../packages/database/src/index.mjs";
test("literal prototype-like filenames are tracked through creation and deletion", (t) => {
  const f = fixture(t);
  const p = plan(f, [
    node("a", { files: ["__proto__"] }),
    node("b", { files: ["__proto__"], deps: ["a"] }),
  ]);
  let c = f.app.claim(f.dev.agent.id, {});
  fs.writeFileSync(path.join(f.p.root, "__proto__"), "literal file");
  finish(f, c);
  assert.equal(f.app.artifact(c.run.id).after.__proto__.text, "literal file");
  c = f.app.claim(f.dev.agent.id, {});
  fs.unlinkSync(path.join(f.p.root, "__proto__"));
  finish(f, c);
  assert.equal(f.app.artifact(c.run.id).after.__proto__.hash, null);
  const a = f.app.list("acceptances").items.find((a) => a.status === "PENDING");
  assert.ok(Object.hasOwn(a.files, "__proto__"));
  f.app.accept(a.id, { version: a.version, targetHash: a.targetHash });
  assert.equal(f.app.get("tasks", p.draft.id).status, "DONE");
});
test("claim and status omit file contents; verified receipts are available on demand", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.p.root, "a.txt"), "original private content");
  plan(f, [node("a")]);
  const c = f.app.claim(f.dev.agent.id, {});
  assert.ok(!JSON.stringify(c).includes("original private content"));
  fs.writeFileSync(path.join(f.p.root, "a.txt"), "new candidate");
  const result = finish(f, c);
  assert.ok(!JSON.stringify(result).includes("original private content"));
  const artifact = f.app.artifact(c.run.id);
  assert.equal(artifact.before["a.txt"].text, "original private content");
  assert.equal(artifact.after["a.txt"].text, "new candidate");
  assert.ok(
    !JSON.stringify(f.app.runStatus(c.run.id)).includes("new candidate"),
  );
  const file = path.join(f.p.docsRoot, "runs", c.run.id, "receipt.json");
  const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  receipt.summary = "tampered";
  fs.writeFileSync(file, JSON.stringify(receipt));
  assert.throws(() => f.app.artifact(c.run.id), { code: "ARTIFACT_MODIFIED" });
  const a = f.app.list("acceptances").items.find((a) => a.status === "PENDING");
  assert.throws(
    () => f.app.accept(a.id, { version: a.version, targetHash: a.targetHash }),
    { code: "ARTIFACT_MODIFIED" },
  );
});
test("same real file in nested registered projects shares one lock namespace", (t) => {
  const f = fixture(t),
    nested = path.join(f.p.root, "nested");
  fs.mkdirSync(nested);
  const inner = f.app.createProject({ name: "Inner", root: nested });
  const outerPlan = plan(f, [node("a", { files: ["nested/shared.txt"] })]),
    innerPlan = plan({ ...f, p: inner }, [
      node("b", { files: ["shared.txt"] }),
    ]);
  const other = f.app.createAgent({
    name: "Other worker",
    roleId: "role-dev",
    teamId: "team-default",
  });
  f.app.claim(f.dev.agent.id, { taskId: outerPlan.tasks[0].id });
  const waiting = f.app.claim(other.agent.id, {
    taskId: innerPlan.tasks[0].id,
  });
  assert.equal(waiting.run, null);
  assert.equal(waiting.waiting[0].reason, "FILE_LOCKED");
});
test("final drift revalidates the latest writer without undoing verified ancestors", (t) => {
  const f = fixture(t),
    p = plan(f, [
      node("a", { files: ["shared.txt"] }),
      node("b", { files: ["shared.txt"], deps: ["a"] }),
    ]);
  let c = f.app.claim(f.dev.agent.id, {});
  fs.writeFileSync(path.join(f.p.root, "shared.txt"), "one");
  finish(f, c);
  c = f.app.claim(f.dev.agent.id, {});
  fs.writeFileSync(path.join(f.p.root, "shared.txt"), "two");
  finish(f, c);
  const a = f.app.list("acceptances").items.find((a) => a.status === "PENDING");
  fs.writeFileSync(path.join(f.p.root, "shared.txt"), "unplanned");
  f.app.revalidateAcceptance(a.id);
  assert.equal(f.app.get("tasks", p.tasks[0].id).status, "VERIFIED");
  assert.equal(f.app.get("tasks", p.tasks[1].id).status, "BLOCKED");
});
test("legacy database refusal does not change its bytes or journal mode", (t) => {
  const f = fixture(t),
    file = path.join(f.root, "legacy.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE old_tasks(id TEXT)");
  db.close();
  const before = fs.readFileSync(file);
  assert.throws(() => openStore(file), { code: "LEGACY_DATABASE" });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.ok(!fs.existsSync(file + "-wal"));
});
test("lease watchers can observe an acknowledged terminal run without a false stop error", (t) => {
  const f = fixture(t);
  plan(f, [node("a")]);
  const c = f.app.claim(f.dev.agent.id, {});
  finish(f, c);
  assert.equal(
    f.app.heartbeat(f.dev.agent.id, c.run.id, { generation: c.generation })
      .finished,
    true,
  );
});
