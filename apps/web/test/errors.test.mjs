// Error presentation coverage, driven by the contract's ERROR_CODE_LIST.
import test from "node:test";
import assert from "node:assert/strict";

import { ERROR_CODES, ERROR_CODE_LIST } from "@atk/contracts";

import {
  ERROR_MESSAGE_KEYS,
  INVALID_RESPONSE_CODE,
  NETWORK_ERROR_CODE,
  actionErrorView,
  describeError,
  errorTitleKey,
  isKnownErrorCode,
  isRetryableCode,
  versionFromDetails,
} from "../src/domain/errors.ts";
import { en } from "../src/i18n/en.ts";
import { zhCN } from "../src/i18n/zh-CN.ts";

test("every contract error code has a human-readable message in both languages", () => {
  for (const code of ERROR_CODE_LIST) {
    const key = ERROR_MESSAGE_KEYS[code];
    assert.ok(key, `${code} has no message key`);
    assert.ok(en[key], `en missing ${key}`);
    assert.ok(zhCN[key], `zh-CN missing ${key}`);
    const descriptor = describeError({ code });
    assert.equal(descriptor.messageKey, key);
    assert.ok(en[descriptor.titleKey], `en missing title ${descriptor.titleKey}`);
    assert.ok(zhCN[descriptor.titleKey], `zh-CN missing title ${descriptor.titleKey}`);
  }
});

test("retryability follows the contract table", () => {
  for (const code of ERROR_CODE_LIST) {
    assert.equal(describeError({ code }).retryable, ERROR_CODES[code].retryable, `${code} retryable mismatch`);
    assert.equal(isRetryableCode(code), ERROR_CODES[code].retryable);
  }
  assert.equal(isRetryableCode("NOT_A_CONTRACT_CODE"), false);
});

test("TASK_VERSION_CONFLICT surfaces details.currentVersion", () => {
  const descriptor = describeError({ code: "TASK_VERSION_CONFLICT", details: { currentVersion: 7 } });
  assert.equal(descriptor.titleKey, "error.title.conflict");
  assert.equal(descriptor.params.version, 7);
  const text = en[descriptor.messageKey].replace("{{version}}", String(descriptor.params.version));
  assert.ok(text.includes("7"), `expected version in message, got: ${text}`);
});

test("version fallbacks and the unknown-version case", () => {
  assert.equal(describeError({ code: "TASK_VERSION_CONFLICT", details: { version: "3" } }).params.version, "3");
  assert.equal(describeError({ code: "TASK_VERSION_CONFLICT", details: { expectedVersion: 4 } }).params.version, 4);
  assert.equal(describeError({ code: "TASK_VERSION_CONFLICT" }).params.version, undefined);
  assert.equal(describeError({ code: "NOT_FOUND", details: { currentVersion: 9 } }).params.version, 9);
});

test("versionFromDetails ignores malformed payloads", () => {
  assert.equal(versionFromDetails(null), null);
  assert.equal(versionFromDetails(undefined), null);
  assert.equal(versionFromDetails("nope"), null);
  assert.equal(versionFromDetails({ currentVersion: { nested: true } }), null);
  assert.equal(versionFromDetails({ currentVersion: false }), null);
});

test("both conflict codes are presented as a conflict with the current version", () => {
  for (const code of ["TASK_VERSION_CONFLICT", "VERSION_CONFLICT"]) {
    const descriptor = describeError({ code, details: { currentVersion: 6 } });
    assert.equal(descriptor.titleKey, "error.title.conflict", `${code} title`);
    assert.equal(descriptor.params.version, 6, `${code} version`);
    assert.equal(descriptor.retryable, true, `${code} should be retryable`);
  }
});

test("transport failure is distinguishable from auth and conflict errors", () => {
  const network = describeError({ code: NETWORK_ERROR_CODE });
  const auth = describeError({ code: "NOT_AUTHORIZED" });
  const conflict = describeError({ code: "TASK_VERSION_CONFLICT" });

  assert.equal(network.titleKey, "error.network.title");
  assert.equal(auth.titleKey, "error.title.unauthorized");
  assert.equal(conflict.titleKey, "error.title.conflict");
  const titles = new Set([network.titleKey, auth.titleKey, conflict.titleKey, describeError({ code: "NOT_FOUND" }).titleKey]);
  assert.equal(titles.size, 4, "each class of failure must be visually distinguishable");
  assert.equal(network.retryable, true);
  assert.equal(network.known, false);
  assert.equal(auth.known, true);
});

test("unknown codes render the code itself, with a readable wrapper", () => {
  const descriptor = describeError({ code: "SOMETHING_NEW", requestId: "req-9" });
  assert.equal(descriptor.known, false);
  assert.equal(descriptor.messageKey, "error.unknownCode");
  assert.deepEqual(descriptor.params, { code: "SOMETHING_NEW" });
  assert.equal(descriptor.requestId, "req-9");
  assert.equal(descriptor.retryable, false);
  assert.ok(en[descriptor.messageKey].includes("{{code}}"));
  assert.ok(zhCN[descriptor.messageKey].includes("{{code}}"));
});

test("missing / malformed input degrades to INVALID_RESPONSE", () => {
  for (const input of [undefined, null, {}, { code: "" }, { code: 42 }]) {
    const descriptor = describeError(input);
    assert.equal(descriptor.code, INVALID_RESPONSE_CODE);
    assert.ok(en[descriptor.messageKey], "fallback message key must exist");
  }
  assert.equal(isKnownErrorCode("NOT_FOUND"), true);
  assert.equal(isKnownErrorCode("NOPE"), false);
});

// ------------------------------------------------- M4 review / acceptance codes ---

test("SELF_REVIEW_FORBIDDEN explains why the reviewer is rejected (en + zh)", () => {
  const descriptor = describeError({ code: "SELF_REVIEW_FORBIDDEN" });
  assert.equal(descriptor.known, true);
  assert.equal(descriptor.titleKey, "error.title.selfReview");
  assert.equal(descriptor.retryable, false);
  assert.match(en[descriptor.messageKey].toLowerCase(), /cannot review your own work/);
  assert.match(zhCN[descriptor.messageKey], /不能审查自己的工作/);
  assert.ok(zhCN[descriptor.messageKey].includes("Agent"));
});

test("EVIDENCE_MISSING states exactly what a PASS requires (en + zh)", () => {
  const descriptor = describeError({ code: "EVIDENCE_MISSING" });
  assert.equal(descriptor.titleKey, "error.title.evidence");
  assert.match(en[descriptor.messageKey], /manifest hash/i);
  assert.match(en[descriptor.messageKey], /passed equal to total/i);
  assert.match(zhCN[descriptor.messageKey], /manifestHash/);
  assert.match(zhCN[descriptor.messageKey], /通过数必须等于用例总数/);
});

test("APPROVAL_STALE tells the user the target changed and must be re-accepted", () => {
  const descriptor = describeError({ code: "APPROVAL_STALE" });
  assert.equal(descriptor.titleKey, "error.title.stale");
  assert.ok(zhCN[descriptor.messageKey].includes("目标已变更，需重新验收"), zhCN[descriptor.messageKey]);
  assert.match(en[descriptor.messageKey].toLowerCase(), /target has changed/);
  assert.match(en[descriptor.messageKey].toLowerCase(), /accept it again/);
  assert.equal(descriptor.retryable, true, "APPROVAL_STALE is marked retryable in the contract");
});

test("REWORK_LIMIT_REACHED explains the block (en + zh)", () => {
  const descriptor = describeError({ code: "REWORK_LIMIT_REACHED" });
  assert.equal(descriptor.titleKey, "error.title.reworkLimit");
  assert.ok(zhCN[descriptor.messageKey].includes("返工上限"));
  assert.match(en[descriptor.messageKey], /rework limit/i);
  assert.equal(descriptor.retryable, false);
});

test("the four M4 codes have distinct titles and every error title is translated", () => {
  const m4 = ["SELF_REVIEW_FORBIDDEN", "EVIDENCE_MISSING", "APPROVAL_STALE", "REWORK_LIMIT_REACHED"];
  const titles = new Set(m4.map((code) => describeError({ code }).titleKey));
  assert.equal(titles.size, 4, "each M4 failure class must be visually distinguishable");
  for (const code of ERROR_CODE_LIST) {
    const titleKey = errorTitleKey(code);
    assert.ok(en[titleKey], `en missing title ${titleKey}`);
    assert.ok(zhCN[titleKey], `zh-CN missing title ${titleKey}`);
  }
});

test("actionErrorView keeps the server message and details verbatim", () => {
  const view = actionErrorView({
    code: "APPROVAL_STALE",
    message: "approval target bbb... != current aaa...",
    requestId: "req-77",
    httpStatus: 409,
    retryable: true,
    details: { currentHash: "a".repeat(64), approvalHash: "b".repeat(64) },
  });
  assert.equal(view.code, "APPROVAL_STALE");
  assert.equal(view.titleKey, "error.title.stale");
  assert.equal(view.serverMessage, "approval target bbb... != current aaa...");
  assert.deepEqual(view.details, { currentHash: "a".repeat(64), approvalHash: "b".repeat(64) });
  assert.equal(view.hasDetails, true);
  assert.equal(view.requestId, "req-77");

  const bare = actionErrorView({ code: "SELF_REVIEW_FORBIDDEN", message: "   " });
  assert.equal(bare.serverMessage, null, "blank server messages are not rendered as an empty line");
  assert.equal(bare.hasDetails, false);
});
