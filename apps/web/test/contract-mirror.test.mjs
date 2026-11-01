// Contract-mirror and page-wiring guards for the M4 review workbench.
//
// 1. The SPA mirrors @atk/contracts with a local ambient declaration
//    (src/types/contracts.d.ts) because the package ships plain .mjs. Nothing at
//    runtime notices when the two drift, so this test compares them literally.
// 2. The workbench is a UI page: no DOM library is allowed in this project, so
//    the stable seams (route + `data-testid` + state components) are asserted
//    statically. Behaviour is covered by test/workbench.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ERROR_CODE_LIST, EVENT_TYPES, REVIEW_STATUSES, REVIEW_VERDICTS, TASK_STATUSES } from "@atk/contracts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

const contractsDts = read("src/types/contracts.d.ts");

function unionMembers(source, typeName) {
  const block = new RegExp(`export type ${typeName} =([\\s\\S]*?);`).exec(source);
  assert.ok(block, `contracts.d.ts has no "export type ${typeName}"`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

test("the contracts.d.ts ErrorCode union mirrors ERROR_CODE_LIST exactly", () => {
  const declared = unionMembers(contractsDts, "ErrorCode");
  assert.deepEqual(declared.sort(), [...ERROR_CODE_LIST].sort());
  for (const code of ["SELF_REVIEW_FORBIDDEN", "EVIDENCE_MISSING", "APPROVAL_STALE", "REWORK_LIMIT_REACHED"]) {
    assert.ok(declared.includes(code), `the M4 error code ${code} is missing from the SPA mirror`);
  }
});

test("the status/verdict/event unions mirror the contract enums exactly", () => {
  assert.deepEqual(unionMembers(contractsDts, "TaskStatus").sort(), [...TASK_STATUSES].sort());
  assert.deepEqual(unionMembers(contractsDts, "ReviewStatus").sort(), [...REVIEW_STATUSES].sort());
  assert.deepEqual(unionMembers(contractsDts, "ReviewVerdict").sort(), [...REVIEW_VERDICTS].sort());
  assert.deepEqual(unionMembers(contractsDts, "EventType").sort(), [...EVENT_TYPES].sort());
});

test("the sidebar exposes a data-testid=nav-reviews entry", () => {
  const sidenav = read("src/components/SideNav.tsx");
  assert.match(sidenav, /data-testid=\{`nav-\$\{item\.name\}`\}/, "nav items must carry stable data-testid hooks");
  const router = read("src/router.ts");
  assert.match(router, /name: "reviews", href: "#\/reviews"/, "the reviews route must stay in the navigation");
});

test("the #/reviews route is the workbench, with queue + verdict + approval panels", () => {
  const page = read("src/pages/ReviewsPage.tsx");
  assert.match(page, /data-testid="reviews-page"/);
  assert.match(page, /workbenchListState/, "the list panel state must be derived by the pure helper");
  assert.match(page, /<ReviewQueue/);
  assert.match(page, /<ReviewPanel/);
  assert.match(page, /<ApprovalPanel/);
  assert.match(page, /buildReviewsQuery/, "the queue must query GET /reviews?status=");
  assert.match(page, /buildApprovalsQuery/, "the acceptance panel must query GET /approvals?taskId=");
  assert.match(page, /data-testid="workbench-result"/, "write confirmations must survive the queue refresh");
  assert.match(page, /onSubmitted/);
  assert.match(page, /onReworked/);

  const queue = read("src/components/ReviewQueue.tsx");
  assert.match(queue, /data-testid="review-queue"/);
  assert.match(queue, /data-testid="review-list"/);
  assert.match(queue, /review-item-\$\{review\.id\}/);
  assert.match(queue, /LoadingState/);
  assert.match(queue, /EmptyState/);
  assert.match(queue, /ErrorState/);
});

test("the verdict panel exposes every field the contract requires", () => {
  const panel = read("src/components/ReviewPanel.tsx");
  for (const testId of [
    "review-panel",
    "review-verdict",
    "review-manifest-hash",
    "review-commit-sha",
    "review-tests-passed",
    "review-tests-total",
    "review-submit",
    "review-rework",
    "review-rework-reason",
  ]) {
    assert.ok(panel.includes(testId), `ReviewPanel is missing data-testid=${testId}`);
  }
  assert.match(panel, /apiPost/, "the verdict must be submitted to the backend");
  assert.match(panel, /buildSubmitRequest/);
  assert.match(panel, /buildReworkRequest/);
  assert.match(panel, /ActionFeedback/, "write failures must render the server error panel");

  const findings = read("src/components/FindingsEditor.tsx");
  assert.ok(findings.includes("review-finding-add"));
  assert.ok(findings.includes("review-finding-${index}-code"));
  assert.ok(findings.includes("review-finding-${index}-remove"));
});

test("the acceptance panel shows a truncated hash with copy and both decisions", () => {
  const panel = read("src/components/ApprovalPanel.tsx");
  for (const testId of [
    "approval-panel",
    "approval-target-hash",
    "approval-copy-hash",
    "approval-approve",
    "approval-reject",
  ]) {
    assert.ok(panel.includes(testId), `ApprovalPanel is missing data-testid=${testId}`);
  }
  assert.match(panel, /shortHash\(/, "the displayed hash must be the truncated form");
  assert.match(panel, /buildDecideRequest/, "decisions must go through the request builder (full targetHash)");
  assert.match(panel, /apiPost/);
  assert.match(panel, /ActionFeedback/);
});

test("write failures show the localized code plus the verbatim server message and details", () => {
  const feedback = read("src/components/ActionFeedback.tsx");
  assert.match(feedback, /data-testid="action-error"/);
  assert.match(feedback, /role="alert"/);
  assert.match(feedback, /actionErrorView/, "the panel must use the shared error view");
  assert.match(feedback, /common\.serverMessage/, "the server message must be displayed");
  assert.match(feedback, /common\.serverDetails/, "the server details must be displayed");
  assert.match(feedback, /data-testid="action-error-server-message"/);
  assert.doesNotMatch(feedback, /error\.code\.INTERNAL_ERROR/, "the panel must not replace server errors with a local guess");
});
