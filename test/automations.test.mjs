import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fixture } from "./helpers.mjs";

async function until(read, predicate) {
  for (let i = 0; i < 100; i++) {
    const value = read();
    if (predicate(value)) return value;
    await delay(40);
  }
  assert.fail("Automation did not reach the expected state");
}

test("automation runs from the project root, reports progress, and retains the actual result", async (t) => {
  const { app, p } = fixture(t);
  const automation = app.automations;
  const file = (name) => path.join(p.root, name);
  const node = (name) => '"' + process.execPath + '" ' + name;
  fs.writeFileSync(file("prepare.mjs"), [
    'import fs from "node:fs";',
    'console.log(\'::atk::{"progress":40,"info":{"Tests passed":2}}\');',
    'while (!fs.existsSync("continue.txt")) await new Promise((resolve) => setTimeout(resolve, 25));',
  ].join("\n"));
  fs.writeFileSync(file("pack.mjs"), 'import fs from "node:fs"; fs.writeFileSync("package.txt", "built"); console.log("Pack finished");');
  const flow = automation.create(p.id, {
    name: "Local package",
    info: { Environment: "local" },
    steps: [{ name: "Prepare", command: node("prepare.mjs") }, { name: "Pack", command: node("pack.mjs") }],
  });
  assert.throws(() => automation.start(p.id, flow.id, { version: flow.version + 1 }), { code: "VERSION_CONFLICT" });
  const started = automation.start(p.id, flow.id, { version: flow.version });
  const detail = () => automation.detail(p.id, started.id);
  assert.throws(() => automation.start(p.id, flow.id, { version: flow.version }), { code: "AUTOMATION_BUSY" });
  assert.throws(() => automation.detail("other-project", started.id), { code: "NOT_FOUND" });
  const running = await until(detail, (run) => run.info["Tests passed"] === "2");
  assert.equal(running.currentStep, "Prepare");
  assert.equal(running.progress, 20);
  assert.equal(running.completedSteps, 0);
  fs.writeFileSync(file("continue.txt"), "");
  const finished = await until(detail, (run) => run.status === "SUCCEEDED");
  assert.equal(fs.readFileSync(file("package.txt"), "utf8"), "built");
  assert.equal(finished.progress, 100);
  assert.equal(finished.completedSteps, 2);
  assert.deepEqual(finished.info, { Environment: "local", "Tests passed": "2" });
  assert.match(finished.log, /Pack finished/);
  assert.ok(Date.parse(finished.endedAt) >= Date.parse(finished.startedAt));
  automation.remove(p.id, flow.id, flow.version);
  assert.equal(automation.list(p.id, 0).workflows.some((row) => row.id === flow.id), false);
  assert.equal(automation.list(p.id, 0).runs.items[0].id, finished.id);
});

test("the Git trigger is chosen per workflow and runs only for new commits on the configured checkout", async (t) => {
  const { app, p } = fixture(t);
  const automation = app.automations;
  const tracked = path.join(p.root, "tracked.txt");
  const git = (...args) => execFileSync("git", [
    "-c", "user.name=ATK Test", "-c", "user.email=atk@example.test", "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=.git/no-hooks", "-c", "core.autocrlf=false", ...args,
  ], { cwd: p.root, encoding: "utf8", windowsHide: true }).trim();
  const branch = "checks/local-smoke";
  git("init", "-b", branch);
  fs.writeFileSync(tracked, "baseline\n");
  git("add", "tracked.txt");
  git("commit", "-m", "baseline");
  const [smoke, release] = automation.list(p.id, 0).workflows;
  assert.deepEqual([smoke.builtIn, release.builtIn], ["smoke", "release"]);
  assert.deepEqual([smoke.trigger.type, release.trigger.type], ["MANUAL", "MANUAL"]);
  assert.equal(smoke.needsSetup, true);
  assert.throws(() => automation.update(p.id, smoke.id, {
    ...smoke, trigger: { type: "GIT_COMMIT", branch: "../other" },
  }), { code: "VALIDATION_ERROR" });
  await automation.configure(p.id, smoke.id, {
    ...smoke, trigger: { type: "GIT_COMMIT", branch }, steps: [{ name: "Check", command: "echo local-check-passed" }],
  });
  const configuredRelease = automation.update(p.id, release.id, {
    ...release, trigger: { type: "GIT_COMMIT", branch: "other" },
  });
  assert.deepEqual(configuredRelease.trigger, { type: "GIT_COMMIT", branch: "other" });
  automation.update(p.id, release.id, { ...configuredRelease, trigger: { type: "MANUAL" } });
  await automation.poll();
  assert.equal(automation.list(p.id, 0).runs.total, 0);
  fs.writeFileSync(tracked, "new commit\n");
  git("add", "tracked.txt");
  git("commit", "-m", "new commit");
  const commit = git("rev-parse", "HEAD");
  git("switch", "--quiet", "-c", "other");
  await automation.poll();
  assert.equal(automation.list(p.id, 0).runs.total, 0);
  git("switch", "--quiet", branch);
  fs.writeFileSync(tracked, "dirty checkout\n");
  await automation.poll();
  assert.equal(automation.list(p.id, 0).runs.total, 0);
  git("restore", "tracked.txt");
  await automation.poll();
  const run = await until(() => automation.list(p.id, 0).runs.items[0], (item) => item?.status === "SUCCEEDED");
  assert.deepEqual(run.trigger, { type: "GIT_COMMIT", branch, commit });
  assert.match(automation.detail(p.id, run.id).log, /local-check-passed/);
  await automation.poll();
  assert.equal(automation.list(p.id, 0).runs.total, 1);
});

test("failed and stopped automations skip subsequent commands", async (t) => {
  const { app, p } = fixture(t);
  const automation = app.automations;
  const node = (name) => '"' + process.execPath + '" ' + name;
  fs.writeFileSync(path.join(p.root, "fail.mjs"), 'console.error("Test failed"); process.exitCode = 7;');
  fs.writeFileSync(path.join(p.root, "wait.mjs"), 'console.log("Waiting"); setInterval(() => {}, 1000);');
  fs.writeFileSync(path.join(p.root, "later.mjs"), 'import fs from "node:fs"; fs.writeFileSync("unexpected.txt", "ran");');
  const second = { name: "Should not run", command: node("later.mjs") };
  const flow = automation.create(p.id, { name: "Local test", steps: [{ name: "Test", command: node("fail.mjs") }, second] });
  const failed = automation.start(p.id, flow.id, { version: flow.version });
  const failure = await until(() => automation.detail(p.id, failed.id), (run) => run.status === "FAILED");
  assert.equal(failure.steps[0].exitCode, 7);
  assert.equal(failure.steps[1].status, "SKIPPED");
  assert.match(failure.log, /Test failed/);
  const edited = automation.update(p.id, flow.id, {
    name: flow.name, version: flow.version, steps: [{ name: "Wait", command: node("wait.mjs") }, second],
  });
  const started = automation.start(p.id, flow.id, { version: edited.version });
  const detail = () => automation.detail(p.id, started.id);
  await until(detail, (run) => run.log.includes("Waiting"));
  automation.stop(p.id, started.id);
  const stopped = await until(detail, (run) => run.status === "CANCELED");
  assert.equal(stopped.steps[1].status, "SKIPPED");
  assert.equal(fs.existsSync(path.join(p.root, "unexpected.txt")), false);
  assert.equal(automation.busy(p.id), false);
});
