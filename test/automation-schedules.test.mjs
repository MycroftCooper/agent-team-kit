import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createService } from "../apps/backend/src/service.mjs";
import { definition } from "../apps/backend/src/automation-definition.mjs";
import { occurrencesBetween, nextOccurrence } from "../apps/backend/src/automation-schedule.mjs";
import { machineId } from "../apps/backend/src/automation-files.mjs";

const initial = Date.parse("2026-11-17T00:00:00Z"), iso = seconds => new Date(initial + seconds * 1000).toISOString();
const d = schedules => ({ schemaVersion: 1, id: "ci", name: "CI", schedules, parameters: { publish: { type: "boolean", default: false } }, steps: [{ id: "check", name: "Check", cli: "node", args: ["-e", "console.log('schedule CI')"] }] });
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atk-schedules-")), projectRoot = path.join(root, "project"); fs.mkdirSync(projectRoot);
  let now = initial, app = createService({ dataDir: path.join(root, "data"), now: () => now });
  const p = app.createProject({ name: "Schedules", root: projectRoot });
  t.after(async () => { await app.automations.shutdown(); app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { p, root, get app() { return app; }, advance: seconds => { now = initial + seconds * 1000; },
    restart: () => { app.close(); app = createService({ dataDir: path.join(root, "data"), now: () => now }); },
    apply: value => { const prior = app.automations.list(p.id).items.find(item => item.id === value.id); return app.automations.apply(p.id, value.id, { definition: value, expectedRevision: prior?.revision ?? null }); } };
}
async function complete(f, id) {
  for (let i = 0; i < 400; i++) {
    const run = f.app.automations.detail(f.p.id, id);
    if (!["STARTING", "RUNNING", "STOPPING"].includes(run.status)) return run;
    await delay(50);
  }
  throw new Error("Scheduled run did not finish");
}

test("schedule schema validates absolute dates, uniqueness, intervals, counts and typed parameters", () => {
  const normalized = definition(d([{ id: "once", type: "at", times: ["2026-11-17T09:00:00+08:00"] }]));
  assert.deepEqual(normalized.schedules[0].times, ["2026-11-17T01:00:00.000Z"]);
  assert.deepEqual(normalized.schedules[0].parameters, { publish: false });
  const invalid = [
    [{ id: "once", type: "at", times: ["2026-11-17T09:00:00"] }],
    [{ id: "once", type: "at", times: ["2026-02-30T00:00:00Z"] }],
    [{ id: "once", type: "at", times: [iso(60), "2026-11-17T08:01:00+08:00"] }],
    [{ id: "once", type: "at", times: [] }],
    [{ id: "once", type: "at", times: [iso(60)], parameters: { publish: "true" } }],
    [{ id: "loop", type: "interval", startAt: iso(60), everySeconds: 1 }],
    [{ id: "loop", type: "interval", startAt: iso(60), everySeconds: 60, count: 0 }],
    [{ id: "loop", type: "interval", startAt: iso(60), everySeconds: 60, count: 1.5 }],
    [{ id: "a", type: "at", times: [iso(60)] }, { id: "a", type: "at", times: [iso(120)] }],
  ];
  for (const schedules of invalid) assert.throws(() => definition(d(schedules)));
});

test("occurrence arithmetic respects exact boundaries and finite slots without catch-up loops", () => {
  const schedule = { type: "interval", startAt: iso(60), everySeconds: 60, count: 3 };
  assert.equal(nextOccurrence(schedule, initial), initial + 60000);
  assert.equal(nextOccurrence(schedule, initial + 180000), null);
  assert.deepEqual(occurrencesBetween(schedule, initial + 60000, initial + 180000), { count: 2, latest: initial + 180000 });
  assert.equal(occurrencesBetween({ ...schedule, count: undefined }, initial, initial + 60 * 1000 * 1000000).count, 1000000);
  const times = { type: "at", times: [iso(180), iso(60)] };
  assert.equal(nextOccurrence(times, initial + 60000), initial + 180000);
  assert.deepEqual(occurrencesBetween(times, initial, initial + 180000), { count: 2, latest: initial + 180000 });
});

test("once, multiple dates, finite repeats and unlimited intervals use the same project executor", async t => {
  const f = await fixture(t);
  const schedules = [{ id: "once", type: "at", times: [iso(60)] }, { id: "dates", type: "at", times: [iso(120), iso(180)] },
    { id: "repeat", type: "interval", startAt: iso(240), everySeconds: 60, count: 2 }, { id: "loop", type: "interval", startAt: iso(360), everySeconds: 60 }];
  f.apply(d(schedules)); await f.app.automations.poll();
  for (const time of [60, 120, 180, 240, 300, 360, 420]) {
    f.advance(time); await f.app.automations.poll();
    const run = f.app.automations.runs(f.p.id).items[0];
    assert.equal(run.requestedBy.type, "schedule"); assert.equal(run.requestedBy.scheduledAt, iso(time)); assert.equal(run.parameters.publish, false);
    assert.equal((await complete(f, run.runId)).status, "SUCCEEDED");
    assert.ok(fs.existsSync(path.join(f.p.root, run.runPath, "result.json")));
    await f.app.automations.poll();
  }
  assert.equal(f.app.automations.runs(f.p.id).total, 7);
  const status = f.app.automations.schedules(f.p.id, "ci");
  assert.deepEqual(status.items.map(s => s.nextAt), [null, null, null, iso(480)]);
});

test("busy slots are consumed, pause/resume does not replay, and ordinary config edits keep the cursor", async t => {
  const f = await fixture(t), schedules = [{ id: "loop", type: "interval", startAt: iso(60), everySeconds: 60, count: 5 }];
  const flow = f.apply(d(schedules)); await f.app.automations.poll();
  const blocker = f.apply({ ...d([]), id: "blocker", steps: [{ id: "check", name: "Hold", cli: "node", args: ["-e", "setTimeout(()=>{},60000)"] }] });
  const busy = await f.app.automations.start(f.p.id, blocker.id, { revision: blocker.revision, idempotencyKey: crypto.randomUUID() });
  f.advance(60); await f.app.automations.poll();
  assert.equal(f.app.automations.schedules(f.p.id, flow.id).items[0].last.reason, "AUTOMATION_BUSY");
  f.app.automations.stop(f.p.id, busy.runId); await complete(f, busy.runId);
  await f.app.automations.poll(); assert.equal(f.app.automations.runs(f.p.id).total, 1);
  f.apply(d([{ ...schedules[0], enabled: false }])); await f.app.automations.poll();
  f.advance(120); await f.app.automations.poll();
  assert.equal(f.app.automations.schedules(f.p.id, flow.id).items[0].status, "PAUSED");
  f.apply(d(schedules)); await f.app.automations.poll();
  f.advance(180); await f.app.automations.poll();
  const run = f.app.automations.runs(f.p.id).items.find(run => run.workflowId === "ci"); await complete(f, run.runId);
  f.apply({ ...d(schedules), name: "Renamed CI" }); await f.app.automations.poll();
  assert.equal(f.app.automations.runs(f.p.id, { workflowId: "ci" }).total, 1);
  // Changing presentation or JSON key order must not skip a newly due slot.
  f.advance(240);
  f.apply(d([{ parameters: { publish: false }, everySeconds: 60, type: "interval", count: 5, startAt: iso(60), id: "loop", name: "A new label", enabled: true }]));
  await f.app.automations.poll();
  const renamedRun = f.app.automations.runs(f.p.id, { workflowId: "ci" }).items[0];
  assert.equal(renamedRun.requestedBy.scheduledAt, iso(240)); await complete(f, renamedRun.runId);
});

test("restart and sleep skip missed slots, clock rollback never duplicates, and a corrupt cursor blocks scheduling", async t => {
  const f = await fixture(t);
  f.apply(d([{ id: "loop", type: "interval", startAt: iso(60), everySeconds: 60 }])); await f.app.automations.poll();
  f.advance(60); await f.app.automations.poll(); await complete(f, f.app.automations.runs(f.p.id).items[0].runId);
  f.advance(180); f.restart(); await f.app.automations.poll();
  assert.equal(f.app.automations.runs(f.p.id).total, 1);
  assert.equal(f.app.automations.schedules(f.p.id, "ci").items[0].last.reason, "MISSED_WHILE_OFFLINE");
  f.advance(280); await f.app.automations.poll();
  assert.equal(f.app.automations.runs(f.p.id).total, 1);
  f.advance(300); await f.app.automations.poll(); await complete(f, f.app.automations.runs(f.p.id).items[0].runId);
  f.advance(240); await f.app.automations.poll(); f.advance(300); await f.app.automations.poll();
  assert.equal(f.app.automations.runs(f.p.id).total, 2);
  fs.writeFileSync(path.join(f.p.root, ".atk/local", machineId, "schedules.json"), "{}");
  f.advance(360); await f.app.automations.poll(); assert.equal(f.app.automations.runs(f.p.id).total, 2);
  assert.ok(f.app.automations.schedules(f.p.id, "ci").error);
});

test("dispatch crash recovery links accepted runs and never repeats an unaccepted slot", async t => {
  const f = await fixture(t);
  f.apply(d([{ id: "loop", type: "interval", startAt: iso(60), everySeconds: 60 }])); await f.app.automations.poll();
  f.advance(60); await f.app.automations.poll();
  const run = f.app.automations.runs(f.p.id).items[0]; await complete(f, run.runId);
  const file = path.join(f.p.root, ".atk/local", machineId, "schedules.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8")); state.entries["ci/loop"].last.status = "DISPATCHING";
  fs.writeFileSync(file, JSON.stringify(state)); f.restart(); await f.app.automations.poll();
  const linked = f.app.automations.schedules(f.p.id, "ci").items[0].last;
  assert.equal(linked.status, "STARTED"); assert.equal(linked.runId, run.runId);
  const next = JSON.parse(fs.readFileSync(file, "utf8"));
  next.entries["ci/loop"].through = initial + 120000;
  next.entries["ci/loop"].last = { status: "DISPATCHING", scheduledAt: iso(120), checkedAt: iso(120), requestId: crypto.randomUUID() };
  fs.writeFileSync(file, JSON.stringify(next)); f.advance(120); f.restart(); await f.app.automations.poll();
  assert.equal(f.app.automations.schedules(f.p.id, "ci").items[0].last.status, "INTERRUPTED");
  assert.equal(f.app.automations.runs(f.p.id).total, 1);
  await f.app.automations.poll(); assert.equal(f.app.automations.runs(f.p.id).total, 1);
});

test("schedule launch failures are recorded once and a corrupt cursor does not disable manual CI", async t => {
  const f = await fixture(t);
  f.apply({ ...d([{ id: "once", type: "at", times: [iso(60)] }]), steps: [{ id: "check", name: "Unavailable", cli: "atk-schedule-no-such-cli", args: [] }] });
  await f.app.automations.poll(); f.advance(60); await f.app.automations.poll();
  assert.equal(f.app.automations.schedules(f.p.id, "ci").items[0].last.error.code, "CLI_UNAVAILABLE");
  assert.equal(f.app.automations.runs(f.p.id).total, 0);
  f.apply(d([{ id: "once", type: "at", times: [iso(60)] }])); await f.app.automations.poll();
  assert.equal(f.app.automations.runs(f.p.id).total, 0);
  fs.writeFileSync(path.join(f.p.root, ".atk/local", machineId, "schedules.json"), "{}");
  await f.app.automations.poll();
  const flow = f.app.automations.show(f.p.id, "ci"); assert.ok(flow.scheduling.error);
  const manual = await f.app.automations.start(f.p.id, "ci", { revision: flow.revision, idempotencyKey: crypto.randomUUID() });
  assert.equal((await complete(f, manual.runId)).status, "SUCCEEDED");
});
