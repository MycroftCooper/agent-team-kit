import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { normalizeScopes } from "../packages/domain/src/index.mjs";
import { fixture, node, plan, finish } from "./helpers.mjs";
test("Windows aliases, devices, wildcard scopes and metadata paths are refused", () => {
  for (const scope of [
    "a.txt:stream",
    "file.txt.",
    "folder ",
    "CON.txt",
    "aux",
    "src/*.js",
    "../out",
    "/root",
    "C:\\root",
    ".git/config",
    ".agent-team/x",
  ]) {
    assert.throws(() => normalizeScopes([scope]), undefined, scope);
  }
  assert.deepEqual(normalizeScopes(["src/", "a.txt", "a.txt"]), [
    "a.txt",
    "src/",
  ]);
});
test("approved role instructions are frozen and identity function cannot be changed", (t) => {
  const f = fixture(t);
  plan(f, [node("a")]);
  const r = f.app.get("roles", "role-dev"),
    original = r.instructions;
  f.app.updateRole(r.id, {
    version: r.version,
    instructions: "New instruction for future plans",
  });
  const c = f.app.claim(f.dev.agent.id, {});
  assert.equal(c.spec.instructions, original);
  assert.throws(
    () =>
      f.app.updateRole(r.id, {
        version: f.app.get("roles", r.id).version,
        function: "ORCHESTRATOR",
      }),
    { code: "ROLE_BUSY" },
  );
});
test("plan revisions return to DRAFT and carry human feedback to the PM", (t) => {
  const f = fixture(t),
    p = plan(f, [node("a")]);
  f.app.requestPlanRevision(p.plan.id, {
    version: p.plan.version,
    reason: "Add an accessibility check",
  });
  assert.equal(f.app.claim(f.dev.agent.id, {}).run, null);
  const next = f.app.claim(f.pm.agent.id, {});
  assert.equal(next.spec.revisionNote, "Add an accessibility check");
  assert.ok(next.spec.previousPlanRef);
});
test("revoking credentials stops new requests but retains active file locks", (t) => {
  const f = fixture(t);
  plan(f, [node("a")]);
  const c = f.app.claim(f.dev.agent.id, {});
  f.app.revokeAgent(f.dev.agent.id);
  assert.throws(() => f.app.authenticate(f.dev.credential), {
    code: "UNAUTHENTICATED",
  });
  assert.equal(f.app.get("runs", c.run.id).status, "STOP_REQUESTED");
  assert.equal(f.app.list("locks").total, 1);
  f.app.confirmStopped(c.run.id, { confirmStopped: true });
  assert.equal(f.app.list("locks").total, 0);
});
test("a team cannot claim another project's work", (t) => {
  const f = fixture(t);
  plan(f, [node("a")]);
  const team = f.app.createTeam({
    name: "Other team",
    roleIds: ["role-dev"],
    maxConcurrent: 2,
  });
  const agent = f.app.createAgent({
    name: "Other",
    roleId: "role-dev",
    teamId: team.id,
  });
  assert.equal(f.app.claim(agent.agent.id, {}).run, null);
});
test("projection failures are visible, persisted and retryable", (t) => {
  const f = fixture(t);
  f.app.createDraft({
    projectId: f.p.id,
    title: "Projection",
    description: "x",
  });
  const old = f.p.docsRoot;
  fs.renameSync(old, old + "-hidden");
  fs.writeFileSync(old, "not a directory");
  f.app.flushDocuments();
  assert.ok(f.app.list("materializations", { status: "FAILED" }).total);
  fs.unlinkSync(old);
  fs.renameSync(old + "-hidden", old);
  f.app.retryDocuments(f.p.id);
  assert.equal(f.app.list("materializations", { status: "FAILED" }).total, 0);
});
test("cancel/stop acknowledgement retains modified content and prevents stale results", (t) => {
  const f = fixture(t);
  plan(f, [node("a")]);
  const c = f.app.claim(f.dev.agent.id, {});
  fs.writeFileSync(path.join(f.p.root, "a.txt"), "unsaved candidate");
  f.app.requestStop(c.run.id);
  const response = f.app.heartbeat(f.dev.agent.id, c.run.id, {
    generation: c.generation,
  });
  assert.equal(response.stopRequired, true);
  assert.throws(() => finish(f, c), { code: "RUN_NOT_ACTIVE" });
  f.app.acknowledgeStop(f.dev.agent.id, c.run.id, {
    generation: c.generation,
    stopped: true,
  });
  assert.equal(
    fs.readFileSync(path.join(f.p.root, "a.txt"), "utf8"),
    "unsaved candidate",
  );
  assert.equal(f.app.list("locks").total, 0);
});
