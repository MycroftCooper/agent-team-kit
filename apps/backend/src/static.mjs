// Static file serving for the built web UI (ADR-009: Backend serves
// apps/web/dist in production; Vite serves in development).
//
// When the build is missing the server must stay useful: GET / explains that
// the UI has not been built yet and prints the exact command, instead of a 500
// or a blank page.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json"],
]);

function contentTypeOf(file) {
  return CONTENT_TYPES.get(path.extname(file).toLowerCase()) ?? "application/octet-stream";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** The "web UI is not built" page (GET / with no dist). */
export function renderUnbuiltPage({ webDist } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Team Kit — Web UI not built</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1115; color: #e6e9ef;
         font: 15px/1.6 "Segoe UI", system-ui, sans-serif; }
  main { max-width: 44rem; padding: 2rem 2.5rem; border: 1px solid #2a2f3a; border-radius: 12px; background: #151922; }
  h1 { margin: 0 0 .5rem; font-size: 1.35rem; font-weight: 600; }
  p { margin: .6rem 0; color: #b6bdc9; }
  pre { padding: .75rem 1rem; border-radius: 8px; background: #0b0d11; border: 1px solid #2a2f3a; color: #9fe3b0; overflow-x: auto; }
  code { color: #cfe3ff; }
  a { color: #7fb4ff; }
</style>
</head>
<body>
<main>
  <h1>Agent Team Kit Backend</h1>
  <p>前端产物尚未构建（<code>${escapeHtml(webDist ?? "apps/web/dist")}</code> 不存在）。</p>
  <p>The web UI has not been built yet, so there is nothing to serve here.</p>
  <p>Build it with:</p>
  <pre>pnpm --filter @atk/web build</pre>
  <p>Then reload this page. The HTTP API is already live: <a href="/api/v1/system/health">/api/v1/system/health</a>.</p>
</main>
</body>
</html>
`;
}

/**
 * Build a static handler bound to a dist directory.
 *
 * @param {object} options
 * @param {string|null|undefined} options.webDist  dist directory (`null` disables static serving)
 */
export function createStaticHandler({ webDist, logger } = {}) {
  const root = webDist ? path.resolve(webDist) : null;
  const indexPath = root ? path.join(root, "index.html") : null;

  function distAvailable() {
    if (!root) return false;
    try {
      return fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  }

  function insideRoot(candidate) {
    if (!root) return false;
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  async function sendFile(res, filePath, method) {
    let data;
    try {
      data = await fsp.readFile(filePath);
    } catch (error) {
      logger?.warn?.(`[atk] static read failed for ${filePath}: ${error?.message ?? error}`);
      return false;
    }
    if (res.headersSent || res.writableEnded) return true;
    res.writeHead(200, {
      "content-type": contentTypeOf(filePath),
      "content-length": data.length,
      // Simple no-cache for every static file: a rebuilt UI must not be served
      // stale during local development or after an upgrade.
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    if (method === "HEAD") res.end();
    else res.end(data);
    return true;
  }

  function sendPrompt(res, method) {
    if (res.headersSent || res.writableEnded) return;
    const html = renderUnbuiltPage({ webDist: root ?? "apps/web/dist" });
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    if (method === "HEAD") res.end();
    else res.end(html);
  }

  /** Serve index.html for SPA routes; when index.html is missing, fall back to the prompt. */
  async function sendIndexFallback(res, method) {
    if (!indexPath) {
      sendPrompt(res, method);
      return true;
    }
    try {
      await fsp.access(indexPath, fs.constants.R_OK);
    } catch {
      sendPrompt(res, method);
      return true;
    }
    return sendFile(res, indexPath, method);
  }

  /**
   * Handle a non-/api request. Returns `true` when a response was written.
   * Unknown paths on a built dist fall back to index.html (SPA routing).
   */
  async function handle(req, res, pathname, method = "GET") {
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found\n");
      return true;
    }
    if (!distAvailable()) {
      sendPrompt(res, method);
      return true;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad Request\n");
      return true;
    }
    const relative = decoded.replace(/^\/+/, "");
    const candidate = path.resolve(root, relative);
    if (!insideRoot(candidate)) {
      // Never let an encoded `..` escape the dist directory; answer with the SPA entry.
      return sendIndexFallback(res, method);
    }
    let stats;
    try {
      stats = fs.statSync(candidate);
    } catch {
      return sendIndexFallback(res, method);
    }
    if (stats.isDirectory()) {
      return sendIndexFallback(res, method);
    }
    if (!stats.isFile()) return sendIndexFallback(res, method);
    return sendFile(res, candidate, method);
  }

  return { handle, distAvailable, root };
}
