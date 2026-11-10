import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { attachBrowser } from "./browser.mjs";

assert.equal(process.platform, "win32", "This desktop smoke test runs on Windows.");
const output = path.resolve("artifacts/desktop-dev/e2e");
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(output, "case-"));
const data = path.join(root, "data"), profile = path.join(root, "profile");
const project = path.join(root, "project");
for (const dir of [profile, project]) fs.mkdirSync(dir);
const logFile = path.join(root, "desktop.log");
const log = fs.openSync(logFile, "w");
const system = process.env.SystemRoot ?? "C:\\Windows";
const probePort = net.createServer();
await new Promise((resolve, reject) => probePort.once("error", reject).listen(0, "127.0.0.1", resolve));
const webPort = probePort.address().port;
await promisify(probePort.close.bind(probePort))();
// Create the fixture before Vite starts watching. Adding its entry module
// during the test would itself trigger a page reload before the real edit.
fs.mkdirSync(path.resolve("apps/web/.vite"), { recursive: true });
const probeDir = fs.mkdtempSync(path.resolve("apps/web/.vite/desktop-probe-"));
const component = path.join(probeDir, "Probe.tsx"), mount = path.join(probeDir, "mount.tsx");
const source = (label) => `import { useState } from 'react';
export default function Probe() { const [n,set] = useState(0); return <button id="atk-hmr-probe" onClick={() => set(n+1)}>${label}:{n}</button>; }`;
fs.writeFileSync(component, source("Before"));
fs.writeFileSync(mount, `import { createRoot } from 'react-dom/client'; import Probe from './Probe';
const target = document.createElement('div'); document.body.append(target); createRoot(target).render(<Probe />);`);
const desktopEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(path|psmodulepath)$/i.test(name)));
const child = spawn(path.join(system, "System32", "cmd.exe"), ["/d", "/c", "dev.bat"], {
  env: { ...desktopEnv, Path: `${system}\\System32;${system}`, ATK_DESKTOP_TEST: profile, ATK_DATA_DIR: data, ATK_PORT: "0", ATK_DEV_PORT: String(webPort) },
  stdio: ["ignore", log, log],
  windowsHide: true,
});
fs.closeSync(log);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = promisify(execFile);
let browser, baseUrl;
const passed = [];
function pass(name) { passed.push(name); console.log("PASS", name); }
async function until(read, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read().catch(() => null);
    if (result) return result;
    if (child.exitCode !== null) throw new Error(`dev.bat exited (${child.exitCode}).`);
    await sleep(150);
  }
  throw new Error("Timed out waiting for the desktop runtime.");
}
async function agent(credential, ...args) {
  const { stdout } = await run(process.execPath, ["apps/agent-cli/cli.mjs", ...args], {
    env: { ...process.env, ATK_AGENT_TOKEN: credential, ATK_URL: baseUrl, ATK_DATA_DIR: data },
    timeout: 15000,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}
async function receipt(credential, claim, type, content) {
  const file = path.join(root, `${type}.json`);
  fs.writeFileSync(file, JSON.stringify({ generation: claim.generation, ...content }));
  return agent(credential, "submit", claim.run.id, type, "--file", file);
}

try {
  const port = await until(async () => {
    const file = path.join(profile, "DevToolsActivePort");
    const port = Number(fs.readFileSync(file, "utf8").split(/\r?\n/)[0]);
    const tabs = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
    return tabs.some((tab) => tab.type === "page" && tab.url.startsWith("http://127.0.0.1:")) && port;
  }, 240000);
  browser = await attachBrowser({ port, outputDir: root });
  await browser.wait("document.body?.innerText.includes('添加本地项目')", 30000);
  assert.equal(await browser.evaluate("location.hash"), "");
  assert.equal(await browser.evaluate("typeof process"), "undefined");
  assert.match(await browser.evaluate("navigator.userAgent"), /Win64; x64.*Electron\//);
  baseUrl = JSON.parse(fs.readFileSync(path.join(data, "runtime", "backend.lock"))).url;
  assert.equal((await fetch(baseUrl)).status, 404);
  pass("dev.bat opens an unlocked Electron window without system Node.js on PATH");
  assert.equal(await browser.evaluate("typeof require"), "undefined");
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.desktop-titlebar')).getPropertyValue('-webkit-app-region')"), "drag");
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.desktop-window-close')).getPropertyValue('-webkit-app-region')"), "no-drag");
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.desktop-titlebar .workspace-switch')).getPropertyValue('-webkit-app-region')"), "no-drag");
  assert.equal(await browser.evaluate("document.querySelector('[name=workspace]').closest('.desktop-titlebar') !== null && !document.querySelector('.sidebar .brand, .sidebar .workspace-switch')"), true);
  assert.equal(await browser.evaluate("document.querySelector('.sidebar').getBoundingClientRect().top === document.querySelector('.desktop-titlebar').getBoundingClientRect().bottom"), true);
  await browser.click("最大化窗口", { exact: true });
  await browser.wait("window.atkDesktop.getWindowState().then(state => state.maximized)");
  await browser.click("还原窗口", { exact: true });
  await browser.wait("window.atkDesktop.getWindowState().then(state => !state.maximized)");
  pass("custom title bar uses a native drag region and its buttons maximize and restore the window");

  await browser.click("添加工作空间", { exact: true, within: "document.querySelector('.desktop-titlebar')" });
  await browser.fill("name", "Desktop Proof");
  await browser.fill("root", project);
  await browser.submit();
  await browser.wait("!document.querySelector('[role=dialog]') && document.body.innerText.includes('Desktop Proof')");
  await browser.wait("document.querySelector('.desktop-titlebar select[name=workspace]')?.selectedOptions[0]?.textContent === 'Desktop Proof'");
  pass("the title bar can add workspaces and displays the active workspace; the sidebar starts with navigation");
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await browser.click("切换到浅色主题", { exact: true, within: "document.querySelector('.app-footer')" });
  await browser.wait("getComputedStyle(document.querySelector('.desktop-titlebar')).backgroundColor === 'rgb(245, 246, 250)' && getComputedStyle(document.querySelector('.project-card')).backgroundColor === 'rgb(255, 255, 255)'");
  await browser.screenshot("desktop-light");
  await browser.click("切换到深色主题", { exact: true, within: "document.querySelector('.app-footer')" });
  await browser.wait("getComputedStyle(document.querySelector('.desktop-titlebar')).backgroundColor === 'rgb(14, 15, 17)' && getComputedStyle(document.querySelector('.project-card')).backgroundColor === 'rgb(17, 18, 20)'");
  await browser.screenshot("desktop-dark");
  pass("desktop title bar and workspace switch together between light and dark");
  const credentials = {};
  await browser.click("Agent 团队", { exact: true });
  await browser.wait("!!document.querySelector('.agent-team-sidebar .agent-team-nav')");
  for (const [role, name] of [["role-pm", "Desktop PM"], ["role-dev", "Desktop Worker"]]) {
    await browser.click("添加 Agent");
    await browser.fill("name", name);
    await browser.fill("roleId", role);
    await browser.submit();
    await browser.wait("!!document.querySelector('.credential')");
    credentials[role] = await browser.evaluate("document.querySelector('.credential').textContent");
    await browser.evaluate("document.querySelector('.modal-close').click()");
  }
  await browser.wait("document.querySelectorAll('.agent-card').length === 2");
  await browser.screenshot("desktop-agent-team");
  const pm = credentials["role-pm"], worker = credentials["role-dev"];
  await agent(pm, "connect");
  await agent(worker, "connect");
  await browser.click("接入说明", { within: "[...document.querySelectorAll('.agent-card')].find(r=>r.textContent.includes('Desktop Worker'))" });
  await browser.wait(`document.querySelector('.command-box pre')?.innerText.includes(${JSON.stringify(baseUrl)})`);
  await browser.click("关闭", { exact: true });

  await browser.click("新建需求");
  await browser.fill("title", "Desktop E2E request");
  await browser.fill("description", "Write a delivery file through the existing agent protocol.");
  await browser.fill("acceptance", "The output file exists.");
  await browser.submit();
  await browser.wait("!document.querySelector('[role=dialog]')");
  await browser.click("工作", { exact: true });
  await browser.wait("document.querySelector('.work-sidebar [aria-label=任务][aria-current=page]') && document.querySelector('[data-column=draft] .board-card')?.innerText.includes('Desktop E2E request')");
  await browser.screenshot("desktop-work");
  const draft = await agent(pm, "claim", "--wait", "0");
  assert.ok(draft.run);
  const submitted = await receipt(pm, draft, "plan", {
    plan: { summary: "Produce the desktop acceptance file", nodes: [{
      key: "delivery", title: "Write desktop output", description: "Write output.txt",
      acceptance: "output.txt exists", roleId: "role-dev", files: ["output.txt"],
      checks: [], reviewPolicy: "NONE", deps: [],
    }] },
  });
  assert.equal(submitted.persisted, true);
  assert.equal((await agent(worker, "claim", "--wait", "0")).run, null);
  await browser.click("待我处理", { exact: true, within: "document.querySelector('.work-sidebar')" });
  await browser.click("审阅计划");
  await browser.wait("document.body.innerText.includes('Write desktop output')");
  await browser.click("批准此版本并开放执行");
  await browser.wait("!document.querySelector('[role=dialog]')");
  const delivery = await agent(worker, "claim", "--wait", "0");
  assert.ok(delivery.run);
  await agent(worker, "heartbeat", delivery.run.id, "--generation", String(delivery.generation));
  fs.writeFileSync(path.join(project, "output.txt"), "Desktop Agent delivery\n");
  assert.equal((await receipt(worker, delivery, "result", {
    outcome: "COMPLETED", stopped: true, summary: "Wrote output.txt",
  })).persisted, true);
  await browser.click("查看交付");
  await browser.click("确认整份计划验收通过");
  await browser.wait("!document.querySelector('[role=dialog]')");
  const status = await browser.evaluate(`(async()=>{
    const access = sessionStorage.getItem('atk-browser-access');
    const session = await fetch('/api/v1/session', {headers:{'x-atk-access':access}}).then(r=>r.json());
    return fetch('/api/v1/tasks/${submitted.plan.sourceTaskId}', {headers:{'x-atk-token':session.token}}).then(r=>r.json()).then(r=>r.status);
  })()`);
  assert.equal(status, "DONE");
  pass("existing atk-agent CLI plans, claims, renews and delivers; Electron approves and accepts via SSE");

  try {
    const moduleUrl = "/" + path.relative("apps/web", mount).replaceAll("\\", "/");
    await browser.evaluate(`import(${JSON.stringify(moduleUrl)}).then(() => true)`);
    await browser.wait("document.querySelector('#atk-hmr-probe')?.textContent === 'Before:0'");
    await browser.evaluate("window.atkDesktopHmrCheck = true; document.querySelector('#atk-hmr-probe').click()");
    await browser.wait("document.querySelector('#atk-hmr-probe')?.textContent === 'Before:1'");
    fs.writeFileSync(component, source("After"));
    await browser.wait("window.atkDesktopHmrCheck && document.querySelector('#atk-hmr-probe')?.textContent === 'After:1'");
  } catch (error) {
    console.error("Fast Refresh state:", await browser.evaluate("({ marker:window.atkDesktopHmrCheck, text:document.querySelector('#atk-hmr-probe')?.textContent })").catch(() => null), browser.errors);
    throw error;
  }
  assert.deepEqual(browser.errors, []);
  pass("React Fast Refresh applies a source edit without reload and preserves component state");
  await browser.click("最小化窗口", { exact: true });
  await browser.wait("window.atkDesktop.getWindowState().then(state => state.minimized)");
  pass("the custom minimize button minimizes the native window");
  await browser.evaluate("setTimeout(() => document.querySelector('.desktop-window-close').click(), 300); true");
  const exit = await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => resolve(null), 10000);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exit, 0, "the development launcher must exit cleanly");
  assert.equal(fs.existsSync(path.join(data, "runtime", "backend.lock")), false);
  pass("the custom close button releases the backend instance lock");
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({ passed, logFile }, null, 2));
} catch (error) {
  console.error(fs.readFileSync(logFile, "utf8"));
  throw error;
} finally {
  await browser?.close();
  if (child.exitCode === null && child.pid)
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  fs.rmSync(component, { force: true });
  fs.rmSync(mount, { force: true });
  fs.rmdirSync(probeDir);
}
