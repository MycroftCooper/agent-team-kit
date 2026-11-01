// Shared loading / error / empty states. The error state is the "backend is not
// running" experience: readable title, dictionary-driven message, the contract
// error code and a retry button — never a blank screen.
import type { ReactNode } from "react";
import type { ApiFailure } from "../domain/errors.ts";
import { describeError } from "../domain/errors.ts";
import { useT } from "../i18n/index.tsx";

export function LoadingState({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className="state state--loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="state__text">{label ?? t("common.loading")}</span>
    </div>
  );
}

export function ErrorState({ failure, onRetry }: { failure: ApiFailure; onRetry?: () => void }) {
  const t = useT();
  const descriptor = describeError(failure);
  return (
    <div className="state state--error" role="alert">
      <h2 className="state__title">{t(descriptor.titleKey)}</h2>
      <p className="state__text">{t(descriptor.messageKey, descriptor.params)}</p>
      {descriptor.retryable ? <p className="state__hint">{t("error.retryHint")}</p> : null}
      <p className="state__meta">
        <code>{descriptor.code}</code>
        {descriptor.requestId ? <span className="state__request">{t("error.requestId", { requestId: descriptor.requestId })}</span> : null}
      </p>
      {onRetry ? (
        <button type="button" className="button" onClick={onRetry}>
          {t("common.retry")}
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, hint, children }: { title?: string; hint?: string; children?: ReactNode }) {
  const t = useT();
  return (
    <div className="state state--empty">
      <h2 className="state__title">{title ?? t("common.empty")}</h2>
      {hint ? <p className="state__text">{hint}</p> : null}
      {children}
    </div>
  );
}

/** One-line failure for a secondary panel that must not take over the page. */
export function InlineError({ failure }: { failure: ApiFailure }) {
  const t = useT();
  const descriptor = describeError(failure);
  return (
    <p className="inline-error" role="status">
      <strong>{t(descriptor.titleKey)}</strong> {t(descriptor.messageKey, descriptor.params)}
    </p>
  );
}

export function SectionHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="section-header">
      <h2 className="section-header__title">{title}</h2>
      {actions ? <div className="section-header__actions">{actions}</div> : null}
    </div>
  );
}
