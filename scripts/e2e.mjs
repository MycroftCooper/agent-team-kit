import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer } from "../apps/backend/src/server.mjs";
import { createAgentClient } from "../packages/agent-client/src/index.mjs";
import { openBrowser } from "./browser.mjs";
const output = path.resolve("artifacts/e2e"),
  root = fs.mkdtempSync(
    path.join((fs.mkdirSync(output, { recursive: true }), output), "case-"),
  );
const projectRoot = path.join(root, "project");
fs.mkdirSync(projectRoot);
const server = createServer({ dataDir: path.join(root, "data") }),
  info = await server.listen({ port: 0 });
let browser;
const steps = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function step(name, fn) {
  await fn();
  steps.push({ name, passed: true, at: new Date().toISOString() });
  console.log("PASS", name);
}
try {
  browser = await openBrowser({ url: info.url, outputDir: output });
  await browser.wait("document.body.innerText.includes('概览')");
  await step("Linear workspace renders without overflow", async () => {
    await browser.wait("document.body.innerText.includes('添加本地项目')");
    assert.equal(
      await browser.evaluate("document.documentElement.scrollWidth>innerWidth"),
      false,
    );
    await browser.screenshot("01-workspace-empty");
  });
  await step("register a non-Git project from the UI", async () => {
    await browser.click("添加本地项目");
    await browser.fill("name", "Browser Project");
    await browser.fill("root", projectRoot);
    await browser.submit();
    await browser.wait(
      "!document.querySelector('[role=dialog]') && document.body.innerText.includes('Browser Project')",
    );
  });
  const credentials = {};
  await step(
    "create PM, worker and reviewer identities in the UI",
    async () => {
      await browser.click("Agent 与团队");
      for (const [name, role] of [
        ["PM Browser", "role-pm"],
        ["Developer Browser", "role-dev"],
        ["Reviewer Browser", "role-qa"],
      ]) {
        await browser.click("添加 Agent");
        await browser.fill("name", name);
        await browser.fill("roleId", role);
        await browser.submit();
        await browser.wait("!!document.querySelector('.credential')");
        credentials[role] = await browser.evaluate(
          "document.querySelector('.credential').textContent",
        );
        await browser.evaluate(
          "document.querySelector('.modal-close').click()",
        );
      }
      await browser.screenshot("02-agent-team");
    },
  );
  const project = server.app.list("projects").items[0];
  await step("submit a DRAFT request in the browser", async () => {
    await browser.click("新建需求");
    await browser.fill("title", "Build the release summary");
    await browser.fill(
      "description",
      "Create an output, ask a human to confirm, and then finalize it.",
    );
    await browser.fill(
      "acceptance",
      "The delivery contains first.txt and final.txt.",
    );
    await browser.submit();
    await browser.wait("!document.querySelector('[role=dialog]')");
    await browser.click("预排池");
    await browser.wait(
      "document.body.innerText.includes('Build the release summary')",
    );
  });
  const pm = createAgentClient({
      baseUrl: info.url,
      credential: credentials["role-pm"],
    }),
    dev = createAgentClient({
      baseUrl: info.url,
      credential: credentials["role-dev"],
    }),
    qa = createAgentClient({
      baseUrl: info.url,
      credential: credentials["role-qa"],
    });
  let submitted;
  await step("external PM pulls and submits a structured plan", async () => {
    const claim = await pm.claim({ projectId: project.id, waitMs: 0 });
    submitted = await pm.submit(claim.run.id, "plan", {
      generation: claim.generation,
      plan: {
        summary:
          "Produce a reviewed first output, obtain human confirmation, then create the final output.",
        nodes: [
          {
            key: "first",
            title: "Produce first output",
            description: "Write first.txt",
            acceptance: "first.txt exists",
            roleId: "role-dev",
            files: ["first.txt"],
            checks: [{ name: "first-check", command: "node check-first.mjs" }],
            reviewPolicy: "INDEPENDENT",
            reviewRoleId: "role-qa",
            deps: [],
          },
          {
            key: "human",
            title: "Confirm the release content",
            description: "Read the first output and confirm",
            acceptance: "Human confirms the content",
            executorType: "HUMAN",
            files: [],
            checks: [],
            reviewPolicy: "NONE",
            deps: ["first"],
          },
          {
            key: "last",
            title: "Finalize release",
            description: "Write final.txt",
            acceptance: "final.txt exists",
            roleId: "role-dev",
            files: ["final.txt"],
            checks: [],
            reviewPolicy: "NONE",
            deps: ["human"],
          },
        ],
      },
    });
    assert.equal((await dev.claim({ waitMs: 0 })).run, null);
  });
  await step("approve the exact plan version in the UI", async () => {
    await browser.click("待我处理");
    await browser.wait("document.body.innerText.includes('审阅计划')");
    await browser.click("审阅计划");
    await browser.wait(
      "document.body.innerText.includes('Produce first output')",
    );
    await browser.screenshot("03-plan-approval");
    await browser.click("批准此版本并开放执行");
    await browser.wait("!document.querySelector('[role=dialog]')");
  });
  await step("worker output updates the task list through SSE", async () => {
    const claim = await dev.claim({ waitMs: 0 });
    await browser.click("任务", { exact: true });
    await browser.wait(
      "document.body.innerText.includes('Produce first output')",
    );
    fs.writeFileSync(
      path.join(projectRoot, "first.txt"),
      "Reviewed first output\n",
    );
    const start = performance.now();
    await dev.submit(claim.run.id, "result", {
      generation: claim.generation,
      outcome: "COMPLETED",
      stopped: true,
      summary: "First output ready",
      checks: [
        {
          name: "first-check",
          passed: true,
          exitCode: 0,
          log: "first.txt exists",
        },
      ],
    });
    await browser.wait(
      "[...document.querySelectorAll('.task-row')].some(r=>r.textContent.includes('Produce first output')&&r.textContent.includes('待评审'))",
    );
    steps.push({ name: "ui-refresh-latency", ms: performance.now() - start });
    await browser.screenshot("04-live-task-list");
  });
  await step("independent reviewer unlocks the human dependency", async () => {
    const r = await qa.claim({ waitMs: 0 });
    assert.ok(r.run);
    await qa.submit(r.run.id, "review", {
      generation: r.generation,
      targetHash: r.spec.targetHash,
      verdict: "PASS",
      summary: "The frozen output meets the criteria.",
    });
    await browser.click("待我处理");
    await browser.wait(
      "document.body.innerText.includes('Confirm the release content')",
    );
    await browser.click("开始处理");
    await browser.wait("document.body.innerText.includes('确认完成')");
    await browser.click("确认完成");
    await browser.fill("summary", "The release content is correct.");
    await browser.submit();
    await browser.wait("!document.querySelector('[role=dialog]')");
  });
  await step(
    "finish downstream work and accept the plan in the UI",
    async () => {
      const r = await dev.claim({ waitMs: 0 });
      assert.ok(r.run);
      fs.writeFileSync(
        path.join(projectRoot, "final.txt"),
        "Release complete\n",
      );
      await dev.submit(r.run.id, "result", {
        generation: r.generation,
        outcome: "COMPLETED",
        stopped: true,
        summary: "Final release ready",
      });
      await browser.wait("document.body.innerText.includes('查看交付')");
      await browser.click("查看交付");
      await browser.screenshot("05-plan-acceptance");
      await browser.click("确认整份计划验收通过");
      await browser.wait("!document.querySelector('[role=dialog]')");
      assert.equal(
        server.app.get("tasks", submitted.plan.sourceTaskId).status,
        "DONE",
      );
    },
  );
  await step(
    "language switch, keyboard navigation and 1280px layout",
    async () => {
      await browser.click("EN", { exact: true });
      await browser.wait("document.body.innerText.includes('My inbox')");
      await browser.click("Overview", { exact: true });
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      assert.equal(
        await browser.evaluate(
          "document.documentElement.scrollWidth>innerWidth",
        ),
        false,
      );
      await browser.screenshot("06-workspace-en-1280");
    },
  );
  await step(
    "keyboard dialog and form preservation during SSE refresh",
    async () => {
      await browser.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "n",
        code: "KeyN",
      });
      await browser.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "n",
        code: "KeyN",
      });
      await browser.wait(
        "!!document.querySelector('[role=dialog] input[name=title]')",
      );
      await browser.fill("title", "Preserve entered text");
      server.app.createDraft({
        projectId: project.id,
        title: "Concurrent intake update",
        description: "SSE form preservation check",
      });
      await sleep(500);
      assert.equal(
        await browser.evaluate("document.querySelector('[name=title]').value"),
        "Preserve entered text",
      );
      await browser.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
      });
      await browser.wait("!document.querySelector('[role=dialog]')");
    },
  );
  await step(
    "plan revision and human-readable version comparison",
    async () => {
      const draft = server.app
        .list("tasks", { status: "DRAFT" })
        .items.find((t) => t.title === "Concurrent intake update");
      const node = {
        key: "compare",
        title: "Compare task",
        description: "Comparison fixture",
        acceptance: "Old acceptance",
        roleId: "role-dev",
        files: [],
        checks: [],
        reviewPolicy: "NONE",
        deps: [],
      };
      let run = await pm.claim({ taskId: draft.id, waitMs: 0 });
      await pm.submit(run.run.id, "plan", {
        generation: run.generation,
        plan: { summary: "First comparison plan", nodes: [node] },
      });
      await browser.click("My inbox", { exact: true });
      await browser.wait("document.body.innerText.includes('Review plan')");
      await browser.click("Review plan");
      await browser.wait(
        "document.body.innerText.includes('First comparison plan')",
      );
      await browser.click("Request revision");
      await browser.fill("reason", "Make the acceptance clearer");
      await browser.submit();
      await browser.wait("!document.querySelector('[role=dialog]')");
      run = await pm.claim({ taskId: draft.id, waitMs: 0 });
      assert.equal(run.spec.revisionNote, "Make the acceptance clearer");
      await pm.submit(run.run.id, "plan", {
        generation: run.generation,
        plan: {
          summary: "Second comparison plan",
          nodes: [{ ...node, acceptance: "New acceptance" }],
        },
      });
      await browser.wait("document.body.innerText.includes('Review plan')");
      await browser.click("Review plan");
      await browser.wait("!!document.querySelector('.plan-comparison')");
      await browser.evaluate(
        "document.querySelector('.plan-comparison > summary').click();document.querySelector('.plan-comparison .diff > summary').click()",
      );
      await browser.wait(
        "document.body.innerText.includes('Old acceptance') && document.body.innerText.includes('New acceptance')",
      );
      await browser.screenshot("07-plan-comparison");
      await browser.evaluate("document.querySelector('.modal-close').click()");
    },
  );
  await step(
    "browser reconnect fills missed task updates without duplicates",
    async () => {
      await browser.click("Intake", { exact: true });
      await browser.send("Network.enable");
      await browser.send("Network.emulateNetworkConditions", {
        offline: true,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await sleep(150);
      server.app.createDraft({
        projectId: project.id,
        title: "Reconnect delivery",
        description: "Created while the browser was offline",
      });
      await sleep(300);
      await browser.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await browser.wait(
        "document.body.innerText.includes('Reconnect delivery')",
        15000,
      );
      assert.equal(
        await browser.evaluate(
          "[...document.querySelectorAll('.task-row')].filter(r=>r.textContent.includes('Reconnect delivery')).length",
        ),
        1,
      );
    },
  );
  assert.deepEqual(browser.errors, []);
  fs.writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify({ passed: true, steps, errors: browser.errors }, null, 2),
  );
  console.log(`E2E PASSED (${steps.length} checks) ${output}`);
} catch (e) {
  if (browser) {
    await browser.screenshot("failure").catch(() => {});
    console.error(
      await browser.evaluate("document.body.innerText").catch(() => ""),
    );
  }
  fs.writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify({ passed: false, steps, error: e.stack }, null, 2),
  );
  throw e;
} finally {
  await browser?.close();
  await server.close();
}
