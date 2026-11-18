import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createServer } from "../apps/backend/src/server.mjs";
import { fixture, node, plan, completeHuman } from "../test/helpers.mjs";
import { openBrowser } from "./browser.mjs";

const output = path.resolve("artifacts/task-lifecycle-e2e"); fs.mkdirSync(output, { recursive: true }); process.env.ATK_TEST_ROOT = output;
const f = fixture(), manual = (key, title) => node(key, { title, executorType: "HUMAN", roleId: null, files: [] });
const graph = plan(f, [node("cancel", { title: "准备旧版接口" }), node("dependent", { title: "接入旧版接口", deps: ["cancel"] }), manual("done", "已经完成的核对")], { title: "旧版接口需求" });
f.app.startHuman(graph.tasks[2].id, { version: graph.tasks[2].version }); completeHuman(f, graph.tasks[2].id, { summary: "Keep this completed evidence" });
const live = plan(f, [node("live", { title: "正在修改导出文件" })], { title: "导出功能需求" });
const run = f.app.claim(f.dev.agent.id, { taskId: live.tasks[0].id });
const other = f.app.createProject({ name: "历史项目", root: fs.mkdtempSync(path.join(f.root, "archived-project-")) });
const old = plan({ ...f, p: other }, [manual("past", "历史人工核对")], { title: "历史需求" });
f.app.startHuman(old.tasks[0].id, { version: old.tasks[0].version }); completeHuman(f, old.tasks[0].id, { summary: "Historical delivery remains readable" });
const oldAcceptance = f.app.inbox(other.id).acceptances[0]; f.app.accept(oldAcceptance.id, { version: oldAcceptance.version, targetHash: oldAcceptance.targetHash });
plan({ ...f, p: other }, [node("old-dependency", { title: "历史前置工作" }), { ...manual("old-waiting", "历史待依赖核对"), deps: ["old-dependency"] }], { title: "历史未完成需求" });
f.app.updateProject(other.id, { version: f.app.get("projects", other.id).version, archived: true });
const server = createServer({ service: f.app }), info = await server.listen({ port: 0 });
let browser, heartbeat; const checks = [];
const dialog = "document.querySelector('[role=dialog]')", drawer = "document.querySelector('.detail-pane')";
async function step(name, fn) { await fn(); checks.push(name); console.log("PASS", name); }
async function work(name) { await browser.click("工作", { exact: true, within: "document.querySelector('.sidebar')" }); await browser.click(name, { exact: true, within: "document.querySelector('.work-nav')" }); }
async function close() { await browser.click("关闭", { exact: true, within: dialog }); }
async function task(title) {
  const target = `[...document.querySelectorAll('.board-card-main,.task-list .text-button')].find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(title)})`;
  await browser.wait(`!!(${target})`); await browser.evaluate(`${target}.click()`);
  await browser.wait(`${drawer}?.querySelector('h2')?.textContent===${JSON.stringify(title)}`);
}
async function confirmCancellation(reason) { await browser.fill("cancellationReason", reason); await browser.wait("!document.querySelector('[name=confirmCancellation]').disabled"); await browser.evaluate("document.querySelector('[name=confirmCancellation]').click()"); await browser.submit(); await browser.wait("!document.querySelector('[name=cancellationReason]')"); }
try {
  heartbeat = setInterval(() => { if (f.app.get("runs", run.run.id).status === "RUNNING") f.app.heartbeat(f.dev.agent.id, run.run.id, { generation: run.generation }); }, 8000);
  browser = await openBrowser({ url: info.browserUrl, outputDir: output });
  await browser.wait("!!document.querySelector('[name=workspace]')"); await browser.fill("workspace", f.p.id); await work("任务");
  await step("cancellation previews downstream work and cancelling the panel preserves state", async () => {
    await task("准备旧版接口"); await browser.click("取消任务…", { exact: true });
    await browser.wait(`${dialog}?.innerText.includes('接入旧版接口')`);
    assert.equal(await browser.evaluate(`${dialog}.innerText.includes('已经完成的核对')`), false);
    await browser.click("返回", { exact: true, within: dialog }); await browser.wait(`!!${drawer}`);
    assert.equal(f.app.get("tasks", graph.tasks[0].id).status, "READY");
  });
  await step("SSE changes require reviewing the new impact without losing cancellation notes", async () => {
    await browser.click("取消任务…", { exact: true }); await browser.fill("cancellationReason", "旧接口不再需要");
    const dep = f.app.get("tasks", graph.tasks[1].id); f.app.updateTaskMetadata(dep.id, { version: dep.version, tags: ["Updated while reviewing"] });
    await browser.wait(`${dialog}?.querySelector('[role=alert]')?.textContent.includes('影响范围已变化')`);
    assert.equal(await browser.evaluate("document.querySelector('[name=cancellationReason]').value"), "旧接口不再需要");
    assert.equal(await browser.evaluate(`${dialog}.querySelector('form button.danger').disabled`), true);
    await browser.click("已重新核对上述范围", { exact: true }); await browser.screenshot("01-cancel-impact");
    await confirmCancellation("旧接口不再需要");
    assert.equal(f.app.get("tasks", graph.tasks[0].id).status, "CANCELLED");
    assert.equal(f.app.get("tasks", graph.tasks[1].id).status, "CANCELLED");
    assert.equal(f.app.get("tasks", graph.tasks[2].id).status, "DONE");
    assert.equal(f.app.get("tasks", graph.draft.id).blockReason, "TASK_CANCELLED");
    await close(); await browser.wait(`!${drawer}`);
  });
  await step("a requirement can be cancelled and archived with its closed subtasks", async () => {
    await task("旧版接口需求"); await browser.click("取消任务…", { exact: true }); await confirmCancellation("整项需求停止推进");
    await browser.click("归档任务…", { exact: true }); await browser.click("确认归档", { exact: true }); await browser.wait(`!${dialog}`);
    assert.ok(f.app.get("tasks", graph.draft.id).archivedAt);
    assert.ok(graph.tasks.every(t => f.app.get("tasks", t.id).archivedAt));
    await browser.wait("![...document.querySelectorAll('.board-card-main')].some(e=>e.textContent.includes('旧版接口需求'))");
  });
  await step("archive history shows receipts and restoring a requirement never reopens execution", async () => {
    await work("归档记录"); await browser.wait(`!!document.querySelector('[data-history-task="${graph.draft.id}"]')`);
    await browser.fill("historySearch", "旧版接口需求"); await browser.wait("document.querySelectorAll('[data-history-task]').length===1");
    await task("旧版接口需求"); await browser.screenshot("02-archive-history");
    assert.equal(await browser.evaluate(`${drawer}.innerText.includes('整项需求停止推进')`), true);
    await browser.click("恢复任务…", { exact: true }); await browser.click("确认恢复", { exact: true }); await browser.wait(`!${dialog}`);
    assert.equal(f.app.get("tasks", graph.draft.id).archivedAt, null);
    assert.equal(f.app.get("tasks", graph.draft.id).status, "CANCELLED");
    assert.equal(f.app.get("tasks", graph.tasks[2].id).status, "DONE");
    await browser.wait("document.querySelectorAll('[data-history-task]').length===0");
  });
  await step("running cancellation keeps locks until explicit stop confirmation and then allows cancellation", async () => {
    await work("任务"); await task("正在修改导出文件"); await browser.click("取消任务…", { exact: true });
    await browser.wait(`${dialog}?.innerText.includes('先处理以下运行')`);
    assert.equal(await browser.evaluate(`${dialog}.querySelector('form button.danger').disabled`), true);
    await browser.click("请求停止", { exact: true, within: dialog });
    await browser.wait(`${dialog}?.innerText.includes('待停止确认')`);
    assert.ok(f.app.list("locks").total > 0); assert.equal(f.app.get("tasks", live.tasks[0].id).status, "RUNNING");
    await browser.click("查看运行并处理停止", { exact: true }); await browser.click("确认执行已停止并释放锁", { exact: true });
    await browser.fill("reason", "External worker was stopped for cancellation"); await browser.evaluate(`${dialog}.querySelector('input[type=checkbox]').click()`); await browser.submit();
    await browser.wait(`!!${drawer}`); assert.equal(f.app.list("locks").total, 0);
    await browser.click("返回关联任务", { exact: false }); await browser.click("取消任务…", { exact: true }); await confirmCancellation("已停止，取消导出工作");
    assert.equal(f.app.get("tasks", live.tasks[0].id).status, "CANCELLED"); await close(); await browser.wait(`!${drawer}`);
  });
  await step("archived projects open directly from Projects and history stays read-only across related records", async () => {
    await browser.click("项目", { exact: true, within: "document.querySelector('.sidebar')" }); await browser.click("查看历史任务", { exact: true });
    await browser.wait(`document.querySelector('[name=historyProject]')?.value===${JSON.stringify(other.id)}`);
    await task("历史待依赖核对");
    await browser.click("历史前置工作", { exact: true, within: "document.querySelector('.detail-body')" });
    await browser.wait(`${drawer}?.querySelector('h2')?.textContent==='历史前置工作'`);
    assert.ok(await browser.evaluate(`location.search.includes(${JSON.stringify(other.id)})`));
    await close(); await browser.wait(`!${drawer}`);
    await task("历史人工核对"); await browser.wait(`${drawer}?.innerText.includes('记录只读')`);
    for (const text of ["取消任务…", "归档任务…", "恢复任务…", "编辑日期和标签"])
      assert.equal(await browser.evaluate(`[...${drawer}.querySelectorAll('button')].some(e=>e.textContent.trim()===${JSON.stringify(text)})`), false);
    await browser.evaluate("[...document.querySelectorAll('.detail-pane summary')].find(e=>e.textContent==='交付记录').click()"); await browser.wait("!!document.querySelector('.detail-pane .attempt-list .attempt-row')");
    await browser.evaluate("document.querySelector('.detail-pane .attempt-list .attempt-row').click()");
    await browser.evaluate("[...document.querySelectorAll('.detail-pane summary')].find(e=>e.textContent==='交付证据与评审').click()"); await browser.wait(`${drawer}?.innerText.includes('Historical delivery remains readable')`);
    assert.equal(f.app.get("projects", other.id).archived, true); await browser.screenshot("03-read-only-project-history");
  });
  await step("an archived-project deep link works without an active project and fits narrow screens", async () => {
    f.app.updateProject(f.p.id, { version: f.app.get("projects", f.p.id).version, archived: true });
    await browser.send("Page.reload"); await browser.wait(`${drawer}?.innerText.includes('历史人工核对')`);
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 480, height: 900, deviceScaleFactor: 1, mobile: false });
    await close(); await browser.wait(`!${drawer}`); await browser.wait("!!document.querySelector('[name=historyProject]')");
    assert.equal(await browser.evaluate("document.documentElement.scrollWidth>innerWidth"), false);
    await browser.screenshot("04-narrow-history");
    assert.equal(f.app.get("projects", other.id).archived, true);
  });
  assert.deepEqual(browser.errors, []); fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) { if (browser) { console.error("Browser errors", browser.errors); await browser.screenshot("failure").catch(() => {}); console.error(await browser.evaluate(`({dialog:${dialog}?.innerText,body:document.body.innerText.slice(-4000)})`).catch(() => null)); } throw error;
} finally { clearInterval(heartbeat); await browser?.close(); await server.close(); if (!path.resolve(f.root).startsWith(output + path.sep)) throw new Error("Unexpected fixture root"); fs.rmSync(f.root, { recursive: true, force: true }); }
