import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createAgentClient } from "../packages/agent-client/src/index.mjs";
import { runBugOnce } from "../apps/agent-cli/codex-runner.mjs";
import { serverFixture } from "./helpers.mjs";

async function setup(t, mode = "ok", engine = "codex") {
  const f = await serverFixture(t);
  const git = args => execFileSync("git", args, { cwd: f.p.root, windowsHide: true, stdio: "pipe" });
  git(["init", "-b", "dev"]);
  git(["-c", "user.name=ATK test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
  const bug = f.app.createBug({ projectId: f.p.id, roleId: "role-dev", title: "Repair", description: "Fix a.txt", files: ["a.txt"] });
  const fake = path.join(f.root, "fake-codex.mjs");
  fs.writeFileSync(fake, `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const mode = process.argv[2], engine = process.argv[3], args = process.argv.slice(4);
let prompt = ''; for await (const data of process.stdin) prompt += data;
if (!prompt.includes('ATK spec:') || process.env.ATK_AGENT_TOKEN || process.env.ATK_URL) process.exit(90);
if (engine === 'dsh') {
  if (!args.includes('--json') || !args.includes('headless') || !args.includes('workspace-write') || !args.includes('never') || args.includes('--output-schema')) process.exit(91);
  console.log(JSON.stringify({ type: 'session', sessionId: 'test-dsh' }));
}
function answer(text) {
  if (engine === 'dsh') {
    const line = JSON.stringify({ type: 'final', sessionId: 'test-dsh', reason: { kind: 'completed' }, text }) + '\\n';
    const bytes = Buffer.from(line); process.stdout.write(bytes.subarray(0, 13)); process.stdout.write(bytes.subarray(13));
  } else fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], text);
}
fs.writeFileSync('a.txt', 'fixed');
if (mode === 'outside') fs.writeFileSync('outside.txt', 'bad');
if (mode === 'hang') {
  spawn(process.execPath, ['-e', "setInterval(()=>require('fs').appendFileSync('a.txt','x'),30)"], { stdio: 'ignore' });
  console.log(JSON.stringify({type:'status',phase:'writing'})); setInterval(()=>{},1000);
} else if (mode === 'invalid') answer('{}');
else answer(JSON.stringify({ outcome: 'IMPLEMENTED', summary: 'Fixed a.txt / 修复完成' }));
`);
  const stateDir = path.join(f.root, "runner");
  const client = createAgentClient({ baseUrl: f.url, credential: f.dev.credential, stateDir: path.join(stateDir, "receipts") });
  const adapter = { executable: process.execPath, args: [fake, mode, engine] };
  return { ...f, bug, client, stateDir, options: { client, taskId: bug.id, engine,
    ...(engine === "codex" ? { codex: adapter } : { agent: adapter }), stateDir, onProgress: () => {} } };
}

for (const engine of ["codex", "dsh"]) {
const prepare = (t, mode) => setup(t, mode, engine);
test(`${engine}: claims one bug, executes the agent and a real check, and waits for human acceptance`, async t => {
  const f = await prepare(t);
  const check = `"${process.execPath}" -e "if(require('fs').readFileSync('a.txt','utf8')!=='fixed')process.exit(1)"`;
  const result = await runBugOnce({ ...f.options, checks: [check] });
  assert.equal(result.outcome, "COMPLETED");
  assert.equal(f.app.get("tasks", f.bug.id).status, "AWAITING_ACCEPTANCE");
  const receipt = f.app.artifact(result.runId);
  assert.equal(receipt.checks[0].passed, true);
  assert.equal(receipt.checks[0].exitCode, 0);
  assert.equal(f.app.store.activeRuns().length, 0);
  assert.equal((await runBugOnce(f.options)).idle, true);
});

for (const mode of ["outside", "invalid"]) test(`${engine}: rejects ${mode} output`, async t => {
  const f = await prepare(t, mode);
  const result = await runBugOnce(f.options);
  assert.equal(result.outcome, "FAILED");
  assert.equal(f.app.get("tasks", f.bug.id).status, "BLOCKED");
});

test(`${engine}: a failing verification command cannot be reported as completed`, async t => {
  const f = await prepare(t);
  const result = await runBugOnce({ ...f.options, checks: [`"${process.execPath}" -e "process.exit(7)"`] });
  assert.equal(result.outcome, "FAILED");
  assert.equal(f.app.artifact(result.runId).checks[0].passed, false);
  assert.equal(f.app.artifact(result.runId).checks[0].exitCode, 7);
});

test(`${engine}: ATK stop terminates the writer and its child before confirming stopped`, async t => {
  const f = await prepare(t, "hang");
  const claim = f.client.claim;
  f.client.claim = async body => { const value = await claim(body); value.spec.lease.heartbeatMs = 40; return value; };
  const running = runBugOnce(f.options);
  while (!fs.existsSync(path.join(f.p.root, "a.txt"))) await new Promise(resolve => setTimeout(resolve, 30));
  const run = f.app.store.activeRuns()[0];
  f.app.requestStop(run.id, { reason: "test" });
  const result = await running;
  assert.equal(result.outcome, "INTERRUPTED");
  assert.equal(f.app.store.activeRuns().length, 0);
  const stopped = fs.readFileSync(path.join(f.p.root, "a.txt"), "utf8");
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(fs.readFileSync(path.join(f.p.root, "a.txt"), "utf8"), stopped);
});

test(`${engine}: lost submission response is replayed without rerunning the agent`, async t => {
  const f = await prepare(t);
  let drop = true;
  f.options.client = createAgentClient({ baseUrl: f.url, credential: f.dev.credential,
    stateDir: path.join(f.stateDir, "receipts"), fetchImpl: async (url, options) => {
      const response = await fetch(url, options);
      if (drop && /\/runs\/[^/]+\/result$/.test(url)) {
        drop = false;
        await response.arrayBuffer();
        throw new Error("lost response");
      }
      return response;
    },
  });
  await assert.rejects(runBugOnce(f.options), /lost response/);
  assert.equal(fs.readdirSync(path.join(f.stateDir, "receipts")).length, 1);
  const original = fs.readFileSync(path.join(f.p.root, "a.txt"), "utf8");
  const recovered = await runBugOnce(f.options);
  assert.equal(recovered.recovered, true);
  assert.equal(fs.readdirSync(path.join(f.stateDir, "receipts")).length, 0);
  assert.equal(fs.readFileSync(path.join(f.p.root, "a.txt"), "utf8"), original);
  assert.equal(f.app.get("tasks", f.bug.id).status, "AWAITING_ACCEPTANCE");
});

test(`${engine}: user interruption settles a running execution after the writer stops`, { timeout: 20000 }, async t => {
  const f = await prepare(t, "hang"), controller = new AbortController();
  const running = runBugOnce({ ...f.options, signal: controller.signal });
  while (!fs.existsSync(path.join(f.p.root, "a.txt"))) await new Promise(resolve => setTimeout(resolve, 30));
  controller.abort(new Error("test interrupt"));
  const result = await running;
  assert.equal(result.outcome, "INTERRUPTED");
  assert.equal(f.app.store.activeRuns().length, 0);
});

test(`${engine}: a stalled heartbeat stops writing before the lease expires`, { timeout: 20000 }, async t => {
  const f = await prepare(t, "hang"), claim = f.client.claim;
  f.client.claim = async body => {
    const value = await claim(body);
    value.spec.lease.heartbeatMs = 40;
    value.leaseUntil = Date.now() + 7500;
    return value;
  };
  f.client.heartbeat = () => new Promise(() => {});
  const result = await runBugOnce(f.options);
  assert.equal(result.outcome, "INTERRUPTED");
  assert.equal(f.app.store.activeRuns().length, 0);
});
}
