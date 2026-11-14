import { useEffect, useState, useRef } from "react";
import type { Row } from "@atk/contracts";
let session: Promise<{ token: string; csrf: string }> | null = null;
let accessKey = sessionStorage.getItem("atk-browser-access") ?? "";
function consumeAccessFragment() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (!fragment.has("access")) return;
  accessKey = fragment.get("access") ?? "";
  session = null;
  fragment.delete("access");
  history.replaceState(
    null,
    "",
    location.pathname + location.search + (fragment.size ? "#" + fragment : ""),
  );
}
consumeAccessFragment();
async function auth() {
  consumeAccessFragment();
  session ??= fetch("/api/v1/session", {
    headers: { "x-atk-access": accessKey },
  })
    .then(async (r) => {
      if (!r.ok) throw new Error("Session unavailable");
      sessionStorage.setItem("atk-browser-access", accessKey);
      return r.json();
    })
    .catch((e) => {
      session = null;
      throw e;
    });
  return session;
}
export async function authorize(code?: string) {
  if (code !== undefined) {
    accessKey = code.trim();
    session = null;
  }
  return auth();
}
async function authorizedFetch(route: string, options: RequestInit = {}) {
  function send({ token, csrf }: { token: string; csrf: string }) {
    const headers = new Headers(options.headers);
    headers.set("x-atk-token", token);
    headers.set("x-atk-csrf", csrf);
    return fetch("/api/v1" + route, { ...options, headers });
  }
  const original = auth(), cached = session;
  const response = await send(await original);
  if (response.status !== 401) return response;
  // Authentication failed before the backend dispatched the request. Its
  // in-memory session may have been replaced by a development reload.
  if (session === cached) session = null;
  await response.body?.cancel();
  return send(await auth());
}
export async function api<T = Row>(
  route: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const r = await authorizedFetch(route, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) {
    const error = new Error(data.error?.message ?? r.statusText);
    Object.assign(error, {
      code: data.error?.code,
      details: data.error?.details,
    });
    throw error;
  }
  return data;
}
export function useData<T = Row>(route: string | null, epoch: number) {
  const previousRoute = useRef(route),
    sameRoute = previousRoute.current === route;
  const [state, set] = useState<{
    data: T | null;
    error: Error | null;
    loading: boolean;
  }>({ data: null, error: null, loading: true });
  useEffect(() => {
    let alive = true,
      attempt = 0,
      retry: ReturnType<typeof setTimeout> | undefined;
    previousRoute.current = route;
    if (!route) {
      set({ data: null, error: null, loading: false });
      return;
    }
    set((s) => ({
      data: sameRoute ? s.data : null,
      loading: true,
      error: null,
    }));
    previousRoute.current = route;
    function read() {
      api<T>(route!)
        .then((data) => {
          if (alive) set({ data, error: null, loading: false });
        })
        .catch((error) => {
          if (!alive) return;
          set((s) => ({ ...s, error, loading: false }));
          // A brief outage may fail a refresh without closing the SSE stream.
          if (!error.code && attempt < 5)
            retry = setTimeout(read, Math.min(10000, 1000 * 2 ** attempt++));
        });
    }
    read();
    return () => {
      alive = false;
      clearTimeout(retry);
    };
  }, [route, epoch]);
  return sameRoute ? state : { data: null, error: null, loading: true };
}
export function useLive(onChange: () => void, projectId: string) {
  const [connection, setConnection] = useState("connecting"),
    [events, setEvents] = useState<Row[]>([]),
    [syncVersion, setSyncVersion] = useState(0);
  useEffect(() => {
    setEvents([]);
    setConnection("connecting");
    if (!projectId) return;
    let disposed = false,
      controller: AbortController | null = null,
      seq: number | null = null,
      attempt = 0,
      timer: ReturnType<typeof setTimeout> | undefined,
      refresh: ReturnType<typeof setTimeout> | undefined;
    function invalidate() {
      if (!refresh)
        refresh = setTimeout(() => {
          refresh = undefined;
          onChange();
        }, 200);
    }
    async function connect() {
      controller = new AbortController();
      try {
        const response = await authorizedFetch("/events/stream?projectId=" + encodeURIComponent(projectId), {
          headers: seq === null ? {} : { "last-event-id": String(seq) },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error("Stream unavailable");
        }
        setConnection("live");
        setSyncVersion((v) => v + 1);
        attempt = 0;
        invalidate();
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > 1024 * 1024)
              throw new Error("Event buffer exceeded");
            let index;
            while ((index = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              const data = frame
                  .split("\n")
                  .find((l) => l.startsWith("data:"))
                  ?.slice(5)
                  .trim(),
                type = frame
                  .split("\n")
                  .find((l) => l.startsWith("event:"))
                  ?.slice(6)
                  .trim(),
                id = frame
                  .split("\n")
                  .find((l) => l.startsWith("id:"))
                  ?.slice(3)
                  .trim();
              if (type === "system.resync-required") {
                seq = null;
                setEvents([]);
                setSyncVersion((v) => v + 1);
                invalidate();
                continue;
              }
              if (!data) continue;
              const event = JSON.parse(data);
              if (id) {
                const next = Number(id);
                if (seq !== null && next <= seq) continue;
                seq = next;
              }
              setEvents((old) => [...old.slice(-199), event]);
              if (!["run.log", "run.progress"].includes(type ?? ""))
                invalidate();
            }
          }
        } finally {
          reader.releaseLock();
        }
      } catch (e) {
        if (!disposed) setConnection("reconnecting");
      } finally {
        if (!disposed) {
          attempt++;
          timer = setTimeout(
            connect,
            Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)),
          );
        }
      }
    }
    void connect();
    window.addEventListener("online", invalidate);
    return () => {
      disposed = true;
      controller?.abort();
      clearTimeout(timer);
      clearTimeout(refresh);
      window.removeEventListener("online", invalidate);
    };
  }, [onChange, projectId]);
  return { connection, events, syncVersion };
}
