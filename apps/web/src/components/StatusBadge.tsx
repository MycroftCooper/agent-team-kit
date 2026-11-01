// Coloured status pill. The enum *value* is not translated; the label is. Tones
// only express success / warning / danger / info — everything else is neutral.
import type { StatusGroup } from "../domain/status.ts";
import { statusMeta } from "../domain/status.ts";
import { useT } from "../i18n/index.tsx";

export function StatusBadge({ group, value }: { group: StatusGroup; value: string | null | undefined }) {
  const t = useT();
  const meta = statusMeta(group, value);
  return (
    <span className={`badge badge--${meta.tone}`} data-status={String(value ?? "")} title={String(value ?? "")}>
      <span className="badge__dot" aria-hidden="true" />
      {t(meta.key)}
    </span>
  );
}
