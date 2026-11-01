// M4 review & acceptance workbench — pure logic.
//
// The page itself cannot be rendered under node:test (no DOM library by design),
// so every decision the page makes is a pure function in src/domain/workbench.ts
// and is covered here: panel states (loading / error / empty / ready), request
// bodies for the three writes, which actions are legal, and how hashes/verdicts
// are displayed.
import test from "node:test";
import assert from "node:assert/strict";

import { REVIEW_STATUSES, REVIEW_VERDICTS, TASK_STATUSES } from "@atk/contracts";

import { en } from "../src/i18n/en.ts";
import { zhCN } from "../src/i18n/zh-CN.ts";
import { statusMeta, verdictMeta } from "../src/domain/status.ts";
import {
  EMPTY_FINDING,
  M4_REVIEW_STATUSES,
  REVIEW_VERDICT_VALUES,
  buildApprovalsQuery,
  buildDecideRequest,
  buildReviewsQuery,
  buildReworkRequest,
  buildSubmitRequest,
  canDecideApproval,
  canRequestRework,
  canSubmitReview,
  formatEvidence,
  hasCompleteEvidence,
  initialReviewForm,
  isReviewVerdict,
  parseTestCount,
  reviewStatusMeta,
  shortHash,
  sortReviews,
  verdictLabelKey,
  verdictOptionLabelKey,
  workbenchListState,
} from "../src/domain/workbench.ts";

const REVIEW = {
  id: "RV-1",
  taskId: "T-1",
  runId: "R-1",
  status: "PENDING",
  attempt: 1,
  version: 4,
  manifestHash: "",
  commitSha: "",
};

test("every M4 verdict has a select label and a badge label in both languages", () => {
  assert.deepEqual([...REVIEW_VERDICT_VALUES], ["PASS", "CHANGES_REQUESTED", "BLOCKED"]);
  for (const verdict of REVIEW_VERDICT_VALUES) {
    const optionKey = verdictOptionLabelKey(verdict);
    const badgeKey = verdictLabelKey(verdict);
    assert.ok(en[optionKey], `en missing ${optionKey}`);
    assert.ok(zhCN[optionKey], `zh-CN missing ${optionKey}`);
    assert.ok(en[badgeKey], `en missing ${badgeKey}`);
    assert.ok(zhCN[badgeKey], `zh-CN missing ${badgeKey}`);
    assert.equal(isReviewVerdict(verdict), true);
  }
});

test("every contract verdict has a badge label (including the historical FAIL)", () => {
  for (const verdict of REVIEW_VERDICTS) {
    const key = verdictLabelKey(verdict);
    assert.ok(en[key], `en missing ${key} for ${verdict}`);
    assert.ok(zhCN[key], `zh-CN missing ${key} for ${verdict}`);
    assert.notEqual(verdictMeta(verdict).key, "status.unknown", `${verdict} must not fall back to unknown`);
  }
  assert.equal(verdictLabelKey("PASS"), "status.verdict.PASS");
  assert.equal(verdictLabelKey("CHANGES_REQUESTED"), "status.verdict.CHANGES_REQUESTED");
});

test("unknown verdicts fall back to a translated label", () => {
  for (const value of [undefined, null, "", "SOMETHING", "toString"]) {
    assert.equal(verdictLabelKey(value), "reviews.verdict.unknown");
  }
  assert.ok(en["reviews.verdict.unknown"]);
  assert.ok(zhCN["reviews.verdict.unknown"]);
});

test("every contract review status maps to a translated label, incl. the M4 states", () => {
  for (const status of [...REVIEW_STATUSES, ...M4_REVIEW_STATUSES]) {
    const meta = reviewStatusMeta(status);
    assert.notEqual(meta.key, "status.unknown", `${status} must be mapped`);
    assert.ok(en[meta.key], `en missing ${meta.key}`);
    assert.ok(zhCN[meta.key], `zh-CN missing ${meta.key}`);
  }
  assert.equal(reviewStatusMeta("CHANGES_REQUESTED").tone, "warning");
  assert.equal(reviewStatusMeta("BLOCKED").tone, "danger");
  assert.equal(reviewStatusMeta("PENDING").tone, "neutral");
});

test("REJECTED (M4 rework waiting room) is a task status with a label", () => {
  assert.ok(TASK_STATUSES.includes("REJECTED"));
  const meta = statusMeta("task", "REJECTED");
  assert.notEqual(meta.key, "status.unknown");
  assert.ok(en[meta.key]);
  assert.ok(zhCN[meta.key]);
});

test("workbenchListState derives loading / error / empty / ready", () => {
  assert.equal(workbenchListState({ loading: true, failed: false, count: 0 }), "loading");
  assert.equal(workbenchListState({ loading: false, failed: false, count: 0 }), "empty");
  assert.equal(workbenchListState({ loading: false, failed: false, count: 3 }), "ready");
  assert.equal(workbenchListState({ loading: true, failed: false, count: 3 }), "ready");
  assert.equal(workbenchListState({ loading: false, failed: true, count: 0 }), "error");
  assert.equal(workbenchListState({ loading: true, failed: true, count: 2 }), "error");
});

test("sortReviews puts pending first, then changes requested, then the rest", () => {
  const items = [
    { id: "A", status: "PASS", createdAt: "2026-11-01T10:00:00Z" },
    { id: "B", status: "PENDING", createdAt: "2026-11-01T09:00:00Z" },
    { id: "C", status: "CHANGES_REQUESTED", createdAt: "2026-11-01T12:00:00Z" },
    { id: "D", status: "PENDING", createdAt: "2026-11-01T11:00:00Z" },
  ];
  assert.deepEqual(
    sortReviews(items).map((review) => review.id),
    ["D", "B", "C", "A"],
  );
});

test("action availability follows the review/approval status", () => {
  assert.equal(canSubmitReview({ status: "PENDING" }), true);
  assert.equal(canSubmitReview({ status: "CHANGES_REQUESTED" }), false);
  assert.equal(canSubmitReview(null), false);
  assert.equal(canRequestRework({ status: "CHANGES_REQUESTED" }), true);
  assert.equal(canRequestRework({ status: "PENDING" }), false);
  assert.equal(canDecideApproval({ status: "PENDING" }), true);
  assert.equal(canDecideApproval({ status: "APPROVED" }), false);
});

test("initialReviewForm pre-fills from the review and never throws", () => {
  assert.deepEqual(initialReviewForm(null), {
    verdict: "PASS",
    manifestHash: "",
    commitSha: "",
    testsPassed: "",
    testsTotal: "",
    findings: [],
  });
  const filled = initialReviewForm({
    ...REVIEW,
    verdict: "CHANGES_REQUESTED",
    manifestHash: "a".repeat(64),
    commitSha: "deadbee",
    evidence: { tests: { passed: 12, total: 12 } },
    findings: [{ code: "QA-1", message: "flaky test" }],
  });
  assert.equal(filled.verdict, "CHANGES_REQUESTED");
  assert.equal(filled.testsPassed, "12");
  assert.equal(filled.testsTotal, "12");
  assert.deepEqual(filled.findings, [{ code: "QA-1", message: "flaky test" }]);
  // Unknown/legacy verdict values do not leak into the select.
  assert.equal(initialReviewForm({ ...REVIEW, verdict: "FAIL" }).verdict, "PASS");
});

test("buildSubmitRequest sends the CAS version, trims values and omits blanks", () => {
  const request = buildSubmitRequest(
    { ...REVIEW, version: 7 },
    {
      verdict: "PASS",
      manifestHash: `  ${"a".repeat(64)}  `,
      commitSha: "  deadbee  ",
      testsPassed: "12",
      testsTotal: "12",
      findings: [],
    },
  );
  assert.equal(request.path, "/reviews/RV-1/submit");
  assert.equal(request.body.expectedVersion, 7);
  assert.equal(request.body.verdict, "PASS");
  assert.equal(request.body.manifestHash, "a".repeat(64));
  assert.equal(request.body.commitSha, "deadbee");
  assert.deepEqual(request.body.evidence, { tests: { passed: 12, total: 12 } });
  assert.equal(request.body.findings, undefined, "an empty findings list is omitted");
});

test("buildSubmitRequest omits empty optional inputs instead of sending empty strings", () => {
  const request = buildSubmitRequest({ ...REVIEW, version: undefined }, initialReviewForm(null));
  assert.equal(request.body.expectedVersion, 0, "a missing CAS version is left for the server to judge");
  assert.equal(request.body.manifestHash, undefined);
  assert.equal(request.body.commitSha, undefined);
  assert.equal(request.body.evidence, undefined);
  assert.equal(request.body.findings, undefined);
});

test("buildSubmitRequest keeps the server contract for evidence and findings", () => {
  const partialEvidence = buildSubmitRequest(REVIEW, {
    verdict: "PASS",
    manifestHash: "",
    commitSha: "",
    testsPassed: "3",
    testsTotal: "",
    findings: [],
  });
  assert.equal(partialEvidence.body.evidence, undefined, "half an evidence pair is not sent as evidence");

  const withFindings = buildSubmitRequest(REVIEW, {
    verdict: "CHANGES_REQUESTED",
    manifestHash: "",
    commitSha: "",
    testsPassed: "",
    testsTotal: "",
    findings: [
      { code: "  QA-1  ", message: " flaky " },
      { code: "   ", message: "dropped because it has no code" },
      { code: "QA-2", message: "" },
    ],
  });
  assert.deepEqual(withFindings.body.findings, [{ code: "QA-1", message: "flaky" }, { code: "QA-2" }]);
  assert.equal(withFindings.body.verdict, "CHANGES_REQUESTED");
});

test("buildSubmitRequest encodes ids and respects a failing PASS payload", () => {
  const request = buildSubmitRequest({ ...REVIEW, id: "RV/1 2" }, initialReviewForm(null));
  assert.equal(request.path, "/reviews/RV%2F1%202/submit");
  // The UI does not pre-reject an evidence-less PASS: the backend owns that
  // judgement (EVIDENCE_MISSING) and the workbench renders its answer.
  assert.equal(request.body.evidence, undefined);
});

test("test counts only accept non-negative integers", () => {
  assert.equal(parseTestCount("0"), 0);
  assert.equal(parseTestCount(" 12 "), 12);
  assert.equal(parseTestCount(""), null);
  assert.equal(parseTestCount("   "), null);
  assert.equal(parseTestCount("-1"), null);
  assert.equal(parseTestCount("1.5"), null);
  assert.equal(parseTestCount("abc"), null);
  assert.equal(parseTestCount(undefined), null);
});

test("rework and decide requests carry the contract bodies", () => {
  const rework = buildReworkRequest({ ...REVIEW, id: "RV-9" }, "  fix the flaky test  ");
  assert.equal(rework.path, "/reviews/RV-9/rework");
  assert.deepEqual(rework.body, { reason: "fix the flaky test" });

  const decide = buildDecideRequest({ id: "AP-1", status: "PENDING", targetHash: "b".repeat(64) }, "APPROVED");
  assert.equal(decide.path, "/approvals/AP-1/decide");
  assert.equal(decide.body.decision, "APPROVED");
  assert.equal(decide.body.targetHash, "b".repeat(64), "the FULL hash is sent, not the truncated one");
});

test("query builders match the contract endpoints", () => {
  assert.equal(buildReviewsQuery("PENDING"), "/reviews?status=PENDING&limit=100");
  assert.equal(buildReviewsQuery(null), "/reviews?limit=100");
  assert.equal(buildReviewsQuery(undefined, 25), "/reviews?limit=25");
  assert.equal(buildApprovalsQuery("T-1"), "/approvals?taskId=T-1");
  assert.equal(buildApprovalsQuery(null), null);
  assert.equal(buildApprovalsQuery("   "), null);
});

test("hashes are truncated for display but never for the request", () => {
  const hash = "0123456789abcdef0123456789abcdef";
  assert.equal(shortHash(hash), "0123456789ab…");
  assert.equal(shortHash(hash, 4), "0123…");
  assert.equal(shortHash("abc"), "abc");
  assert.equal(shortHash(""), "");
  assert.equal(shortHash(null), "");
  assert.equal(shortHash("  "), "");
});

test("evidence helpers describe completeness for the UI hint", () => {
  assert.equal(formatEvidence({ tests: { passed: 12, total: 12 } }), "12/12");
  assert.equal(formatEvidence({ tests: { passed: 0, total: 0 } }), "0/0");
  assert.equal(formatEvidence(null), null);
  assert.equal(formatEvidence({ tests: {} }), null);
  assert.equal(hasCompleteEvidence({ tests: { passed: 12, total: 12 } }), true);
  assert.equal(hasCompleteEvidence({ tests: { passed: 11, total: 12 } }), false);
  assert.equal(hasCompleteEvidence({ tests: { passed: 0, total: 0 } }), false);
  assert.equal(hasCompleteEvidence(null), false);
});

test("the M4 review statuses used by the page are the documented four", () => {
  assert.deepEqual([...M4_REVIEW_STATUSES], ["PENDING", "PASS", "CHANGES_REQUESTED", "BLOCKED"]);
  assert.equal(EMPTY_FINDING.code, "");
  assert.equal(EMPTY_FINDING.message, "");
});
