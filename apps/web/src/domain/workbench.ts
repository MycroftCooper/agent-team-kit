// Pure logic for the M4 review & acceptance workbench (docs/architecture/m4-contracts.md
// §2/§3). Everything the page decides — which panel state to show, what request
// body to POST, which actions are legal, how a hash/verdict/status is displayed —
// lives here so it can be unit-tested with node:test (the project has no DOM
// testing library by design).
//
// The workbench never *guesses* a verdict: it sends what the user typed and
// renders the backend's error code/message/details verbatim (see
// `actionErrorView` in ./errors.ts).
import type {
  Approval,
  DecideApprovalRequest,
  Review,
  ReviewEvidence,
  ReviewFinding,
  ReworkRequest,
  SubmitReviewRequest,
} from "../api/types.ts";
import { buildQuery } from "../api/client.ts";
import type { MessageKey } from "../i18n/en.ts";
import { statusMeta, verdictMeta, type StatusMeta } from "./status.ts";

/** Verdicts accepted by `POST /reviews/:id/submit` (m4-contracts §1/§2). */
export const REVIEW_VERDICT_VALUES = ["PASS", "CHANGES_REQUESTED", "BLOCKED"] as const;
export type ReviewVerdictValue = (typeof REVIEW_VERDICT_VALUES)[number];

/** Labels for the verdict *select options* (badges use `status.verdict.*`). */
const VERDICT_OPTION_LABEL_KEYS: Record<ReviewVerdictValue, MessageKey> = {
  PASS: "reviews.verdict.PASS",
  CHANGES_REQUESTED: "reviews.verdict.CHANGES_REQUESTED",
  BLOCKED: "reviews.verdict.BLOCKED",
};

export const UNKNOWN_VERDICT_LABEL_KEY: MessageKey = "reviews.verdict.unknown";

/** Badge label for any verdict, including historical `FAIL` and unknown values. */
export function verdictLabelKey(verdict: string | null | undefined): MessageKey {
  const meta = verdictMeta(verdict);
  return meta.key === "status.unknown" ? UNKNOWN_VERDICT_LABEL_KEY : meta.key;
}

/** Select-option label ("PASS — accept the candidate"). */
export function verdictOptionLabelKey(verdict: ReviewVerdictValue): MessageKey {
  return VERDICT_OPTION_LABEL_KEYS[verdict];
}

export function isReviewVerdict(value: unknown): value is ReviewVerdictValue {
  return (REVIEW_VERDICT_VALUES as readonly string[]).includes(String(value ?? ""));
}

/**
 * Review statuses used by the M4 review lifecycle. These now live in the
 * contracts `REVIEW_STATUSES` enum, so `statusMeta("review", …)` knows them; the
 * helper stays as the page-facing name for "the four review outcomes".
 */
export const M4_REVIEW_STATUSES = ["PENDING", "PASS", "CHANGES_REQUESTED", "BLOCKED"] as const;

/** Exposed for the page so it does not import the mapping table directly. */
export function reviewStatusMeta(value: string | null | undefined): StatusMeta {
  return statusMeta("review", value);
}

// ---------------------------------------------------------------- panel states ---

export type WorkbenchListState = "loading" | "error" | "empty" | "ready";

/** The list panel state is derived, never a pile of ad-hoc booleans in JSX. */
export function workbenchListState(input: { loading: boolean; failed: boolean; count: number }): WorkbenchListState {
  if (input.failed) return "error";
  if (input.count > 0) return "ready";
  return input.loading ? "loading" : "empty";
}

/** PENDING first, then CHANGES_REQUESTED, then finished reviews (newest first). */
export function sortReviews(reviews: readonly Review[]): Review[] {
  const rank = (status: string | undefined): number => {
    if (status === "PENDING") return 0;
    if (status === "CHANGES_REQUESTED") return 1;
    return 2;
  };
  return [...reviews].sort((left, right) => {
    const byRank = rank(left.status) - rank(right.status);
    if (byRank !== 0) return byRank;
    return String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? ""));
  });
}

export function canSubmitReview(review: Review | null | undefined): boolean {
  return review?.status === "PENDING";
}

export function canRequestRework(review: Review | null | undefined): boolean {
  return review?.status === "CHANGES_REQUESTED";
}

export function canDecideApproval(approval: Approval | null | undefined): boolean {
  return approval?.status === "PENDING";
}

// -------------------------------------------------------------------- the form ---

export type ReviewFindingDraft = { code: string; message: string };

export type ReviewFormState = {
  verdict: ReviewVerdictValue;
  manifestHash: string;
  commitSha: string;
  testsPassed: string;
  testsTotal: string;
  findings: ReviewFindingDraft[];
};

export const EMPTY_FINDING: ReviewFindingDraft = { code: "", message: "" };

/** Never throws on a half-populated review (backend fields are optional). */
export function initialReviewForm(review: Review | null | undefined): ReviewFormState {
  const evidence = review?.evidence ?? null;
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  return {
    verdict: isReviewVerdict(review?.verdict) ? (review.verdict as ReviewVerdictValue) : "PASS",
    manifestHash: typeof review?.manifestHash === "string" ? review.manifestHash : "",
    commitSha: typeof review?.commitSha === "string" ? review.commitSha : "",
    testsPassed: evidence?.tests?.passed !== undefined && Number.isFinite(evidence.tests.passed) ? String(evidence.tests.passed) : "",
    testsTotal: evidence?.tests?.total !== undefined && Number.isFinite(evidence.tests.total) ? String(evidence.tests.total) : "",
    findings: findings.map((finding) => ({ code: String(finding.code ?? ""), message: String(finding.message ?? "") })),
  };
}

/** Integer count parser for the evidence inputs; `null` when absent/invalid. */
export function parseTestCount(value: string | null | undefined): number | null {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

function buildEvidence(form: ReviewFormState): ReviewEvidence | null {
  const passed = parseTestCount(form.testsPassed);
  const total = parseTestCount(form.testsTotal);
  if (passed === null || total === null) return null;
  return { tests: { passed, total } };
}

function buildFindings(findings: readonly ReviewFindingDraft[]): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  for (const draft of findings) {
    const code = draft.code.trim();
    if (code === "") continue;
    const message = draft.message.trim();
    out.push(message === "" ? { code } : { code, message });
  }
  return out;
}

export type SubmitRequest = { path: string; body: SubmitReviewRequest };

/**
 * `POST /reviews/:id/submit` body:
 * - `expectedVersion` is the review's CAS token (0 when the backend omitted it, so
 *   the server — not the UI — decides whether that is a conflict);
 * - empty optional inputs are omitted instead of sent as `""`;
 * - findings with a blank `code` are dropped; message-only rows cannot exist.
 */
export function buildSubmitRequest(review: Review, form: ReviewFormState): SubmitRequest {
  const body: SubmitReviewRequest = {
    expectedVersion: Number.isInteger(review.version) ? (review.version as number) : 0,
    verdict: form.verdict,
  };
  const manifestHash = form.manifestHash.trim();
  if (manifestHash !== "") body.manifestHash = manifestHash;
  const commitSha = form.commitSha.trim();
  if (commitSha !== "") body.commitSha = commitSha;
  const findings = buildFindings(form.findings);
  if (findings.length > 0) body.findings = findings;
  const evidence = buildEvidence(form);
  if (evidence !== null) body.evidence = evidence;
  return { path: `/reviews/${encodeURIComponent(review.id)}/submit`, body };
}

export type ReworkRequestPayload = { path: string; body: ReworkRequest };

export function buildReworkRequest(review: Review, reason: string): ReworkRequestPayload {
  return { path: `/reviews/${encodeURIComponent(review.id)}/rework`, body: { reason: reason.trim() } };
}

export const APPROVAL_DECISIONS = ["APPROVED", "REJECTED"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export type DecideRequest = { path: string; body: DecideApprovalRequest };

/**
 * `POST /approvals/:id/decide`. The full `targetHash` (never the truncated one
 * shown in the UI) is sent so the backend can detect a stale approval.
 */
export function buildDecideRequest(approval: Approval, decision: ApprovalDecision): DecideRequest {
  return {
    path: `/approvals/${encodeURIComponent(approval.id)}/decide`,
    body: { decision, targetHash: String(approval.targetHash ?? "") },
  };
}

// ------------------------------------------------------------------- endpoints ---

/** `GET /reviews?status=&limit=`; `status === null` lists everything. */
export function buildReviewsQuery(status: string | null | undefined, limit = 100): string {
  return `/reviews${buildQuery({ status: status ?? undefined, limit })}`;
}

/** `GET /approvals?taskId=`; `null` when no task is selected yet. */
export function buildApprovalsQuery(taskId: string | null | undefined): string | null {
  const id = String(taskId ?? "").trim();
  if (id === "") return null;
  return `/approvals${buildQuery({ taskId: id })}`;
}

// --------------------------------------------------------------------- display ---

/** First `length` characters of a hash for display; the full value is still sent. */
export function shortHash(hash: string | null | undefined, length = 12): string {
  const value = String(hash ?? "").trim();
  if (value === "") return "";
  return value.length <= length ? value : `${value.slice(0, Math.max(1, length))}…`;
}

/** `"3/4"` for the evidence column; `null` when the backend sent no evidence. */
export function formatEvidence(evidence: ReviewEvidence | null | undefined): string | null {
  const passed = evidence?.tests?.passed;
  const total = evidence?.tests?.total;
  if (typeof passed !== "number" || typeof total !== "number") return null;
  return `${passed}/${total}`;
}

/** True when the evidence shows a complete test run (the PASS precondition). */
export function hasCompleteEvidence(evidence: ReviewEvidence | null | undefined): boolean {
  const passed = evidence?.tests?.passed;
  const total = evidence?.tests?.total;
  return typeof passed === "number" && typeof total === "number" && total > 0 && passed === total;
}
