import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createService } from "../apps/backend/src/service.mjs";
import { createServer } from "../apps/backend/src/server.mjs";
import { openBrowser } from "./browser.mjs";

const output = path.resolve("artifacts/automation-schedule-e2e"); fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(output, "case-")), projectRoot = path.join(root, "project"); fs.mkdirSync(projectRoot);
const initial = Date.now(), absolute = seconds => new Date(initial + seconds * 1000).toISOString();
const local = seconds => new Date(initial + seconds * 1000 + 8 * 3600000).toISOString().slice(0, -1);
let clock = initial;
const service = createService({ dataDir: path.join(root, "data"), now: () => clock });
const server = createServer({ service }), info = await server.listen({ port: 0 });
const p = service.createProject({ name: "Scheduled CI", root: projectRoot });
const agent = service.createAgent({ name: "Scheduler Agent", roleId: "role-dev", projectId: p.id });
const invoke = promisify(execFile), passed = [], pass = name => { passed.push(name); console.log("PASS", name); };
const command = async (...args) => JSON.parse((await invoke(process.execPath, [path.resolve("apps/agent-cli/cli.mjs"), "automation", ...args, "--project", p.id], { env: { ...process.env, ATK_URL: info.url, ATK_AGENT_TOKEN: agent.credential }, windowsHide: true, timeout: 30000 })).stdout);
let browser;
try {
  const definition = { schemaVersion: 1, id: "ci", name: "Scheduled checks", parameters: { publish: { type: "boolean", title: "是否发布", default: false }, label: { type: "string", title: "运行标记", default: "local" } }, steps: [{ id: "check", name: "Project CI", cli: "node", args: ["-e", "console.log('Scheduled CI completed')"] }] };
  const file = path.join(root, "definition.json"); fs.writeFileSync(file, JSON.stringify(definition)); await command("apply", "--file", file, "--create");
  browser = await openBrowser({ url: info.browserUrl, outputDir: root, width: 1440, height: 1100 });
  await browser.send("Emulation.setTimezoneOverride", { timezoneId: "Asia/Shanghai" });
  await browser.wait("document.body.innerText.includes('概览')"); await browser.click("自动化", { exact: true });
  await browser.click("添加定时", { exact: true });
  for (let index = 0; index < 4; index++) {
    await browser.click("添加计划", { exact: true });
    await browser.fill("schedule-name-" + index, ["单次检查", "指定时间检查", "重复两次", "循环检查"][index]);
    await browser.fill("schedule-mode-" + index, ["once", "times", "repeat", "interval"][index]);
    assert.equal(await browser.evaluate(`document.querySelector('[name=schedule-param-${index}-publish]').value`), "false");
    if (index < 2) {
      await browser.fill(`schedule-time-${index}-0`, local(index === 0 ? 60 : 120));
      if (index === 1) { await browser.click("添加时间点", { exact: true }); await browser.fill("schedule-time-1-1", local(180)); }
    } else {
      await browser.fill("schedule-start-" + index, local(index === 2 ? 240 : 360));
      await browser.fill("schedule-every-" + index, "1"); await browser.fill("schedule-unit-" + index, "60");
      if (index === 2) await browser.fill("schedule-count-" + index, "2");
    }
  }
  await browser.click("校验配置", { exact: true }); await browser.wait("document.body.innerText.includes('配置校验通过')");
  await browser.submit(); await browser.wait("!document.querySelector('[role=dialog]') && document.querySelectorAll('.automation-schedule-card').length===4");
  const configured = await command("show", "ci");
  assert.equal(configured.definition.schedules[0].times[0], absolute(60));
  assert.deepEqual(configured.definition.schedules[1].times, [absolute(120), absolute(180)]);
  assert.equal(configured.definition.schedules[2].count, 2); assert.equal(configured.definition.schedules[3].count, undefined);
  await service.automations.poll();
  const schedules = await command("schedules", "ci"); assert.equal(schedules.items[0].nextAt, absolute(60));
  await browser.screenshot("01-four-schedule-types"); pass("Human forms configure all four schedule modes with correct UTC conversion and false boolean defaults");

  const second = "document.querySelectorAll('.automation-schedule-card')[1]";
  await browser.click("暂停", { exact: true, within: second }); await browser.wait(`(${second}).dataset.enabled==='false'`);
  await service.automations.poll(); assert.equal((await command("schedules", "ci")).items[1].status, "PAUSED");
  await browser.click("启用", { exact: true, within: second }); await browser.wait(`(${second}).dataset.enabled==='true'`); await service.automations.poll();
  pass("Pause and enable write the same version-controlled definition seen by Agent CLI");

  for (const seconds of [60, 120, 180, 240, 300, 360, 420]) {
    clock = initial + seconds * 1000; await service.automations.poll();
    const run = service.automations.runs(p.id).items[0]; assert.equal(run.requestedBy.scheduledAt, absolute(seconds));
    await browser.wait(`document.querySelector('.automation-run')?.dataset.status==='SUCCEEDED' && document.querySelector('.automation-trigger')?.textContent.includes('定时触发') && document.querySelector('.automation-run-info')?.textContent.includes('${run.runId}')`, 20000);
    assert.equal(service.automations.detail(p.id, run.runId).parameters.publish, false);
    assert.ok(fs.existsSync(path.join(projectRoot, run.runPath, "result.json")));
  }
  assert.equal(service.automations.runs(p.id).total, 7);
  pass("All schedule types launch actual CI, stream into UI with scheduled origin and archive project-owned results");

  const current = await command("show", "ci");
  const updated = { ...current.definition, schedules: current.definition.schedules.map(s => s.type === "interval" && s.count === undefined ? { ...s, enabled: false } : s).concat({ id: "agent-once", name: "Agent planned CI", type: "at", times: [absolute(480)], parameters: { publish: false, label: "agent-plan" } }) };
  fs.writeFileSync(file, JSON.stringify(updated)); await command("validate", "--file", file); await command("apply", "--file", file, "--revision", current.revision);
  await service.automations.poll(); await browser.wait("document.querySelectorAll('.automation-schedule-card').length===5 && document.body.innerText.includes('Agent planned CI')");
  clock = initial + 480000; await service.automations.poll();
  const run = service.automations.runs(p.id).items[0];
  await browser.wait(`document.querySelector('.automation-run-info')?.textContent.includes('${run.runId}') && document.querySelector('.automation-run')?.dataset.status==='SUCCEEDED'`, 20000);
  assert.equal(run.requestedBy.scheduleId, "agent-once"); assert.equal(run.parameters.label, "agent-plan");
  assert.equal((await command("schedules", "ci")).items.at(-1).last.runId, run.runId);
  pass("Agent CLI configures scheduled parameters and reads the same dispatch and archived run as the UI");

  await browser.click("管理定时", { exact: true }); await browser.click("JSON", { exact: true });
  assert.equal(await browser.evaluate("JSON.parse(document.querySelector('[name=automationJson]').value).schedules.length"), 5);
  await browser.click("表单", { exact: true });
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('select[name^=schedule-mode]')].map(select=>select.value)"), ["once", "times", "repeat", "interval", "once"]);
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 600, height: 1000, deviceScaleFactor: 1, mobile: false });
  assert.equal(await browser.evaluate("document.documentElement.scrollWidth>innerWidth"), false);
  await browser.screenshot("02-schedule-editor-narrow"); await browser.submit(); await browser.wait("!document.querySelector('[role=dialog]')");
  pass("JSON and human forms preserve schedule semantics and remain usable in narrow windows");
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await browser.wait("getComputedStyle(document.querySelector('.automation-schedules-overview')).backgroundColor==='rgb(17, 18, 20)'");
  await browser.screenshot("03-scheduled-results-dark");
  assert.deepEqual(browser.errors, []); pass("Schedule views support dark mode without browser exceptions or horizontal overflow");
  const beforeFold = await command("show", "ci");
  const fold = { id: "dst-fold", type: "at", enabled: false, times: ["2027-11-07T06:30:00.000Z"] };
  fs.writeFileSync(file, JSON.stringify({ ...beforeFold.definition, schedules: [...beforeFold.definition.schedules, fold] }));
  await command("apply", "--file", file, "--revision", beforeFold.revision);
  await browser.send("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });
  await browser.wait("document.querySelectorAll('.automation-schedule-card').length===6");
  await browser.click("管理定时", { exact: true });
  assert.equal(await browser.evaluate("document.querySelector('[name=schedule-time-5-0]').value.startsWith('2027-11-07T01:30')"), true);
  await browser.submit(); await browser.wait("!document.querySelector('[role=dialog]')");
  assert.equal((await command("show", "ci")).definition.schedules.at(-1).times[0], fold.times[0]);
  pass("Changing device time zone and editing a repeated DST hour preserves the original absolute instant");
  await browser.click("管理定时", { exact: true });
  await browser.fill("automationParameters", '{"publish":null}');
  await browser.click("校验配置", { exact: true }); await browser.wait("!!document.querySelector('[role=dialog] [role=alert]')");
  assert.deepEqual(browser.errors, []);
  await browser.fill("automationParameters", JSON.stringify(definition.parameters));
  await browser.fill("schedule-time-5-0", "2027-03-14T02:30:00");
  await browser.click("校验配置", { exact: true }); await browser.wait("document.querySelector('[role=dialog] [role=alert]')?.textContent.includes('This local time does not exist')");
  await browser.fill("schedule-time-5-0", "2027-11-07T01:30:00");
  await browser.click("校验配置", { exact: true }); await browser.wait("document.querySelector('[role=dialog] [role=status]')?.textContent.includes('配置校验通过')");
  await browser.submit(); await browser.wait("!document.querySelector('[role=dialog]')");
  assert.deepEqual(browser.errors, []); pass("Invalid parameter drafts and nonexistent DST times show validation errors without losing the schedule form");
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ ok: true, passed }, null, 2));
} catch (e) {
  if (browser) { await browser.screenshot("failure").catch(() => {}); fs.writeFileSync(path.join(root, "failure.txt"), String(e.stack)); }
  throw e;
} finally { await browser?.close(); await server.close(); }
