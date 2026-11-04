import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { createServer } from "../apps/backend/src/server.mjs";
import { createAgentClient } from "../packages/agent-client/src/index.mjs";
import { openBrowser } from "./browser.mjs";
const arg = process.argv.indexOf("--duration");
const duration = arg >= 0 ? Number(process.argv[arg + 1]) : 30 * 60 * 1000;
const output = path.resolve(
    process.argv.includes("--output")
      ? process.argv[process.argv.indexOf("--output") + 1]
      : "artifacts/benchmark",
  ),
  root = fs.mkdtempSync(
    path.join((fs.mkdirSync(output, { recursive: true }), output), "case-"),
  );
const appServer = createServer({ dataDir: path.join(root, "data") }),
  { url } = await appServer.listen({ port: 0 }),
  app = appServer.app;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  percentile = (arr, p) =>
    [...arr].sort((a, b) => a - b)[Math.floor((arr.length - 1) * p)] ?? 0;
const timings = [],
  samples = [],
  failures = [];
let browser,
  running = true,
  logTimer;
const started = Date.now();
const report = {
  seed: 20261105,
  durationMs: duration,
  machine: {
    platform: process.platform,
    node: process.version,
    cpus: os.cpus().length,
    cpu: os.cpus()[0]?.model,
    memoryGiB: Math.round(os.totalmem() / 1024 ** 3),
  },
  dataset: { projects: 10, tasks: 10000, clients: 20 },
  samples,
};
try {
  const projects = [];
  for (let i = 0; i < 10; i++) {
    const dir = path.join(root, `project-${i}`);
    fs.mkdirSync(dir);
    projects.push(app.createProject({ name: `Benchmark ${i}`, root: dir }));
  }
  const pm = app.createAgent({
      name: "Seed PM",
      roleId: "role-pm",
      teamId: "team-default",
    }),
    draft = app.createDraft({
      projectId: projects[0].id,
      title: "Benchmark stream",
      description: "Read-only protocol workload",
    });
  const planning = app.claim(pm.agent.id, { taskId: draft.id });
  const submitted = app.submitPlan(pm.agent.id, planning.run.id, {
    generation: planning.generation,
    idempotencyKey: "seed-plan",
    plan: {
      summary: "Benchmark fixture",
      nodes: [
        {
          key: "stream",
          title: "Benchmark stream",
          description: "Emit bounded progress events",
          acceptance: "Bounded buffers",
          roleId: "role-dev",
          files: [],
          checks: [],
          reviewPolicy: "NONE",
          deps: [],
        },
      ],
    },
  });
  app.approvePlan(submitted.plan.id, { version: submitted.plan.version });
  app.store.tx(() => {
    for (let i = 2; i < 10000; i++)
      app.store.put("tasks", {
        id: `bench-${String(i).padStart(5, "0")}`,
        createdAt: new Date(1700000000000 + i).toISOString(),
        projectId: projects[i % 10].id,
        kind: "WORK",
        parentId: null,
        planId: null,
        title: `Historical task ${i}`,
        description: "Fixed seed history; no model context attached",
        acceptance: "Fixture",
        executorType: "AGENT",
        roleId: "role-dev",
        priority: i % 4,
        status: "DONE",
        files: [],
        checks: [],
        deps: [],
      });
  });
  const clients = [];
  for (let i = 0; i < 20; i++) {
    const a = app.createAgent({
      name: `Benchmark Agent ${i}`,
      roleId: "role-dev",
      teamId: "team-default",
    });
    const client = createAgentClient({
      baseUrl: url,
      credential: a.credential,
    });
    await client.connect();
    clients.push(client);
  }
  const active = await clients[0].claim({
    taskId: app.list("tasks", { parentId: draft.id }).items[0].id,
    waitMs: 0,
  });
  const stopWatch = clients[0].watch(active.run.id, active.generation, {
    onError: (e) => failures.push(e.message),
    onStop: () => failures.push("unexpected stop"),
  });
  const session = await fetch(url + "/api/v1/session").then((r) => r.json());
  for (let wave = 0; wave < 10; wave++)
    await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const begin = performance.now();
        if (i % 3 === 0) await clients[1].claim({ waitMs: 0 });
        else {
          const endpoint =
            i % 3 === 1
              ? "/api/v1/tasks?limit=50"
              : "/api/v1/tasks/bench-00002";
          const r = await fetch(url + endpoint, {
            headers: { "x-atk-token": session.token },
          });
          assert.ok(r.ok);
          await r.json();
        }
        timings.push(performance.now() - begin);
      }),
    );
  console.log(
    "Metadata round-trip p95:",
    percentile(timings, 0.95).toFixed(2),
    "ms",
  );
  browser = await openBrowser({
    url,
    outputDir: output,
    width: 1440,
    height: 1000,
  });
  await browser.wait("document.body.innerText.includes('概览')");
  await browser.click("执行记录", { exact: true });
  await browser.wait("document.body.innerText.includes('Benchmark stream')");
  await browser.evaluate(
    `[...document.querySelectorAll('.run-row')].find(r=>r.textContent.includes(${JSON.stringify(active.run.id)})).click()`,
  );
  await browser.wait("!!document.querySelector('.timeline')");
  for (let i = 0; i < 300; i += 100)
    await clients[0].events(
      active.run.id,
      active.generation,
      Array.from({ length: 100 }, (_, j) => ({
        eventId: crypto.randomUUID(),
        type: "log",
        message: `Warmup ${i + j}`,
      })),
    );
  await browser.wait(
    "document.querySelector('.timeline').children.length===100",
  );
  const pollers = clients.slice(1).map(async (client) => {
    while (running) {
      try {
        await client.claim({ waitMs: 30000 });
      } catch (e) {
        if (running) failures.push(e.message);
        await sleep(1000);
      }
    }
  });
  let tick = 0;
  logTimer = setInterval(() => {
    void clients[0]
      .events(active.run.id, active.generation, [
        {
          eventId: crypto.randomUUID(),
          type: "progress",
          message: `Soak tick ${++tick}`,
        },
      ])
      .catch((e) => failures.push(e.message));
  }, 1000);
  const soakStart = Date.now();
  while (Date.now() - soakStart < duration) {
    const sample = await browser.evaluate(
      "({domNodes:document.querySelectorAll('*').length,timeline:document.querySelector('.timeline')?.children.length,heap:performance.memory?.usedJSHeapSize})",
    );
    samples.push({ elapsedMs: Date.now() - soakStart, ...sample });
    if (samples.length % 12 === 1)
      console.log(
        `Soak ${Math.round((Date.now() - soakStart) / 1000)}s / ${duration / 1000}s, DOM ${sample.domNodes}, timeline ${sample.timeline}`,
      );
    await sleep(Math.min(5000, duration - (Date.now() - soakStart)));
  }
  running = false;
  clearInterval(logTimer);
  stopWatch();
  const begin = performance.now();
  await clients[0].submit(active.run.id, "result", {
    generation: active.generation,
    outcome: "COMPLETED",
    stopped: true,
    idempotencyKey: "soak-finish",
    summary: "Soak completed",
  });
  await browser.wait(
    "document.querySelector('[role=dialog] .badge')?.textContent.includes('执行结束')",
  );
  const refreshMs = performance.now() - begin;
  assert.ok(
    percentile(timings, 0.95) <= 300,
    `p95 exceeds 300ms: ${percentile(timings, 0.95)}`,
  );
  assert.ok(refreshMs <= 1000, `UI latency exceeds 1s: ${refreshMs}`);
  assert.ok(samples.every((s) => s.timeline <= 100));
  assert.ok(
    Math.max(...samples.map((s) => s.domNodes)) <= samples[0].domNodes + 30,
    "DOM grew beyond the bounded timeline",
  );
  assert.deepEqual(failures, []);
  assert.deepEqual(browser.errors, []);
  await browser.screenshot("soak-final");
  Object.assign(report, {
    passed: true,
    fullThirtyMinutes: duration >= 1800000,
    metadataP95Ms: percentile(timings, 0.95),
    uiRefreshMs: refreshMs,
    roundTrips: timings,
    failures,
    totalMs: Date.now() - started,
  });
  fs.writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    "BENCHMARK PASSED",
    JSON.stringify({
      durationMs: duration,
      p95: report.metadataP95Ms,
      uiRefreshMs: refreshMs,
    }),
  );
  // Long polls return on timeout; do not close their service underneath them.
  await Promise.race([Promise.allSettled(pollers), sleep(31000)]);
} catch (e) {
  running = false;
  Object.assign(report, { passed: false, error: e.stack, failures });
  fs.writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  throw e;
} finally {
  running = false;
  clearInterval(logTimer);
  await browser?.close();
  await appServer.close();
}
