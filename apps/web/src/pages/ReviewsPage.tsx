// Reviews & acceptance. M1 is a read-only view (the console is planned for M2),
// but the navigation entry exists and the contract endpoints are rendered.
import type { Approval, Review } from "../api/types.ts";
import { useApi } from "../api/useApi.ts";
import { InlineError, SectionHeader } from "../components/StateViews.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { formatDateTime } from "../format.ts";
import { useLang, useT } from "../i18n/index.tsx";

export function ReviewsPage({ refetchKey }: { refetchKey: number }) {
  const t = useT();
  const { lang } = useLang();
  const reviewsState = useApi<{ items: Review[] }>("/reviews", { refetchKey });
  const approvalsState = useApi<{ items: Approval[] }>("/approvals", { refetchKey });
  const reviews = reviewsState.data?.items ?? [];
  const approvals = approvalsState.data?.items ?? [];

  return (
    <section className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">{t("reviews.title")}</h1>
          <p className="page__subtitle">{t("reviews.placeholderHint")}</p>
        </div>
      </header>

      <div className="notice">
        <strong>{t("reviews.placeholderTitle")}</strong>
        <span>{t("reviews.placeholderHint")}</span>
      </div>

      <div className="grid grid--2">
        <section className="card">
          <SectionHeader title={t("reviews.reviewsTitle")} />
          {reviewsState.error ? <InlineError failure={reviewsState.error} /> : null}
          {reviews.length === 0 ? (
            reviewsState.error ? null : <p className="muted">{t("reviews.reviewsEmpty")}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t("reviews.columnId")}</th>
                    <th scope="col">{t("reviews.columnTask")}</th>
                    <th scope="col">{t("reviews.columnStatus")}</th>
                    <th scope="col">{t("reviews.columnCreated")}</th>
                  </tr>
                </thead>
                <tbody>
                  {reviews.map((review) => (
                    <tr key={review.id}>
                      <td className="mono">{review.id}</td>
                      <td className="mono">{review.taskId ?? t("common.none")}</td>
                      <td>
                        <StatusBadge group="review" value={review.status} />
                      </td>
                      <td className="muted">{formatDateTime(review.createdAt, lang) ?? t("common.none")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card">
          <SectionHeader title={t("reviews.approvalsTitle")} />
          {approvalsState.error ? <InlineError failure={approvalsState.error} /> : null}
          {approvals.length === 0 ? (
            approvalsState.error ? null : <p className="muted">{t("reviews.approvalsEmpty")}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t("reviews.columnId")}</th>
                    <th scope="col">{t("reviews.columnTask")}</th>
                    <th scope="col">{t("reviews.columnStatus")}</th>
                    <th scope="col">{t("reviews.columnCreated")}</th>
                  </tr>
                </thead>
                <tbody>
                  {approvals.map((approval) => (
                    <tr key={approval.id}>
                      <td className="mono">{approval.id}</td>
                      <td className="mono">{approval.taskId ?? t("common.none")}</td>
                      <td>
                        <StatusBadge group="acceptance" value={approval.status} />
                      </td>
                      <td className="muted">{formatDateTime(approval.at ?? approval.createdAt, lang) ?? t("common.none")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
