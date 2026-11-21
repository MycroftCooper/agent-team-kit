import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { createServer } from "../apps/backend/src/server.mjs";
import { fixture, node, plan, finish } from "../test/helpers.mjs";
import { openBrowser } from "./browser.mjs";

const output = path.resolve("artifacts/task-movement-e2e"); fs.mkdirSync(output, { recursive: true }); process.env.ATK_TEST_ROOT = output;
const f = fixture(), human = (key, more = {}) => node(key, { executorType: "HUMAN", roleId: null, files: [], ...more });
const manualPlan = plan(f, [human("manual", { title: "核对登录说明", files: ["manual.txt"], checks: [{ name: "manual-check", command: "Check the login instructions" }] })], { title: "登录说明验收" });
const manualId = manualPlan.tasks[0].id;
const retryPlan = plan(f, [node("retry", { title: "补齐导出文件检查" })], { title: "导出检查" });
finish(f, f.app.claim(f.dev.agent.id, { taskId: retryPlan.tasks[0].id }), { outcome: "FAILED" });
const acceptPlan = plan(f, [node("accept", { title: "实现导出结果" })], { title: "验收导出功能" });
const acceptRun = f.app.claim(f.dev.agent.id, { taskId: acceptPlan.tasks[0].id }); fs.writeFileSync(path.join(f.p.root, "accept.txt"), "verified"); finish(f, acceptRun);
const agentPlan = plan(f, [node("agent", { title: "实现账户校验" })], { title: "账户校验需求" });
const agentRun = f.app.claim(f.dev.agent.id, { taskId: agentPlan.tasks[0].id });
const dependencyPlan = plan(f, [node("upstream"), human("waiting", { title: "等待前置核对", deps: ["upstream"] })]);
const uncertainAgent = f.app.createAgent({ projectId: f.p.id, name: "Uncertain worker", roleId: "role-dev" });
const uncertainPlan = plan(f, [node("uncertain", { title: "旧运行尚未停止" })]);
const uncertain = f.app.claim(uncertainAgent.agent.id, { taskId: uncertainPlan.tasks[0].id });
f.app.store.put("runs", { ...f.app.get("runs", uncertain.run.id), leaseUntil: 0 }); f.app.maintenance({ documents: false, drift: false });
const noPlan = f.app.createDraft({ projectId: f.p.id, title: "尚未规划的需求", description: "Needs a real plan" });
const approval = f.app.createDraft({ projectId: f.p.id, title: "批准登录方案", description: "Review a submitted plan" });
const planning = f.app.claim(f.pm.agent.id, { taskId: approval.id });
f.app.submitPlan(f.pm.agent.id, planning.run.id, { generation: planning.generation, idempotencyKey: crypto.randomUUID(), plan: { summary: "One small login task", nodes: [node("welcome", { title: "实现欢迎提示" })] } });
const server = createServer({ service: f.app }), info = await server.listen({ port: 0 });
let browser, heartbeat;
const checks = [];
const card = (id) => `document.querySelector('.board-card:has([data-move-handle="${id}"])')`;
const taskStatus = (id) => f.app.get("tasks", id).status;
async function step(name, fn) { await fn(); checks.push(name); console.log("PASS", name); }
async function closeModal() { await browser.click("关闭", { exact: true, within: "document.querySelector('[role=dialog]')" }); await browser.wait("!document.querySelector('[role=dialog]')"); }
async function beginDrag(id) {
  await browser.wait(`!!(${card(id)}) && !(${card(id)}.querySelector('[data-move-handle]')).disabled`);
  const point = await browser.evaluate(`(()=>{const e=${card(id)}.querySelector('[data-move-handle]');e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
  await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x + 16, y: point.y + 8, buttons: 1 });
  await browser.wait("!!document.querySelector('.task-move-ghost')");
}
async function releaseTo(column, lane) {
  const selector = lane ? `.swimlane-lane[data-lane=${lane}] [data-column=${column}]` : `.board [data-column=${column}]`;
  const point = await browser.evaluate(`(()=>{const col=document.querySelector(${JSON.stringify(selector)});const e=col.querySelector('.task-drop-target')??col;e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, buttons: 1 });
  await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 });
  await browser.wait("!document.querySelector('.task-move-ghost')");
}
async function move(id, column, lane) { await beginDrag(id); await releaseTo(column, lane); }
async function display(open) { const expanded = await browser.evaluate("document.querySelector('[aria-controls=task-display-options]').getAttribute('aria-expanded')==='true'"); if (expanded !== open) await browser.click("显示设置", { exact: true }); }
try {
  heartbeat = setInterval(() => { if (f.app.get("runs", agentRun.run.id).status === "RUNNING") f.app.heartbeat(f.dev.agent.id, agentRun.run.id, { generation: agentRun.generation }); }, 8000);
  browser = await openBrowser({ url: info.browserUrl, outputDir: output, width: 1800, height: 1100 });
  await browser.wait("!!document.querySelector('[name=workspace]')"); await browser.fill("workspace", f.p.id);
  await browser.click("工作", { exact: true, within: "document.querySelector('.sidebar')" }); await browser.click("任务", { exact: true, within: "document.querySelector('.work-nav')" });
  await step("invalid cards expose reasons and actual agent/verification stages cannot be dragged", async () => {
    await browser.wait(`!!(${card(noPlan.id)})?.querySelector('[data-move-handle]')`);
    for (const id of [noPlan.id, agentPlan.tasks[0].id, acceptPlan.tasks[0].id, uncertainPlan.tasks[0].id, dependencyPlan.tasks[1].id])
      assert.equal(await browser.evaluate(`${card(id)}.querySelector('[data-move-handle]').disabled`), true);
    assert.ok(await browser.evaluate(`${card(uncertainPlan.tasks[0].id)}.innerText.includes('确认旧运行已停止')`));
    await browser.screenshot("01-board-actions");
  });
  await step("dragging human work starts a real leased run and cancels an unconfirmed delivery", async () => {
    await move(manualId, "running"); await browser.wait(`${card(manualId)}?.closest('[data-column]').dataset.column==='running'`);
    assert.equal(taskStatus(manualId), "RUNNING"); assert.equal(f.app.list("locks").items.some(l => l.taskId === manualId), true);
    await move(manualId, "closed"); await browser.wait("document.querySelector('[role=dialog] h2')?.textContent==='完成人工任务'");
    assert.equal(taskStatus(manualId), "RUNNING"); await browser.screenshot("02-human-delivery-panel");
    await browser.click("取消", { exact: true, within: "document.querySelector('[role=dialog]')" }); await browser.wait("!document.querySelector('[role=dialog]')"); assert.equal(taskStatus(manualId), "RUNNING");
  });
  await step("an old human delivery form cannot complete a restarted run", async () => {
    await move(manualId, "closed"); await browser.wait("!!document.querySelector('[name=summary]')"); await browser.fill("summary", "Preserve my notes");
    const previous = f.app.get("tasks", manualId); f.app.requestStop(previous.humanRun.id); f.app.confirmStopped(previous.humanRun.id, { confirmStopped: true });
    f.app.retryTask(manualId, { version: f.app.get("tasks", manualId).version }); f.app.startHuman(manualId, { version: f.app.get("tasks", manualId).version });
    await browser.wait("document.querySelector('[role=dialog] [role=alert]')?.textContent.includes('任务或运行已变化')");
    assert.equal(await browser.evaluate("document.querySelector('[name=summary]').value"), "Preserve my notes");
    assert.equal(await browser.evaluate("document.querySelector('[role=dialog] button.primary').disabled"), true); await closeModal();
    await move(manualId, "closed"); await browser.wait("!!document.querySelector('[name=summary]')");
    fs.writeFileSync(path.join(f.p.root, "manual.txt"), "checked"); await browser.fill("summary", "Checked the actual instructions");
    await browser.fill("log0", "Instruction and fixture checks passed"); await browser.evaluate("document.querySelector('[name=passed0]').click()"); await browser.submit();
    await browser.wait("!document.querySelector('[role=dialog]')"); assert.equal(taskStatus(manualId), "DONE");
    assert.equal(f.app.get("runs", f.app.get("tasks", manualId).latestRunId).artifact.summary, "Checked the actual instructions");
  });
  await step("draft drag reviews the submitted plan and approval creates the real child tasks", async () => {
    await move(approval.id, "queue"); await browser.wait("!!document.querySelector('[role=dialog] .plan-nodes') || document.querySelector('[role=dialog]')?.innerText.includes('批准此版本并开放执行')");
    assert.equal(taskStatus(approval.id), "DRAFT"); await closeModal(); assert.equal(f.app.list("tasks", { parentId: approval.id }).total, 0);
    await move(approval.id, "queue"); await browser.click("批准此版本并开放执行", { exact: true }); await browser.wait("!document.querySelector('[role=dialog]')");
    assert.equal(taskStatus(approval.id), "READY"); assert.equal(f.app.list("tasks", { parentId: approval.id }).total, 1);
  });
  await step("blocked work drag requires requeue confirmation and preserves uncertainty barriers", async () => {
    const id = retryPlan.tasks[0].id; await move(id, "queue"); await browser.wait("document.querySelector('[role=dialog] h2')?.textContent==='重新排队'");
    assert.equal(taskStatus(id), "BLOCKED"); await browser.click("取消", { exact: true, within: "document.querySelector('[role=dialog]')" }); await browser.wait("!document.querySelector('[role=dialog]')");
    await move(id, "queue"); await browser.click("确认重新排队", { exact: true, within: "document.querySelector('[role=dialog]')" }); await browser.wait("!document.querySelector('[role=dialog]')"); assert.equal(taskStatus(id), "READY");
    assert.equal(taskStatus(uncertainPlan.tasks[0].id), "BLOCKED");
  });
  await step("whole requirement acceptance shows affected children and closes them only on confirmation", async () => {
    await move(acceptPlan.draft.id, "closed"); await browser.wait("document.querySelector('.acceptance-impact')?.innerText.includes('实现导出结果')");
    assert.equal(taskStatus(acceptPlan.tasks[0].id), "VERIFIED"); await browser.screenshot("03-whole-plan-acceptance");
    await browser.click("确认整份计划验收通过", { exact: true }); await browser.wait("!document.querySelector('[role=dialog]')");
    assert.equal(taskStatus(acceptPlan.draft.id), "DONE"); assert.equal(taskStatus(acceptPlan.tasks[0].id), "DONE");
  });
  await step("keyboard equivalent actions, Escape and concurrent SSE cancel a stale drag", async () => {
    const extra = plan(f, [human("extra", { title: "键盘操作核对" })]); const id = extra.tasks[0].id;
    await browser.wait(`!!(${card(id)})`);
    await browser.send("Page.bringToFront");
    await browser.evaluate(`${card(id)}.querySelector('.task-move-menu-trigger').focus()`);
    assert.equal(await browser.evaluate("document.activeElement.classList.contains('task-move-menu-trigger')"), true);
    await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
    await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await browser.wait(`!!(${card(id)}.querySelector('.task-move-menu'))`);
    await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" }); await browser.wait("!document.querySelector('.task-move-menu')"); assert.equal(taskStatus(id), "READY");
    await beginDrag(id); const row = f.app.get("tasks", id); f.app.updateTaskMetadata(id, { version: row.version, tags: ["Concurrent update"] });
    await browser.wait("!document.querySelector('.task-move-ghost') && document.querySelector('.task-move-feedback')?.textContent.includes('已取消移动')");
    await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 500, y: 400, button: "left", buttons: 0 }); assert.equal(taskStatus(id), "READY");
    await browser.evaluate(`${card(id)}.querySelector('.task-move-menu-trigger').click()`); await browser.click("开始人工任务", { exact: true, within: card(id) + ".querySelector('.task-move-menu')" });
    await browser.wait(`${card(id)}?.closest('[data-column]').dataset.column==='running'`); assert.equal(taskStatus(id), "RUNNING");
  });
  await step("executor grouping has no state targets and swimlanes reject moving across execution types", async () => {
    await display(true); await browser.fill("taskGrouping", "owner"); await display(false); await browser.wait("!!document.querySelector('[data-column=HUMAN]')"); assert.equal(await browser.evaluate("document.querySelectorAll('[data-move-handle]').length"), 0);
    await display(true); await browser.click("泳道", { exact: true, within: "document.querySelector('.task-layout-options')" }); await display(false);
    const h = plan(f, [human("lane", { title: "泳道内核对" })]); const id = h.tasks[0].id;
    await browser.wait(`!!(${card(id)})`); await beginDrag(id); await releaseTo("running", "AGENT"); assert.equal(taskStatus(id), "READY");
    await move(id, "running", "HUMAN"); await browser.wait(`${card(id)}?.closest('[data-column]').dataset.column==='running'`); assert.equal(taskStatus(id), "RUNNING");
  });
  await step("narrow keyboard moves preserve filters when the task leaves the filtered column", async () => {
    await display(true); await browser.click("看板", { exact: true, within: "document.querySelector('.task-layout-options')" });
    await browser.wait("!!document.querySelector('[name=taskGrouping]')"); await browser.fill("taskGrouping", "flow"); await display(false);
    const h = plan(f, [human("filtered", { title: "筛选内人工任务" })]); const id = h.tasks[0].id;
    await browser.fill("taskStatus", "READY"); await browser.fill("taskOwner", "HUMAN");
    await browser.wait(`!!(${card(id)})`);
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 480, height: 900, deviceScaleFactor: 1, mobile: false });
    await browser.evaluate(`${card(id)}.scrollIntoView({block:'center',inline:'center'});${card(id)}.querySelector('.task-move-menu-trigger').click()`);
    await browser.click("开始人工任务", { exact: true, within: card(id) + ".querySelector('.task-move-menu')" });
    await browser.wait(`!(${card(id)})`); assert.equal(taskStatus(id), "RUNNING");
    assert.equal(await browser.evaluate("document.querySelector('[name=taskStatus]').value"), "READY");
    assert.equal(await browser.evaluate("document.querySelector('[name=taskOwner]').value"), "HUMAN");
    assert.equal(await browser.evaluate("document.documentElement.scrollWidth>innerWidth"), false);
    assert.ok(await browser.evaluate("document.querySelector('.task-move-feedback').textContent.includes('移出当前筛选')"));
    await browser.screenshot("04-filtered-narrow-board");
  });
  assert.deepEqual(browser.errors, []); fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) { if (browser) { console.error("Browser errors", browser.errors); await browser.screenshot("failure").catch(() => {}); console.error(await browser.evaluate("({dialog:document.querySelector('[role=dialog]')?.innerText,alerts:[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent),feedback:document.querySelector('.task-move-feedback')?.textContent})").catch(() => null)); } throw error;
} finally { clearInterval(heartbeat); await browser?.close(); await server.close(); if (!path.resolve(f.root).startsWith(output + path.sep)) throw new Error("Unexpected fixture root"); fs.rmSync(f.root, { recursive: true, force: true }); }
