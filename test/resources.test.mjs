import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createAgentClient } from "../packages/agent-client/src/index.mjs";
import { backup, restore } from "../apps/backend/src/operations.mjs";
import { fixture, serverFixture, node, plan } from "./helpers.mjs";

const query = (p) => `scope=project&projectId=${encodeURIComponent(p.id)}`;
const options = (p) => ({ scope: "project", projectId: p.id });
function secondProject(f, more = {}) {
  const root = path.join(f.root, "second");
  fs.mkdirSync(root);
  return f.app.createProject({ name: "Second", root, docsRoot: "atk-data", ...more });
}
function cli(f, args, input) {
  const file = fileURLToPath(new URL("../apps/agent-cli/cli.mjs", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [file, "resources", ...args], {
      cwd: f.p.root,
      env: { ...process.env, ATK_URL: f.url, ATK_AGENT_TOKEN: f.dev.credential },
      timeout: 15_000, windowsHide: true,
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(input);
  });
}

test("all four resource kinds keep global and project entries separate through CRUD", async (t) => {
  const f = await serverFixture(t), p2 = secondProject(f);
  const client = createAgentClient({ baseUrl: f.url, credential: f.dev.credential });
  for (const [kind, entry, original, updated] of [
    ["agent", "AGENT.md", "# Agent", "# Updated agent"],
    ["skill", "SKILL.md", "# Skill", "# Updated skill"],
    ["mcp", "mcp.json", '{"transport":"http","url":"https://example.test/mcp"}', '{"transport":"stdio","command":"node","args":[]}'],
    ["cli", "main.mjs", 'console.log("first")', 'console.log("updated")'],
  ]) {
    const route = `/resources/${kind}/same`, scoped = `/project-resources/${f.p.id}/${kind}/same?scope=project`;
    const global = await f.human(`/resources/${kind}`, { name: "same", content: original });
    const local = await f.human(`/project-resources/${f.p.id}/${kind}`, { name: "same", content: original });
    const other = await f.human(`/resources/${kind}?${query(p2)}`, { name: "same", content: original });
    assert.equal(global.status, 200);
    assert.equal(local.status, 200);
    assert.equal(other.status, 200);
    assert.equal(global.body.scope, "global");
    assert.equal(local.body.scope, "project");
    assert.equal(local.body.projectId, f.p.id);
    assert.equal(local.body.path, path.join(f.p.docsRoot, "resources", kind, "same", entry));
    assert.equal(other.body.path, path.join(p2.docsRoot, "resources", kind, "same", entry));
    const listing = await client.request(`/project-resources/${f.p.id}?kind=${kind}`);
    assert.equal(listing.root, path.join(f.p.docsRoot, "resources"));
    assert.deepEqual(listing.items.map((item) => [item.id, item.scope, item.projectId]), [[`${kind}/same`, "project", f.p.id]]);
    const support = path.join(path.dirname(local.body.path), "reference.txt");
    fs.writeFileSync(support, "Keep this file");
    const before = (await f.human(scoped)).body;
    assert.equal((await client.request(`${route}?${query(f.p)}`)).content, original);
    assert.equal((await f.human(scoped, { revision: before.revision, content: updated }, "PATCH")).status, 200);
    assert.equal((await f.human(scoped, { revision: before.revision, content: original }, "PATCH")).body.error.code, "RESOURCE_CHANGED");
    assert.equal((await f.human(`${scoped}&revision=${before.revision}`, undefined, "DELETE")).body.error.code, "RESOURCE_CHANGED");
    assert.equal((await client.request(route)).content, original);
    await assert.rejects(client.request(`${route}?${query(p2)}`), { code: "PROJECT_FORBIDDEN" });
    assert.equal(fs.readFileSync(support, "utf8"), "Keep this file");
    const current = await client.request(`${route}?${query(f.p)}`);
    await assert.rejects(client.request(scoped, { revision: current.revision, content: original }, "PATCH"), { code: "NOT_FOUND" });
    await assert.rejects(client.request(`${scoped}&revision=${current.revision}`, undefined, "DELETE"), { code: "NOT_FOUND" });
    const removed = await f.human(`${scoped}&revision=${current.revision}`, undefined, "DELETE");
    assert.equal(removed.status, 200);
    assert.ok(removed.body.trashPath.startsWith(path.join(f.p.docsRoot, "resource-trash") + path.sep));
    assert.equal(fs.readFileSync(path.join(removed.body.trashPath, "reference.txt"), "utf8"), "Keep this file");
    await assert.rejects(client.request(`${route}?${query(f.p)}`), { code: "RESOURCE_NOT_FOUND" });
    assert.equal((await client.request(route)).content, original);
  }
});

test("project resource access validates scope, project grants and built-in reserved names", async (t) => {
  const f = await serverFixture(t);
  const team = f.app.createTeam({ name: "Other squad", roleIds: ["role-dev"] });
  const p2 = secondProject(f, { teamId: team.id });
  const client = createAgentClient({ baseUrl: f.url, credential: f.dev.credential });
  const outsider = f.app.createAgent({ projectId: p2.id, name: "Other", roleId: "role-dev", teamId: team.id });
  const otherClient = createAgentClient({ baseUrl: f.url, credential: outsider.credential });
  for (const suffix of ["scope=project", `projectId=${f.p.id}`, `scope=global&projectId=${f.p.id}`, "scope=unknown"]) {
    assert.equal((await f.human(`/resources/skill?${suffix}`)).body.error.code, "INVALID_RESOURCE_SCOPE");
    await assert.rejects(client.request(`/resources?${suffix}`), { code: "INVALID_RESOURCE_SCOPE" });
  }
  for (const route of ["/resources", "/resources/skill/secret"]) {
    await assert.rejects(client.request(`${route}?${query(p2)}`), { code: "PROJECT_FORBIDDEN" });
    await assert.rejects(otherClient.request(`${route}?${query(f.p)}`), { code: "PROJECT_FORBIDDEN" });
  }
  await assert.rejects(client.request(`/project-resources/${p2.id}`), { code: "PROJECT_FORBIDDEN" });
  await assert.rejects(otherClient.request(`/project-resources/${f.p.id}/skill/secret`), { code: "PROJECT_FORBIDDEN" });
  for (const suffix of ["scope=global", "scope=", "projectId=", `projectId=${p2.id}`]) {
    const route = `/project-resources/${f.p.id}?${suffix}`;
    assert.equal((await f.human(route)).body.error.code, "INVALID_RESOURCE_SCOPE");
    await assert.rejects(client.request(route), { code: "INVALID_RESOURCE_SCOPE" });
  }
  assert.equal(fs.existsSync(path.join(p2.docsRoot, "resources")), false);
  const secret = await f.human(`/resources/skill?${query(f.p)}`, { name: "secret", content: "Project only" });
  assert.equal(secret.status, 200);
  assert.equal((await client.request("/resources")).items.some((item) => item.name === "secret"), false);
  const originalTeam = f.app.get("teams", "team-default");
  f.app.updateTeam(originalTeam.id, { version: originalTeam.version, projectIds: [p2.id] });
  await assert.rejects(client.request(`/resources?${query(f.p)}`), { code: "PROJECT_FORBIDDEN" });
  for (const name of ["atk-create-skill", "linus-review", "linus-design-guard"]) {
    const builtin = `/resources/skill/${name}?${query(f.p)}`;
    assert.equal((await f.human(`/resources/skill?${query(f.p)}`, { name, content: "Override" })).body.error.code, "RESOURCE_READ_ONLY");
    const shadow = path.join(f.p.docsRoot, "resources", "skill", name);
    fs.mkdirSync(shadow);
    fs.writeFileSync(path.join(shadow, "SKILL.md"), "Override");
    assert.equal((await f.human(builtin)).body.error.code, "RESOURCE_NOT_FOUND");
    assert.equal((await f.human(`/resources/skill?${query(f.p)}`)).body.items.some((item) => item.builtIn || item.name === name), false);
    assert.equal((await f.human(builtin, { content: "Changed" }, "PATCH")).body.error.code, "RESOURCE_READ_ONLY");
    assert.equal((await f.human(builtin, undefined, "DELETE")).body.error.code, "RESOURCE_READ_ONLY");
  }
  const archived = f.app.get("projects", p2.id);
  f.app.updateProject(p2.id, { version: archived.version, archived: true });
  assert.equal((await f.human(`/resources?${query(p2)}`)).body.error.code, "PROJECT_ARCHIVED");
});

test("project CLI and stdio MCP require explicit scope and preserve their execution contexts", async (t) => {
  const f = await serverFixture(t), library = f.app.resourceLibrary(options(f.p));
  f.app.resources.create("cli", { name: "echo", content: 'console.log("global")' });
  library.create("cli", { name: "echo", content: 'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),hasToken:Boolean(process.env.ATK_AGENT_TOKEN)}))' });
  const mcp = library.create("mcp", { name: "echo", content: '{"transport":"stdio","command":"node","args":["server.mjs"]}' });
  fs.writeFileSync(path.join(path.dirname(mcp.path), "server.mjs"), `
    import { createInterface } from "node:readline";
    for await (const line of createInterface({input:process.stdin})) {
      const request=JSON.parse(line);
      console.log(JSON.stringify({jsonrpc:"2.0",id:request.id,result:{cwd:process.cwd(),hasToken:Boolean(process.env.ATK_AGENT_TOKEN)}}));
    }`);
  const flags = ["--scope", "project", "--project", f.p.id];
  assert.equal((await cli(f, ["run", "cli/echo"])).trim(), "global");
  assert.deepEqual(JSON.parse(await cli(f, ["run", "cli/echo", ...flags, "--", "--scope", "global", "a b", "x & y"])), {
    args: ["--scope", "global", "a b", "x & y"], cwd: f.p.root, hasToken: false,
  });
  const listing = JSON.parse(await cli(f, ["list", "--kind", "cli", ...flags]));
  assert.deepEqual(listing.items.map((item) => item.id), ["cli/echo"]);
  assert.equal(JSON.parse(await cli(f, ["show", "cli/echo", ...flags])).scope, "project");
  const reply = JSON.parse(await cli(f, ["serve-mcp", "mcp/echo", ...flags], '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'));
  assert.equal(reply.result.cwd, path.dirname(mcp.path));
  assert.equal(reply.result.hasToken, false);
  for (const args of [["list", "--project", f.p.id], ["list", "--scope", "project"], ["list", "--scope", "other"]])
    await assert.rejects(cli(f, args), /Use --scope project --project/);
  f.app.resources.create("cli", { name: "global-only", content: "console.log(1)" });
  await assert.rejects(cli(f, ["run", "cli/global-only", ...flags]), /Resource entry is missing/);
  plan(f, [node("a")]);
  const claimed = f.app.claim(f.dev.agent.id, {});
  assert.equal(claimed.spec.resources.command, "atk-agent resources list");
  assert.equal(claimed.spec.resources.project.ref, `/api/agent/v1/project-resources/${f.p.id}`);
  assert.equal(claimed.spec.resources.project.command, `atk-agent resources list --scope project --project ${f.p.id}`);
  assert.equal(f.app.connect(f.dev.agent.id).resources.command, "atk-agent resources list");
});

test("project resources follow custom docsRoot relocation and remain in backups", (t) => {
  const f = fixture(t), p2 = secondProject(f);
  const local = f.app.resourceLibrary(options(p2)).create("skill", { name: "notes", content: "Project notes" });
  const attachment = path.join(path.dirname(local.path), "reference.txt");
  fs.writeFileSync(attachment, "Original reference");
  f.app.resources.create("skill", { name: "notes", content: "Global notes" });
  const saved = backup(f.app, path.join(f.root, "backup"));
  assert.ok(saved.manifest.files[`projects/${p2.id}/resources/skill/notes/SKILL.md`]);
  fs.writeFileSync(local.path, "Changed");
  fs.writeFileSync(attachment, "Changed reference");
  restore(f.app, saved.destination);
  assert.equal(f.app.resourceLibrary(options(p2)).read("skill", "notes").content, "Project notes");
  assert.equal(fs.readFileSync(attachment, "utf8"), "Original reference");
  assert.equal(f.app.resources.read("skill", "notes").content, "Global notes");
  const moved = p2.root + "-moved";
  fs.renameSync(p2.root, moved);
  const current = f.app.get("projects", p2.id);
  f.app.updateProject(p2.id, { version: current.version, root: moved, docsRoot: path.join(moved, "atk-data") });
  const after = f.app.resourceLibrary(options(p2)).read("skill", "notes");
  assert.equal(after.path, path.join(moved, "atk-data", "resources", "skill", "notes", "SKILL.md"));
  assert.equal(after.content, "Project notes");
  assert.throws(() => f.app.resourceLibrary(options(p2)).create("skill", { name: "../escape", content: "No" }), { code: "INVALID_RESOURCE_NAME" });
});

test("project resources reject directory aliases and overlapping library ownership", (t) => {
  const f = fixture(t), p2 = secondProject(f);
  // Legacy or externally changed configuration must still fail closed at read time.
  const updated = f.app.store.put("projects", { ...p2, docsRoot: f.p.docsRoot });
  assert.throws(() => f.app.resourceLibrary(options(p2)), { code: "RESOURCE_PATH_CONFLICT" });
  f.app.store.put("projects", { ...updated, docsRoot: f.data });
  assert.throws(() => f.app.resourceLibrary(options(p2)), { code: "RESOURCE_PATH_CONFLICT" });
  const current = f.app.get("projects", p2.id);
  f.app.updateProject(p2.id, { version: current.version, docsRoot: path.join(p2.root, "atk-data") });
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  const symlinkType = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(outside, path.join(p2.docsRoot, "resources"), symlinkType);
  assert.throws(() => f.app.resourceLibrary(options(p2)), { code: "UNSAFE_RESOURCE_PATH" });
  fs.renameSync(f.p.docsRoot, f.p.docsRoot + "-moved");
  fs.symlinkSync(f.p.docsRoot + "-moved", f.p.docsRoot, symlinkType);
  assert.throws(() => f.app.resourceLibrary(options(f.p)), { code: "PROJECT_DATA_MOVED" });
});

test("resource ownership conflicts are rejected before changing project configuration", (t) => {
  const f = fixture(t), p2 = secondProject(f);
  f.app.resourceLibrary(options(f.p)).create("skill", { name: "existing", content: "Keep available" });
  const projectCount = f.app.list("projects").total;
  assert.throws(() => f.app.updateProject(p2.id, { version: p2.version, docsRoot: f.p.docsRoot }), { code: "RESOURCE_PATH_CONFLICT" });
  assert.deepEqual(f.app.get("projects", p2.id), p2);
  const thirdRoot = path.join(f.root, "third");
  fs.mkdirSync(thirdRoot);
  for (const docsRoot of [f.p.docsRoot, f.data, path.join(f.p.docsRoot, "resources", "nested")]) {
    assert.throws(() => f.app.createProject({ name: "Conflicting", root: thirdRoot, docsRoot }), { code: "RESOURCE_PATH_CONFLICT" });
    assert.equal(f.app.list("projects").total, projectCount);
  }
  assert.equal(f.app.resourceLibrary(options(f.p)).read("skill", "existing").content, "Keep available");
});

test("project CLI rejects legacy or mismatched response ownership before starting tools", async (t) => {
  const f = fixture(t), marker = path.join(f.p.root, "unexpected-run.txt");
  const script = path.join(f.p.root, "legacy.mjs");
  fs.writeFileSync(script, 'import fs from "node:fs"; fs.writeFileSync("unexpected-run.txt", "executed");');
  let ownership = {}, itemOwnership;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const item = {
      id: pathname.includes("/mcp/") ? "mcp/legacy" : "cli/legacy", content: "Legacy resource",
      path: script, config: { transport: "stdio", command: process.execPath, args: [script] },
      ...(itemOwnership ?? ownership),
    };
    const list = pathname.endsWith("/resources") || /\/project-resources\/[^/]+$/.test(pathname);
    const result = list ? { items: [item], ...ownership } : item;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const connected = { ...f, url: `http://127.0.0.1:${server.address().port}` };
  const flags = ["--scope", "project", "--project", f.p.id];
  for (const response of [{}, { scope: "global" }, { scope: "project", projectId: "another-project" }]) {
    ownership = response;
    for (const args of [["run", "cli/legacy"], ["serve-mcp", "mcp/legacy"], ["show", "cli/legacy"], ["list"]]) {
      await assert.rejects(cli(connected, [...args, ...flags]), /RESOURCE_SCOPE_MISMATCH/);
      assert.equal(fs.existsSync(marker), false);
    }
  }
  ownership = { scope: "project", projectId: f.p.id };
  itemOwnership = { scope: "project", projectId: "another-project" };
  await assert.rejects(cli(connected, ["list", ...flags]), /RESOURCE_SCOPE_MISMATCH/);
  ownership = {};
  itemOwnership = undefined;
  assert.equal(JSON.parse(await cli(connected, ["show", "cli/legacy"])).content, "Legacy resource");
  assert.equal(JSON.parse(await cli(connected, ["list"])).items.length, 1);
});
