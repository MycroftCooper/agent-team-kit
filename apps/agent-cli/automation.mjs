import fs from "node:fs";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseStrictJson } from "../../packages/platform/src/strict-json.mjs";

const active = new Set(["STARTING", "RUNNING", "STOPPING"]);
function requireOption(ok, message) { if (!ok) throw Object.assign(new Error(message), { code: "INVALID_ARGUMENTS" }); }
function parse(argv) {
  const options = { params: [] }, positional = [];
  const flags = new Set(["create", "wait", "follow", "json"]);
  const values = new Set(["project", "revision", "file", "params-file", "param", "request-id", "limit", "cursor"]);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) { positional.push(argv[i]); continue; }
    const split = argv[i].indexOf("="), key = argv[i].slice(2, split < 0 ? undefined : split);
    requireOption(flags.has(key) || values.has(key), `Unknown option --${key}`);
    if (flags.has(key)) { requireOption(split < 0 && !options[key], `Invalid --${key}`); options[key] = true; continue; }
    const value = split < 0 ? argv[++i] : argv[i].slice(split + 1);
    requireOption(typeof value === "string" && !value.startsWith("--"), `--${key} requires a value`);
    if (key === "param") options.params.push(value);
    else { requireOption(options[key] === undefined, `Duplicate --${key}`); options[key] = value; }
  }
  requireOption(options.project && positional.length <= 2, "Use --project <projectId> and one automation action/ID");
  return { options, action: positional[0], id: positional[1] };
}
export async function automationCommand(argv, client) {
  const { options: o, action, id } = parse(argv), base = `/projects/${encodeURIComponent(o.project)}`;
  const flow = base + "/automations", runs = base + "/automation-runs";
  const read = file => { requireOption(file, "Use --file <file.json>"); return parseStrictJson(fs.readFileSync(file, "utf8")); };
  const print = value => console.log(JSON.stringify(value, null, 2));
  let result;
  if (action === "list") result = await client.request(flow);
  else if (["show", "schedules"].includes(action)) { requireOption(id, `Use ${action} <workflowId>`); result = await client.request(flow + "/" + encodeURIComponent(id) + (action === "schedules" ? "/schedules" : "")); }
  else if (action === "validate") {
    result = await client.request(flow + "/validate", { definition: read(o.file) });
    if (!result.valid || result.diagnostics.length) process.exitCode = 2;
  } else if (action === "apply") {
    requireOption(Boolean(o.create) !== Boolean(o.revision), "Use exactly one of --create or --revision <sha256>");
    const definition = read(o.file);
    result = await client.request(flow + "/" + encodeURIComponent(definition.id), { expectedRevision: o.create ? null : o.revision, definition }, "PUT");
  } else if (action === "remove") {
    requireOption(id && o.revision, "Use remove <workflowId> --revision <sha256>");
    result = await client.request(flow + "/" + encodeURIComponent(id) + "?revision=" + encodeURIComponent(o.revision), undefined, "DELETE");
  } else if (action === "run") {
    requireOption(id && o.revision, "Use run <workflowId> --revision <sha256>");
    requireOption(!o["params-file"] || !o.params.length, "--param and --params-file are mutually exclusive");
    const supplied = Object.create(null);
    if (o.params.length) {
      const definition = (await client.request(flow + "/" + encodeURIComponent(id))).definition;
      for (const item of o.params) {
        const split = item.indexOf("="), key = item.slice(0, split), raw = item.slice(split + 1), spec = definition.parameters[key];
        requireOption(split > 0 && spec && !Object.hasOwn(supplied, key), `Unknown or duplicate parameter ${key}`);
        if (spec.type === "boolean") { requireOption(["true", "false"].includes(raw), `${key} must be true or false`); supplied[key] = raw === "true"; }
        else if (["number", "integer"].includes(spec.type)) {
          requireOption(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw), `${key} must be numeric`);
          supplied[key] = Number(raw); requireOption(Number.isFinite(supplied[key]), `${key} must be finite`);
        } else supplied[key] = raw;
      }
    }
    const idempotencyKey = o["request-id"] ?? crypto.randomUUID();
    if (!o["request-id"]) console.error(JSON.stringify({ requestId: idempotencyKey }));
    result = await client.request(flow + "/" + encodeURIComponent(id) + "/runs", { revision: o.revision,
      parameters: o["params-file"] ? read(o["params-file"]) : supplied, idempotencyKey });
    if (o.wait) {
      console.error(JSON.stringify({ accepted: result }));
      do { await delay(500); result = await client.request(runs + "/" + encodeURIComponent(result.runId)); } while (active.has(result.status));
      process.exitCode = result.status === "SUCCEEDED" ? 0 : result.status === "RECOVERY_REQUIRED" ? 3 : 1;
    }
  } else if (action === "runs") {
    const query = new URLSearchParams({ limit: o.limit ?? "20" }); if (o.cursor) query.set("cursor", o.cursor);
    result = await client.request(runs + "?" + query);
  } else if (["status", "stop"].includes(action)) {
    requireOption(id, `Use ${action} <runId>`);
    result = await client.request(runs + "/" + encodeURIComponent(id) + (action === "stop" ? "/stop" : ""), action === "stop" ? {} : undefined);
  } else if (action === "logs") {
    requireOption(id, "Use logs <runId>"); let cursor = o.cursor;
    while (true) {
      const query = new URLSearchParams(); if (cursor) query.set("cursor", cursor);
      const page = await client.request(runs + "/" + encodeURIComponent(id) + "/logs?" + query);
      for (const item of page.items) o.json ? console.log(JSON.stringify(item)) : process.stdout.write(item.text);
      cursor = page.nextCursor;
      if (page.endOfFile && (!o.follow || page.complete)) return;
      if (page.endOfFile) await delay(500);
    }
  } else throw new Error("Use automation list|show|schedules|validate|apply|remove|run|runs|status|logs|stop");
  print(result);
}
