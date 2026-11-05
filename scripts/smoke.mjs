import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const output = path.resolve("artifacts/smoke");
fs.mkdirSync(output, { recursive: true });
const runRoot = fs.mkdtempSync(path.join(output, "case-"));
const executableDir = path.dirname(process.execPath);
const npmCli = [
  process.env.npm_execpath,
  path.join(executableDir, "node_modules/npm/bin/npm-cli.js"),
  path.join(executableDir, "../lib/node_modules/npm/bin/npm-cli.js"),
  "/usr/share/nodejs/npm/bin/npm-cli.js",
].find((p) => p && fs.existsSync(p));
assert.ok(npmCli, "npm CLI must be installed with Node");
const steps = [];
let baseUrl, launcher, dataDir, accessKey;
function command(file, args, cwd = process.cwd()) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
    env: { ...process.env, npm_config_cache: path.join(output, "npm-cache") },
  });
  if (result.status !== 0)
    throw new Error(
      `Command failed: ${file}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}
async function human(route, body) {
  const session = await fetch(baseUrl + "/api/v1/session", {
    headers: { "x-atk-access": accessKey },
  }).then((r) =>
    r.json(),
  );
  const response = await fetch(baseUrl + "/api/v1" + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-atk-token": session.token,
      "x-atk-csrf": session.csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return data;
}
async function step(name, fn) {
  await fn();
  steps.push({ name, passed: true });
  console.log("PASS", name);
}
try {
  let packed;
  await step("npm pack includes built UI and excludes legacy runtimes", () => {
    packed = JSON.parse(
      command(npmCli, [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        runRoot,
      ]),
    )[0];
    const names = packed.files.map((f) => f.path);
    assert.ok(names.includes("apps/web/dist/index.html"));
    assert.ok(names.includes("apps/agent-cli/cli.mjs"));
    assert.ok(names.includes("apps/launcher/desktop.mjs"));
    assert.ok(names.includes("start.bat"));
    assert.ok(names.includes("stop.bat"));
    assert.ok(!names.includes("atk.local.json"));
    assert.ok(
      names.every(
        (n) =>
          !/^(lib|plugins|presets|templates|skills|test|artifacts)\//.test(n),
      ),
    );
    assert.ok(
      names.every(
        (n) =>
          !/runtime-host|runtime-sdk|packages\/workspace|apps\/scheduler\//.test(
            n,
          ),
      ),
    );
  });
  const prefix = path.join(runRoot, "install prefix");
  await step(
    "install tarball into an isolated prefix without production dependencies",
    () => {
      command(npmCli, [
        "install",
        "--global",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--offline",
        path.join(runRoot, packed.filename),
      ]);
    },
  );
  const installed =
    process.platform === "win32"
      ? path.join(prefix, "node_modules/agent-team-kit")
      : path.join(prefix, "lib/node_modules/agent-team-kit");
  launcher = path.join(installed, "apps/launcher/cli.mjs");
  dataDir = path.join(runRoot, "state");
  const outside = path.join(runRoot, "ordinary-project");
  fs.mkdirSync(outside);
  await step(
    "start the installed tool from an unrelated working directory",
    () => {
      const started = JSON.parse(
        command(launcher, ["start", "--data", dataDir, "--port", "0"], outside),
      );
      assert.ok(started.running);
      baseUrl = started.url;
      accessKey = new URLSearchParams(new URL(started.browserUrl).hash.slice(1)).get("access");
      assert.ok(accessKey);
      assert.ok(!fs.readFileSync(path.join(dataDir, "logs/backend.log"), "utf8").includes(accessKey));
      assert.ok(!fs.readFileSync(path.join(dataDir, "runtime/service.json"), "utf8").includes(accessKey));
      assert.equal(
        JSON.parse(command(launcher, ["status", "--data", dataDir], outside))
          .running,
        true,
      );
      const help = command(
        path.join(installed, "apps/agent-cli/cli.mjs"),
        ["help"],
        outside,
      );
      assert.ok(help.includes("atk-agent claim"));
    },
  );
  await step("serve the complete bundled web application", async () => {
    assert.equal((await fetch(baseUrl + "/api/v1/session")).status, 401);
    fs.writeFileSync(
      path.join(dataDir, "runtime", "service.json"),
      "{corrupt state",
    );
    assert.equal(
      JSON.parse(command(launcher, ["status", "--data", dataDir])).running,
      true,
    );
    const response = await fetch(baseUrl);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("/assets/"));
    const asset = html.match(/src="([^"]+\.js)"/)[1];
    assert.equal((await fetch(baseUrl + asset)).status, 200);
  });
  await step("desktop startup reuses the installed service from an unrelated directory", () => {
    const before = JSON.parse(command(launcher, ["status", "--data", dataDir]));
    const result = command(path.join(installed, "apps/launcher/desktop.mjs"), ["start", "--no-open", "--data", dataDir], outside);
    assert.ok(result.includes(baseUrl));
    assert.ok(!result.includes(accessKey));
    const after = JSON.parse(command(launcher, ["status", "--data", dataDir]));
    assert.equal(after.pid, before.pid);
    assert.equal(after.instanceId, before.instanceId);
  });
  let first;
  await step(
    "register multiple ordinary project folders through the installed API",
    async () => {
      first = await human("/projects", { name: "Installed A", root: outside });
      const other = path.join(runRoot, "other-project");
      fs.mkdirSync(other);
      await human("/projects", { name: "Installed B", root: other });
      assert.equal((await human("/projects")).total, 2);
      assert.ok(!fs.existsSync(path.join(outside, ".git")));
    },
  );
  await step(
    "external protocol client works from the installed package",
    async () => {
      const identity = await human("/agents", {
        name: "Installed PM",
        roleId: "role-pm",
        teamId: "team-default",
      });
      const { createAgentClient } = await import(
        pathToFileURL(
          path.join(installed, "packages/agent-client/src/index.mjs"),
        )
      );
      const client = createAgentClient({
        baseUrl,
        credential: identity.credential,
      });
      await client.connect();
      const draft = await human("/tasks", {
        projectId: first.id,
        title: "Installed request",
        description: "Protocol exercise",
      });
      const claim = await client.claim({ taskId: draft.id, waitMs: 0 });
      const plan = await client.submit(claim.run.id, "plan", {
        generation: claim.generation,
        plan: {
          summary: "Installed plan",
          nodes: [
            {
              key: "a",
              title: "A",
              description: "A",
              acceptance: "A",
              roleId: "role-dev",
              files: [],
              checks: [],
              reviewPolicy: "NONE",
              deps: [],
            },
          ],
        },
      });
      assert.equal(plan.persisted, true);
      assert.equal(plan.plan.status, "SUBMITTED");
    },
  );
  await step(
    "backup and restore both database and project artifacts",
    async () => {
      const backup = await human("/operations/backup", {
        destination: path.join(runRoot, "backup"),
      });
      assert.ok(fs.existsSync(path.join(backup.destination, "manifest.json")));
      const total = (await human("/tasks")).total;
      await human("/tasks", {
        projectId: first.id,
        title: "Later",
        description: "Not in backup",
      });
      const result = await human("/operations/restore", {
        source: backup.destination,
      });
      assert.ok(result.restored);
      assert.equal((await human("/tasks")).total, total);
    },
  );
  await step(
    "stop the matching installation without trusting a stale PID",
    async () => {
      command(path.join(installed, "apps/launcher/desktop.mjs"), ["stop", "--data", dataDir], outside);
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          await fetch(baseUrl + "/api/v1/system/health", {
            signal: AbortSignal.timeout(300),
          });
        } catch {
          return;
        }
      }
      throw new Error("Installed service did not stop");
    },
  );
  fs.writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify({ passed: true, package: packed.filename, steps }, null, 2),
  );
  console.log(`PACKAGE SMOKE PASSED (${steps.length} checks)`);
} catch (error) {
  fs.writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify({ passed: false, steps, error: error.stack }, null, 2),
  );
  throw error;
} finally {
  if (launcher && dataDir) {
    try {
      command(launcher, ["stop", "--data", dataDir]);
    } catch {}
  }
}
