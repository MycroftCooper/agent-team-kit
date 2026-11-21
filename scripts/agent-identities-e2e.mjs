import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "../apps/backend/src/server.mjs";
import { createAgentClient } from "../packages/agent-client/src/index.mjs";
import { plan, node } from "../test/helpers.mjs";
import { openBrowser } from "./browser.mjs";

const output = path.resolve("artifacts/agent-identities-e2e"); fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(output, "case-")), projectRoot = path.join(root, "project"); fs.mkdirSync(projectRoot);
const server = createServer({ dataDir: path.join(root, "data") }), info = await server.listen({ port: 0 }), app = server.app;
const p = app.createProject({ name: "Identity lifecycle", root: projectRoot });
const identity = app.createAgent({ projectId: p.id, name: "Reusable worker", roleId: "role-dev" });
const busy = app.createAgent({ projectId: p.id, name: "Busy worker", roleId: "role-dev" });
const pm = app.createAgent({ projectId: p.id, name: "Planner", roleId: "role-pm" });
const client = credential => createAgentClient({ baseUrl: info.url, credential });
const passed = [], pass = name => { passed.push(name); console.log("PASS", name); };
const card = name => `[...document.querySelectorAll('.agent-card')].find(card=>card.querySelector('h3')?.textContent===${JSON.stringify(name)})`;
let browser;
try {
  browser = await openBrowser({ url: info.browserUrl, outputDir: root });
  await browser.wait("document.body.innerText.includes('概览')"); await browser.click("Agent 团队", { exact: true });
  await browser.wait("document.querySelectorAll('.agent-card').length===3");
  assert.equal(await browser.evaluate("[...document.querySelectorAll('button')].some(button=>/^(撤销|撤销凭据|Revoke)$/.test(button.textContent.trim()))"), false);
  await browser.click("恢复接入", { exact: true, within: card(identity.agent.name) });
  await browser.wait("document.querySelector('[role=dialog] h2')?.textContent==='恢复 Agent 接入'");
  await browser.click("重新签发凭据", { exact: true }); await browser.wait("!!document.querySelector('.credential')");
  const firstCredential = await browser.evaluate("document.querySelector('.credential').textContent");
  assert.equal(await browser.evaluate(`document.querySelector('[role=dialog]').textContent.includes(${JSON.stringify(identity.agent.id)})`), true);
  await assert.rejects(client(identity.credential).doctor(), { code: "UNAUTHENTICATED" });
  const first = client(firstCredential); assert.equal((await first.doctor()).identity.id, identity.agent.id);
  for (let i = 0; i < 3; i++) await first.connect();
  assert.equal(app.store.all("agents").length, 3);
  await browser.evaluate("document.querySelector('.modal-close').click()");
  pass("Recovering and reconnecting repeatedly keeps the same ID and roster count; the old credential is invalid");

  await browser.click("接入说明", { exact: true, within: card(identity.agent.name) });
  await browser.wait("document.querySelector('[role=dialog]')?.textContent.includes('接入外部 Agent')");
  assert.equal(await browser.evaluate("document.querySelector('[role=dialog]').textContent.includes('请创建一个新身份')"), false);
  await browser.click("恢复接入", { exact: true, within: "document.querySelector('[role=dialog]')" });
  await browser.click("重新签发凭据", { exact: true }); await browser.wait("!!document.querySelector('.credential')");
  const secondCredential = await browser.evaluate("document.querySelector('.credential').textContent");
  assert.equal((await client(secondCredential).doctor()).identity.id, identity.agent.id);
  await assert.rejects(first.doctor(), { code: "UNAUTHENTICATED" });
  await browser.evaluate("document.querySelector('.modal-close').click()");
  pass("The connection guide reissues credentials for the original identity and no revoke action is offered");

  plan({ app, p, pm }, [node("held")]); const claim = app.claim(busy.agent.id, {});
  assert.ok(claim.run);
  await browser.click("删除", { exact: true, within: card(busy.agent.name) });
  await browser.click("确认删除", { exact: true });
  await browser.wait("document.querySelector('[role=dialog] [role=alert]')?.textContent.includes('AGENT_BUSY')");
  assert.equal(app.list("locks").total, 1); assert.equal(app.get("runs", claim.run.id).status, "RUNNING");
  await browser.evaluate("document.querySelector('.modal-close').click()");
  app.requestStop(claim.run.id); app.confirmStopped(claim.run.id, { confirmStopped: true });
  pass("Deletion is blocked by active work and preserves its run state and file lock");

  await browser.click("删除", { exact: true, within: card(busy.agent.name) });
  await browser.click("确认删除", { exact: true });
  await browser.wait("!document.querySelector('[role=dialog]') && document.querySelectorAll('.agent-card').length===2");
  assert.equal(app.get("runs", claim.run.id).agentId, busy.agent.id);
  assert.equal(app.store.get("agents", busy.agent.id).name, busy.agent.name);
  await assert.rejects(client(busy.credential).doctor(), { code: "UNAUTHENTICATED" });
  await browser.screenshot("01-agent-removed-history-kept");
  pass("After confirmed stop, deletion removes the card, invalidates access and retains historical identity and run references");

  await browser.click("删除", { exact: true, within: card(identity.agent.name) });
  await browser.click("取消", { exact: true, within: "document.querySelector('[role=dialog]')" });
  assert.equal(app.list("agents", { projectId: p.id }).total, 2);
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 600, height: 1000, deviceScaleFactor: 1, mobile: false });
  assert.equal(await browser.evaluate("document.documentElement.scrollWidth>innerWidth"), false);
  assert.deepEqual(browser.errors, []);
  await browser.screenshot("02-agent-actions-narrow");
  pass("Cancelling is non-destructive and the additional identity actions work without narrow-screen overflow or browser exceptions");
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ ok: true, passed }, null, 2));
} catch (e) {
  if (browser) { await browser.screenshot("failure").catch(() => {}); fs.writeFileSync(path.join(root, "failure.txt"), String(e.stack)); }
  throw e;
} finally { await browser?.close(); await server.close(); }
