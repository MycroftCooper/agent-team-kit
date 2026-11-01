// Generic "write action" hook: runs one POST/PATCH, keeps the failure (as the
// contract failure object) and the result, and never swallows an error — the
// workbench renders `failure` verbatim so the server message/details stay visible.
import { useCallback, useEffect, useRef, useState } from "react";
import { isAbortError, toFailure } from "./client.ts";
import type { ApiFailure } from "../domain/errors.ts";

export type UseWriteActionResult<TResult> = {
  pending: boolean;
  failure: ApiFailure | null;
  result: TResult | null;
  execute: (run: () => Promise<TResult>) => Promise<TResult | null>;
  reset: () => void;
};

export function useWriteAction<TResult>(): UseWriteActionResult<TResult> {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [result, setResult] = useState<TResult | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reset = useCallback(() => {
    setFailure(null);
    setResult(null);
  }, []);

  const execute = useCallback(async (run: () => Promise<TResult>): Promise<TResult | null> => {
    setPending(true);
    setFailure(null);
    try {
      const next = await run();
      if (mounted.current) {
        setResult(next);
        setFailure(null);
      }
      return next;
    } catch (error) {
      if (!isAbortError(error) && mounted.current) {
        setResult(null);
        setFailure(toFailure(error));
      }
      return null;
    } finally {
      if (mounted.current) setPending(false);
    }
  }, []);

  return { pending, failure, result, execute, reset };
}
