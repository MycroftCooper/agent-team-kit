// Event-type label coverage driven by the contract's EVENT_TYPES.
import test from "node:test";
import assert from "node:assert/strict";

import { EVENT_TYPES } from "@atk/contracts";

import { EVENT_TYPE_KEYS, UNKNOWN_EVENT_LABEL_KEY, eventTypeLabelKey } from "../src/domain/events.ts";
import { en } from "../src/i18n/en.ts";
import { zhCN } from "../src/i18n/zh-CN.ts";

test("every contract event type has a translated label", () => {
  for (const type of EVENT_TYPES) {
    const key = EVENT_TYPE_KEYS[type];
    assert.ok(key, `${type} has no label key`);
    assert.ok(en[key], `en missing ${key}`);
    assert.ok(zhCN[key], `zh-CN missing ${key}`);
    assert.equal(eventTypeLabelKey(type), key);
  }
});

test("no stale event labels beyond the contract enum", () => {
  assert.deepEqual(Object.keys(EVENT_TYPE_KEYS).sort(), [...EVENT_TYPES].sort());
});

test("unknown event types fall back to a translated label", () => {
  for (const value of [undefined, null, "", "internal.secret", "toString"]) {
    assert.equal(eventTypeLabelKey(value), UNKNOWN_EVENT_LABEL_KEY);
  }
  assert.ok(en[UNKNOWN_EVENT_LABEL_KEY]);
  assert.ok(zhCN[UNKNOWN_EVENT_LABEL_KEY]);
});
