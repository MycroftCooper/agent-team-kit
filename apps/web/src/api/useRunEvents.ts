// F12 (M6.2): per-run event history for the timeline.
//
// The server exposes `GET /api/v1/events?aggregateId=<runId>&limit=&afterSeq=`
// with `{ items, hasMore, nextAfterSeq?, earliestSeq? }`, so the browser pages
// only this run's events instead of scanning the global log. `loadRunHistory`
// (src/domain/runs.ts) owns the cursor walk; this hook only wires it to React and
// the HTTP client.
//
// While a refetch is in flight the previous items stay rendered ("no flash back")
// and the timeline shows a catching-up state; errors keep the last good data and
// surface the failure separately.
import { useCallback, useEffect, useState } from "react";
import { apiGet, isAbortError, toFailure } from "./client.ts";
import type { ApiFailure } from "../domain/errors.ts";
import { loadRunHistory } from "../domain/runs.ts";
import type { AtkEvent } from "./types.ts";

export type RunEventPageResponse = {
  items?: AtkEvent[];
  hasMore?: boolean;
  nextAfterSeq?: number | null;
  /** WP1/M6.2: global oldest retained seq (null on an empty db). */
  earliestSeq?: number | null;
};

export type UseRunEventsResult = {
  items: AtkEvent[];
  loading: boolean;
  error: ApiFailure | null;
  truncated: boolean;
  incomplete: boolean;
  prunedEvents: number | null;
  earliestSeq: number | null;
  exact: boolean;
  refresh: () => void;
};

export function useRunEvents(runId: string | null, refetchKey: number): UseRunEventsResult {
  const [items, setItems] = useState<AtkEvent[]>([]);
  const [loading, setLoading] = useState(runId !== null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const [prunedEvents, setPrunedEvents] = useState<number | null>(null);
  const [earliestSeq, setEarliestSeq] = useState<number | null>(null);
  const [exact, setExact] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (runId === null) {
      setItems([]);
      setLoading(false);
      setError(null);
      setTruncated(false);
      setIncomplete(false);
      setPrunedEvents(null);
      setEarliestSeq(null);
      setExact(false);
      return;
    }

    let disposed = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    loadRunHistory({
      runId,
      fetchPage: (query) => apiGet<RunEventPageResponse>(query, controller.signal),
    })
      .then((history) => {
        if (disposed) return;
        setItems(history.items);
        setTruncated(history.truncated);
        setIncomplete(history.incomplete);
        setPrunedEvents(history.prunedEvents);
        setEarliestSeq(history.earliestSeq);
        setExact(history.exact);
      })
      .catch((failure: unknown) => {
        if (disposed || isAbortError(failure)) return;
        // Keep the last good timeline on screen; the error renders above it.
        setError(toFailure(failure));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [runId, tick, refetchKey]);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  return { items, loading, error, truncated, incomplete, prunedEvents, earliestSeq, exact, refresh };
}
