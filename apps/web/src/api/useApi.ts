// One-shot data fetching with loading/error/data, matching the shape a future
// TanStack Query migration would expose (`data` / `error` / `isLoading` /
// `refetch`). `refetchKey` is how the SSE layer forces a full snapshot reload:
// `system.resync-required` bumps the key and every mounted `useApi` refetches.
import { useCallback, useEffect, useState } from "react";
import { apiGet, isAbortError, toFailure } from "./client.ts";
import type { ApiFailure } from "../domain/errors.ts";

export type UseApiResult<T> = {
  data: T | null;
  error: ApiFailure | null;
  loading: boolean;
  refresh: () => void;
};

export type UseApiOptions = {
  /** Change to force a refetch (SSE resync). */
  refetchKey?: number;
};

export function useApi<T>(path: string | null, options: UseApiOptions = {}): UseApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const [tick, setTick] = useState(0);
  const refetchKey = options.refetchKey ?? 0;

  useEffect(() => {
    if (path === null) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    let disposed = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    apiGet<T>(path, controller.signal)
      .then((next) => {
        if (disposed) return;
        setData(next);
        setError(null);
      })
      .catch((failure: unknown) => {
        if (disposed || isAbortError(failure)) return;
        setData(null);
        setError(toFailure(failure));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [path, tick, refetchKey]);

  const refresh = useCallback(() => {
    setTick((value) => value + 1);
  }, []);

  return { data, error, loading, refresh };
}
