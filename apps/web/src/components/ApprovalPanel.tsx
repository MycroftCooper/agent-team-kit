// Human acceptance panel: the approval is bound to a `targetHash`, so the full
// hash is shown truncated + copyable while the *full* value is sent with the
// decision. A mismatched target comes back as 409 `APPROVAL_STALE` and is
// rendered as "the target changed — review it again", never as a generic failure.
import { useState } from "react";
import { apiPost } from "../api/client.ts";
import type { Approval, DecideApprovalResponse } from "../api/types.ts";
import type { ApiFailure } from "../domain/errors.ts";
import { useWriteAction } from "../api/useWriteAction.ts";
import type { ApprovalDecision } from "../domain/workbench.ts";
import { buildDecideRequest, canDecideApproval, shortHash } from "../domain/workbench.ts";
import { useT } from "../i18n/index.tsx";
import { ActionFeedback, ActionSuccess } from "./ActionFeedback.tsx";
import { InlineError, SectionHeader } from "./StateViews.tsx";
import { StatusBadge } from "./StatusBadge.tsx";

export function ApprovalPanel({
  taskId,
  approvals,
  taskFailure,
  onChanged,
}: {
  taskId: string | null;
  approvals: readonly Approval[];
  taskFailure: ApiFailure | null;
  onChanged: () => void;
}) {
  const t = useT();
  const decide = useWriteAction<DecideApprovalResponse>();
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyHash = async (approval: Approval) => {
    const hash = String(approval.targetHash ?? "");
    if (hash === "") return;
    try {
      await navigator.clipboard.writeText(hash);
      setCopiedId(approval.id);
      window.setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // Clipboard can be blocked by the browser; the hash stays visible and
      // selectable, so this is not an error worth interrupting the user for.
      setCopiedId(null);
    }
  };

  const decideOn = async (approval: Approval, decision: ApprovalDecision) => {
    const payload = buildDecideRequest(approval, decision);
    const result = await decide.execute(() => apiPost<DecideApprovalResponse>(payload.path, payload.body));
    if (result) onChanged();
  };

  return (
    <section className="card approval-panel" data-testid="approval-panel" aria-label={t("reviews.approvalTitle")}>
      <SectionHeader title={t("reviews.approvalTitle")} />

      {decide.failure ? <ActionFeedback failure={decide.failure} onDismiss={decide.reset} /> : null}
      {decide.result ? (
        <ActionSuccess>
          <span>{t("reviews.approvalDecided", { decision: String(decide.result.approval.status ?? "") })}</span>
          <StatusBadge group="task" value={decide.result.task.status} />
        </ActionSuccess>
      ) : null}
      {taskFailure ? <InlineError failure={taskFailure} /> : null}

      {taskId === null ? <p className="muted">{t("reviews.selectHint")}</p> : null}
      {taskId !== null && approvals.length === 0 && !taskFailure ? <p className="muted">{t("reviews.approvalNone")}</p> : null}

      <ul className="approval-list">
        {approvals.map((approval) => {
          const hash = String(approval.targetHash ?? "");
          const decidable = canDecideApproval(approval) && !decide.pending;
          return (
            <li key={approval.id} className="approval" data-testid={`approval-${approval.id}`}>
              <div className="approval__head">
                <StatusBadge group="acceptance" value={approval.status} />
                <span className="muted">
                  {t("reviews.approvalScope")}: <code className="mono">{approval.scope ?? t("common.none")}</code>
                </span>
              </div>

              <div className="hash-row">
                <span className="field__label">{t("reviews.approvalTargetHash")}</span>
                <code className="mono" data-testid="approval-target-hash" title={hash === "" ? undefined : hash}>
                  {shortHash(hash, 12) === "" ? t("common.none") : shortHash(hash, 12)}
                </code>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  data-testid="approval-copy-hash"
                  onClick={() => void copyHash(approval)}
                  disabled={hash === ""}
                >
                  {copiedId === approval.id ? t("common.copied") : t("common.copy")}
                </button>
              </div>
              <p className="muted">{t("reviews.approvalHashHint")}</p>

              <div className="approval__actions">
                <button
                  type="button"
                  className="button button--success button--small"
                  data-testid="approval-approve"
                  disabled={!decidable}
                  onClick={() => void decideOn(approval, "APPROVED")}
                >
                  {decide.pending ? t("reviews.deciding") : t("reviews.approve")}
                </button>
                <button
                  type="button"
                  className="button button--danger button--small"
                  data-testid="approval-reject"
                  disabled={!decidable}
                  onClick={() => void decideOn(approval, "REJECTED")}
                >
                  {decide.pending ? t("reviews.deciding") : t("reviews.reject")}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
