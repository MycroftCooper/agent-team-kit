// Explicit opt-in live integration test. Calls the installed DSH and its model.
// Repairs an intentionally broken fixture, never edits ATK source or accepts it.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer } from "../apps/backend/src/server.mjs";

const { values } = parseArgs({ options: { dsh: { type: "string" } } });
const repo = fileURLToPath(new URL("../", import.meta.url));
const base = path.join(repo, "artifacts", "dsh-runner-smoke");
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, "case-")), projectRoot = path.join(root, "project");
fs.mkdirSync(projectRoot);
fs.writeFileSync(path.join(projectRoot, "calculator.mjs"), "export function add(a, b) { return a - b; }\n");
fs.writeFileSync(path.join(projectRoot, "calculator.test.mjs"), `import test from 'node:test'; import assert from 'node:assert/strict'; import { add } from './calculator.mjs'; test('addition', () => { assert.equal(add(2, 3), 5); assert.equal(add(-2, 3), 1); });\n`);
const git = args => execFileSync("git", args, { cwd: projectRoot, windowsHide: true, stdio: "pipe" });
git(["init", "-b", "dev"]);
git(["add", "calculator.mjs", "calculator.test.mjs"]);
git(["-c", "user.name=ATK smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "broken integration fixture"]);
const server = createServer({ dataDir: path.join(root, "data") }), info = await server.listen({ port: 0 });
try {
  const app = server.app, p = app.createProject({ name: "DSH live integration fixture", root: projectRoot });
  const identity = app.createAgent({ projectId: p.id, name: "DSH smoke worker", roleId: "role-dev" });
  const bug = app.createBug({ projectId: p.id, roleId: "role-dev", title: "Fix addition in the integration fixture",
    files: ["calculator.mjs"], description: "The intentionally broken fixture subtracts instead of adding. Read calculator.mjs and calculator.test.mjs, repair add(a,b) within calculator.mjs only. Do not edit the regression test. The runner will run it independently. No new agents, commits, or other file changes.",
    acceptance: "add(2,3) is 5; add(-2,3) is 1; calculator.test.mjs passes unchanged." });
  const args = [path.join(repo, "apps", "agent-cli", "cli.mjs"), "run", "--engine", "dsh", "--task", bug.id,
    "--state-dir", path.join(root, "runner"), "--check", "node --test calculator.test.mjs"];
  if (values.dsh) args.push("--dsh", values.dsh);
  const child = spawn(process.execPath, args, { cwd: repo, windowsHide: true,
    env: { ...process.env, ATK_URL: info.url, ATK_AGENT_TOKEN: identity.credential }, stdio: ["ignore", "pipe", "pipe"] });
  const log = fs.createWriteStream(path.join(root, "runner.log"));
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]])
    stream.on("data", data => { log.write(data); destination.write(data); });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  await new Promise(resolve => log.end(resolve));
  const task = app.get("tasks", bug.id);
  const report = { engine: "dsh", fixture: true, projectId: p.id, taskId: bug.id, runId: task.latestRunId, status: task.status,
    exitCode: code, receipt: task.latestRunId ? app.artifact(task.latestRunId) : null };
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(base, "latest.json"), JSON.stringify({ root, ...report, receipt: undefined }, null, 2));
  assert.equal(code, 0, `Inspect ${root}`);
  assert.equal(task.status, "AWAITING_ACCEPTANCE");
  assert.ok(report.receipt.checks.every(check => check.passed));
  console.log(JSON.stringify({ passed: true, root, status: task.status, runId: task.latestRunId }));
} finally { await server.close(); }
