import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "../apps/backend/src/server.mjs";
import { openBrowser } from "./browser.mjs";

const output = path.resolve("artifacts/automation-e2e"); fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(output, "case-")), projectRoot = path.join(root, "project"); fs.mkdirSync(projectRoot);
const server = createServer({ dataDir: path.join(root, "data") }), info = await server.listen({ port: 0 });
const p = server.app.createProject({ name: "Automation proof", root: projectRoot });
const identity = server.app.createAgent({ name: "CI Agent", roleId: "role-dev", projectId: p.id });
const runCLI = promisify(execFile), passed = [];
let browser;
const command = async (...args) => JSON.parse((await runCLI(process.execPath, [path.resolve("apps/agent-cli/cli.mjs"), "automation", ...args, "--project", p.id], {
  env: { ...process.env, ATK_URL: info.url, ATK_AGENT_TOKEN: identity.credential }, timeout: 30000, windowsHide: true,
})).stdout);
const pass = name => { passed.push(name); console.log("PASS", name); };
try {
  fs.writeFileSync(path.join(projectRoot, "check.mjs"), `import fs from 'node:fs';import path from 'node:path';
console.log('::atk::{"schemaVersion":1,"type":"progress","percent":35,"current":"rust-test","message":"Checking project"}');
console.log('::atk::{"schemaVersion":1,"type":"info","values":{"testsPassed":2}}');
while(!fs.existsSync('continue.txt')) await new Promise(r=>setTimeout(r,50));
fs.writeFileSync(path.join(process.env.ATK_OUTPUT_DIR,'report.json'),JSON.stringify({schemaVersion:1,runId:process.env.ATK_RUN_ID,stepId:process.env.ATK_STEP_ID,status:'passed',summary:'All checks passed',checks:[{id:'rust-test',name:'Rust tests',status:'passed',durationMs:123}]}));
console.log('CI complete: '+process.argv[2]);`);
  browser = await openBrowser({ url: info.browserUrl, outputDir: root });
  await browser.wait("document.body.innerText.includes('概览')"); await browser.click("自动化", { exact: true });
  await browser.wait("document.body.innerText.includes('创建流程或将配置文件')");
  const definition = { schemaVersion: 1, id: "checks", name: "Agent checks", parameters: { mode: { type: "string", title: "检查范围", enum: ["quick", "local"], default: "quick" } },
    steps: [{ id: "test", name: "Project tests", cli: "node", args: ["check.mjs", "${params.mode}"],
      exports: [{ id: "report", path: "${step.dir}/output/report.json", kind: "file", required: true }], result: { protocol: "atk-ci-result/v1", exportId: "report" } }] };
  const file = path.join(root, "definition.json"); fs.writeFileSync(file, JSON.stringify(definition));
  await command("validate", "--file", file); let flow = await command("apply", "--file", file, "--create");
  await browser.wait("document.querySelector('.automation-row')?.textContent.includes('Agent checks')"); pass("Agent CLI config appears in the human UI from project files");
  assert.equal(await browser.evaluate("!!document.querySelector('.automation-sidebar .automation-workflow-nav button[aria-current=page]') && document.querySelector('.main').getBoundingClientRect().left >= document.querySelector('.automation-sidebar').getBoundingClientRect().right"), true);
  pass("Workflow navigation occupies the shared secondary sidebar without overlapping the page");
  await browser.click("编辑流程", { exact: true, within: "document.querySelector('.automation-row')" });
  await browser.fill("automationName", "Shared checks"); await browser.click("校验配置", { exact: true });
  await browser.wait("document.body.innerText.includes('配置校验通过')"); await browser.submit(); await browser.wait("!document.querySelector('[role=dialog]')");
  flow = await command("show", "checks"); assert.equal(flow.definition.name, "Shared checks"); pass("UI edits and Agent reads share one revision-controlled definition");
  const started = await command("run", "checks", "--revision", flow.revision, "--param", "mode=local", "--request-id", crypto.randomUUID());
  await browser.wait("document.querySelector('.automation-progress progress')?.value === 35 && document.querySelector('.automation-live-detail')?.textContent.includes('rust-test')", 20000);
  assert.equal(await browser.evaluate("document.querySelector('.automation-trigger').textContent.includes('Agent')"), true);
  await browser.wait("document.querySelector('.automation-log')?.textContent.includes('Checking project')"); await browser.screenshot("01-agent-running"); pass("Agent-triggered run streams internal progress, origin and logs into UI");
  fs.writeFileSync(path.join(projectRoot, "continue.txt"), "go");
  await browser.wait("document.querySelector('.automation-run .automation-status')?.dataset.status==='SUCCEEDED' && document.querySelector('.automation-check')?.textContent.includes('Rust tests')", 20000);
  await browser.wait("document.querySelector('.automation-log')?.textContent.includes('CI complete: local')");
  assert.equal(await browser.evaluate("!!document.querySelector('.automation-file')"), true);
  const final = await command("status", started.runId), runDir = path.join(projectRoot, final.runPath);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, "result.json"))).status, "SUCCEEDED");
  const archived = server.app.automations.file(p.id, started.runId, "test", "report");
  const response = await fetch(info.url + `/api/agent/v1/projects/${p.id}/automation-runs/${started.runId}/files/test/report`, { headers: { authorization: "Bearer " + identity.credential } });
  assert.equal(response.status, 200); assert.equal((await response.json()).runId, started.runId); assert.ok(fs.existsSync(archived.file));
  await browser.click("检查结果", { exact: true, within: "document.querySelector('.automation-tabs')" });
  await browser.wait("[...document.querySelectorAll('[role=tabpanel]')].some(panel=>!panel.hidden && panel.textContent.includes('Rust tests'))");
  await browser.screenshot("02-agent-result");
  await browser.evaluate("document.querySelector('[role=tab][aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
  await browser.wait("[...document.querySelectorAll('[role=tabpanel]')].some(panel=>!panel.hidden && panel.querySelector('.automation-file')) && document.activeElement.getAttribute('role')==='tab'");
  await browser.screenshot("02-archived-files"); pass("Results and downloadable archives have separate keyboard-accessible tabs");
  fs.unlinkSync(path.join(projectRoot, "continue.txt"));
  await browser.click("运行流程", { exact: true, within: "document.querySelector('.automation-row')" }); await browser.fill("parameter-mode", "quick");
  await browser.screenshot("03-human-parameters"); await browser.click("启动流程", { exact: true });
  await browser.wait("document.querySelector('.automation-progress progress')?.value===35 && document.querySelector('.automation-trigger')?.textContent.includes('人工触发')", 20000);
  fs.writeFileSync(path.join(projectRoot, "continue.txt"), "go"); await browser.wait("document.querySelector('.automation-run .automation-status')?.dataset.status==='SUCCEEDED'", 20000);
  pass("Human parameter form starts the same execution and archiving path");
  const second = { schemaVersion: 1, id: "preview", name: "Preview workflow", description: "Build locally or publish with explicit parameters.", parameters: { publish: { type: "boolean", title: "是否发布", default: false, description: "默认只做本地检查。" } }, steps: [{ id: "check", name: "Preview check", cli: "node", args: ["-e", "console.log('Preview ready')"] }] };
  fs.writeFileSync(file, JSON.stringify(second)); await command("apply", "--file", file, "--create");
  await browser.click("Preview workflow", { exact: true, within: "document.querySelector('.automation-workflow-nav')" });
  await browser.wait("document.querySelector('.automation-workflow-copy h2')?.textContent==='Preview workflow' && document.querySelector('.automation-history-list')?.textContent.includes('还没有执行记录') && !document.querySelector('.automation-run')");
  pass("Switching workflows isolates history and clears the previously selected run");
  await browser.click("运行流程", { exact: true });
  await browser.wait("document.querySelector('[name=parameter-publish]')?.value==='false'");
  assert.equal(await browser.evaluate("document.querySelector('[name=parameter-publish]').selectedOptions[0].textContent"), "否");
  assert.equal(await browser.evaluate("document.querySelector('.automation-command-details').open"), false);
  await browser.screenshot("03-boolean-parameters"); await browser.click("取消", { exact: true });
  await browser.click("全部运行记录", { exact: true, within: "document.querySelector('.automation-sidebar')" });
  await browser.wait("document.querySelectorAll('.automation-history').length===2 && !document.querySelector('.automation-workflow-overview')");
  pass("Boolean parameters preserve false defaults and all-runs navigation retains every workflow's history");
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await browser.wait("getComputedStyle(document.querySelector('.automation-history[aria-pressed=true]')).backgroundColor==='rgb(38, 41, 54)'");
  await browser.screenshot("04-history-dark");
  for (const width of [1024, 768, 600, 390]) {
    await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    assert.equal(await browser.evaluate("document.documentElement.scrollWidth>innerWidth"), false, `History overflows at ${width}px`);
    await browser.click("Preview workflow", { exact: true, within: "document.querySelector('.automation-workflow-nav')" });
    await browser.click("运行流程", { exact: true });
    assert.equal(await browser.evaluate("document.documentElement.scrollWidth>innerWidth"), false, `Parameters overflow at ${width}px`);
    await browser.click("取消", { exact: true });
    await browser.click("全部运行记录", { exact: true, within: "document.querySelector('.automation-sidebar')" });
  }
  await browser.screenshot("05-history-mobile"); pass("Dark theme and narrow layouts keep navigation, history and parameter forms usable");
  assert.equal(await browser.evaluate("document.documentElement.scrollWidth>innerWidth"), false);
  assert.deepEqual(browser.errors, []); pass("Automation UI has no browser exceptions or horizontal overflow");
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ ok: true, passed, projectRoot }, null, 2));
} catch (e) {
  if (browser) { await browser.screenshot("failure").catch(() => {}); fs.writeFileSync(path.join(root, "failure.txt"), String(e.stack)); }
  throw e;
} finally { await browser?.close(); await server.close(); }
