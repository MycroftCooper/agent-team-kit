import fs from "node:fs";
import path from "node:path";

export const ENGINES = ["codex", "dsh"];

export function resolveEngine(engine, value = engine) {
  if (!ENGINES.includes(engine)) throw new Error("engine must be codex or dsh");
  const explicit = path.isAbsolute(value) || /[/\\]/.test(value);
  const candidates = explicit ? [path.resolve(value)] : (process.env.PATH ?? "").split(path.delimiter).flatMap(dir =>
    process.platform === "win32" ? [path.join(dir, value + ".exe"), path.join(dir, value), path.join(dir, value + ".cmd")] : [path.join(dir, value)]);
  for (const file of candidates) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    if (/\.(cmd|bat)$/i.test(file)) {
      // The official desktop shim uses Electron as Node. Invoke its native host
      // and packaged entry directly, with separate argv and no cmd.exe quoting.
      if (engine !== "dsh" || path.basename(file).toLowerCase() !== "dsh.cmd") continue;
      const root = path.resolve(path.dirname(file), "../../../..");
      const executable = path.join(root, "DeepSeek Harness.exe"), asar = path.join(root, "resources", "app.asar");
      if (!fs.existsSync(executable) || !fs.existsSync(asar)) continue;
      return { executable, args: ["--expose-internals", path.join(asar, "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js")],
        env: { ELECTRON_RUN_AS_NODE: "1" }, desktopAsar: asar };
    }
    return { executable: path.resolve(file) };
  }
  throw new Error(`Cannot find ${engine} CLI. Add it to PATH or pass --${engine} <executable>. ` +
    (engine === "dsh" ? "The official desktop resources/runtime/cli/bin/dsh.cmd is also supported." : "Windows .cmd/.bat shims are not supported for Codex; select codex.exe."));
}

export function resolveCodex(value = "codex") { return resolveEngine("codex", value); }

export function parseAgentAnswer(text) {
  // DSH has no schema-output option. Accept a single JSON object, optionally in
  // one Markdown JSON fence; never infer success from tool output or prose.
  const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1"));
  if (!value || !["IMPLEMENTED", "BLOCKED"].includes(value.outcome) || typeof value.summary !== "string" ||
      !value.summary.trim() || Object.keys(value).some(key => !["outcome", "summary"].includes(key)))
    throw new Error("Agent returned an invalid result");
  return value;
}

export function createDshResult() {
  let sessionId, final, failure;
  return {
    line(raw) {
      if (failure || !raw.trim()) return;
      try {
        if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error("DSH event is too large");
        if (final) throw new Error("DSH emitted events after its final result");
        const event = JSON.parse(raw);
        if (!event || typeof event.type !== "string") throw new Error("Invalid DSH event");
        if (event.type === "session") {
          if (sessionId || typeof event.sessionId !== "string" || !event.sessionId) throw new Error("Invalid DSH session event");
          sessionId = event.sessionId;
        } else if (event.type === "final") {
          if (!sessionId) throw new Error("DSH final result has no preceding session");
          final = event;
        } else if (event.type === "error") throw new Error("DSH reported an error");
      } catch (error) { failure = error; }
    },
    finish() {
      if (failure) throw failure;
      if (!sessionId || !final || final.sessionId !== sessionId || final.reason?.kind !== "completed" ||
          final.truncated || typeof final.text !== "string") throw new Error("DSH did not emit a completed final result for this session");
      return parseAgentAnswer(final.text);
    },
  };
}
