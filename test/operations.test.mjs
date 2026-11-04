import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture, node, plan, finish } from "./helpers.mjs";
import { backup, restore } from "../apps/backend/src/operations.mjs";
import { openStore } from "../packages/database/src/index.mjs";
test("multiple non-Git projects have independent artifacts and unavailable paths are isolated", (t) => {
  const f = fixture(t);
  const second = path.join(f.root, "second");
  fs.mkdirSync(second);
  const p = f.app.createProject({ name: "B", root: second });
  assert.throws(
    () => f.app.createProject({ name: "Duplicate", root: second }),
    { code: "PROJECT_EXISTS" },
  );
  f.app.createDraft({ projectId: p.id, title: "B", description: "B" });
  fs.renameSync(second, second + "-moved");
  assert.throws(
    () => f.app.createDraft({ projectId: p.id, title: "B", description: "B" }),
    { code: "PROJECT_UNAVAILABLE" },
  );
  assert.ok(
    f.app.createDraft({ projectId: f.p.id, title: "A", description: "A" }),
  );
  f.app.flushDocuments();
  assert.ok(f.app.list("materializations", { status: "FAILED" }).total > 0);
  f.app.updateProject(p.id, {
    version: p.version,
    root: second + "-moved",
    docsRoot: path.join(second + "-moved", ".agent-team"),
  });
  f.app.retryDocuments(p.id);
  assert.equal(f.app.list("materializations", { status: "FAILED" }).total, 0);
});
test("backup rejects live runs and restore preserves database and referenced artifacts", (t) => {
  const f = fixture(t);
  const p = plan(f, [node("a")]);
  const r = f.app.claim(f.dev.agent.id, {});
  assert.throws(() => backup(f.app, path.join(f.root, "busy-backup")), {
    code: "BACKUP_BUSY",
  });
  fs.writeFileSync(path.join(f.p.root, "a.txt"), "a");
  finish(f, r);
  f.app.flushDocuments();
  const target = path.join(f.root, "backup");
  backup(f.app, target);
  const original = f.app.list("tasks").total;
  f.app.createDraft({
    projectId: f.p.id,
    title: "Later",
    description: "Should not be in restored snapshot",
  });
  const restored = restore(f.app, target);
  assert.ok(restored.safetyBackup);
  assert.equal(f.app.list("tasks").total, original);
  assert.ok(
    fs.existsSync(path.join(f.p.docsRoot, "plans", p.plan.id + ".json")),
  );
});
test("tampered backups and legacy databases are refused", (t) => {
  const f = fixture(t),
    target = path.join(f.root, "backup");
  backup(f.app, target);
  fs.appendFileSync(path.join(target, "next.db"), "tamper");
  assert.throws(() => restore(f.app, target), { code: "INVALID_BACKUP" });
  const legacy = path.join(f.root, "old.db"),
    db = new DatabaseSync(legacy);
  db.exec("CREATE TABLE tasks(id TEXT)");
  db.close();
  assert.throws(() => openStore(legacy), { code: "LEGACY_DATABASE" });
});
