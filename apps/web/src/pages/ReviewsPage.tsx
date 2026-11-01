// Review & acceptance workbench (M4): a review queue on the left, and on the
// right the verdict panel plus the human-acceptance panel for the selected task.
//
// Writes are the point of this page, so failures are first-class UI: see
// components/ActionFeedback.tsx (localized server code + verbatim server
// message/details) and domains/workbench.ts (request builders, pure + tested).
import { useCallback, useMemo, useState } from "react";
import type { Approval, Review, ReworkResponse, SubmitReviewResponse, Task } from "../api/types.ts";
import { useApi } from "../api/useApi.ts";
import { ActionSuccess } from "../components/ActionFeedback.tsx";
import { ApprovalPanel } from "../components/ApprovalPanel.tsx";
import { ReviewPanel } from "../components/ReviewPanel.tsx";
import { ReviewQueue } from "../components/ReviewQueue.tsx";
import { EmptyState } from "../components/StateViews.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { buildApprovalsQuery, buildReviewsQuery, sortReviews, verdictLabelKey, workbenchListState } from "../domain/workbench.ts";
import { useT } from "../i18n/index.tsx";

type WorkbenchResult =
  | { kind: "submit"; review: Review; task: Task }
  | { kind: "rework"; review: Review; task: Task; attempt: number };

export function ReviewsPage({ refetchKey }: { refetchKey: number }) {
  const t = useT();
  const [pendingOnly, setPendingOnly] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [writeTick, setWriteTick] = useState(0);
  // Success confirmation is page-level: a reviewed item usually leaves the
  // "pending" queue, so a panel-local banner would unmount with it.
  const [result, setResult] = useState<WorkbenchResult | null>(null);

  // SSE resyncs and post-write refreshes both invalidate the snapshot.
  const queryKey = refetchKey + writeTick;
  const reviewsState = useApi<{ items: Review[] }>(buildReviewsQuery(pendingOnly ? "PENDING" : null), { refetchKey: queryKey });
  const reviews = useMemo(() => sortReviews(reviewsState.data?.items ?? []), [reviewsState.data]);

  const selected = useMemo(() => {
    if (reviews.length === 0) return null;
    if (selectedId !== null) {
      const match = reviews.find((review) => review.id === selectedId);
      if (match) return match;
    }
    return reviews[0];
  }, [reviews, selectedId]);

  const approvalsState = useApi<{ items: Approval[] }>(buildApprovalsQuery(selected?.taskId ?? null), { refetchKey: queryKey });
  const refresh = useCallback(() => setWriteTick((value) => value + 1), []);

  const handleSubmitted = useCallback((next: SubmitReviewResponse) => {
    if (next?.review && next?.task) setResult({ kind: "submit", review: next.review, task: next.task });
    setWriteTick((value) => value + 1);
  }, []);

  const handleReworked = useCallback((next: ReworkResponse) => {
    if (next?.review && next?.task) {
      setResult({ kind: "rework", review: next.review, task: next.task, attempt: next.attempt });
    }
    setWriteTick((value) => value + 1);
  }, []);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setResult(null);
  }, []);

  const listState = workbenchListState({
    loading: reviewsState.loading,
    failed: Boolean(reviewsState.error),
    count: reviews.length,
  });

  return (
    <section className="page" data-testid="reviews-page">
      <header className="page__header">
        <div>
          <h1 className="page__title">{t("reviews.title")}</h1>
          <p className="page__subtitle">{t("reviews.subtitle")}</p>
        </div>
        <div className="toolbar toolbar--inline">
          <div className="segmented" role="group" aria-label={t("reviews.listTitle")}>
            <button
              type="button"
              className={pendingOnly ? "segmented__button is-active" : "segmented__button"}
              aria-pressed={pendingOnly}
              data-testid="reviews-filter-pending"
              onClick={() => setPendingOnly(true)}
            >
              {t("reviews.filterPending")}
            </button>
            <button
              type="button"
              className={!pendingOnly ? "segmented__button is-active" : "segmented__button"}
              aria-pressed={!pendingOnly}
              data-testid="reviews-filter-all"
              onClick={() => setPendingOnly(false)}
            >
              {t("reviews.filterAll")}
            </button>
          </div>
          <button type="button" className="button button--ghost" onClick={refresh} disabled={reviewsState.loading}>
            {t("common.refresh")}
          </button>
        </div>
      </header>

      <p className="notice notice--muted">{t("reviews.readOnlyNote")}</p>

      {result ? (
        <div data-testid="workbench-result">
          <ActionSuccess>
            <span>
              {result.kind === "submit"
                ? t("reviews.submitSuccess", { verdict: t(verdictLabelKey(result.review.verdict)) })
                : t("reviews.reworkSuccess", { attempt: result.attempt ?? result.review.attempt ?? 0 })}
            </span>
            <StatusBadge group="review" value={result.review.status} />
            <StatusBadge group="task" value={result.task.status} />
            <button type="button" className="button button--ghost button--small" onClick={() => setResult(null)}>
              {t("common.dismiss")}
            </button>
          </ActionSuccess>
        </div>
      ) : null}

      <div className="workbench">
        <ReviewQueue
          reviews={reviews}
          state={listState}
          failure={reviewsState.error}
          selectedId={selected?.id ?? null}
          onSelect={handleSelect}
          onRetry={refresh}
        />
        <div className="workbench__detail">
          {selected ? (
            <ReviewPanel key={selected.id} review={selected} onSubmitted={handleSubmitted} onReworked={handleReworked} />
          ) : (
            <EmptyState title={t("reviews.selectHint")} />
          )}
          <ApprovalPanel
            taskId={selected?.taskId ?? null}
            approvals={approvalsState.data?.items ?? []}
            taskFailure={approvalsState.error}
            onChanged={refresh}
          />
        </div>
      </div>
    </section>
  );
}
