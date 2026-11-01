// Live event stream over `fetch` + `ReadableStream` (see src/api/stream.ts for
// why not `EventSource`: the token must be an `x-atk-token` header).
//
// Behaviour required by the contract:
//  * read chunks, keep the incomplete tail, parse `id:`/`event:`/`data:`/comment;
//  * reconnect with exponential backoff and always send the latest `Last-Event-ID`;
//  * on `system.resync-required`: reset the seq, bump `resyncCount` and call
//    `onResync` so the app re-fetches its snapshot instead of pretending the
//    skipped window was received;
//  * abort the request and release the reader on unmount.
import { useEffect, useRef, useState } from "react";
import { isAbortError, openEventStream } from "./client.ts";
import { advanceLastSeq, classifyFrame, parseSseBuffer, reconnectDelayMs } from "./stream.ts";

/** Attempts before the indicator stops saying "reconnecting" and says "offline". */
export const MAX_RECONNECT_ATTEMPTS_BEFORE_OFFLINE = 5;

/** Milliseconds the top bar shows "resyncing" after a gap was detected. */
export const RESYNC_INDICATOR_MS = 4000;

export type ConnectionState = "connecting" | "live" | "reconnecting" | "resyncing" | "offline";

export type StreamEvent = {
  seq: number | null;
  type: string;
  data: unknown;
};

export type UseEventStreamResult = {
  state: Exclude<ConnectionState, "resyncing">;
  lastEvent: StreamEvent | null;
  resyncCount: number;
};

export type UseEventStreamOptions = {
  onResync?: () => void;
  enabled?: boolean;
};

export function useEventStream(options: UseEventStreamOptions = {}): UseEventStreamResult {
  const enabled = options.enabled !== false;
  const [state, setState] = useState<Exclude<ConnectionState, "resyncing">>(enabled ? "connecting" : "offline");
  const [lastEvent, setLastEvent] = useState<StreamEvent | null>(null);
  const [resyncCount, setResyncCount] = useState(0);
  const onResyncRef = useRef<UseEventStreamOptions["onResync"]>(options.onResync);
  onResyncRef.current = options.onResync;

  useEffect(() => {
    if (!enabled) {
      setState("offline");
      return;
    }

    let disposed = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let lastSeq: number | null = null;
    let attempt = 0;

    const scheduleReconnect = (): void => {
      if (disposed) return;
      attempt += 1;
      setState(attempt >= MAX_RECONNECT_ATTEMPTS_BEFORE_OFFLINE ? "offline" : "reconnecting");
      timer = setTimeout(() => {
        void connect();
      }, reconnectDelayMs(attempt - 1));
    };

    const connect = async (): Promise<void> => {
      if (disposed) return;
      try {
        const response = await openEventStream({ lastSeq, signal: controller.signal });
        if (disposed) return;
        if (!response.body) throw new Error("event stream response has no body");

        attempt = 0;
        setState("live");
        const streamReader = response.body.getReader();
        reader = streamReader;
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const chunk = await streamReader.read();
          if (disposed) break;
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const parsed = parseSseBuffer(buffer);
          buffer = parsed.rest;

          let resyncSeen = false;
          for (const frame of parsed.frames) {
            const kind = classifyFrame(frame);
            if (kind === "ignore") continue;
            if (kind === "resync") {
              // The gap cannot be replayed: drop the seq and ask for a snapshot.
              lastSeq = null;
              resyncSeen = true;
              break;
            }
            lastSeq = advanceLastSeq(lastSeq, frame);
            setLastEvent({ seq: frame.id, type: frame.type ?? "message", data: frame.data });
          }
          if (resyncSeen) {
            setResyncCount((count) => count + 1);
            onResyncRef.current?.();
          }
        }

        if (!disposed) scheduleReconnect();
      } catch (error) {
        if (disposed || isAbortError(error)) return;
        scheduleReconnect();
      } finally {
        try {
          reader?.releaseLock();
        } catch {
          // The reader was already cancelled by the unmount path.
        }
        reader = null;
      }
    };

    void connect();

    return () => {
      disposed = true;
      controller.abort();
      if (timer !== null) clearTimeout(timer);
      const current = reader;
      reader = null;
      current?.cancel().catch(() => undefined);
    };
  }, [enabled]);

  return { state, lastEvent, resyncCount };
}
