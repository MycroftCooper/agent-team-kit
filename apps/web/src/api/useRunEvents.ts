// Paginated event history for the run detail timeline.
//
// `GET /api/v1/events` filters by `afterSeq` + `limit` only (no aggregateId), so
// the SPA walks forward pages and filters per aggregate client-side. The walk is
// bounded (EVENTS_MAX_PAGES) and reports `truncated` so the UI can say that older
// history was not loaded instead of silently showing a partial timeline.
import { useCallback, useEffect, useState } from "react";
import { apiGet, isAbortError, toFailure } from "./client.ts";
import type { ApiFailure } from "../domain/errors.ts";
import { buildEventsQuery, planNextEventsPage } from "../domain/runs.ts";
import type { AtkEvent } from "./types.ts";

export const RUN_EVENTS_PAGE_SIZE = 1000;
export const RUN_EVENTS_MAX_PAGES = 5;

export type UseRunEventsResult = {
  items: AtkEvent[];
  loading: boolean;
  error: ApiFailure | null;
  truncated: boolean;
  refresh: () => void;
};

export function useRunEvents(refetchKey: number): UseRunEventsResult {
  const [items, setItems] = useState<AtkEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    (async () => {
      const collected: AtkEvent[] = [];
      let afterSeq: number | null = null;
      let pageIndex = 0;
      let hasMore = true;
      let truncatedPage = false;

      while (hasMore && !disposed) {
        const page: { items: AtkEvent[] } = await apiGet<{ items: AtkEvent[] }>(buildEventsQuery(afterSeq), controller.signal);
        const pageItems: AtkEvent[] = Array.isArray(page?.items) ? page.items : [];
        collected.push(...pageItems);

        const lastSeq: number | null = pageItems.reduce<number | null>((last: number | null, event: AtkEvent) => {
          const seq = typeof event.seq === "number" && Number.isInteger(event.seq) ? event.seq : null;
          if (seq === null) return last;
          return last === null || seq > last ? seq : last;
        }, null);
        if (lastSeq !== null) afterSeq = lastSeq;

        const plan = planNextEventsPage({
          count: pageItems.length,
          limit: RUN_EVENTS_PAGE_SIZE,
          pageIndex,
          maxPages: RUN_EVENTS_MAX_PAGES,
        });
        hasMore = plan.hasMore && pageItems.length > 0;
        truncatedPage = plan.truncated;
        pageIndex += 1;
      }

      if (disposed) return;
      setItems(collected);
      setTruncated(truncatedPage);
    })()
      .catch((failure: unknown) => {
        if (disposed || isAbortError(failure)) return;
        setItems([]);
        setTruncated(false);
        setError(toFailure(failure));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [tick, refetchKey]);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  return { items, loading, error, truncated, refresh };
}
