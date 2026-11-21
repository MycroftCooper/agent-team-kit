import { startDevWeb } from "../web/dev-server.mjs";

const parent = process.parentPort;
let started, stopping = false, paused = false;
const waiting = new Set();

function waitForBackend(_req, res, next) {
  if (!paused) return next();
  const timer = setTimeout(() => finish(false), 5000);
  function remove() {
    clearTimeout(timer);
    waiting.delete(finish);
    res.off("close", remove);
  }
  function finish(ready) {
    remove();
    if (res.destroyed) return;
    if (ready) next();
    else {
      res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: { code: "SERVICE_RESTARTING", message: "The development backend is restarting" } }));
    }
  }
  waiting.add(finish);
  res.once("close", remove);
}

parent.on("message", ({ data }) => {
  if (data.type === "start" && !started) {
    started = startDevWeb({ backendUrl: data.backendUrl, port: data.port, waitForBackend });
    void started.then((web) => {
      parent.postMessage({ type: "ready", port: web.httpServer.address().port });
    }, (error) => {
      parent.postMessage({ type: "error", error: error.message });
      process.exit(1);
    });
  } else if (data.type === "pause-backend") {
    paused = true;
    parent.postMessage({ type: "backend-paused" });
  } else if (data.type === "resume-backend") {
    paused = false;
    for (const finish of waiting) finish(true);
  } else if (data.type === "stop" && !stopping) {
    stopping = true;
    for (const finish of waiting) finish(false);
    void Promise.resolve(started).then((web) => web?.close()).then(
      () => process.exit(0), (error) => { console.error(error); process.exit(1); },
    );
  }
});
