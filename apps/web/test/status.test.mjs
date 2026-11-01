// Status -> label/tone coverage. The data source is @atk/contracts itself, so a
// new enum value cannot be merged without a label: this test iterates the
// canonical arrays instead of a hand-written copy.
import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCEPTANCE_STATUSES,
  AGENT_STATUSES,
  FUNCTIONS,
  GATE_STATUSES,
  INTEGRATION_STATUSES,
  PRIORITY,
  REVIEW_STATUSES,
  RUN_STATUSES,
  TASK_STATUSES,
} from "@atk/contracts";

import { STATUS_GROUPS, STATUS_GROUP_META, priorityMeta, statusGroupLabelKey, statusMeta } from "../src/domain/status.ts";
import { en } from "../src/i18n/en.ts";
import { zhCN } from "../src/i18n/zh-CN.ts";

const TONES = new Set(["neutral", "info", "success", "warning", "danger"]);

const ENUMS = {
  task: TASK_STATUSES,
  run: RUN_STATUSES,
  agent: AGENT_STATUSES,
  review: REVIEW_STATUSES,
  integration: INTEGRATION_STATUSES,
  acceptance: ACCEPTANCE_STATUSES,
  gate: GATE_STATUSES,
  function: FUNCTIONS,
};

test("every contract status group is mapped", () => {
  assert.deepEqual(STATUS_GROUPS.sort(), Object.keys(ENUMS).sort());
});

for (const [group, values] of Object.entries(ENUMS)) {
  test(`${group}: every enum value has a label and a valid tone in both languages`, () => {
    assert.ok(values.length > 0, `${group} enum must not be empty`);
    for (const value of values) {
      const meta = statusMeta(group, value);
      assert.equal(meta.key, `status.${group}.${value}`, `${group}/${value} maps to an unexpected key`);
      assert.ok(en[meta.key], `en is missing ${meta.key}`);
      assert.ok(zhCN[meta.key], `zh-CN is missing ${meta.key}`);
      assert.ok(TONES.has(meta.tone), `${group}/${value} has invalid tone ${meta.tone}`);
    }
  });

  test(`${group}: the meta table contains no stale values`, () => {
    const table = STATUS_GROUP_META[group].byValue;
    assert.deepEqual(Object.keys(table).sort(), [...values].sort());
  });

  test(`${group}: group label is translated`, () => {
    const labelKey = statusGroupLabelKey(group);
    assert.ok(en[labelKey], `en missing group label ${labelKey}`);
    assert.ok(zhCN[labelKey], `zh-CN missing group label ${labelKey}`);
  });
}

test("gate statuses never mark SKIPPED/UNCONFIGURED as success", () => {
  assert.equal(statusMeta("gate", "PASS").tone, "success");
  assert.equal(statusMeta("gate", "FAIL").tone, "danger");
  assert.notEqual(statusMeta("gate", "SKIPPED").tone, "success");
  assert.notEqual(statusMeta("gate", "UNCONFIGURED").tone, "success");
  assert.equal(statusMeta("gate", "ERROR").tone, "danger");
});

test("acceptance PENDING is a warning, APPROVED success, REJECTED danger", () => {
  assert.equal(statusMeta("acceptance", "PENDING").tone, "warning");
  assert.equal(statusMeta("acceptance", "APPROVED").tone, "success");
  assert.equal(statusMeta("acceptance", "REJECTED").tone, "danger");
});

test("unknown / missing values fall back to status.unknown and neutral", () => {
  for (const value of [undefined, null, "", "NOT_A_STATUS", "constructor", "__proto__"]) {
    const meta = statusMeta("task", value);
    assert.deepEqual(meta, { key: "status.unknown", tone: "neutral" });
  }
  assert.ok(en["status.unknown"]);
  assert.ok(zhCN["status.unknown"]);
});

test("priority labels cover every named level", () => {
  for (const value of Object.values(PRIORITY)) {
    const meta = priorityMeta(value);
    assert.ok(meta.key.startsWith("task.priority."), `unexpected key ${meta.key}`);
    assert.ok(en[meta.key], `en missing ${meta.key}`);
    assert.ok(zhCN[meta.key], `zh-CN missing ${meta.key}`);
    assert.ok(TONES.has(meta.tone));
  }
});

test("urgent and high priorities are visually flagged, normal/low are neutral", () => {
  assert.equal(priorityMeta(PRIORITY.URGENT).tone, "warning");
  assert.equal(priorityMeta(PRIORITY.HIGH).tone, "warning");
  assert.equal(priorityMeta(PRIORITY.NORMAL).tone, "neutral");
  assert.equal(priorityMeta(PRIORITY.LOW).tone, "neutral");
});

test("unknown priorities render as P<value>", () => {
  const meta = priorityMeta(-1);
  assert.equal(meta.key, "task.priorityOther");
  assert.deepEqual(meta.params, { value: -1 });
  assert.ok(en[meta.key]);
  assert.ok(zhCN[meta.key]);

  const missing = priorityMeta(undefined);
  assert.equal(missing.key, "task.priorityOther");
  assert.deepEqual(missing.params, { value: "?" });
});
