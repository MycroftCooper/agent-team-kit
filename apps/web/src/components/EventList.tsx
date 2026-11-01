// Shared event feed table (dashboard + details pages).
import type { AtkEvent } from "../api/types.ts";
import { eventTypeLabelKey } from "../domain/events.ts";
import { formatDateTime } from "../format.ts";
import { useLang, useT } from "../i18n/index.tsx";

export function EventList({ events, empty }: { events: readonly AtkEvent[]; empty?: string }) {
  const t = useT();
  const { lang } = useLang();

  if (events.length === 0) {
    return <p className="muted">{empty ?? t("events.empty")}</p>;
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t("events.columnSeq")}</th>
            <th scope="col">{t("events.columnType")}</th>
            <th scope="col">{t("events.columnAggregate")}</th>
            <th scope="col">{t("events.columnAt")}</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const aggregate = [event.aggregateType, event.aggregateId].filter((part) => Boolean(part)).join(" ");
            return (
              <tr key={`${event.seq}-${event.type}`}>
                <td className="mono">{event.seq}</td>
                <td>{t(eventTypeLabelKey(event.type))}</td>
                <td className="mono">{aggregate === "" ? t("common.none") : aggregate}</td>
                <td className="muted">{formatDateTime(event.happenedAt, lang) ?? t("common.none")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
