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
  await step("web access stays locked until opened with the private launcher link", async () => {
    await browser.wait("document.body.innerText.includes('解锁工作空间')");
    await browser.fill("accessCode", "not-the-access-code");
    await browser.evaluate("document.querySelector('.auth-panel form').requestSubmit()");
    await browser.wait("document.body.innerText.includes('解锁失败')");
    await browser.send("Page.navigate", { url: info.browserUrl });
    await browser.wait("document.body.innerText.includes('概览')");
    assert.equal(await browser.evaluate("location.hash"), "");
    assert.equal(await browser.evaluate("localStorage.getItem('atk-browser-access')"), null);
  });
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
    const heartbeatRoot = path.join(root, "heartbeat-workspace");
    fs.mkdirSync(heartbeatRoot);
    const heartbeatProject = server.app.createProject({
      name: "Heartbeat Workspace",
      root: heartbeatRoot,
    });
    await browser.wait(`!!document.querySelector('[name=workspace] option[value="${heartbeatProject.id}"]')`);
    await browser.fill("workspace", heartbeatProject.id);
    await browser.wait("document.body.innerText.includes('当前没有待处理事项')");
    const humanRun = server.app.list("runs", { projectId: project.id }).items.find((r) => r.stage === "HUMAN");
    const leaseBefore = humanRun.leaseUntil;
    await sleep(11000);
    assert.ok(server.app.get("runs", humanRun.id).leaseUntil > leaseBefore, "human lease renews while another workspace is selected");
    await browser.fill("workspace", project.id);
    await browser.wait("document.body.innerText.includes('确认完成')");
    server.app.updateProject(heartbeatProject.id, { version: heartbeatProject.version, archived: true });
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
  await step("project workspaces switch every business page and persist across reloads", async () => {
    const otherRoot = path.join(root, "other-project");
    fs.mkdirSync(otherRoot);
    await browser.click("Projects", { exact: true });
    await browser.click("Add local project");
    await browser.fill("name", "Second Workspace");
    await browser.fill("root", otherRoot);
    await browser.submit();
    const other = server.app.list("projects").items.find((p) => p.name === "Second Workspace");
    await browser.wait(`document.querySelector('[name=workspace]').value === ${JSON.stringify(other.id)} && !document.querySelector('[role=dialog]')`);
    await browser.click("New request");
    assert.equal(await browser.evaluate("document.querySelector('[name=projectId]').value"), other.id);
    assert.equal(await browser.evaluate("!!document.querySelector('select[name=projectId]')"), false);
    await browser.fill("title", "Only in the second workspace");
    await browser.fill("description", "Workspace isolation fixture");
    await browser.submit();
    await browser.wait("!document.querySelector('[role=dialog]')");
    await browser.click("Intake", { exact: true });
    await browser.wait("document.body.innerText.includes('Only in the second workspace')");
    assert.equal(await browser.evaluate("document.body.innerText.includes('Reconnect delivery')"), false);
    await browser.click("Tasks", { exact: true });
    await browser.wait("document.body.innerText.includes('Only in the second workspace')");
    assert.equal(await browser.evaluate("document.body.innerText.includes('Build the release summary')"), false);
    await browser.click("My inbox", { exact: true });
    await browser.wait("document.body.innerText.includes('You’re all caught up')");
    assert.equal(await browser.evaluate("document.body.innerText.includes('Review plan')"), false);
    await browser.click("Runs", { exact: true });
    await browser.wait("document.body.innerText.includes('No runs yet')");
    await browser.send("Page.reload");
    await browser.wait(`document.querySelector('[name=workspace]')?.value === ${JSON.stringify(other.id)}`);
    assert.equal(await browser.evaluate("localStorage.getItem('atk-workspace')"), other.id);
    await browser.screenshot("08-project-workspace");
    await browser.fill("workspace", project.id);
    await browser.click("Intake", { exact: true });
    await browser.wait("document.body.innerText.includes('Reconnect delivery')");
    assert.equal(await browser.evaluate("document.body.innerText.includes('Only in the second workspace')"), false);
    await browser.evaluate("(()=>{const el=document.querySelector('.search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'No matching tasks');el.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await browser.wait("!document.querySelector('.task-row')");
    await browser.fill("workspace", other.id);
    await browser.wait("document.body.innerText.includes('Only in the second workspace')");
    await browser.click("Projects", { exact: true });
    await browser.click("Archive", { exact: true, within: "[...document.querySelectorAll('.list-row')].find(r=>r.textContent.includes('Second Workspace'))" });
    await browser.wait(`document.querySelector('[name=workspace]').value === ${JSON.stringify(project.id)} && localStorage.getItem('atk-workspace') === ${JSON.stringify(project.id)}`);
    assert.equal(await browser.evaluate(`!!document.querySelector('[name=workspace] option[value="${other.id}"]')`), false);
    await browser.evaluate("localStorage.setItem('atk-workspace','missing-project')");
    await browser.send("Page.reload");
    await browser.wait(`document.querySelector('[name=workspace]')?.value === ${JSON.stringify(project.id)} && localStorage.getItem('atk-workspace') === ${JSON.stringify(project.id)}`);
  });
  await step("human delivery drift can be reopened and finally accepted entirely in the UI", async () => {
    const draft = server.app.createDraft({ projectId: project.id, title: "Human drift recovery", description: "Confirm a human-owned file" });
    const planning = await pm.claim({ taskId: draft.id, waitMs: 0 });
    await pm.submit(planning.run.id, "plan", {
      generation: planning.generation,
      plan: { summary: "Human drift recovery", nodes: [{ key: "human", title: "Reconfirm manual output", description: "Read manual.txt", acceptance: "Confirm current contents", executorType: "HUMAN", files: ["manual.txt"], checks: [], reviewPolicy: "NONE", deps: [] }] },
    });
    await browser.click("My inbox", { exact: true });
    await browser.wait("[...document.querySelectorAll('.inbox-row')].some(r=>r.textContent.includes('Human drift recovery'))");
    await browser.click("Review plan", { within: "[...document.querySelectorAll('.inbox-row')].find(r=>r.textContent.includes('Human drift recovery'))" });
    await browser.click("Approve this version & release tasks");
    await browser.wait("!document.querySelector('[role=dialog]')");
    await browser.click("Start", { exact: true });
    fs.writeFileSync(path.join(projectRoot, "manual.txt"), "confirmed");
    await browser.click("Complete", { exact: true });
    await browser.fill("summary", "Confirmed original contents");
    await browser.submit();
    await browser.wait("!document.querySelector('[role=dialog]')");
    await browser.wait("document.body.innerText.includes('Inspect output')");
    fs.writeFileSync(path.join(projectRoot, "manual.txt"), "changed");
    await browser.click("Inspect output");
    await browser.click("Detect changes & revalidate");
    await browser.wait("!document.querySelector('[role=dialog]')");
    await browser.wait("[...document.querySelectorAll('.inbox-row')].some(r=>r.textContent.includes('Reconfirm manual output') && r.textContent.includes('Open task'))");
    await browser.click("Open task", { within: "[...document.querySelectorAll('.inbox-row')].find(r=>r.textContent.includes('Reconfirm manual output'))" });
    await browser.click("Requeue task");
    await browser.wait("!document.querySelector('[role=dialog]')");
    await browser.click("Start", { exact: true });
    await browser.click("Complete", { exact: true });
    await browser.fill("summary", "Reconfirmed changed contents");
    await browser.submit();
    await browser.wait("!document.querySelector('[role=dialog]')");
    await browser.click("Inspect output");
    await browser.click("Accept this plan", { exact: true });
    await browser.wait("!document.querySelector('[role=dialog]')");
    assert.equal(server.app.get("tasks", draft.id).status, "DONE");
  });
  await step("manual access-code unlock survives reload without exposing the code in the URL", async () => {
    await browser.evaluate("sessionStorage.clear()");
    await browser.send("Page.reload");
    await browser.wait("!!document.querySelector('[name=accessCode]:not(:disabled)')");
    const accessCode = new URLSearchParams(new URL(info.browserUrl).hash.slice(1)).get("access");
    await browser.fill("accessCode", accessCode);
    await browser.evaluate("document.querySelector('.auth-panel form').requestSubmit()");
    await browser.wait("!!document.querySelector('[name=workspace]')");
    await browser.send("Page.reload");
    await browser.wait("!!document.querySelector('[name=workspace]')");
    assert.equal(await browser.evaluate("location.hash"), "");
  });
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
