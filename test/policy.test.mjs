import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { normalizeScopes } from "../packages/domain/src/index.mjs";
import { fixture, node, plan, finish, projectForTeam } from "./helpers.mjs";
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
  const agent = f.app.createAgent({ projectId: projectForTeam(f, team.id).id,
    name: "Other",
    roleId: "role-dev",
    teamId: team.id,
  });
  assert.equal(f.app.claim(agent.agent.id, {}).run, null);
});

for (const { name, identity, stage, prepare } of [
  {
    name: "planning", identity: "pm", stage: "PLANNING",
    prepare: (f) => f.app.createDraft({ projectId: f.p.id, title: "Draft", description: "Plan this" }),
  },
  {
    name: "approved execution", identity: "dev", stage: "EXECUTION",
    prepare: (f) => plan(f, [node("a")]).tasks[0],
  },
  {
    name: "independent review", identity: "qa", stage: "REVIEW",
    prepare: (f) => {
      const { tasks } = plan(f, [node("a", { reviewPolicy: "INDEPENDENT", reviewRoleId: "role-qa" })]);
      finish(f, f.app.claim(f.dev.agent.id, { taskId: tasks[0].id }));
      return f.app.get("tasks", tasks[0].id);
    },
  },
  {
    name: "bug repair", identity: "dev", stage: "EXECUTION",
    prepare: (f) => f.app.createBug({
      projectId: f.p.id, roleId: "role-dev", title: "Bug", description: "Fix this", files: ["a.txt"],
    }),
  },
]) {
  test(`removing a team role blocks ${name} until the role is restored`, (t) => {
    const f = fixture(t), task = prepare(f), agent = f[identity].agent;
    const team = f.app.get("teams", agent.teamId);
    const role = f.app.get("roles", agent.roleId);
    if (task.planId) {
      f.app.updateRole(role.id, { version: role.version, instructions: "Updated for future plans" });
    }
    const removed = f.app.updateTeam(team.id, {
      version: team.version, roleIds: team.roleIds.filter((id) => id !== role.id),
    });
    const runs = f.app.list("runs").total, locks = f.app.list("locks").total;
    assert.throws(() => f.app.claim(agent.id, { taskId: task.id }), { code: "ROLE_FORBIDDEN", status: 403 });
    assert.equal(f.app.list("runs").total, runs);
    assert.equal(f.app.list("locks").total, locks);
    assert.equal(f.app.get("tasks", task.id).status, task.status);
    assert.equal(f.app.get("tasks", task.id).version, task.version);

    f.app.updateTeam(team.id, { version: removed.version, roleIds: team.roleIds });
    const claimed = f.app.claim(agent.id, { taskId: task.id });
    assert.equal(claimed.run.taskId, task.id);
    assert.equal(claimed.run.stage, stage);
    assert.ok(claimed.spec.instructions.startsWith(role.instructions));
  });
}

test("removed worker roles are excluded from assignment and dispatch", (t) => {
  const f = fixture(t), { tasks } = plan(f, [node("a")]);
  const task = f.app.assignTask(tasks[0].id, { version: tasks[0].version, agentId: f.dev.agent.id });
  const team = f.app.get("teams", "team-default");
  const removed = f.app.updateTeam(team.id, {
    version: team.version, roleIds: team.roleIds.filter((id) => id !== "role-dev"),
  });
  assert.deepEqual(f.app.taskAssignment(task.id).choices, []);
  assert.equal(f.app.taskDispatch(task.id).code, "ASSIGNEE_UNAVAILABLE");
  const cleared = f.app.assignTask(task.id, { version: task.version, agentId: null });
  assert.equal(f.app.taskDispatch(task.id).code, "NO_MATCHING_AGENT");
  assert.throws(
    () => f.app.assignTask(task.id, { version: cleared.version, agentId: f.dev.agent.id }),
    { code: "ASSIGNEE_FORBIDDEN" },
  );
  f.app.updateTeam(team.id, { version: removed.version, roleIds: team.roleIds });
  assert.deepEqual(f.app.taskAssignment(task.id).choices.map((a) => a.id), [f.dev.agent.id]);
  assert.equal(f.app.taskDispatch(task.id).code, "WAITING_FOR_CLAIM");
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
