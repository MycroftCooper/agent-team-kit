import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer } from "../apps/backend/src/server.mjs";
import { createAgentClient } from "../packages/agent-client/src/index.mjs";
import { fixture, node, plan, finish } from "../test/helpers.mjs";
import { openBrowser } from "./browser.mjs";

const output = path.resolve("artifacts/collaboration-e2e");
fs.mkdirSync(output, { recursive: true });
process.env.ATK_TEST_ROOT = output;
const f = fixture();
const second = f.app.createProject({ name: "Other project", root: fs.mkdtempSync(path.join(f.root, "other-project-")) });
f.app.createAgent({ projectId: second.id, name: "Only in project B", roleId: "role-dev" });
const planned = plan(f, [
  node("contract", { title: "确定接口约定" }),
  node("login", { title: "开发登录接口", deps: ["contract"], reviewPolicy: "INDEPENDENT", reviewRoleId: "role-qa" }),
  node("human", { title: "核对登录说明", executorType: "HUMAN", files: [], deps: ["login"] }),
], { title: "支持账号登录" });
finish(f, f.app.claim(f.dev.agent.id, { taskId: planned.tasks[0].id }));
const server = createServer({ service: f.app });
const info = await server.listen({ port: 0 });
const dev = createAgentClient({ baseUrl: info.url, credential: f.dev.credential });
const qa = createAgentClient({ baseUrl: info.url, credential: f.qa.credential });
let browser, contactTimer;
const checks = [];
async function step(name, fn) { await fn(); checks.push(name); console.log("PASS", name); }
async function workPage(name) {
  if (!await browser.evaluate("!!document.querySelector('.work-sidebar')")) await browser.click("工作", { exact: true, within: "document.querySelector('.sidebar')" });
  await browser.click(name, { exact: true, within: "document.querySelector('.work-nav')" });
}
async function closeDrawer() { await browser.click("关闭", { exact: true, within: "document.querySelector('.detail-pane')" }); await browser.wait("!document.querySelector('.detail-pane')"); }
try {
  browser = await openBrowser({ url: info.browserUrl, outputDir: output });
  await browser.wait("!!document.querySelector('[name=workspace]')");
  await browser.fill("workspace", f.p.id);
  contactTimer = setInterval(() => { for (const a of [f.pm, f.dev, f.qa]) f.app.heartbeat(a.agent.id, null, {}); }, 4000);
  await step("project roster and initial snapshot contain no other-project identity", async () => {
    await workPage("协作实况");
    await browser.wait("document.querySelectorAll('.collab-agent').length===3");
    assert.equal(await browser.evaluate("document.querySelector('.collaboration').innerText.includes('Only in project B')"), false);
    assert.equal(await browser.evaluate("document.querySelector('.collab-token strong').textContent"), "开发登录接口");
    assert.equal(await browser.evaluate("Boolean(document.querySelector('.detail-pane'))"), false);
    await browser.screenshot("01-project-collaboration");
  });
  await step("one nonmodal task drawer opens, changes task, folds sections, and restores focus on close", async () => {
    await browser.evaluate("document.querySelector('.collab-token').click()");
    await browser.wait("document.querySelector('.detail-heading h2')?.textContent==='开发登录接口'");
    assert.equal(await browser.evaluate("document.querySelector('.detail-pane').getAttribute('aria-modal')"), "false");
    assert.equal(await browser.evaluate("document.querySelector('.main').inert"), false);
    await browser.evaluate("void(window.sharedDrawer=document.querySelector('.detail-pane'))");
    await browser.click("看工作拆分", { exact: true });
    await browser.evaluate("[...document.querySelectorAll('.collab-task')].find(b=>b.querySelector('strong')?.textContent==='确定接口约定').click()");
    await browser.wait("document.querySelector('.detail-heading h2')?.textContent==='确定接口约定'");
    assert.equal(await browser.evaluate("document.querySelector('.detail-pane')===window.sharedDrawer && document.querySelectorAll('.detail-pane').length===1"), true);
    const criteria = "[...document.querySelectorAll('.detail-pane details')].find(d=>d.querySelector('summary')?.textContent==='验收条件')";
    assert.equal(await browser.evaluate(`${criteria}.open`), false);
    await browser.evaluate(`${criteria}.querySelector('summary').click()`);
    assert.equal(await browser.evaluate(`${criteria}.open`), true);
    await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await browser.wait("!document.querySelector('.detail-pane')");
    await browser.click("看 Agent", { exact: true });
  });
  await step("claim, progress and independent review update the view with real event motion", async () => {
    await browser.evaluate(`(()=>{const select=document.querySelector('.collab-current select');select.value=${JSON.stringify(planned.tasks[1].id)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await browser.wait("document.querySelector('.collab-token strong')?.textContent==='开发登录接口'");
    await browser.evaluate("window.flowMotions=[];window.animateOriginal=Element.prototype.animate;Element.prototype.animate=function(frames,opts){if(this.matches('.collab-token'))window.flowMotions.push(frames);return window.animateOriginal.call(this,frames,opts)}");
    const claimed = await dev.claim({ taskId: planned.tasks[1].id, waitMs: 0 });
    await browser.wait("document.querySelector('.collab-flow li.current')?.textContent==='执行中'");
    await browser.wait("window.flowMotions.length>0");
    await dev.events(claimed.run.id, claimed.generation, [{ eventId: crypto.randomUUID(), type: "progress", message: "正在实现账号校验" }]);
    await browser.wait("document.querySelector('.collab-agent-work')?.innerText.includes('正在实现账号校验')");
    await browser.screenshot("02-executing");
    await dev.submit(claimed.run.id, "result", { generation: claimed.generation, outcome: "COMPLETED", stopped: true, summary: "登录接口已完成", checks: [] });
    await browser.wait("document.querySelector('.collab-flow li.current')?.textContent==='独立检查'");
    const review = await qa.claim({ taskId: planned.tasks[1].id, waitMs: 0 });
    await browser.wait("[...document.querySelectorAll('.collab-agent')].some(c=>c.querySelector('strong')?.textContent==='qa'&&c.innerText.includes('开发登录接口'))");
    const worker = f.app.get("tasks", planned.tasks[1].id);
    await qa.submit(review.run.id, "review", { generation: review.generation, targetHash: worker.resultHash, verdict: "PASS", summary: "独立检查通过" });
    await browser.wait("document.querySelector('.collab-flow li.current')?.textContent==='已验证'");
    await browser.screenshot("03-review-verified");
  });
  await step("task drawer keeps task filters, and run names use the same task details", async () => {
    await workPage("任务");
    await browser.evaluate("(()=>{const input=document.querySelector('[aria-label=搜索工作空间任务]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'登录');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await browser.wait("[...document.querySelectorAll('.board-card-main')].some(b=>b.querySelector(':scope > strong')?.textContent==='支持账号登录')");
    await browser.evaluate("[...document.querySelectorAll('.board-card-main')].find(b=>b.querySelector(':scope > strong')?.textContent==='支持账号登录').click()");
    await browser.wait("document.querySelector('.detail-heading h2')?.textContent==='支持账号登录'");
    await closeDrawer();
    assert.equal(await browser.evaluate("document.querySelector('[aria-label=搜索工作空间任务]').value"), "登录");
    await workPage("执行记录");
    await browser.wait("[...document.querySelectorAll('.run-row .text-button')].some(b=>b.innerText.includes('开发登录接口'))");
    await browser.evaluate("[...document.querySelectorAll('.run-row .text-button')].find(b=>b.innerText.includes('开发登录接口')).click()");
    await browser.wait("document.querySelector('.detail-heading h2')?.textContent==='开发登录接口'");
    await closeDrawer();
  });
  await step("human work is shown separately and project switching clears both drawer and roster", async () => {
    const human = f.app.get("tasks", planned.tasks[2].id);
    f.app.startHuman(human.id, { version: human.version });
    await workPage("待我处理");
    await browser.wait("[...document.querySelectorAll('.inbox-row .text-button')].some(b=>b.textContent==='核对登录说明')");
    await browser.evaluate("[...document.querySelectorAll('.inbox-row .text-button')].find(b=>b.textContent==='核对登录说明').click()");
    await browser.wait("document.querySelector('.detail-heading h2')?.textContent==='核对登录说明'");
    await closeDrawer();
    const bug = f.app.createBug({ projectId: f.p.id, roleId: "role-dev", title: "登录错误提示", description: "修复登录错误提示" });
    await workPage("Bug 单");
    await browser.wait("[...document.querySelectorAll('.bug-title, .text-button')].some(b=>b.textContent==='登录错误提示')");
    await browser.evaluate("[...document.querySelectorAll('.text-button')].find(b=>b.textContent==='登录错误提示').click()");
    await browser.wait("document.querySelector('.detail-heading h2')?.textContent==='登录错误提示'");
    assert.equal(new URL(await browser.evaluate("location.href")).searchParams.get("task"), bug.id);
    await closeDrawer();
    await workPage("协作实况");
    await browser.wait("document.querySelector('.collab-human')?.innerText.includes('核对登录说明')");
    await browser.evaluate("(()=>{const select=document.querySelector('.collab-controls select');select.value=select.options[1].value;select.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await browser.wait("document.querySelector('.collab-controls select')?.value!==''");
    await browser.wait("!!document.querySelector('.collab-human button')");
    await browser.evaluate("document.querySelector('.collab-human button').click()");
    await browser.wait("document.querySelector('.detail-heading h2')?.textContent==='核对登录说明'");
    await browser.fill("workspace", second.id);
    await browser.wait("document.querySelector('.collab-agent strong')?.textContent==='Only in project B' && !document.querySelector('.detail-pane')");
    assert.equal(await browser.evaluate("document.querySelector('.collaboration').innerText.includes('开发登录接口')"), false);
    await browser.fill("workspace", f.p.id);
    await browser.wait("document.querySelectorAll('.collab-agent').length===3");
    assert.ok(f.app.store.activeRuns().some((r) => r.taskId === human.id));
  });
  await step("legacy identity project assignment is available in Settings without exposing it in project lists", async () => {
    const legacy = f.app.createAgent({ projectId: f.p.id, name: "旧身份待归属", roleId: "role-dev" });
    f.app.store.put("agents", { ...legacy.agent, projectId: null });
    await browser.click("设置与运维", { exact: true });
    await browser.wait("document.querySelector('.agent-migration')?.innerText.includes('旧身份待归属')");
    await browser.evaluate(`(()=>{const select=document.querySelector('.agent-migration select');select.value=${JSON.stringify(f.p.id)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await browser.click("确认项目归属", { exact: true });
    await browser.wait("!document.querySelector('.agent-migration')");
    assert.equal(f.app.get("agents", legacy.agent.id).projectId, f.p.id);
  });
  await step("shared drawer and collaboration fit narrow screens and honor reduced motion", async () => {
    await workPage("协作实况");
    await browser.wait("document.querySelectorAll('.collab-agent').length===4");
    await browser.evaluate("document.querySelector('.collab-token').click()");
    await browser.wait("!!document.querySelector('.detail-pane')");
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await browser.wait("document.querySelector('.detail-pane').getAnimations().every(a=>a.playState!=='running')");
    assert.equal(await browser.evaluate("(()=>{const r=document.querySelector('.detail-pane').getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1;})()"), true);
    assert.equal(await browser.evaluate("(()=>{const r=document.querySelector('.detail-pane .modal-close').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})()"), true);
    assert.equal(await browser.evaluate("document.querySelector('.detail-pane').scrollWidth>document.querySelector('.detail-pane').clientWidth"), false);
    await browser.screenshot("04-task-drawer-narrow");
    await closeDrawer();
    assert.equal(await browser.evaluate("document.documentElement.scrollWidth>innerWidth"), false);
    await browser.screenshot("05-collaboration-narrow");
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await browser.evaluate("document.querySelector('.collab-token').click()");
    assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.detail-pane')).animationName"), "none");
  });
  assert.deepEqual(browser.errors, []);
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ checks, passed: true }, null, 2));
} catch (error) {
  if (browser) {
    await browser.screenshot("failure").catch(() => {});
    console.error(await browser.evaluate("({heading:document.querySelector('.detail-heading h2')?.textContent,alerts:[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent),url:location.pathname+location.search})").catch(() => null));
  }
  throw error;
} finally {
  clearInterval(contactTimer);
  await browser?.close(); await server.close();
  if (!path.resolve(f.root).startsWith(output + path.sep)) throw new Error("Unexpected fixture path");
  fs.rmSync(f.root, { recursive: true, force: true });
}
