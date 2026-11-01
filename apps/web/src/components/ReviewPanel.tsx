// Verdict panel: submit PASS / CHANGES_REQUESTED / BLOCKED with the frozen
// candidate's manifest hash, commit sha, test evidence and findings — or request
// rework once the review came back as CHANGES_REQUESTED.
//
// Write failures render `ActionFeedback` (localized server code + verbatim server
// message/details); the panel never replaces the backend's judgement.
import { useEffect, useState, type FormEvent } from "react";
import { apiPost } from "../api/client.ts";
import type { Review, ReworkResponse, SubmitReviewResponse } from "../api/types.ts";
import { useWriteAction } from "../api/useWriteAction.ts";
import { formatEvidence, verdictLabelKey, verdictOptionLabelKey } from "../domain/workbench.ts";
import type { ReviewFormState } from "../domain/workbench.ts";
import {
  REVIEW_VERDICT_VALUES,
  buildReworkRequest,
  buildSubmitRequest,
  canRequestRework,
  canSubmitReview,
  initialReviewForm,
} from "../domain/workbench.ts";
import { verdictMeta } from "../domain/status.ts";
import { formatDateTime } from "../format.ts";
import { useLang, useT } from "../i18n/index.tsx";
import { ActionFeedback } from "./ActionFeedback.tsx";
import { FindingsEditor } from "./FindingsEditor.tsx";
import { StatusBadge } from "./StatusBadge.tsx";

export function ReviewPanel({
  review,
  onSubmitted,
  onReworked,
}: {
  review: Review;
  onSubmitted: (result: SubmitReviewResponse) => void;
  onReworked: (result: ReworkResponse) => void;
}) {
  const t = useT();
  const { lang } = useLang();
  const [form, setForm] = useState<ReviewFormState>(() => initialReviewForm(review));
  const [reworkReason, setReworkReason] = useState("");
  const submit = useWriteAction<SubmitReviewResponse>();
  const rework = useWriteAction<ReworkResponse>();

  // A different review is a different form (and different CAS version).
  useEffect(() => {
    setForm(initialReviewForm(review));
    setReworkReason("");
    submit.reset();
    rework.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review.id]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload = buildSubmitRequest(review, form);
    const result = await submit.execute(() => apiPost<SubmitReviewResponse>(payload.path, payload.body));
    // The page owns the success banner: the reviewed item usually leaves the
    // "pending" queue, so the confirmation must not unmount with this panel.
    if (result) onSubmitted(result);
  };

  const onRework = async () => {
    const payload = buildReworkRequest(review, reworkReason);
    const result = await rework.execute(() => apiPost<ReworkResponse>(payload.path, payload.body));
    if (result) {
      setReworkReason("");
      onReworked(result);
    }
  };

  const verdictBadge = verdictMeta(review.verdict);
  const evidence = formatEvidence(review.evidence);
  const canSubmit = canSubmitReview(review);
  const canRework = canRequestRework(review);

  return (
    <section className="card review-panel" data-testid="review-panel" aria-label={t("reviews.panelTitle")}>
      <header className="review-panel__header">
        <div>
          <h2 className="section-header__title">{t("reviews.panelTitle")}</h2>
          <p className="page__meta">
            <span className="mono">{review.id}</span>
            <StatusBadge group="review" value={review.status} />
            {typeof review.attempt === "number" ? <span>{t("reviews.attempt", { n: review.attempt })}</span> : null}
            {review.verdict ? <span className={`badge badge--${verdictBadge.tone}`}>{t(verdictLabelKey(review.verdict))}</span> : null}
          </p>
        </div>
        <span className="muted">
          {t("reviews.createdLabel")}: {formatDateTime(review.createdAt, lang) ?? t("common.none")}
        </span>
      </header>

      {submit.failure ? <ActionFeedback failure={submit.failure} onDismiss={submit.reset} /> : null}
      {rework.failure ? <ActionFeedback failure={rework.failure} onDismiss={rework.reset} /> : null}

      {canSubmit ? (
        <form className="review-form" onSubmit={onSubmit}>
          <label className="field">
            <span className="field__label">{t("reviews.fieldVerdict")}</span>
            <select
              className="field__control"
              data-testid="review-verdict"
              value={form.verdict}
              disabled={submit.pending}
              onChange={(event) => setForm({ ...form, verdict: event.target.value as ReviewFormState["verdict"] })}
            >
              {REVIEW_VERDICT_VALUES.map((verdict) => (
                <option key={verdict} value={verdict}>
                  {t(verdictOptionLabelKey(verdict))}
                </option>
              ))}
            </select>
          </label>

          <div className="form-grid">
            <label className="field">
              <span className="field__label">{t("reviews.fieldManifestHash")}</span>
              <input
                className="field__control mono"
                type="text"
                data-testid="review-manifest-hash"
                value={form.manifestHash}
                disabled={submit.pending}
                onChange={(event) => setForm({ ...form, manifestHash: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">{t("reviews.fieldCommitSha")}</span>
              <input
                className="field__control mono"
                type="text"
                data-testid="review-commit-sha"
                value={form.commitSha}
                disabled={submit.pending}
                onChange={(event) => setForm({ ...form, commitSha: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">{t("reviews.fieldTests")}</span>
              <input
                className="field__control mono"
                type="number"
                min={0}
                data-testid="review-tests-passed"
                placeholder={t("reviews.fieldTestsPassed")}
                value={form.testsPassed}
                disabled={submit.pending}
                onChange={(event) => setForm({ ...form, testsPassed: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field__label">{t("reviews.fieldTestsTotal")}</span>
              <input
                className="field__control mono"
                type="number"
                min={0}
                data-testid="review-tests-total"
                value={form.testsTotal}
                disabled={submit.pending}
                onChange={(event) => setForm({ ...form, testsTotal: event.target.value })}
              />
            </label>
          </div>
          <p className="muted">{t("reviews.evidenceHint")}</p>

          <FindingsEditor
            findings={form.findings}
            disabled={submit.pending}
            onChange={(findings) => setForm({ ...form, findings })}
          />

          <div className="review-form__actions">
            <button type="submit" className="button" data-testid="review-submit" disabled={submit.pending}>
              {submit.pending ? t("reviews.submitting") : t("reviews.submit")}
            </button>
          </div>
        </form>
      ) : (
        <dl className="kv">
          <div className="kv__row">
            <dt>{t("reviews.verdictLabel")}</dt>
            <dd>{review.verdict ? t(verdictLabelKey(review.verdict)) : t("reviews.noVerdictYet")}</dd>
          </div>
          <div className="kv__row">
            <dt>{t("reviews.fieldTests")}</dt>
            <dd className="mono">{evidence ?? t("common.none")}</dd>
          </div>
          <div className="kv__row">
            <dt>{t("reviews.fieldCommitSha")}</dt>
            <dd className="mono">{review.commitSha ?? t("common.none")}</dd>
          </div>
        </dl>
      )}

      {!canSubmit && canRework ? (
        <div className="rework">
          <h3 className="section-header__title">{t("reviews.reworkTitle")}</h3>
          <p className="muted">{t("reviews.reworkLimitNote")}</p>
          <label className="field field--grow">
            <span className="field__label">{t("reviews.reworkReason")}</span>
            <input
              className="field__control"
              type="text"
              data-testid="review-rework-reason"
              placeholder={t("reviews.reworkReasonPlaceholder")}
              value={reworkReason}
              disabled={rework.pending}
              onChange={(event) => setReworkReason(event.target.value)}
            />
          </label>
          <div className="review-form__actions">
            <button
              type="button"
              className="button"
              data-testid="review-rework"
              disabled={rework.pending || reworkReason.trim() === ""}
              onClick={onRework}
            >
              {rework.pending ? t("reviews.reworking") : t("reviews.requestRework")}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
