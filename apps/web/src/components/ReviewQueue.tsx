// Left-hand review queue: Task, Run, attempt and status for every review of the
// current filter. Selecting an item opens the verdict/acceptance panels.
import type { ApiFailure } from "../domain/errors.ts";
import type { Review } from "../api/types.ts";
import { verdictLabelKey, type WorkbenchListState } from "../domain/workbench.ts";
import { verdictMeta } from "../domain/status.ts";
import { formatDateTime } from "../format.ts";
import { useLang, useT } from "../i18n/index.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { EmptyState, ErrorState, LoadingState } from "./StateViews.tsx";

export function ReviewQueue({
  reviews,
  state,
  failure,
  selectedId,
  onSelect,
  onRetry,
}: {
  reviews: readonly Review[];
  state: WorkbenchListState;
  failure: ApiFailure | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
}) {
  const t = useT();
  const { lang } = useLang();

  return (
    <section className="card review-queue" data-testid="review-queue" aria-label={t("reviews.listTitle")}>
      <header className="section-header">
        <h2 className="section-header__title">{t("reviews.listTitle")}</h2>
        <span className="muted">{t("reviews.listCount", { n: reviews.length })}</span>
      </header>

      {state === "loading" ? <LoadingState /> : null}
      {state === "error" && failure ? <ErrorState failure={failure} onRetry={onRetry} /> : null}
      {state === "empty" ? <EmptyState title={t("reviews.listEmptyTitle")} hint={t("reviews.listEmptyHint")} /> : null}

      {state === "ready" ? (
        <ul className="review-queue__list" data-testid="review-list">
          {reviews.map((review) => {
            const selected = review.id === selectedId;
            const verdict = verdictMeta(review.verdict);
            return (
              <li key={review.id}>
                <button
                  type="button"
                  className={selected ? "queue-item is-selected" : "queue-item"}
                  data-testid={`review-item-${review.id}`}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelect(review.id)}
                >
                  <span className="queue-item__row">
                    <span className="mono queue-item__task">{review.taskId ?? t("common.none")}</span>
                    <StatusBadge group="review" value={review.status} />
                  </span>
                  <span className="queue-item__row queue-item__meta">
                    <span className="mono">{review.runId ?? t("common.none")}</span>
                    {typeof review.attempt === "number" ? <span>{t("reviews.attempt", { n: review.attempt })}</span> : null}
                  </span>
                  <span className="queue-item__row queue-item__meta">
                    {review.verdict ? <span className={`badge badge--${verdict.tone}`}>{t(verdictLabelKey(review.verdict))}</span> : null}
                    <span className="muted">{formatDateTime(review.createdAt, lang) ?? t("common.none")}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
