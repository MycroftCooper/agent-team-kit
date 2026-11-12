import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "../apps/backend/src/server.mjs";
import { createAgentClient } from "../packages/agent-client/src/index.mjs";
import { fixture, node, plan, finish, serverFixture } from "./helpers.mjs";
test("team resources are created by humans and discovered, read and invoked by agents", async (t) => {
  const f = await serverFixture(t);
  const client = createAgentClient({ baseUrl: f.url, credential: f.dev.credential });
  const cli = fileURLToPath(new URL("../apps/agent-cli/cli.mjs", import.meta.url));
  const launcher = fileURLToPath(new URL("../apps/launcher/cli.mjs", import.meta.url));
  const run = (args, input) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [cli, "resources", ...args], {
      cwd: f.p.root,
      env: { ...process.env, ATK_URL: f.url, ATK_AGENT_TOKEN: f.dev.credential },
      timeout: 5_000,
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(input);
  });
  assert.equal((await fetch(`${f.url}/api/agent/v1/resources`)).status, 401);
  const listing = (await f.human("/resources")).body;
  assert.deepEqual(Object.keys(listing.folders), ["agent", "skill", "mcp", "cli"]);
  const defaults = ["agent", "skill", "mcp", "cli", "automation"].map((kind) => `skill/atk-create-${kind}`)
    .concat(["skill/linus-review", "skill/linus-design-guard"]);
  const builtIns = (await client.request("/resources?kind=skill")).items;
  assert.deepEqual(builtIns.map((item) => item.id), defaults);
  for (const item of builtIns) {
    assert.ok(item.builtIn && item.description);
    const skill = await client.request(`/resources/${item.id}`);
    assert.equal(skill.content, fs.readFileSync(item.path, "utf8"));
  }
  assert.equal(fs.readdirSync(listing.folders.skill).length, 0);
  assert.deepEqual((await f.human("/resources/cli")).body.items.map((item) => item.command), ["atk --help", "atk-agent --help"]);
  const created = await f.human("/resources/skill", { name: "write-notes", content: "# Write notes\n" });
  assert.equal(created.status, 200);
  assert.equal((await f.human("/resources/skill", { name: "write-notes", content: "overwrite" })).status, 409);
  assert.equal((await f.human("/resources/cli", { name: "../escape", content: "no" })).status, 400);
  await assert.rejects(client.request("/resources/skill", { name: "injected", content: "no" }), { code: "NOT_FOUND" });
  assert.equal(JSON.parse(await run(["show", "skill/write-notes"])).content, "# Write notes\n");

  const toolDir = path.join(listing.folders.cli, "echo-args");
  fs.mkdirSync(toolDir);
  fs.writeFileSync(path.join(toolDir, "main.mjs"),
    'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), hasToken: Boolean(process.env.ATK_AGENT_TOKEN) }));');
  const pack = path.join(listing.folders.mcp, "local-echo");
  fs.mkdirSync(pack);
  fs.writeFileSync(path.join(pack, "mcp.json"), JSON.stringify({ transport: "stdio", command: "node", args: ["server.mjs"] }));
  fs.writeFileSync(path.join(pack, "server.mjs"), `
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const result = request.method === "initialize"
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } }
    : { content: [{ type: "text", text: request.params.arguments.message }] };
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}`);
  const external = path.join(f.root, "external");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "SKILL.md"), "Do not expose");
  fs.symlinkSync(external, path.join(listing.folders.skill, "outside"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(client.request("/resources/skill/outside"), { code: "RESOURCE_NOT_FOUND" });

  plan(f, [node("work")]);
  const claimed = await client.claim({ projectId: f.p.id, waitMs: 0 });
  assert.equal(claimed.spec.resources.command, "atk-agent resources list");
  const items = JSON.parse(await run(["list"])).items;
  assert.deepEqual(items.map((item) => item.id), [...defaults, "skill/write-notes", "mcp/local-echo", "cli/atk", "cli/atk-agent", "cli/echo-args"]);
  for (const [kind, name, entry] of [
    ["skill", "atk-create-cli", "SKILL.md"], ["skill", "linus-review", "SKILL.md"],
    ["skill", "linus-design-guard", "SKILL.md"], ["cli", "atk", "main.mjs"],
  ]) {
    const route = `/resources/${kind}/${name}`;
    const original = await f.human(route);
    assert.equal(original.status, 200);
    assert.equal(original.body.builtIn, true);
    assert.equal(original.body.scope, "global");
    if (name.startsWith("linus-"))
      assert.equal(JSON.parse(await run(["show", `skill/${name}`])).content, original.body.content);
    const override = "Do not let this local file replace the bundled resource";
    const blocked = await f.human(`/resources/${kind}`, { name, content: override });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "RESOURCE_READ_ONLY");
    for (const response of [await f.human(route, { content: override }, "PATCH"), await f.human(route, undefined, "DELETE")]) {
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, "RESOURCE_READ_ONLY");
    }
    const shadow = path.join(listing.folders[kind], name);
    fs.mkdirSync(shadow);
    fs.writeFileSync(path.join(shadow, entry), override);
    assert.equal((await client.request(`/resources?kind=${kind}`)).items.filter((item) => item.id === original.body.id).length, 1);
    assert.deepEqual(await client.request(route), original.body);
    assert.equal(fs.readFileSync(path.join(shadow, entry), "utf8"), override);
  }
  for (const [name, file] of [["atk", launcher], ["atk-agent", cli]]) {
    const help = await new Promise((resolve, reject) => execFile(process.execPath, [file, "--help"],
      (error, stdout) => error ? reject(error) : resolve(stdout.trimEnd())));
    assert.equal((await f.human(`/resources/cli/${name}`)).body.content, help);
  }
  await assert.rejects(run(["run", "cli/atk", "--", "--help"]), /Run atk directly/);
  assert.deepEqual(JSON.parse(await run(["run", "cli/echo-args", "--", "--flag", "with spaces", "x & y"])), {
    args: ["--flag", "with spaces", "x & y"], cwd: f.p.root, hasToken: false,
  });
  const calls = [
    { id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/call", params: { name: "echo", arguments: { message: "from the team" } } },
  ];
  const stdout = await run(["serve-mcp", "mcp/local-echo"], calls.map((call) => JSON.stringify({ jsonrpc: "2.0", ...call })).join("\n") + "\n");
  const replies = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(replies[0].result.serverInfo.name, "echo");
  assert.equal(replies[1].result.content[0].text, "from the team");
});
test("humans can update custom entries and move their complete resource folders to trash", async (t) => {
  const f = await serverFixture(t);
  const client = createAgentClient({ baseUrl: f.url, credential: f.dev.credential });
  const types = [
    ["agent", "# Initial profile\n", "# Updated profile\n"],
    ["skill", "# Initial skill\n", "# Updated skill\n"],
    ["mcp", '{"transport":"http","url":"https://example.test/mcp"}', '{"transport":"stdio","command":"node","args":["server.mjs"]}'],
    ["cli", 'console.log("initial");\n', 'console.log("updated");\n'],
  ];
  for (const [kind, initial, content] of types) {
    const created = await f.human(`/resources/${kind}`, { name: "custom", content: initial });
    assert.equal(created.status, 200);
    const file = created.body.path, directory = path.dirname(file), route = `/resources/${kind}/custom`;
    const support = path.join(directory, "support.txt");
    fs.writeFileSync(support, "Supporting file");
    const old = (await f.human(route)).body;
    const external = kind === "mcp" ? "{invalid json" : "Changed outside ATK";
    fs.writeFileSync(file, external);
    assert.equal((await f.human(route, { revision: old.revision, content }, "PATCH")).body.error.code, "RESOURCE_CHANGED");
    assert.equal((await f.human(`${route}?revision=${old.revision}`, undefined, "DELETE")).body.error.code, "RESOURCE_CHANGED");
    const current = (await f.human(route)).body;
    assert.equal(current.content, external);
    if (kind === "mcp") {
      await assert.rejects(client.request(route), { code: "INVALID_MCP_RESOURCE" });
      assert.equal((await f.human(route, { revision: current.revision, content: external }, "PATCH")).body.error.code, "INVALID_MCP_RESOURCE");
    }
    await assert.rejects(client.request(route, { revision: current.revision, content }, "PATCH"), { code: "NOT_FOUND" });
    assert.equal((await f.human(route, { revision: current.revision, content }, "PATCH")).status, 200);
    assert.equal(fs.readFileSync(support, "utf8"), "Supporting file");
    const updated = await client.request(route);
    assert.equal(updated.content, content);
    if (kind === "mcp") assert.deepEqual(updated.config, { transport: "stdio", command: "node", args: ["server.mjs"] });
    const removeRoute = `${route}?revision=${updated.revision}`;
    await assert.rejects(client.request(removeRoute, undefined, "DELETE"), { code: "NOT_FOUND" });
    const removed = await f.human(removeRoute, undefined, "DELETE");
    assert.equal(removed.status, 200);
    assert.equal(fs.existsSync(directory), false);
    assert.equal(fs.readFileSync(path.join(removed.body.trashPath, path.basename(file)), "utf8"), content);
    assert.equal(fs.readFileSync(path.join(removed.body.trashPath, "support.txt"), "utf8"), "Supporting file");
    await assert.rejects(client.request(route), { code: "RESOURCE_NOT_FOUND" });
  }
});
test("a bug goes straight to its repair role, supports rework, and closes on human acceptance", async (t) => {
  const f = await serverFixture(t);
  const role = f.app.createRole({ name: "Bug fixer", function: "WORKER", instructions: "Reproduce and fix bugs", files: ["widget.txt"] });
  const team = f.app.get("teams", f.p.teamId);
  f.app.updateTeam(team.id, { version: team.version, roleIds: [...team.roleIds, role.id] });
  const identity = f.app.createAgent({ name: "Fixer", roleId: role.id, teamId: team.id });
  const fixer = createAgentClient({ baseUrl: f.url, credential: identity.credential });
  const body = { projectId: f.p.id, roleId: role.id, title: "Broken widget", description: "Opening a widget fails", acceptance: "Opening works" };
  assert.equal((await f.human("/bugs", { ...body, roleId: f.qa.agent.roleId })).body.error.code, "INVALID_BUG_ROLE");
  assert.equal((await f.human("/bugs", { ...body, files: ["other.txt"] })).body.error.code, "SCOPE_FORBIDDEN");
  const created = await f.human("/bugs", body);
  assert.equal(created.status, 200);
  const bug = created.body, scope = `?projectId=${f.p.id}`;
  assert.equal(bug.status, "READY");
  assert.equal(bug.planId, null);
  assert.deepEqual(bug.files, ["widget.txt"]);
  assert.deepEqual((await f.human(`/bugs${scope}&status=`)).body.items.map((item) => item.id), [bug.id]);
  assert.equal((await f.human(`/tasks${scope}`)).body.items.some((item) => item.id === bug.id), false);
  assert.equal(f.app.taskBoard(f.p.id).columns.flatMap((column) => column.items).some((item) => item.id === bug.id), false);
  assert.equal(f.app.claim(f.pm.agent.id, { taskId: bug.id }).run, null);
  assert.equal(f.app.claim(f.dev.agent.id, { taskId: bug.id }).run, null);

  const regular = plan(f, [node("widget")]);
  const writer = f.app.claim(f.dev.agent.id, { taskId: regular.tasks[0].id });
  assert.deepEqual((await fixer.claim({ kind: "BUG", waitMs: 0 })).waiting.map((item) => item.reason), ["FILE_LOCKED"]);
  finish(f, writer);
  const attempt = await fixer.claim({ kind: "BUG", waitMs: 0 });
  assert.equal(attempt.spec.taskKind, "BUG");
  assert.equal(attempt.spec.taskId, bug.id);
  const file = path.join(f.p.root, "widget.txt");
  fs.writeFileSync(file, "partial fix");
  const submit = (claim) => fixer.submit(claim.run.id, "result", { generation: claim.generation, stopped: true, outcome: "COMPLETED", summary: "Verified widget opens" });
  const first = (await submit(attempt)).task;
  assert.equal(first.status, "AWAITING_ACCEPTANCE");
  assert.equal(f.app.inbox(f.p.id).bugs[0].id, bug.id);
  assert.equal((await fixer.claim({ kind: "BUG", waitMs: 0 })).run, null);
  const reviewRoute = `/bugs/${bug.id}/review${scope}`;
  const rejection = { version: first.version, targetHash: first.resultHash, decision: "REJECT", reason: "Opening twice still fails" };
  await assert.rejects(fixer.request(reviewRoute, rejection), { code: "NOT_FOUND" });
  assert.equal((await f.human(reviewRoute, rejection)).body.status, "READY");
  const rework = await fixer.claim({ kind: "BUG", waitMs: 0 });
  assert.ok(rework.generation > attempt.generation);
  assert.equal(rework.spec.rework.summary, rejection.reason);
  assert.equal(rework.spec.rework.targetHash, first.resultHash);
  assert.equal((await fixer.request(rework.spec.rework.previousOutputRef.replace("/api/agent/v1", ""))).targetHash, first.resultHash);
  fs.writeFileSync(file, "fixed");
  const second = (await submit(rework)).task;
  const acceptance = { version: second.version, targetHash: second.resultHash, decision: "ACCEPT" };
  fs.writeFileSync(file, "edited after fix");
  assert.equal((await f.human(reviewRoute, acceptance)).body.error.code, "APPROVAL_STALE");
  fs.writeFileSync(file, "fixed");
  assert.equal((await f.human(reviewRoute, acceptance)).body.status, "DONE");
  assert.equal(f.app.inbox(f.p.id).bugs.length, 0);
  assert.equal((await fixer.claim({ kind: "BUG", waitMs: 0 })).run, null);
});
test("a bug with an expired repair lease cannot be requeued until the writer stops", (t) => {
  const f = fixture(t);
  const bug = f.app.createBug({ projectId: f.p.id, roleId: f.dev.agent.roleId, title: "Lease recovery", description: "Retry safely", files: ["a.txt"] });
  const claimed = f.app.claim(f.dev.agent.id, { kind: "BUG" });
  f.app.store.put("runs", { ...f.app.get("runs", claimed.run.id), leaseUntil: 0 });
  f.app.maintenance();
  const blocked = f.app.get("tasks", bug.id);
  assert.equal(blocked.status, "BLOCKED");
  assert.throws(() => f.app.retryTask(bug.id, { version: blocked.version }), { code: "TASK_BUSY" });
  f.app.confirmStopped(claimed.run.id, { confirmStopped: true });
  assert.equal(f.app.retryTask(bug.id, { version: f.app.get("tasks", bug.id).version }).status, "READY");
  assert.ok(f.app.claim(f.dev.agent.id, { kind: "BUG" }).generation > claimed.generation);
});
test("browser session and CSRF are distinct from agent credentials", async (t) => {
  const f = await serverFixture(t);
  assert.throws(() => createServer({ dataDir: f.data }), {
    code: "INSTANCE_ACTIVE",
  });
  assert.equal((await fetch(f.url + "/api/v1/projects")).status, 401);
  for (const headers of [
    {},
    { "x-atk-access": "incorrect" },
    { authorization: `Bearer ${f.pm.credential}` },
    { "x-atk-access": f.pm.credential, "sec-fetch-site": "same-origin" },
  ]) {
    const locked = await fetch(f.url + "/api/v1/session", { headers });
    assert.equal(locked.status, 401);
    const body = await locked.json();
    assert.equal(body.error.code, "UI_LOCKED");
    assert.equal(body.token, undefined);
    assert.equal(body.csrf, undefined);
  }
  assert.equal(
    (
      await fetch(f.url + "/api/v1/session", {
        headers: { origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  const rejected = await fetch(f.url + "/api/v1/tasks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-atk-token": f.session.token,
    },
    body: JSON.stringify({}),
  });
  assert.equal(rejected.status, 403);
  const response = await fetch(f.url + "/api/v1/plans/x/approve", {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.pm.credential}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(response.status, 401);
  const agents = await f.human("/agents");
  assert.ok(!JSON.stringify(agents.body).includes(f.pm.credential));
  assert.ok(!JSON.stringify(agents.body).includes("credentialHash"));
});

test("human assignment reserves execution for one eligible worker without bypassing dependencies", async (t) => {
  const f = await serverFixture(t);
  const { tasks } = plan(f, [
    node("human", { executorType: "HUMAN", files: [] }),
    node("worker", { deps: ["human"], reviewPolicy: "INDEPENDENT", reviewRoleId: "role-qa" }),
  ]);
  const manual = tasks[0], task = tasks[1], route = "/tasks/" + task.id + "/assignment";
  const other = f.app.createAgent({ name: "Second worker", roleId: "role-dev", teamId: "team-default" });
  const team = f.app.createTeam({ name: "Other team", roleIds: ["role-dev"] });
  const outsider = f.app.createAgent({ name: "Outside worker", roleId: "role-dev", teamId: team.id });
  const options = await f.human(route);
  assert.deepEqual(new Set(options.body.choices.map((a) => a.id)), new Set([f.dev.agent.id, other.agent.id]));
  for (const agentId of [f.pm.agent.id, f.qa.agent.id, outsider.agent.id]) {
    const response = await f.human(route, { version: task.version, agentId }, "PATCH");
    assert.equal(response.body.error.code, "ASSIGNEE_FORBIDDEN");
  }
  const unauthorized = await fetch(f.url + "/api/v1" + route, {
    method: "PATCH",
    headers: { authorization: `Bearer ${f.dev.credential}`, "content-type": "application/json" },
    body: JSON.stringify({ version: task.version, agentId: f.dev.agent.id }),
  });
  assert.equal(unauthorized.status, 401);
  const assigned = await f.human(route, { version: task.version, agentId: f.dev.agent.id }, "PATCH");
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.assignedAgentId, f.dev.agent.id);
  assert.equal((await f.human(route, { version: task.version, agentId: null }, "PATCH")).body.error.code, "VERSION_CONFLICT");
  assert.equal(f.app.claim(other.agent.id, { taskId: task.id }).run, null);
  assert.equal(f.app.claim(f.dev.agent.id, { taskId: task.id }).waiting[0].reason, "DEPENDENCIES");
  f.app.startHuman(manual.id, { version: manual.version });
  f.app.finishHuman(manual.id, { stopped: true, outcome: "COMPLETED", summary: "Ready", checks: [] });
  assert.equal(f.app.claim(other.agent.id, { taskId: task.id }).run, null);
  const run = f.app.claim(f.dev.agent.id, { taskId: task.id });
  assert.equal(run.run.agentId, f.dev.agent.id);
  const busy = await f.human(route, { version: f.app.get("tasks", task.id).version, agentId: other.agent.id }, "PATCH");
  assert.equal(busy.body.error.code, "TASK_BUSY");
  f.app.finishRun(f.dev.agent.id, run.run.id, {
    generation: run.generation, idempotencyKey: "assigned-delivery",
    stopped: true, outcome: "COMPLETED", summary: "Assigned work done", checks: [],
  });
  assert.equal(f.app.claim(f.qa.agent.id, { taskId: task.id }).run.agentId, f.qa.agent.id);
  assert.equal(f.app.store.events({ entityId: task.id }).filter((e) => e.type === "task.assignment_changed").length, 1);
});

test("revoked assignment waits for a human to clear it; no other agent takes over automatically", async (t) => {
  const f = await serverFixture(t);
  const { tasks: [task] } = plan(f, [node("reserved")]);
  const other = f.app.createAgent({ name: "Available worker", roleId: "role-dev", teamId: "team-default" });
  const route = "/tasks/" + task.id + "/assignment";
  const assigned = (await f.human(route, { version: task.version, agentId: f.dev.agent.id }, "PATCH")).body;
  f.app.revokeAgent(f.dev.agent.id);
  assert.equal(f.app.claim(other.agent.id, { taskId: task.id }).run, null);
  assert.equal(f.app.taskDispatch(task.id).code, "ASSIGNEE_UNAVAILABLE");
  const cleared = await f.human(route, { version: assigned.version, agentId: null }, "PATCH");
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.assignedAgentId, null);
  assert.equal(f.app.claim(other.agent.id, { taskId: task.id }).run.agentId, other.agent.id);
});

test("board separates drafts from ready tasks and paginates each column independently", async (t) => {
  const f = await serverFixture(t);
  const { tasks } = plan(f, [node("manual", { executorType: "HUMAN", files: [] }), node("worker")]);
  for (let i = 0; i < 23; i++)
    f.app.createDraft({ projectId: f.p.id, title: "Queue item " + i, description: "Pending planning" });
  const route = "/tasks/board?projectId=" + f.p.id;
  const { body: first } = await f.human(route);
  assert.deepEqual(first.columns.slice(0, 2).map((c) => [c.key, c.total]), [["draft", 23], ["queue", 3]]);
  assert.equal(first.columns[0].items.length, 20);
  assert.ok(first.columns[0].items.every((task) => task.status === "DRAFT"));
  assert.ok(first.columns[1].items.every((task) => task.status === "READY"));
  assert.equal(first.columns[0].nextCursor, 20);
  const { body: later } = await f.human(route + "&cursor.draft=20");
  assert.equal(later.columns[0].items.length, 3);
  assert.equal(later.columns[0].previousCursor, 0);
  assert.equal(later.columns[1].offset, 0);
  const { body: owners } = await f.human(route + "&group=owner");
  assert.deepEqual(owners.columns.map((c) => c.total), [1, 1, 24]);
  assert.deepEqual(owners.columns[0].items.map((task) => task.id), [tasks[0].id]);
  const { body: filtered } = await f.human(route + "&group=owner&owner=REQUEST&q=Queue%20item%2022");
  assert.equal(filtered.columns.length, 1);
  assert.equal(filtered.columns[0].total, 1);
  const { body: view } = await f.human(route + "&group=swimlane&hidden=closed&cursor.REQUEST.draft=10&progress=1");
  assert.deepEqual(view.lanes.map((lane) => lane.key), ["HUMAN", "AGENT", "REQUEST"]);
  assert.equal(view.lanes[0].columns[1].items[0].id, tasks[0].id);
  assert.equal(view.lanes[0].columns[0].offset, 0);
  assert.equal(view.lanes[2].columns[0].offset, 10);
  assert.ok(view.lanes.every((lane) => !lane.columns.some((column) => column.key === "closed")));
  const { body: parents } = await f.human(route + "&children=0&q=Feature&progress=1");
  const readyParents = parents.columns.find((column) => column.key === "queue");
  assert.equal(readyParents.total, 1);
  assert.deepEqual(readyParents.items[0].subtaskProgress, { total: 2, verified: 0 });
  const { body: sorted } = await f.human(`/tasks?projectId=${f.p.id}&children=0&sort=title&direction=desc&q=Queue%20item&limit=3`);
  assert.equal(sorted.total, 23);
  assert.deepEqual(sorted.items.map((task) => task.title), ["Queue item 9", "Queue item 8", "Queue item 7"]);
});

test("doctor validates credentials without checking in or claiming work", async (t) => {
  const f = await serverFixture(t);
  const { agent, credential } = f.app.createAgent({
    name: "Unconnected worker", roleId: "role-dev", teamId: "team-default",
  });
  const before = f.app.get("agents", agent.id);
  const client = createAgentClient({ baseUrl: f.url, credential });
  const result = await client.doctor();
  assert.equal(result.identity.id, agent.id);
  assert.equal(result.identity.lastSeen, null);
  assert.equal(JSON.stringify(result).includes(credential), false);
  assert.deepEqual(f.app.get("agents", agent.id), before);
  assert.equal(f.app.list("runs").total, 0);
  await assert.rejects(createAgentClient({ baseUrl: f.url, credential: "wrong" }).doctor(), { code: "UNAUTHENTICATED" });
  await assert.rejects(createAgentClient({
    baseUrl: f.url, credential, fetchImpl: () => Promise.reject(new TypeError("Connection refused")),
  }).doctor(), { code: "SERVICE_UNREACHABLE" });
  await client.connect();
  assert.ok((await client.doctor()).identity.lastSeen);
  f.app.revokeAgent(agent.id);
  await assert.rejects(client.doctor(), { code: "UNAUTHENTICATED" });
});

test("task deadlines and tags are versioned, filter together, and do not change execution", async (t) => {
  const f = await serverFixture(t);
  const { plan: approved, tasks: [task] } = plan(f, [node("deadline")]);
  const run = f.app.claim(f.dev.agent.id, { taskId: task.id });
  const route = "/tasks/" + task.id + "/metadata?projectId=" + f.p.id;
  const running = f.app.get("tasks", task.id);
  assert.equal((await f.human(route, { version: running.version, dueDate: "2026-02-30" }, "PATCH")).body.error.code, "INVALID_DUE_DATE");
  const { body: updated, status } = await f.human(route, {
    version: running.version, dueDate: "2026-11-06", tags: ["UI", " UI ", "人工"],
  }, "PATCH");
  assert.equal(status, 200);
  assert.deepEqual(updated.tags, ["UI", "人工"]);
  assert.equal(updated.status, "RUNNING");
  assert.equal(f.app.get("plans", approved.id).version, approved.version);
  assert.equal(f.app.list("locks").total, 1);
  assert.equal((await f.human(route, { version: running.version, tags: [] }, "PATCH")).body.error.code, "VERSION_CONFLICT");

  const prefix = "?projectId=" + f.p.id;
  const { body: tags } = await f.human("/tasks/tags" + prefix);
  assert.deepEqual(tags.items, ["UI", "人工"]);
  const { body: matching } = await f.human("/tasks" + prefix + "&due=overdue&day=2026-11-07&tag=UI");
  assert.deepEqual(matching.items.map((item) => item.id), [task.id]);
  const { body: board } = await f.human("/tasks/board" + prefix + "&group=swimlane&due=on&day=2026-11-06&tag=UI");
  assert.deepEqual(board.lanes.find((lane) => lane.key === "AGENT").columns.find((col) => col.key === "running").items.map((item) => item.id), [task.id]);
  const { body: week } = await f.human("/tasks" + prefix + "&due=week&day=2026-10-31");
  assert.deepEqual(week.items.map((item) => item.id), [task.id]);
  assert.equal((await f.human("/tasks" + prefix + "&due=overdue")).status, 400);
  assert.equal((await f.human("/tasks" + prefix + "&due=none&tag=UI")).body.total, 0);
  f.app.finishRun(f.dev.agent.id, run.run.id, {
    generation: run.generation, idempotencyKey: "metadata-during-execution", stopped: true,
    outcome: "COMPLETED", summary: "Execution still completes", checks: [],
  });
  assert.equal((await f.human("/tasks" + prefix + "&due=overdue&day=2026-11-07")).body.total, 0);
  const latest = f.app.get("tasks", task.id);
  const { body: cleared } = await f.human(route, { version: latest.version, dueDate: null, tags: [] }, "PATCH");
  assert.equal(cleared.dueDate, null);
  assert.deepEqual(cleared.tags, []);
  assert.deepEqual((await f.human("/tasks/tags" + prefix)).body.items, []);
});

test("claim diagnostics distinguish readiness, locks, missing contact and capacity without making a claim", async (t) => {
  const f = await serverFixture(t);
  plan(f, [
    node("first"),
    node("second"),
    node("same", { files: ["first.txt"] }),
    node("dependent", { deps: ["first"] }),
  ]);
  const tasks = f.app.list("tasks").items;
  const route = (name) => "/tasks/" + tasks.find((task) => task.title === "Task " + name).id;
  const diagnostic = async (name) => (await f.human(route(name) + "/dispatch")).body;
  const worker = f.app.createAgent({ name: "Other worker", roleId: "role-dev", teamId: "team-default" });
  f.app.revokeAgent(f.dev.agent.id);
  assert.equal((await diagnostic("dependent")).code, "DEPENDENCIES");
  assert.equal((await diagnostic("second")).code, "NO_RECENT_AGENT");
  f.app.connect(worker.agent.id);
  assert.equal((await diagnostic("second")).code, "WAITING_FOR_CLAIM");
  const first = tasks.find((task) => task.title === "Task first");
  const claim = f.app.claim(worker.agent.id, { taskId: first.id });
  assert.equal((await diagnostic("same")).code, "FILE_LOCKED");
  const before = f.app.list("runs").total;
  assert.equal((await diagnostic("second")).code, "AGENT_CAPACITY");
  assert.equal(f.app.list("runs").total, before);
  assert.equal((await f.human(route("second"))).body.waiting, null);
  assert.equal((await f.human(route("second") + "?projectId=wrong")).status, 404);
  assert.equal((await f.human("/runs/" + claim.run.id + "/artifact?projectId=wrong")).status, 404);
  f.app.revokeAgent(worker.agent.id);
  assert.equal((await diagnostic("second")).code, "NO_MATCHING_AGENT");
  assert.equal(f.app.list("locks").total, 1);
});

test("HTTP clients race atomically, report receipts and replay idempotently", async (t) => {
  const f = await serverFixture(t);
  plan(f, [node("a")]);
  const extra = f.app.createAgent({
    name: "extra",
    roleId: "role-dev",
    teamId: "team-default",
  });
  const a = createAgentClient({ baseUrl: f.url, credential: f.dev.credential }),
    b = createAgentClient({ baseUrl: f.url, credential: extra.credential });
  const results = await Promise.all([
    a.claim({ waitMs: 0 }),
    b.claim({ waitMs: 0 }),
  ]);
  assert.equal(results.filter((r) => r.run).length, 1);
  const r = results.find((r) => r.run),
    client = r.run.agentId === f.dev.agent.id ? a : b;
  fs.writeFileSync(path.join(f.p.root, "a.txt"), "done");
  const output = await client.submit(r.run.id, "result", {
    generation: r.generation,
    idempotencyKey: "one",
    stopped: true,
    outcome: "COMPLETED",
    summary: "complete",
  });
  assert.equal(output.persisted, true);
  const second = await client.submit(r.run.id, "result", {
    generation: r.generation,
    idempotencyKey: "one",
    stopped: true,
    outcome: "COMPLETED",
    summary: "complete",
  });
  assert.equal(second.run.resultHash, output.run.resultHash);
});

test("a real submitted plan needs private web authorization and rework feedback is readable by its worker", async (t) => {
  const f = await serverFixture(t),
    dev = createAgentClient({ baseUrl: f.url, credential: f.dev.credential });
  const draft = f.app.createDraft({ projectId: f.p.id, title: "Protected approval", description: "x" });
  const planning = f.app.claim(f.pm.agent.id, { taskId: draft.id });
  const submitted = f.app.submitPlan(f.pm.agent.id, planning.run.id, {
    generation: planning.generation, idempotencyKey: "protected-plan",
    plan: { summary: "Protected plan", nodes: [node("a", { reviewPolicy: "INDEPENDENT", reviewRoleId: "role-qa" })] },
  });
  const blocked = await fetch(`${f.url}/api/v1/plans/${submitted.plan.id}/approve`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.pm.credential}` },
    body: JSON.stringify({ version: submitted.plan.version }),
  });
  assert.equal(blocked.status, 401);
  assert.equal(f.app.get("plans", submitted.plan.id).status, "SUBMITTED");
  const approved = await f.human(`/plans/${submitted.plan.id}/approve`, { version: submitted.plan.version });
  assert.equal(approved.status, 200);
  const worker = await dev.claim({ taskId: approved.body.tasks[0].id, waitMs: 0 });
  const delivered = await dev.submit(worker.run.id, "result", {
    generation: worker.generation, stopped: true, outcome: "COMPLETED", summary: "Candidate",
  });
  const reviewer = f.app.claim(f.qa.agent.id, {});
  f.app.submitReview(f.qa.agent.id, reviewer.run.id, {
    generation: reviewer.generation, idempotencyKey: "feedback", targetHash: delivered.task.resultHash,
    verdict: "CHANGES_REQUESTED", summary: "Fix empty input", findings: [{ message: "Empty input crashes" }],
  });
  const retry = await dev.claim({ waitMs: 0 });
  const feedback = await dev.request(retry.spec.rework.reviewRef.replace("/api/agent/v1", ""));
  assert.equal(feedback.review.findings[0].message, "Empty input crashes");
});
test("long poll waits without work and returns on a new eligible DRAFT", async (t) => {
  const f = await serverFixture(t),
    client = createAgentClient({ baseUrl: f.url, credential: f.pm.credential });
  const started = Date.now();
  const waiting = client.claim({ waitMs: 2000 });
  setTimeout(
    () =>
      f.app.createDraft({
        projectId: f.p.id,
        title: "new",
        description: "New work",
      }),
    150,
  );
  const result = await waiting;
  assert.ok(result.run);
  assert.ok(Date.now() - started >= 100);
});
test("SSE replays events by seq and marks invalid cursors for resync", async (t) => {
  const f = await serverFixture(t);
  async function seesEvent(cursor, expected) {
    const response = await fetch(f.url + "/api/v1/events/stream", {
      headers: { "x-atk-token": f.session.token, "last-event-id": cursor },
      signal: AbortSignal.timeout(3_000),
    });
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of response.body) {
      text += decoder.decode(chunk, { stream: true });
      if (text.includes(expected)) return true;
    }
    return false;
  }
  assert.ok(await seesEvent("0", "id:"));
  assert.ok(await seesEvent("99999999", "system.resync-required"));
});
