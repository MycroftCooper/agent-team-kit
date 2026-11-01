// Findings editor: a CHANGES_REQUESTED verdict needs at least one finding, so the
// rows are addable/removable instead of a free-form textarea.
import type { ReviewFindingDraft } from "../domain/workbench.ts";
import { EMPTY_FINDING } from "../domain/workbench.ts";
import { useT } from "../i18n/index.tsx";

export function FindingsEditor({
  findings,
  onChange,
  disabled,
}: {
  findings: readonly ReviewFindingDraft[];
  onChange: (next: ReviewFindingDraft[]) => void;
  disabled?: boolean;
}) {
  const t = useT();

  const update = (index: number, patch: Partial<ReviewFindingDraft>) => {
    onChange(findings.map((finding, current) => (current === index ? { ...finding, ...patch } : finding)));
  };

  const remove = (index: number) => {
    onChange(findings.filter((_, current) => current !== index));
  };

  const add = () => {
    onChange([...findings, { ...EMPTY_FINDING }]);
  };

  return (
    <div className="findings">
      <div className="findings__header">
        <span className="field__label">{t("reviews.fieldFindings")}</span>
        <button
          type="button"
          className="button button--ghost button--small"
          data-testid="review-finding-add"
          onClick={add}
          disabled={disabled}
        >
          {t("reviews.findingAdd")}
        </button>
      </div>
      {findings.length === 0 ? <p className="muted">{t("reviews.findingsHint")}</p> : null}
      <ul className="findings__list">
        {findings.map((finding, index) => (
          <li key={index} className="findings__row">
            <label className="field field--grow">
              <span className="field__label">{t("reviews.findingCode")}</span>
              <input
                className="field__control"
                type="text"
                value={finding.code}
                disabled={disabled}
                data-testid={`review-finding-${index}-code`}
                onChange={(event) => update(index, { code: event.target.value })}
              />
            </label>
            <label className="field field--grow">
              <span className="field__label">{t("reviews.findingMessage")}</span>
              <input
                className="field__control"
                type="text"
                value={finding.message}
                disabled={disabled}
                data-testid={`review-finding-${index}-message`}
                onChange={(event) => update(index, { message: event.target.value })}
              />
            </label>
            <button
              type="button"
              className="button button--ghost button--small"
              data-testid={`review-finding-${index}-remove`}
              onClick={() => remove(index)}
              disabled={disabled}
              aria-label={t("reviews.findingRemove")}
            >
              {t("reviews.findingRemove")}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
