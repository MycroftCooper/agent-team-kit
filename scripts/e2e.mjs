import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
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
const primaryRailWidth = "document.querySelector('.sidebar').offsetWidth";
const leftSecondarySidebar = "(()=>{const rail=document.querySelector('.sidebar').getBoundingClientRect(), section=document.querySelector('.section-sidebar').getBoundingClientRect(), main=document.querySelector('.main').getBoundingClientRect();return rail.right===section.left && section.right===main.left && section.top===rail.top;})()";
async function step(name, fn) {
  await fn();
  steps.push({ name, passed: true, at: new Date().toISOString() });
  console.log("PASS", name);
}
async function displayMenu(open) {
  const current = await browser.evaluate("document.querySelector('[aria-controls=task-display-options]')?.getAttribute('aria-expanded') === 'true'");
  if (current !== open) await browser.click("显示设置", { exact: true });
}
async function taskLayout(name) {
  await displayMenu(true);
  await browser.click(name, { exact: true, within: "document.querySelector('.task-layout-options')" });
  await displayMenu(false);
}
async function workPage(name) {
  const menu = "document.querySelector('.work-sidebar .work-nav')";
  if (!await browser.evaluate(`!!${menu}`)) {
    const english = await browser.evaluate("document.documentElement.lang === 'en'");
    await browser.click(english ? "Work" : "工作", { exact: true });
    await browser.wait(`!!${menu}`);
  }
  await browser.click(name, { exact: true, within: menu });
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
    assert.equal(await browser.evaluate("!!document.querySelector('.topbar [name=workspace]') && !document.querySelector('.sidebar .brand, .sidebar .workspace-switch')"), true);
    assert.equal(
      await browser.evaluate("document.documentElement.scrollWidth>innerWidth"),
      false,
    );
    await browser.screenshot("01-workspace-empty");
  });
  await step("browser appearance switches, persists, and can follow the OS", async () => {
    assert.equal(await browser.evaluate("typeof window.atkDesktop"), "undefined");
    assert.equal(await browser.evaluate("Boolean(document.querySelector('.desktop-titlebar'))"), false);
    const background = "getComputedStyle(document.documentElement).backgroundColor";
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await browser.wait(`document.documentElement.dataset.theme === "system" && ${background} === "rgb(11, 12, 14)"`);
    await browser.click("切换到浅色主题", { exact: true, within: "document.querySelector('.app-footer')" });
    await browser.wait(`${background} === "rgb(247, 248, 251)"`);
    await browser.send("Page.reload");
    await browser.wait(`document.querySelector('.topbar') && ${background} === "rgb(247, 248, 251)"`);
    await browser.click("设置与运维", { exact: true });
    await browser.fill("theme", "system");
    await browser.wait(`${background} === "rgb(11, 12, 14)"`);
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await browser.wait(`${background} === "rgb(247, 248, 251)"`);
    await browser.fill("theme", "dark");
    await browser.click("概览", { exact: true });
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
  const overviewRailWidth = await browser.evaluate(primaryRailWidth);
  await step("automation shows live progress, elapsed time, custom fields and logs", async () => {
    fs.writeFileSync(path.join(projectRoot, "automation-check.mjs"), [
      'import fs from "node:fs";',
      'console.log(\'::atk::{"progress":40,"info":{"artifact":"demo.txt"}}\');',
      'while (!fs.existsSync("automation-continue.txt")) await new Promise((resolve) => setTimeout(resolve, 50));',
      'console.log("Local check passed");',
    ].join("\n"));
    await browser.click("自动化", { exact: true });
    await browser.click("新建流程", { exact: true });
    await browser.click("演示流程", { exact: true });
    await browser.fill("stepCommand", '"' + process.execPath + '" automation-check.mjs');
    await browser.fill("automationInfo", "Environment=local");
    await browser.submit();
    await browser.wait("!document.querySelector('[role=dialog]')");
    await browser.click("运行", { exact: true, within: "[...document.querySelectorAll('.automation-row')].find(row=>row.textContent.includes('演示流程'))" });
    await browser.wait("document.querySelector('.automation-progress progress')?.value === 20 && document.querySelector('.automation-run-meta strong')?.textContent !== '00:00:00' && document.querySelector('.automation-info')?.innerText.includes('demo.txt')");
    await browser.screenshot("automation-running");
    fs.writeFileSync(path.join(projectRoot, "automation-continue.txt"), "");
    await browser.wait("document.querySelector('.automation-progress progress')?.value === 100 && document.querySelector('.automation-run .section-title .badge')?.dataset.status === 'SUCCEEDED' && document.querySelector('.automation-log')?.textContent.includes('Local check passed')");
    assert.equal(await browser.evaluate("document.querySelector('.automation-info').innerText.includes('Environment')"), true);
    await browser.click("概览", { exact: true, within: "document.querySelector('.sidebar')" });
  });
  await step("a built-in workflow can watch a project-specific Git branch from the UI", async () => {
    const branch = "checks/browser";
    const git = (...args) => execFileSync("git", [
      "-c", "user.name=ATK Browser Test", "-c", "user.email=atk@example.test",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=.git/no-hooks", ...args,
    ], { cwd: projectRoot, encoding: "utf8", windowsHide: true }).trim();
    git("init", "-b", branch);
    git("commit", "--allow-empty", "-m", "baseline");
    await browser.click("自动化", { exact: true });
    const nav = await browser.evaluate("[...document.querySelectorAll('.sidebar nav button')].map(button=>button.getAttribute('aria-label'))");
    assert.deepEqual(nav.slice(1, 4), ["工作", "自动化", "Agent 团队"]);
    const smoke = "[...document.querySelectorAll('.automation-row')].find(row=>row.textContent.includes('冒烟测试'))";
    await browser.click("编辑", { exact: true, within: smoke });
    assert.equal(await browser.evaluate("document.querySelector('[name=automationTrigger]').value"), "MANUAL");
    await browser.click("移除此步骤", { exact: true, within: "document.querySelectorAll('.automation-step-editor')[1]" });
    await browser.fill("stepCommand", "echo Git-triggered check passed");
    await browser.fill("automationTrigger", "GIT_COMMIT");
    await browser.fill("automationBranch", branch);
    await browser.submit();
    await browser.wait("(" + smoke + ")?.textContent.includes('checks/browser 有新提交')");
    git("commit", "--allow-empty", "-m", "trigger");
    const sha = git("rev-parse", "HEAD").slice(0, 8);
    await browser.wait("document.querySelector('.automation-trigger')?.textContent.includes('" + sha + "') && document.querySelector('.automation-log')?.textContent.includes('Git-triggered check passed')");
    await browser.click("概览", { exact: true, within: "document.querySelector('.sidebar')" });
  });
  const credentials = {};
  await step(
    "create PM, worker and reviewer identities in the UI",
    async () => {
      await browser.click("Agent 团队", { exact: true });
      await browser.wait("!!document.querySelector('.agent-team-sidebar .agent-team-nav')");
      assert.equal(await browser.evaluate(leftSecondarySidebar), true);
      assert.equal(await browser.evaluate(primaryRailWidth), overviewRailWidth);
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
  await step("agent team shows scoped agents, role dialogs and setup resources", async () => {
    const otherTeam = server.app.createTeam({ name: "Other squad", roleIds: ["role-dev"] });
    server.app.createAgent({ name: "Outside squad agent", teamId: otherTeam.id, roleId: "role-dev" });
    const content = "document.querySelector('.agent-team-content')";
    await browser.wait(`${content}?.innerText.includes('Outside squad agent')`);
    await browser.click("我的 Agent", { exact: true });
    await browser.wait(`${content}?.innerText.includes('Developer Browser') && !${content}?.innerText.includes('Outside squad agent')`);
    const template = "document.querySelector('[role=dialog][aria-label=角色模板]')";
    const cardLayout = "[...document.querySelectorAll('.agent-card')].map(card=>[card.offsetLeft,card.offsetTop,card.offsetWidth,card.offsetHeight])";
    const originalLayout = await browser.evaluate(cardLayout);
    await browser.click("PM Browser 的角色模板", { exact: true, within: content });
    await browser.wait(`${template}?.innerText.includes('PM Browser') && ${template}?.innerText.includes('ORCHESTRATOR')`);
    await browser.click("关闭", { exact: true, within: template });
    await browser.wait(`!${template}`);
    await browser.click("Developer Browser 的角色模板", { exact: true, within: content });
    await browser.wait(`${template}?.innerText.includes('Developer Browser') && ${template}?.innerText.includes('WORKER')`);
    assert.deepEqual(await browser.evaluate(cardLayout), originalLayout);
    await browser.screenshot("02-agent-role-template");
    await browser.click("编辑模板", { exact: true, within: template });
    const developerRole = server.app.get("roles", "role-dev");
    await browser.wait(`document.querySelector('[role=dialog] [name=name]')?.value === ${JSON.stringify(developerRole.name)}`);
    await browser.click("关闭", { exact: true });
    await browser.click("小队", { exact: true });
    await browser.wait(`${content}?.innerText.includes('Other squad')`);
    await browser.click("新建角色", { exact: true, within: content });
    await browser.fill("name", "Documentation worker");
    await browser.fill("instructions", "Maintain project documentation.");
    await browser.click("保存角色", { exact: true });
    await browser.wait("!document.querySelector('[role=dialog]')");
    assert.ok(server.app.list("roles").items.some((role) => role.name === "Documentation worker"));
    await browser.click("成员", { exact: true });
    await browser.wait(`${content}?.innerText.includes('本机用户')`);
    await browser.click("Skills", { exact: true });
    await browser.wait(`${content}?.innerText.includes('skill/atk-create-automation/SKILL.md')`);
    assert.ok(await browser.evaluate(`${content}?.innerText.includes('skill/atk-create-skill/SKILL.md')`));
    assert.equal(await browser.evaluate(`${content}?.querySelector('[aria-label="编辑 atk-create-skill"], [aria-label="删除 atk-create-skill"]')`), null);
    await browser.click("查看 atk-create-skill", { exact: true, within: content });
    await browser.wait(`${content}?.querySelector('.team-resource-preview pre')?.textContent.includes('name: atk-create-skill')`);
    await browser.click("收起 atk-create-skill", { exact: true, within: content });
    assert.equal(await browser.evaluate(`${content}.innerText.includes('角色模板')`), false);
    await browser.click("新建资源", { exact: true });
    await browser.fill("resourceName", "release-notes");
    await browser.fill("resourceContent", "# Release notes\nCheck the delivered files.");
    await browser.click("创建资源", { exact: true });
    await browser.wait(`${content}?.innerText.includes('skill/release-notes/SKILL.md')`);
    assert.equal(server.app.resources.read("skill", "release-notes").content, "# Release notes\nCheck the delivered files.");
    await browser.click("编辑 release-notes", { exact: true, within: content });
    await browser.wait(`${content}?.querySelector('[name=resourceEditContent]')?.value.startsWith('# Release notes')`);
    await browser.fill("resourceEditContent", "# Updated release notes");
    await browser.click("保存修改", { exact: true, within: content });
    await browser.wait(`${content}?.querySelector('.team-resource-preview pre')?.textContent === '# Updated release notes'`);
    await browser.click("删除 release-notes", { exact: true, within: content });
    await browser.click("取消删除", { exact: true, within: content });
    assert.equal(server.app.resources.read("skill", "release-notes").content, "# Updated release notes");
    await browser.click("删除 release-notes", { exact: true, within: content });
    await browser.wait(`${content}?.querySelector('.team-resource-preview .danger')?.disabled === false`);
    await browser.click("确认删除", { exact: true, within: content });
    await browser.wait(`${content}?.querySelector('.team-resource-notice') && !${content}?.innerText.includes('skill/release-notes/SKILL.md')`);
    assert.throws(() => server.app.resources.read("skill", "release-notes"), { code: "RESOURCE_NOT_FOUND" });
    await browser.click("Agent 模板", { exact: true });
    await browser.wait(`${content}?.innerText.includes('AGENT.md')`);
    await browser.click("MCP", { exact: true });
    await browser.click("查看 CLI 接入");
    await browser.wait(`${content}?.querySelector('pre')?.textContent.includes('atk-agent connect')`);
    assert.equal(await browser.evaluate(`${content}.querySelector('pre').textContent.includes('<credential>')`), true);
    await browser.wait(`${content}?.innerText.includes('自带 CLI') && ${content}?.querySelectorAll('.team-resource-list .badge').length === 2`);
    await browser.click("查看 atk", { exact: true, within: content });
    await browser.wait(`${content}?.querySelector('.team-resource-preview pre')?.textContent.includes('atk backup')`);
    await browser.click("查看 atk-agent", { exact: true, within: content });
    await browser.wait(`${content}?.querySelector('.team-resource-preview pre')?.textContent.includes('atk-agent claim')`);
    await browser.click("全部 Agent", { exact: true });
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
    const narrowRailWidth = await browser.evaluate(primaryRailWidth);
    assert.equal(await browser.evaluate(leftSecondarySidebar), true);
    assert.equal(await browser.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    await browser.click("概览", { exact: true });
    await browser.wait("!document.querySelector('.section-sidebar')");
    assert.equal(await browser.evaluate(primaryRailWidth), narrowRailWidth);
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  });
  const project = server.app.list("projects").items[0];
  await step("work uses a secondary sidebar and new requests have their own draft column", async () => {
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
    await browser.click("工作", { exact: true });
    await browser.wait("document.querySelector('.work-sidebar [aria-current=page]')?.getAttribute('aria-label') === '任务'");
    assert.equal(await browser.evaluate(leftSecondarySidebar), true);
    assert.equal(await browser.evaluate(primaryRailWidth), overviewRailWidth);
    assert.equal(await browser.evaluate("!!document.querySelector('.sidebar [aria-label=预排池]')"), false);
    await browser.wait("document.querySelector('[data-column=draft] .board-card')?.innerText.includes('Build the release summary')");
    assert.equal(await browser.evaluate("!!document.querySelector('[data-column=queue] .board-card')"), false);
    await browser.fill("taskStatus", "DRAFT");
    await browser.wait("document.querySelectorAll('.board-column').length === 1 && !!document.querySelector('[data-column=draft] .board-card')");
    await browser.fill("taskStatus", "");
    await browser.wait("!!document.querySelector('[data-column=queue]')");
    await browser.screenshot("03-work-draft");
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
  await step("agent connection guide distinguishes valid credentials from first contact", async () => {
    await browser.click("Agent 团队", { exact: true });
    const card = "[...document.querySelectorAll('.agent-card')].find(r=>r.textContent.includes('Developer Browser'))";
    await browser.wait("Boolean(" + card + ")");
    await browser.click("接入说明", { within: card });
    await browser.wait("document.querySelector('.contact-card')?.innerText.includes('尚未联系')");
    assert.equal((await dev.doctor()).identity.lastSeen, null);
    await dev.connect();
    await browser.wait("document.querySelector('.contact-card')?.innerText.includes('最近已联系')");
    assert.equal(await browser.evaluate("document.querySelector('.command-box pre').innerText.includes('<credential>')"), true);
    await browser.screenshot("09-agent-connection");
    await browser.click("关闭", { exact: true });
  });
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
    await workPage("待我处理");
    await browser.wait("document.body.innerText.includes('审阅计划')");
    await browser.click("审阅计划");
    await browser.wait(
      "document.body.innerText.includes('Produce first output')",
    );
    await browser.screenshot("03-plan-approval");
    await browser.click("批准此版本并开放执行");
    await browser.wait("!document.querySelector('[role=dialog]')");
  });
  await step("board mixes human and agent work and lets a human reserve an agent task", async () => {
    await workPage("任务");
    await browser.wait("!!document.querySelector('.board-card[data-executor=HUMAN]') && !!document.querySelector('.board-card[data-executor=AGENT]')");
    const agentCard = "[...document.querySelectorAll('.board-card')].find(card=>card.querySelector('.board-card-main > strong')?.textContent === 'Produce first output')";
    await browser.click("指派", { within: agentCard, exact: true });
    await browser.wait("!!document.querySelector('[name=assignedAgent] option[value]:not([value=\"\"])')");
    const assigned = (await dev.doctor()).identity.id;
    await browser.fill("assignedAgent", assigned);
    await browser.click("保存指派", { exact: true });
    await browser.wait("!document.querySelector('[role=dialog]') && " + agentCard + "?.innerText.includes('Developer Browser')");
    const task = server.app.list("tasks", { projectId: project.id }).items.find((row) => row.title === "Produce first output");
    const competitor = server.app.createAgent({ name: "Another worker", roleId: "role-dev", teamId: "team-default" });
    const client = createAgentClient({ baseUrl: info.url, credential: competitor.credential });
    assert.equal((await client.claim({ taskId: task.id, waitMs: 0 })).run, null);
    await displayMenu(true);
    await browser.fill("taskGrouping", "owner");
    await displayMenu(false);
    await browser.wait("!!document.querySelector('[data-column=HUMAN] .board-card') && !!document.querySelector('[data-column=AGENT] .board-card')");
    await browser.screenshot("13-board-by-executor");
    await browser.fill("taskOwner", "HUMAN");
    await browser.wait("document.querySelectorAll('.board-column').length === 1 && !!document.querySelector('[data-column=HUMAN]')");
    await browser.fill("taskOwner", "");
    await displayMenu(true);
    await browser.fill("taskGrouping", "flow");
    await displayMenu(false);
    await browser.wait("document.querySelectorAll('.board-column').length === 7");
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.equal(await browser.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    assert.equal(await browser.evaluate("document.querySelector('.board').scrollWidth > document.querySelector('.board').clientWidth"), true);
    await browser.screenshot("15-board-narrow");
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  });
  await step("worker output updates the task list through SSE", async () => {
    await workPage("任务");
    await taskLayout("列表");
    await browser.wait("[...document.querySelectorAll('.task-row')].some(row=>row.innerText.includes('Produce first output'))");
    await browser.evaluate("[...document.querySelectorAll('.task-row')].find(row=>row.innerText.includes('Produce first output')).click()");
    await browser.wait("document.querySelector('.dispatch-notice')?.innerText.includes('等待外部 Agent 领取')");
    await browser.screenshot("12-task-claim-diagnostics");
    await browser.click("关闭", { exact: true });
    const claim = await dev.claim({ waitMs: 0 });
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
    await taskLayout("看板");
    await browser.wait("document.querySelector('[data-column=review] .board-card')?.innerText.includes('Produce first output')");
    await browser.screenshot("14-board-by-workflow");
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
    const card = "[...document.querySelectorAll('.board-card[data-executor=HUMAN]')].find(row=>row.innerText.includes('Confirm the release content'))";
    await browser.wait("Boolean(" + card + "?.querySelector('.board-card-footer button'))");
    await browser.click("开始", { within: card, exact: true });
    await browser.wait("document.querySelector('[data-column=running] .board-card[data-executor=HUMAN]')?.innerText.includes('Confirm the release content')");
    await workPage("待我处理");
    await browser.wait(
      "document.body.innerText.includes('Confirm the release content')",
    );
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
    await workPage("任务");
    await browser.wait("Boolean(" + card + "?.querySelector('.board-card-footer button'))");
    await browser.click("提交交付", { within: card, exact: true });
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
      await workPage("待我处理");
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
  await step("task and run links keep delivery context and load receipts on demand", async () => {
    const first = server.app.list("tasks", { projectId: project.id }).items.find((t) => t.title === "Produce first output");
    await workPage("任务");
    await taskLayout("列表");
    await browser.wait("[...document.querySelectorAll('.task-row')].some(row=>row.innerText.includes('Produce first output'))");
    await browser.evaluate("[...document.querySelectorAll('.task-row')].find(row=>row.innerText.includes('Produce first output')).click()");
    await browser.wait("document.querySelector('.attempt-row')?.innerText.includes('#2')");
    const taskUrl = new URL(await browser.evaluate("location.href"));
    assert.equal(taskUrl.searchParams.get("project"), project.id);
    assert.equal(taskUrl.searchParams.get("task"), first.id);
    assert.equal(taskUrl.hash, "");
    await browser.wait("document.querySelector('.delivery-footer')?.innerText.includes('查看最终验收')");
    await browser.screenshot("10-task-delivery");
    await browser.evaluate("[...document.querySelectorAll('.attempt-row')].find(row=>row.innerText.includes('#1')).click()");
    await browser.wait("document.querySelector('.detail-toolbar')?.innerText.includes('执行 #1')");
    assert.equal(await browser.evaluate("document.querySelector('.evidence-section').innerText.includes('First output ready')"), false);
    await browser.evaluate("document.querySelector('.evidence-section summary').click()");
    await browser.wait("document.querySelector('.evidence-section').innerText.includes('First output ready')");
    await browser.send("Page.reload");
    await browser.wait("document.querySelector('.detail-toolbar')?.innerText.includes('执行 #1')");
    assert.equal(await browser.evaluate("location.hash"), "");
    await browser.evaluate("history.back()");
    await browser.wait("document.querySelector('.attempt-row')?.innerText.includes('#2')");
    assert.equal(await browser.evaluate("location.href"), taskUrl.href);
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.equal(await browser.evaluate("document.querySelector('.detail-pane').scrollWidth > document.querySelector('.detail-pane').clientWidth"), false);
    await browser.screenshot("11-task-delivery-narrow");
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await browser.click("关闭", { exact: true });
  });
  await step("display settings switch all task layouts and persist across reload", async () => {
    await workPage("任务");
    await taskLayout("表格");
    await browser.wait("document.querySelectorAll('.task-table tbody tr').length === 4");
    await displayMenu(true);
    await browser.fill("taskSort", "title");
    await browser.click("切换为降序", { exact: true });
    await browser.wait("document.querySelector('.task-table tbody tr')?.innerText.includes('Produce first output')");
    await displayMenu(false);
    await browser.screenshot("18-task-table");
    await displayMenu(true);
    await browser.click("显示子任务", { exact: true });
    await browser.wait("document.querySelectorAll('.task-table tbody tr').length === 1");
    await browser.send("Page.reload");
    await browser.wait("!!document.querySelector('.nav-item[aria-label=工作]')");
    await workPage("任务");
    await browser.wait("document.querySelectorAll('.task-table tbody tr').length === 1");
    await displayMenu(true);
    assert.equal(await browser.evaluate("document.querySelector('[name=taskSort]').value"), "title");
    assert.equal(await browser.evaluate("document.querySelector('.task-display-sort button').getAttribute('aria-pressed')"), "true");
    await browser.click("显示子任务", { exact: true });
    await displayMenu(false);
    await taskLayout("泳道");
    await browser.wait("!!document.querySelector('[data-lane=HUMAN] .board-card') && !!document.querySelector('[data-lane=AGENT] .board-card')");
    await browser.screenshot("17-task-swimlanes");
    await taskLayout("看板");
    await browser.wait("document.querySelectorAll('.board > .board-column').length === 7");
    await displayMenu(true);
    await browser.click("已结束", { exact: true, within: "document.querySelector('[aria-labelledby=task-columns-label]')" });
    await browser.wait("document.querySelectorAll('.board > .board-column').length === 6 && !document.querySelector('.board > [data-column=closed]')");
    await browser.click("已结束", { exact: true, within: "document.querySelector('[aria-labelledby=task-columns-label]')" });
    await browser.click("描述", { exact: true, within: "document.querySelector('[aria-labelledby=task-card-fields-label]')" });
    await browser.wait("[...document.querySelectorAll('.board-card-description')].some(node=>node.innerText.includes('Write first.txt'))");
    await browser.screenshot("16-task-display-settings");
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.equal(await browser.evaluate("(()=>{ const r=document.querySelector('.task-display-menu').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()"), true);
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await browser.click("描述", { exact: true, within: "document.querySelector('[aria-labelledby=task-card-fields-label]')" });
    await browser.fill("taskSort", "priority");
    await browser.click("切换为升序", { exact: true });
    await displayMenu(false);
    await taskLayout("列表");
  });
  await step("edit due date and tags, toggle their card properties, and filter across views", async () => {
    const row = "[...document.querySelectorAll('.task-row')].find(row=>row.innerText.includes('Produce first output'))";
    await browser.wait("Boolean(" + row + ")");
    await browser.evaluate(row + ".click()");
    await browser.click("编辑日期和标签", { exact: true });
    await browser.fill("dueDate", "2031-04-05");
    await browser.fill("tagInput", "回归");
    await browser.click("添加标签", { exact: true });
    await browser.click("保存日期和标签", { exact: true });
    await browser.wait("document.querySelector('.task-metadata-summary')?.innerText.includes('2031-04-05') && document.querySelector('.task-metadata-summary')?.innerText.includes('回归')");
    await browser.click("关闭", { exact: true });

    await taskLayout("看板");
    await browser.wait("document.querySelector('.board-card .task-deadline')?.innerText.includes('2031-04-05')");
    await displayMenu(true);
    const properties = "document.querySelector('[aria-labelledby=task-card-fields-label]')";
    await browser.click("截止日期", { exact: true, within: properties });
    await browser.click("标签", { exact: true, within: properties });
    await browser.wait("!!document.querySelector('.board-card') && !document.querySelector('.board-card .task-deadline, .board-card .task-tags')");
    await browser.click("截止日期", { exact: true, within: properties });
    await browser.click("标签", { exact: true, within: properties });
    await displayMenu(false);

    await browser.click("日期和标签筛选", { exact: true });
    await browser.fill("deadlineFilter", "on");
    await browser.fill("deadlineDay", "2031-04-05");
    await browser.wait("!!document.querySelector('[name=tagFilter] option[value=回归]')");
    await browser.fill("tagFilter", "回归");
    await browser.wait("document.querySelectorAll('.board-card').length === 1 && document.querySelector('.board-card')?.innerText.includes('Produce first output')");
    await browser.screenshot("19-task-date-and-tag-filters");
    await browser.click("日期和标签筛选", { exact: true });
    await taskLayout("表格");
    await browser.wait("document.querySelectorAll('.task-table tbody tr').length === 1 && document.querySelector('.task-table tbody tr')?.innerText.includes('回归')");
    await browser.click("Produce first output", { exact: true, within: "document.querySelector('.task-table')" });
    await browser.click("编辑日期和标签", { exact: true });
    await browser.click("清除日期", { exact: true });
    await browser.click("移除标签 回归", { exact: true });
    await browser.click("保存日期和标签", { exact: true });
    await browser.wait("document.querySelector('.task-metadata-summary')?.innerText.includes('未设截止日期') && !document.querySelector('.task-metadata-summary .task-tags')");
    await browser.click("关闭", { exact: true });
    await browser.click("日期和标签筛选", { exact: true });
    await browser.click("清除日期和标签筛选", { exact: true });
    await browser.click("日期和标签筛选", { exact: true });
    await taskLayout("列表");
    await browser.wait("document.querySelectorAll('.task-row').length === 4");
  });
  await step(
    "language switch, keyboard navigation and 1280px layout",
    async () => {
      await browser.click("切换到英文", { exact: true, within: "document.querySelector('.app-footer')" });
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
      await workPage("My inbox");
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
      await workPage("Tasks");
      await browser.fill("taskStatus", "DRAFT");
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
      await browser.wait("document.querySelector('.app-footer .live-label')?.textContent.trim() === 'Live'");
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
    await browser.wait("!document.querySelector('[role=dialog]') && [...document.querySelector('[name=workspace]').options].some(o=>o.textContent==='Second Workspace')");
    const other = server.app.list("projects").items.find((p) => p.name === "Second Workspace");
    await browser.wait(`document.querySelector('[name=workspace]').value === ${JSON.stringify(other.id)} && !document.querySelector('[role=dialog]')`);
    await browser.click("New request");
    assert.equal(await browser.evaluate("document.querySelector('[name=projectId]').value"), other.id);
    assert.equal(await browser.evaluate("!!document.querySelector('select[name=projectId]')"), false);
    await browser.fill("title", "Only in the second workspace");
    await browser.fill("description", "Workspace isolation fixture");
    await browser.submit();
    await browser.wait("!document.querySelector('[role=dialog]')");
    await workPage("Tasks");
    await browser.wait("document.querySelector('[data-column=draft] .board-card')?.innerText.includes('Only in the second workspace')");
    assert.equal(await browser.evaluate("document.body.innerText.includes('Reconnect delivery')"), false);
    assert.equal(await browser.evaluate("document.body.innerText.includes('Build the release summary')"), false);
    await workPage("My inbox");
    await browser.wait("document.body.innerText.includes('You’re all caught up')");
    assert.equal(await browser.evaluate("document.body.innerText.includes('Review plan')"), false);
    await workPage("Runs");
    await browser.wait("document.body.innerText.includes('No runs yet')");
    await browser.send("Page.reload");
    await browser.wait(`document.querySelector('[name=workspace]')?.value === ${JSON.stringify(other.id)}`);
    assert.equal(await browser.evaluate("localStorage.getItem('atk-workspace')"), other.id);
    await browser.screenshot("08-project-workspace");
    await browser.fill("workspace", project.id);
    await workPage("Tasks");
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
    await workPage("My inbox");
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
    const pendingAcceptance = "document.querySelector('.inbox-row:has(.status-PENDING)')";
    await browser.wait(`!!(${pendingAcceptance})`);
    await browser.click("Inspect output", { exact: true, within: pendingAcceptance });
    await browser.click("Accept this plan", { exact: true });
    await browser.wait("!document.querySelector('[role=dialog]')");
    assert.equal(server.app.get("tasks", draft.id).status, "DONE");
  });
  await step("report a bug, return the first fix, and accept the second in the UI", async () => {
    await workPage("Bugs");
    await browser.click("New bug");
    await browser.fill("bugTitle", "Opening a widget fails");
    await browser.fill("bugDescription", "Open the same widget twice; the second open fails.");
    await browser.fill("bugFiles", "bug-demo.txt");
    await browser.click("Create bug", { exact: true });
    await browser.wait("!document.querySelector('[role=dialog]') && document.querySelector('.task-list')?.innerText.includes('To fix')");
    const attempt = await dev.claim({ projectId: project.id, kind: "BUG", waitMs: 0 });
    assert.equal(attempt.spec.taskKind, "BUG");
    await browser.wait("document.querySelector('.task-list')?.innerText.includes('Fixing')");
    const submitFix = async (claim, content) => {
      fs.writeFileSync(path.join(projectRoot, "bug-demo.txt"), content);
      await dev.submit(claim.run.id, "result", { generation: claim.generation, outcome: "COMPLETED", stopped: true, summary: content });
    };
    await submitFix(attempt, "Initial widget fix");
    await workPage("My inbox");
    await browser.click("Review bug fix", { exact: true });
    await browser.click("Reject and return", { exact: true });
    await browser.fill("bugRejectionReason", "Check repeated opens");
    await browser.click("Return to repair queue", { exact: true });
    await browser.wait("document.querySelector('.detail-heading')?.innerText.includes('To fix')");
    const next = await dev.claim({ projectId: project.id, kind: "BUG", waitMs: 0 });
    assert.equal(next.spec.rework.summary, "Check repeated opens");
    await submitFix(next, "Repeated opens now work");
    await browser.click("Accept and close", { exact: true });
    await browser.wait("document.querySelector('.detail-heading')?.innerText.includes('Closed')");
    await browser.click("Close", { exact: true });
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
