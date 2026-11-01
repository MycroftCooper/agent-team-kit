// Server-Sent Events hub.
//
// One interval per connected client polls the store for events newer than the
// client cursor (the store interface in m1-contracts §1 has no subscribe hook),
// and one interval writes the 25s keep-alive comment. Both timers are cleared
// when the client goes away or the server closes: a dead connection must not
// leave a polling loop behind.
import { createEvent, encodeSseFrame, encodeSseKeepAlive, resumePlan } from "@atk/contracts";

const REPLAY_BATCH = 500;
const MAX_REPLAY_BATCHES = 100;

/**
 * @param {object} options
 * @param {object} options.store  injected @atk/database store
 * @param {number} [options.heartbeatMs]  keep-alive interval (contract: 25s)
 * @param {number} [options.pollMs]       store poll interval for live events
 */
export function createSseHub({ store, heartbeatMs = 25_000, pollMs = 300, logger, now = () => Date.now() } = {}) {
  const clients = new Set();

  function latestSeq() {
    const value = store.latestSeq();
    return Number.isInteger(value) && value >= 0 ? value : 0;
  }

  /** Lowest seq still retained; the store has no oldestSeq(), so ask for one row. */
  function oldestSeq() {
    const first = store.listEvents({ limit: 1 });
    if (Array.isArray(first) && first.length > 0 && Number.isInteger(first[0]?.seq)) return first[0].seq;
    return 1;
  }

  function cleanup(client) {
    if (!client || client.closed) return;
    client.closed = true;
    clients.delete(client);
    clearInterval(client.heartbeatTimer);
    clearInterval(client.pollTimer);
    try {
      client.res.end();
    } catch {
      // The socket is already gone.
    }
  }

  function writeFrame(client, frame) {
    if (client.closed || client.res.writableEnded) {
      cleanup(client);
      return false;
    }
    try {
      client.res.write(frame);
      return true;
    } catch (error) {
      logger?.error?.(`[atk] SSE write failed: ${error?.message ?? error}`);
      cleanup(client);
      return false;
    }
  }

  function resyncFrame({ lastEventId, oldestAvailable, latest, reason }) {
    const event = createEvent({
      seq: latest,
      aggregateType: "system",
      aggregateId: "events",
      type: "system.resync-required",
      payload: { lastEventId, oldestAvailable, latest, reason },
      happenedAt: new Date(now()).toISOString(),
    });
    return encodeSseFrame(event);
  }

  /** Replay persisted events after `fromSeq` (inclusive), batching so a long gap cannot block the loop. */
  function replayFrom(client, fromSeq) {
    let cursor = fromSeq - 1;
    let batches = 0;
    while (!client.closed && batches < MAX_REPLAY_BATCHES) {
      batches += 1;
      const batch = store.listEvents({ afterSeq: cursor, limit: REPLAY_BATCH });
      if (!Array.isArray(batch) || batch.length === 0) break;
      // Retention could prune between the oldest-seq probe and this read; never
      // skip a hole silently, tell the client to resync instead.
      if (Number.isInteger(batch[0]?.seq) && batch[0].seq > cursor + 1) {
        const latest = latestSeq();
        client.cursor = latest;
        writeFrame(
          client,
          resyncFrame({
            lastEventId: cursor,
            oldestAvailable: batch[0].seq,
            latest,
            reason: "gap-while-connected",
          }),
        );
        return client.cursor;
      }
      for (const event of batch) {
        if (client.closed) return client.cursor;
        if (!Number.isInteger(event?.seq) || event.seq <= cursor) continue;
        writeFrame(client, encodeSseFrame(event));
        cursor = event.seq;
      }
      if (batch.length < REPLAY_BATCH) break;
    }
    client.cursor = Math.max(client.cursor, cursor);
    return client.cursor;
  }

  /**
   * Attach an HTTP response as an SSE stream. The caller has already completed
   * authentication; this function owns the response from here on.
   */
  function attach(req, res, { lastEventId } = {}) {
    // Probe the store before committing response headers: a store failure must
    // still be answerable with the JSON error envelope, not a half-open stream.
    const latest = latestSeq();
    const oldest = oldestSeq();

    const client = {
      req,
      res,
      cursor: 0,
      closed: false,
      heartbeatTimer: null,
      pollTimer: null,
    };
    clients.add(client);
    req.on("close", () => cleanup(client));
    req.on("aborted", () => cleanup(client));
    res.on("close", () => cleanup(client));
    res.on("error", () => cleanup(client));

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    res.write(`: connected ${now()}\n\n`);

    const resumeHeader = lastEventId === undefined || lastEventId === null ? "" : String(lastEventId).trim();

    if (resumeHeader === "") {
      // Fresh connection: only live events; the client already fetched its snapshot.
      client.cursor = latest;
    } else {
      const numeric = Number(resumeHeader);
      const plan = resumePlan(Number.isInteger(numeric) ? numeric : null, oldest, latest);
      if (plan.action === "replay") {
        client.cursor = Number.isInteger(numeric) ? numeric : 0;
        replayFrom(client, plan.from);
      } else {
        const previous = Number.isInteger(numeric) ? numeric : null;
        client.cursor = latest;
        writeFrame(
          client,
          resyncFrame({
            lastEventId: previous,
            oldestAvailable: oldest,
            latest,
            reason: Number.isInteger(numeric) ? "gap" : "invalid-last-event-id",
          }),
        );
      }
    }

    client.pollTimer = setInterval(() => {
      if (client.closed) return;
      try {
        const latestNow = latestSeq();
        if (latestNow <= client.cursor) return;
        const oldestNow = oldestSeq();
        if (client.cursor + 1 < oldestNow) {
          const previous = client.cursor;
          client.cursor = latestNow;
          writeFrame(
            client,
            resyncFrame({ lastEventId: previous, oldestAvailable: oldestNow, latest: latestNow, reason: "gap-while-connected" }),
          );
          return;
        }
        replayFrom(client, client.cursor + 1);
      } catch (error) {
        logger?.error?.(`[atk] SSE poll failed: ${error?.message ?? error}`);
        cleanup(client);
      }
    }, pollMs);
    client.pollTimer.unref?.();

    client.heartbeatTimer = setInterval(() => {
      if (client.closed) return;
      writeFrame(client, encodeSseKeepAlive(now()));
    }, heartbeatMs);
    client.heartbeatTimer.unref?.();

    return client;
  }

  function closeAll() {
    for (const client of [...clients]) cleanup(client);
  }

  function size() {
    return clients.size;
  }

  return { attach, closeAll, size };
}
