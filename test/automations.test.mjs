import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, serverFixture } from "./helpers.mjs";
import { createService } from "../apps/backend/src/service.mjs";
import { createAgentClient } from "../packages/agent-client/src/index.mjs";
import { definition, strictJson } from "../apps/backend/src/automation-definition.mjs";
import { capture, resolveScope } from "../packages/project-files/src/index.mjs";
import { backup, restore } from "../apps/backend/src/operations.mjs";

const invoke = promisify(execFile), cli = path.resolve("apps/agent-cli/cli.mjs");
const terminal = run => !["STARTING", "RUNNING", "STOPPING"].includes(run.status);
async function until(read, predicate, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await delay(50); }
  throw new Error("Timed out waiting for automation");
}
const def = (script = 'console.log("passed")', more = {}) => ({ schemaVersion: 1, id: "checks", name: "Project checks", steps: [{ id: "test", name: "Tests", cli: "node", args: ["-e", script] }], ...more });
const apply = (f, d, expectedRevision = null) => f.app.automations.apply(f.p.id, d.id, { definition: d, expectedRevision });
const start = (f, flow, more = {}, actor) => f.app.automations.start(f.p.id, flow.id, { revision: flow.revision, idempotencyKey: crypto.randomUUID(), ...more }, actor);
const done = (f, runId) => until(() => f.app.automations.detail(f.p.id, runId), terminal);

test("definitions reject duplicate keys, unknown fields, invalid parameters and shell paths", () => {
  assert.throws(() => strictJson('{"id":"a","id":"b"}'), /Duplicate/);
  assert.throws(() => strictJson('{"a":{"x":1,"x":2}}'), /Duplicate/);
  assert.equal(strictJson('{"a":[],"b":{},"c":[{"x":1}]}').c[0].x, 1);
  const d = def();
  assert.equal(definition(d).steps[0].timeoutMs, 900000);
  for (const invalid of [ { ...d, extra: true }, { ...d, parameters: { x: { type: "string" } } },
    { ...d, parameters: { x: { type: "integer", default: 1.5 } } },
    { ...d, steps: [{ ...d.steps[0], cli: "node && echo" }] },
    { ...d, steps: [{ ...d.steps[0], args: ["${params.missing}"] }] },
    { ...d, steps: [{ ...d.steps[0], env: { SECRET: { fromEnv: "ATK_AGENT_TOKEN" } } }] },
    { ...d, steps: [{ ...d.steps[0], cwd: "../outside" }] },
    { ...d, trigger: { type: "git-commit", branch: "../bad" } } ]) assert.throws(() => definition(invalid));
});

test("configuration is project-owned, revision controlled, portable and excluded from task scopes", t => {
  const f = fixture(t);
  assert.deepEqual(f.app.automations.list(f.p.id).items, []);
  assert.equal(fs.existsSync(path.join(f.p.root, ".atk")), false);
  const configured = apply(f, def());
  const file = path.join(f.p.root, ".atk/automations/checks.json");
  assert.ok(fs.readFileSync(file, "utf8").includes('"schemaVersion": 1'));
  assert.ok(fs.readFileSync(path.join(f.p.root, ".atk/.gitignore"), "utf8").includes("/runs/"));
  assert.throws(() => apply(f, def(), null), { code: "REVISION_CONFLICT" });
  fs.writeFileSync(file, '{"id":"broken","id":"duplicate"}');
  const invalid = f.app.automations.list(f.p.id).items[0]; assert.equal(invalid.valid, false);
  assert.throws(() => f.app.automations.show(f.p.id, "checks"));
  const repaired = apply(f, def(), crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
  assert.equal(repaired.revision, configured.revision);
  assert.throws(() => resolveScope(f.p, ".atk/automations/checks.json"), { code: "MANAGED_PATH" });
  assert.equal(Object.keys(capture(f.p, ["."])).some(key => key.startsWith(".atk/")), false);
  const tables = f.app.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const table of ["automations", "automation_runs", "automation_trigger_states"]) assert.equal(tables.includes(table), false);
  const otherRoot = path.join(f.root, "portable"); fs.mkdirSync(otherRoot);
  fs.cpSync(path.join(f.p.root, ".atk/automations"), path.join(otherRoot, ".atk/automations"), { recursive: true });
  const p = f.app.createProject({ name: "Portable", root: otherRoot });
  assert.equal(f.app.automations.show(p.id, "checks").revision, configured.revision);
  assert.throws(() => resolveScope(f.p, "nested/.atk/automations/private.json"), { code: "MANAGED_PATH" });
});

test("execution reports progress, preserves argv, strips credentials, snapshots configuration and archives immutable reports", async t => {
  const f = fixture(t), api = f.app.automations;
  const script = `import fs from 'node:fs'; import path from 'node:path';
console.log(JSON.stringify({args:process.argv.slice(2),hasToken:Boolean(process.env.ATK_AGENT_TOKEN),cwd:process.cwd()}));
console.log('::atk::{"schemaVersion":1,"type":"progress","percent":40,"current":"rust-test"}');
console.log('::atk::{"schemaVersion":1,"type":"info","values":{"testsPassed":2}}');
while(!fs.existsSync('continue.txt')) await new Promise(r=>setTimeout(r,30));
fs.writeFileSync(path.join(process.env.ATK_OUTPUT_DIR,'report.json'),JSON.stringify({schemaVersion:1,runId:process.env.ATK_RUN_ID,stepId:process.env.ATK_STEP_ID,status:'passed',summary:'Two checks passed',checks:[{id:'rust-test',name:'Rust tests',status:'passed',durationMs:123}]}));
console.log('finished');`;
  fs.writeFileSync(path.join(f.p.root, "check.mjs"), script);
  const d = def("", { parameters: { mode: { type: "string", default: "quick" }, count: { type: "integer", default: 2, minimum: 1 } }, steps: [{ id: "test", name: "Tests", cli: "node", args: ["check.mjs", "${params.mode}", "${params.count}"], exports: [{ id: "report", path: "${step.dir}/output/report.json", kind: "file", required: true }], result: { protocol: "atk-ci-result/v1", exportId: "report" } }] });
  const flow = apply(f, d), args = 'a "quoted" value & $(no) ; %PATH%';
  const previousToken = process.env.ATK_AGENT_TOKEN;
  let run;
  try { process.env.ATK_AGENT_TOKEN = "test-credential-must-not-reach-ci"; run = await start(f, flow, { parameters: { mode: args } }, { type: "agent", agentId: f.dev.agent.id }); }
  finally { if (previousToken === undefined) delete process.env.ATK_AGENT_TOKEN; else process.env.ATK_AGENT_TOKEN = previousToken; }
  const running = await until(() => api.detail(f.p.id, run.runId), r => r.steps[0].progress.current === "rust-test");
  assert.equal(running.progress, 40); assert.equal(running.steps[0].info.testsPassed, 2);
  assert.equal(running.requestedBy.agentId, f.dev.agent.id);
  const log = api.logs(f.p.id, run.runId).items.map(i => i.text).join("");
  const observed = JSON.parse(log.split("\n")[0]); assert.deepEqual(observed.args, [args, "2"]); assert.equal(observed.hasToken, false);
  await assert.rejects(start(f, flow), { code: "AUTOMATION_BUSY" });
  const changed = apply(f, { ...d, name: "Changed after start" }, flow.revision);
  fs.writeFileSync(path.join(f.p.root, "continue.txt"), "go");
  const finished = await done(f, run.runId); assert.equal(finished.status, "SUCCEEDED"); assert.equal(finished.progress, 100);
  assert.equal(finished.name, "Project checks"); assert.equal(finished.definitionRevision, flow.revision); assert.notEqual(flow.revision, changed.revision);
  const artifact = api.file(f.p.id, run.runId, "test", "report");
  const original = fs.readFileSync(artifact.file, "utf8"); assert.equal(JSON.parse(original).runId, run.runId);
  fs.writeFileSync(path.join(f.p.root, finished.runPath, "steps/test/output/report.json"), "overwritten");
  assert.equal(fs.readFileSync(artifact.file, "utf8"), original);
  assert.equal(api.logs(f.p.id, run.runId).complete, true);
  assert.ok(api.events(f.p.id, run.runId).items.some(e => e.type === "step.progress"));
  api.remove(f.p.id, flow.id, changed.revision); assert.equal(api.detail(f.p.id, run.runId).status, "SUCCEEDED");
});

test("result protocol and required exports cannot turn failures or stale reports into success", async t => {
  const f = fixture(t);
  const cases = [
    { name: "nonzero", code: 'console.error("failure");process.exit(7)', expected: "NONZERO_EXIT" },
    { name: "exit-125", code: 'process.exit(125)', expected: "NONZERO_EXIT" },
    { name: "missing", code: "", report: true, expected: "EXPORT_MISSING" },
    { name: "failed-report", code: "status:'failed'", report: true, reportObject: true, expected: "CI_FAILED" },
    { name: "wrong-run", code: "status:'passed',runId:'old-run'", report: true, reportObject: true, expected: "RESULT_INVALID" },
    { name: "nonzero-passed", code: "status:'passed'", report: true, reportObject: true, exit: 3, expected: "NONZERO_EXIT" },
  ];
  for (const entry of cases) {
    const d = def(entry.reportObject ? `require('node:fs').writeFileSync(require('node:path').join(process.env.ATK_OUTPUT_DIR,'report.json'),JSON.stringify({schemaVersion:1,runId:process.env.ATK_RUN_ID,stepId:process.env.ATK_STEP_ID,${entry.code}}));process.exit(${entry.exit ?? 0})` : entry.code);
    d.id = entry.name;
    if (entry.report) { d.steps[0].exports = [{ id: "report", path: "${step.dir}/output/report.json", kind: "file", required: true }]; d.steps[0].result = { protocol: "atk-ci-result/v1", exportId: "report" }; }
    const flow = apply(f, d), run = await start(f, flow), finished = await done(f, run.runId);
    assert.equal(finished.status, "FAILED", entry.name); assert.equal(finished.error.code, entry.expected, entry.name);
  }
  fs.writeFileSync(path.join(f.p.root, "latest.json"), '{"ok":true}');
  const stale = def("", { id: "stale", steps: [{ id: "test", name: "Tests", cli: "node", args: ["-e", ""], exports: [{ id: "report", path: "latest.json", kind: "file", required: true }] }] });
  const run = await start(f, apply(f, stale)); assert.equal((await done(f, run.runId)).error.code, "EXPORT_NOT_FRESH");
});

test("stopping kills detached descendants, prevents later steps, and timeout is a failure", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.p.root, "parent.mjs"), `import {spawn} from 'node:child_process';
spawn(process.execPath,['-e',"setTimeout(()=>require('node:fs').writeFileSync('escaped.txt','bad'),4000)"],{detached:true,stdio:'ignore'}).unref();
console.log('waiting');setInterval(()=>{},1000);`);
  const d = def("", { steps: [{ id: "test", name: "Wait", cli: "node", args: ["parent.mjs"] }, { id: "later", name: "Never", cli: "node", args: ["-e", "require('node:fs').writeFileSync('unexpected.txt','bad')"] }] });
  const run = await start(f, apply(f, d));
  await until(() => f.app.automations.logs(f.p.id, run.runId), page => page.items.some(i => i.text.includes("waiting")));
  f.app.automations.stop(f.p.id, run.runId);
  const stopped = await done(f, run.runId); assert.equal(stopped.status, "CANCELED"); assert.equal(stopped.steps[1].status, "SKIPPED");
  await delay(4100); assert.equal(fs.existsSync(path.join(f.p.root, "escaped.txt")), false); assert.equal(fs.existsSync(path.join(f.p.root, "unexpected.txt")), false);
  const timed = def('setInterval(()=>{},1000)', { id: "timeout" }); timed.steps[0].timeoutMs = 1000;
  const timedRun = await start(f, apply(f, timed)); const failed = await done(f, timedRun.runId);
  assert.equal(failed.status, "FAILED"); assert.equal(failed.error.code, "TIMEOUT");
});

test("restart requires explicit process recovery and does not treat an unpublished result as success", async t => {
  const f = fixture(t), flow = apply(f, def()), run = await start(f, flow); await done(f, run.runId);
  const dir = path.join(f.p.root, run.runPath); f.app.close(); fs.unlinkSync(path.join(dir, "result.json"));
  fs.appendFileSync(path.join(dir, "events.ndjson"), '{"torn":');
  fs.appendFileSync(path.join(dir, "log.ndjson"), '{"torn":');
  const app = createService({ dataDir: f.data });
  try {
    const recovered = app.automations.detail(f.p.id, run.runId); assert.equal(recovered.status, "RECOVERY_REQUIRED");
    assert.equal(app.automations.busy(f.p.id), true);
    await assert.rejects(app.automations.start(f.p.id, flow.id, { revision: flow.revision, idempotencyKey: crypto.randomUUID() }), { code: "AUTOMATION_BUSY" });
    app.automations.confirmStopped(f.p.id, run.runId, { stopped: true, reason: "No old process is running" });
    assert.equal(app.automations.detail(f.p.id, run.runId).status, "INTERRUPTED"); assert.equal(app.automations.busy(f.p.id), false);
  } finally { app.close(); }
});

test("Git triggers observe project files, establish a baseline and record local cursors", async t => {
  const f = fixture(t), git = (...args) => execFileSync("git", ["-c", "user.name=ATK Test", "-c", "user.email=atk@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=.git/no-hooks", ...args], { cwd: f.p.root, encoding: "utf8", windowsHide: true }).trim();
  git("init", "-b", "dev"); fs.writeFileSync(path.join(f.p.root, "tracked.txt"), "baseline"); git("add", "tracked.txt"); git("commit", "-m", "baseline");
  apply(f, def('console.log("git-passed")', { trigger: { type: "git-commit", branch: "dev", parameters: {} } }));
  await f.app.automations.poll(); assert.equal(f.app.automations.runs(f.p.id).total, 0);
  fs.writeFileSync(path.join(f.p.root, "tracked.txt"), "new commit"); git("add", "tracked.txt"); git("commit", "-m", "new");
  fs.writeFileSync(path.join(f.p.root, "tracked.txt"), "dirty"); await f.app.automations.poll(); assert.equal(f.app.automations.runs(f.p.id).total, 0);
  git("restore", "tracked.txt"); await f.app.automations.poll();
  const run = f.app.automations.runs(f.p.id).items[0]; assert.equal((await done(f, run.runId)).status, "SUCCEEDED"); assert.equal(run.requestedBy.type, "git");
  await f.app.automations.poll(); assert.equal(f.app.automations.runs(f.p.id).total, 1);
  assert.ok(fs.readdirSync(path.join(f.p.root, ".atk/local")).some(name => name !== "owner.lock"));
});

test("backup includes configuration and run evidence, excludes ownership and restores file definitions", async t => {
  const f = fixture(t), d = def(), flow = apply(f, d), run = await start(f, flow); await done(f, run.runId);
  const target = path.join(f.root, "backup"); backup(f.app, target);
  const saved = path.join(target, "automations", f.p.id); assert.ok(fs.existsSync(path.join(saved, "automations/checks.json")));
  assert.ok(fs.existsSync(path.join(saved, run.runPath.replace(".atk/", ""), "result.json"))); assert.equal(fs.existsSync(path.join(saved, "local")), false);
  apply(f, { ...d, name: "Changed" }, flow.revision); restore(f.app, target);
  assert.equal(f.app.automations.show(f.p.id, "checks").definition.name, "Project checks"); assert.equal(f.app.automations.detail(f.p.id, run.runId).status, "SUCCEEDED");
});

test("Agent CLI/API configure, trigger and query the same human-visible run with authorization and idempotency", async t => {
  const f = await serverFixture(t), client = createAgentClient({ baseUrl: f.url, credential: f.dev.credential });
  const base = `/projects/${f.p.id}`, file = path.join(f.root, "definition.json");
  fs.writeFileSync(file, JSON.stringify(def('console.log("agent-ci-passed")', { parameters: { mode: { type: "string", enum: ["quick", "local"], default: "quick" } } })));
  const command = (...args) => invoke(process.execPath, [cli, "automation", ...args, "--project", f.p.id], { env: { ...process.env, ATK_URL: f.url, ATK_AGENT_TOKEN: f.dev.credential }, timeout: 20000, windowsHide: true });
  const configured = JSON.parse((await command("apply", "--file", file, "--create")).stdout);
  assert.equal((await command("validate", "--file", file)).stderr, "");
  assert.equal((await f.human(base + "/automations")).body.items[0].revision, configured.revision);
  const requestId = crypto.randomUUID();
  const started = JSON.parse((await command("run", "checks", "--revision", configured.revision, "--param", "mode=local", "--request-id", requestId)).stdout);
  const body = { revision: configured.revision, parameters: { mode: "local" }, idempotencyKey: requestId };
  const again = await client.request(base + "/automations/checks/runs", body); assert.equal(again.runId, started.runId); assert.equal(again.reused, true);
  await assert.rejects(client.request(base + "/automations/checks/runs", { ...body, parameters: { mode: "quick" } }), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(client.request(base + "/automation-runs/" + started.runId + "/confirm-stopped", {}), { code: "AUTOMATION_FORBIDDEN" });
  const humanRun = await until(() => f.human(base + "/automation-runs/" + started.runId), r => terminal(r.body));
  assert.equal(humanRun.body.status, "SUCCEEDED"); assert.equal(humanRun.body.requestedBy.agentId, f.dev.agent.id); assert.equal(humanRun.body.parameters.mode, "local");
  assert.match((await command("logs", started.runId)).stdout, /agent-ci-passed/);
  const stream = await fetch(f.url + "/api/agent/v1" + base + "/automation-runs/" + started.runId + "/events/stream", { headers: { authorization: "Bearer " + f.dev.credential, "last-event-id": "1" } });
  const replay = await stream.text(); assert.match(replay, /event: run.finished/); assert.doesNotMatch(replay, /id: 1\n/);
  const completed = JSON.parse((await command("run", "checks", "--revision", configured.revision, "--wait")).stdout); assert.equal(completed.status, "SUCCEEDED");
  const foreignRoot = path.join(f.root, "foreign"); fs.mkdirSync(foreignRoot); const foreign = f.app.createProject({ name: "Foreign", root: foreignRoot });
  await assert.rejects(client.request(`/projects/${foreign.id}/automations`), { code: "NOT_FOUND" });
  assert.equal((await f.human("/automations?projectId=" + f.p.id)).status, 404);
  assert.equal(f.app.store.events({ after: 0, limit: 10000 }).some(e => e.type.startsWith("automation.")), false);
});

test("concurrent duplicate starts return one run, and retry survives a changed definition", async t => {
  const f = fixture(t), d = def('console.log("once")'), flow = apply(f, d);
  const body = { revision: flow.revision, idempotencyKey: crypto.randomUUID(), parameters: {} };
  const [a, b] = await Promise.all([f.app.automations.start(f.p.id, flow.id, body), f.app.automations.start(f.p.id, flow.id, body)]);
  assert.equal(a.runId, b.runId); assert.equal(f.app.automations.runs(f.p.id).total, 1);
  await done(f, a.runId); apply(f, { ...d, name: "New version" }, flow.revision);
  assert.equal((await f.app.automations.start(f.p.id, flow.id, body)).runId, a.runId);
});

test("workflow history filters before pagination and retains the project-wide active run", async t => {
  const f = await serverFixture(t), api = f.app.automations;
  const first = apply(f, def()), second = apply(f, def("", { id: "second" }));
  const older = await start(f, first); await done(f, older.runId);
  const other = await start(f, second); await done(f, other.runId);
  const newer = await start(f, first); await done(f, newer.runId);
  const runningFlow = apply(f, def('setTimeout(() => {}, 60000)', { id: "running" }));
  const running = await start(f, runningFlow);
  const page = await f.human(`/projects/${f.p.id}/automation-runs?workflowId=checks&limit=1`);
  assert.equal(page.status, 200); assert.equal(page.body.total, 2);
  assert.equal(page.body.items[0].runId, newer.runId);
  assert.equal(page.body.activeRun.runId, running.runId);
  const next = api.runs(f.p.id, { workflowId: "checks", limit: 1, cursor: page.body.nextCursor });
  assert.deepEqual(next.items.map(run => run.runId), [older.runId]); assert.equal(next.nextCursor, null);
  api.remove(f.p.id, first.id, first.revision);
  assert.equal(api.runs(f.p.id, { workflowId: "checks" }).total, 2);
  assert.equal(api.runs(f.p.id).total, 4);
  assert.equal(api.runs(f.p.id, { workflowId: "missing" }).total, 0);
  api.stop(f.p.id, running.runId); await done(f, running.runId);
});

test("project ownership prevents another backend writing the same files", t => {
  const f = fixture(t), other = fixture(t); apply(f, def());
  const p = other.app.createProject({ name: "Same directory", root: f.p.root });
  assert.equal(other.app.automations.list(p.id).items.length, 1);
  assert.throws(() => other.app.automations.apply(p.id, "second", { expectedRevision: null, definition: def("", { id: "second" }) }), { code: "AUTOMATION_BUSY" });
});

test("invalid parameters and unavailable CLI entries are rejected before accepting a run", async t => {
  const f = fixture(t), flow = apply(f, def("", { parameters: { mode: { type: "string", enum: ["quick"], required: true }, count: { type: "integer", minimum: 1, default: 1 } } }));
  for (const parameters of [{}, { mode: "bad" }, { mode: "quick", count: 0 }, { mode: "quick", count: 1.5 }, { mode: "quick", unknown: true }]) await assert.rejects(start(f, flow, { parameters }), { code: "INVALID_PARAMETERS" });
  const missing = apply(f, def("", { id: "missing-cli", steps: [{ id: "check", name: "Check", cli: "atk-no-such-cli-2026", args: [] }] }));
  await assert.rejects(start(f, missing), { code: "CLI_UNAVAILABLE" });
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(f.p.root, "ci.cmd"), "@echo off\r\necho no\r\n");
    const cmd = apply(f, def("", { id: "cmd-entry", steps: [{ id: "check", name: "Check", cli: "./ci.cmd", args: [] }] }));
    await assert.rejects(start(f, cmd), { code: "CLI_UNSUPPORTED" });
  }
  assert.equal(f.app.automations.runs(f.p.id).total, 0);
});

test("relocating idle automation data preserves ownership release and corrupt history does not hide other runs", async t => {
  const f = fixture(t), flow = apply(f, def()), run = await start(f, flow); await done(f, run.runId);
  const moved = f.p.root + "-moved"; fs.renameSync(f.p.root, moved);
  const updated = f.app.updateProject(f.p.id, { version: f.p.version, root: moved, docsRoot: path.join(moved, ".agent-team") });
  assert.equal(f.app.automations.show(f.p.id, flow.id).revision, flow.revision);
  f.app.automations.apply(f.p.id, "second", { expectedRevision: null, definition: def("", { id: "second" }) });
  fs.writeFileSync(path.join(moved, run.runPath, "result.json"), '{"schemaVersion":1}');
  assert.equal(f.app.automations.runs(f.p.id).items[0].status, "CORRUPT");
  f.app.close(); assert.equal(fs.existsSync(path.join(updated.root, ".atk/local/owner.lock")), false);
});

test("unreported progress is unknown, optional exports warn, directory exports are fresh and cursors bind to a run", async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.p.root, "logs")); fs.writeFileSync(path.join(f.p.root, "logs/old.log"), "old");
  fs.writeFileSync(path.join(f.p.root, "go.mjs"), `import fs from 'node:fs';console.log('waiting');while(!fs.existsSync('gate'))await new Promise(r=>setTimeout(r,30));fs.writeFileSync('logs/new.log','new');console.log('z'.repeat(300000));`);
  const d = def("", { steps: [{ id: "test", name: "Tests", cli: "node", args: ["go.mjs"], exports: [{ id: "logs", path: "logs", kind: "directory", required: true }, { id: "optional", path: "not-created.json", kind: "file", required: false }] }] });
  const flow = apply(f, d), a = await start(f, flow);
  await until(() => f.app.automations.logs(f.p.id, a.runId), page => page.items.some(i => i.text.includes("waiting")));
  assert.equal(f.app.automations.detail(f.p.id, a.runId).progress, null);
  fs.writeFileSync(path.join(f.p.root, "gate"), "go"); const finished = await done(f, a.runId); assert.equal(finished.status, "SUCCEEDED");
  const files = finished.steps[0].exports[0].files; assert.equal(files.length, 1); assert.ok(files[0].path.endsWith("new.log"));
  assert.ok(finished.steps[0].diagnostics.some(d => d.code === "EXPORT_MISSING"));
  let cursor, text = "", pages = 0;
  while (true) { const page = f.app.automations.logs(f.p.id, a.runId, { cursor, limitBytes: 65536 }); cursor = page.nextCursor; text += page.items.map(i => i.text).join(""); pages++; if (page.endOfFile) break; }
  assert.ok(pages > 1); assert.equal(text.match(/z/g).length, 300000);
  const b = await start(f, apply(f, def("", { id: "other" }))); await done(f, b.runId);
  assert.throws(() => f.app.automations.logs(f.p.id, b.runId, { cursor }), { code: "INVALID_PARAMETERS" });
});

test("export links cannot disclose another directory and invalid siblings do not hide valid configurations", async t => {
  const f = fixture(t), outside = path.join(f.root, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "secret.txt"), "private");
  const flow = apply(f, def("", { steps: [{ id: "test", name: "Tests", cli: "node", args: ["-e", ""], exports: [{ id: "unsafe", path: "link/secret.txt", kind: "file", required: true }] }] }));
  fs.symlinkSync(outside, path.join(f.p.root, "link"), process.platform === "win32" ? "junction" : "dir");
  const run = await start(f, flow); assert.equal((await done(f, run.runId)).error.code, "PATH_ESCAPE");
  const configs = path.join(f.p.root, ".atk/automations"); fs.symlinkSync(outside, path.join(configs, "bad.json"), process.platform === "win32" ? "junction" : "dir");
  const listing = f.app.automations.list(f.p.id); assert.equal(listing.items.find(i => i.id === "bad").valid, false); assert.equal(listing.items.find(i => i.id === "checks").valid, true);
});

test("four-project capacity is enforced without a queue and can be released before execution starts", async t => {
  const f = fixture(t), runs = [];
  for (let i = 0; i < 5; i++) {
    const root = path.join(f.root, "project-" + i); fs.mkdirSync(root); const p = f.app.createProject({ name: "Project " + i, root });
    const flow = f.app.automations.apply(p.id, "checks", { expectedRevision: null, definition: def("setInterval(()=>{},1000)") });
    if (i === 4) { await assert.rejects(f.app.automations.start(p.id, "checks", { revision: flow.revision, idempotencyKey: crypto.randomUUID() }), { code: "AUTOMATION_BUSY" }); break; }
    runs.push({ p, run: await f.app.automations.start(p.id, "checks", { revision: flow.revision, idempotencyKey: crypto.randomUUID() }) });
  }
  for (const { p, run } of runs) f.app.automations.stop(p.id, run.runId);
  for (const { p, run } of runs) assert.equal((await until(() => f.app.automations.detail(p.id, run.runId), terminal)).status, "CANCELED");
  assert.equal(f.app.automations.busy(), false);
});
