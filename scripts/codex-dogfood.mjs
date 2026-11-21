// Opt-in live proof: calls the installed Codex CLI and edits this repository.
// Uses separate ATK data and never accepts the resulting fix on the user's behalf.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "../apps/backend/src/server.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(repo, "artifacts", "codex-dogfood");
fs.mkdirSync(output, { recursive: true });
const dataDir = path.join(output, "data"), server = createServer({ dataDir });
const info = await server.listen({ port: 0 }), app = server.app;
try {
  const project = app.store.all("projects").find(p => path.resolve(p.root) === path.resolve(repo)) ??
    app.createProject({ name: "ATK · Codex 自举验证", root: repo });
  const identityFile = path.join(output, "worker.private.json");
  let identity;
  if (fs.existsSync(identityFile)) identity = JSON.parse(fs.readFileSync(identityFile, "utf8"));
  else {
    identity = app.createAgent({ projectId: project.id, name: "Codex dogfood worker", roleId: "role-dev" });
    fs.writeFileSync(identityFile, JSON.stringify(identity), { mode: 0o600, flag: "wx" });
  }
  const title = "回执重放未获持久化确认时应报错，并保留原回执供重试";
  let bug = app.store.all("tasks").find(t => t.projectId === project.id && t.kind === "BUG" && t.title === title) ??
    app.createBug({ projectId: project.id, roleId: "role-dev", title,
      files: ["packages/agent-client/src/index.mjs", "test/agent-client.test.mjs"],
      description: "createAgentClient.submit() rejects a response without persisted:true, but replay() silently succeeds and returns [] for the same response. Reproduce with node --test test/agent-client.test.mjs (currently Missing expected rejection), then fix replay to reject an unacknowledged response. Keep the exact pending receipt and idempotency key so the same request can be retried. Preserve all existing edits in this dirty dev checkout. Do not weaken the regression test.",
      acceptance: "The regression test passes; unacknowledged or missing persisted confirmation rejects, leaves the receipt unchanged, and a later persisted:true response removes it after retrying the same payload. Existing client/HTTP behavior still works.",
    });
  if (bug.status === "BLOCKED" && process.argv.includes("--retry"))
    bug = app.retryTask(bug.id, { version: bug.version });
  const setup = { projectId: project.id, taskId: bug.id, dataDir, status: bug.status };
  fs.writeFileSync(path.join(output, "setup.json"), JSON.stringify(setup, null, 2));
  console.log(JSON.stringify(setup));
  if (bug.status !== "READY") throw new Error(`Bug is ${bug.status}; inspect existing evidence before retrying`);
  const child = spawn(process.execPath, [path.join(repo, "apps", "agent-cli", "cli.mjs"), "run", "--task", bug.id,
    "--state-dir", path.join(output, "runner"),
    "--check", "node --test test/agent-client.test.mjs",
    "--check", "node --test test/http.test.mjs",
  ], { cwd: repo, windowsHide: true, env: { ...process.env, ATK_URL: info.url, ATK_AGENT_TOKEN: identity.credential }, stdio: ["ignore", "pipe", "pipe"] });
  const log = fs.createWriteStream(path.join(output, "runner.log"), { flags: "a" });
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]])
    stream.on("data", data => { log.write(data); destination.write(data); });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  await new Promise(resolve => log.end(resolve));
  const task = app.get("tasks", bug.id);
  const report = { ...setup, status: task.status, runId: task.latestRunId, runnerExitCode: code, awaitingHumanAcceptance: task.status === "AWAITING_ACCEPTANCE" };
  if (task.latestRunId) report.receipt = app.artifact(task.latestRunId);
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, receipt: undefined }));
  if (code !== 0 || task.status !== "AWAITING_ACCEPTANCE") process.exitCode = 1;
} finally { await server.close(); }
