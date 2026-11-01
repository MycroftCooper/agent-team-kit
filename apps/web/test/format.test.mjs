// Locale-aware date formatting: missing/invalid timestamps must render as the
// dictionary's "none" label, never as "Invalid Date".
import test from "node:test";
import assert from "node:assert/strict";

import { formatDateTime } from "../src/format.ts";

test("valid timestamps format in both locales", () => {
  const en = formatDateTime("2026-11-02T03:12:04.000Z", "en");
  const zh = formatDateTime("2026-11-02T03:12:04.000Z", "zh-CN");
  assert.equal(typeof en, "string");
  assert.equal(typeof zh, "string");
  assert.ok(en.includes("2026"), `en output should contain the year, got ${en}`);
  assert.ok(zh.includes("2026"), `zh output should contain the year, got ${zh}`);
  assert.ok(en.length > 0 && zh.length > 0);
});

test("missing and invalid timestamps return null", () => {
  for (const value of [null, undefined, "", "   ", "not-a-date", "2026-13-45T99:99:99Z"]) {
    assert.equal(formatDateTime(value, "en"), null, `expected null for ${JSON.stringify(value)}`);
  }
});

test("epoch zero is a valid timestamp", () => {
  const formatted = formatDateTime("1970-01-01T00:00:00.000Z", "en");
  assert.equal(typeof formatted, "string");
  assert.ok(formatted.length > 0);
});
