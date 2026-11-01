// Write-failure panel for the review workbench.
//
// Rule from the M4 contract (§3): a failed write must show the *server's* error —
// the localized text of the server `code`, plus the server `message` and
// `details` verbatim. Nothing is guessed locally, nothing is swallowed.
import type { ReactNode } from "react";
import type { ApiFailure } from "../domain/errors.ts";
import { actionErrorView } from "../domain/errors.ts";
import { useT } from "../i18n/index.tsx";

export function ActionFeedback({ failure, onDismiss }: { failure: ApiFailure; onDismiss?: () => void }) {
  const t = useT();
  const view = actionErrorView(failure);

  return (
    <div className="action-error" role="alert" data-testid="action-error" data-code={view.code}>
      <div className="action-error__head">
        <span className="action-error__title">{t(view.titleKey)}</span>
        <code className="action-error__code" data-testid="action-error-code">
          {view.code}
        </code>
        {view.requestId ? <span className="muted">{t("error.requestId", { requestId: view.requestId })}</span> : null}
        {onDismiss ? (
          <button type="button" className="button button--ghost button--small" onClick={onDismiss}>
            {t("common.dismiss")}
          </button>
        ) : null}
      </div>
      <p className="action-error__message">{t(view.messageKey, view.params)}</p>
      {view.serverMessage ? (
        <p className="action-error__server">
          <span className="action-error__label">{t("common.serverMessage")}</span>
          <code data-testid="action-error-server-message">{view.serverMessage}</code>
        </p>
      ) : null}
      {view.hasDetails ? (
        <details className="action-error__details" open>
          <summary>{t("common.serverDetails")}</summary>
          <pre className="mono" data-testid="action-error-details">
            {JSON.stringify(view.details, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

export function ActionSuccess({ children }: { children: ReactNode }) {
  return (
    <div className="action-success" role="status" data-testid="action-success">
      {children}
    </div>
  );
}
