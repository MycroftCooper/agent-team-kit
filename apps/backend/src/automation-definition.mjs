import { AppError } from "../../../packages/contracts/src/index.mjs";
import { parseStrictJson } from "../../../packages/platform/src/strict-json.mjs";

export const definitionLimit = 128 * 1024;
export const identifier = /^[a-z][a-z0-9-]{0,63}$/;
const parameterName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export function check(ok, message, code = "INVALID_DEFINITION", status = 422) {
  if (!ok) throw new AppError(code, message, status);
}
export function fields(value, allowed, label) {
  check(value && typeof value === "object" && !Array.isArray(value), `${label}: expected object`);
  for (const key of Object.keys(value)) check(allowed.includes(key), `${label}: unknown field ${key}`);
  return value;
}
function string(value, label, max, empty = false) {
  check(typeof value === "string" && (empty || value.trim()) && value.length <= max && !/[\0\r\n]/.test(value), `${label}: invalid string`);
  return value;
}
function integer(value, min, max, label) {
  check(Number.isInteger(value) && value >= min && value <= max, `${label}: expected integer ${min}..${max}`);
  return value;
}
export function strictJson(text, limit = definitionLimit) {
  try { return parseStrictJson(text, limit); }
  catch (e) { throw new AppError("INVALID_DEFINITION", e.message, 422); }
}

function parameterValue(spec, value, label) {
  const type = spec.type;
  check(type === "integer" ? Number.isSafeInteger(value) : typeof value === type, `${label}: expected ${type}`, "INVALID_PARAMETERS");
  if (type === "string") {
    check(value.length <= (spec.maxLength ?? 4096) && !/[\0\r\n]/.test(value), `${label}: invalid string`, "INVALID_PARAMETERS");
    check(!spec.enum || spec.enum.includes(value), `${label}: expected one of ${spec.enum?.join(", ")}`, "INVALID_PARAMETERS");
  }
  if (type === "number" || type === "integer") {
    check(Number.isFinite(value) && (spec.minimum === undefined || value >= spec.minimum) && (spec.maximum === undefined || value <= spec.maximum), `${label}: out of range`, "INVALID_PARAMETERS");
  }
  return value;
}
export function parameters(definition, supplied = {}) {
  check(supplied && typeof supplied === "object" && !Array.isArray(supplied), "parameters must be an object", "INVALID_PARAMETERS");
  for (const key of Object.keys(supplied)) check(Object.hasOwn(definition.parameters, key), "Unknown parameter " + key, "INVALID_PARAMETERS");
  return Object.fromEntries(Object.entries(definition.parameters).map(([name, spec]) => {
    const value = Object.hasOwn(supplied, name) ? supplied[name] : spec.default;
    check(value !== undefined, `Missing required parameter ${name}`, "INVALID_PARAMETERS");
    return [name, parameterValue(spec, value, name)];
  }));
}

export function expand(text, values) {
  return text.replace(/\$\$\{|\$\{([^}]+)\}/g, (match, name) => {
    if (match === "$${") return "${";
    check(Object.hasOwn(values, name), `Unknown placeholder ${name}`);
    return String(values[name]);
  });
}
function template(text, names, label) {
  string(text, label, 8192, true);
  expand(text, Object.fromEntries(names.map(name => [name, "value"])));
  check(!text.replace(/\$\$\{|\$\{[^}]+\}/g, "").includes("${"), `${label}: incomplete placeholder`);
}
function relative(text, label) {
  string(text, label, 4096);
  check(!text.includes("\\") && !text.startsWith("/") && !/^[a-z]:/i.test(text) && !text.split("/").includes("..") && !text.includes("${"), `${label}: use a project-relative path`);
  return text;
}
function unique(list, label) { check(new Set(list).size === list.length, `${label}: duplicate ID`); }

function instant(value, label) {
  const match = typeof value === "string" && /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  check(match && Number.isFinite(Date.parse(value)) && Date.parse(value) >= 0, `${label}: use an ISO timestamp with Z or a UTC offset`);
  const wall = match[1] + "T" + match[2];
  check(new Date(wall + "Z").toISOString().slice(0, 19) === wall, `${label}: invalid calendar date`);
  return new Date(value).toISOString();
}

function schedules(input, specs) {
  check(Array.isArray(input) && input.length <= 32, "Use up to 32 schedules");
  const result = input.map(s => {
    fields(s, s?.type === "at" ? ["id", "name", "type", "enabled", "parameters", "times"] : ["id", "name", "type", "enabled", "parameters", "startAt", "everySeconds", "count"], "schedule");
    check(identifier.test(s.id) && ["at", "interval"].includes(s.type), "Invalid schedule ID/type");
    if (s.name !== undefined) string(s.name, "schedule.name", 128);
    check(s.enabled === undefined || typeof s.enabled === "boolean", "schedule.enabled must be boolean");
    const normalized = { ...s, enabled: s.enabled ?? true, parameters: parameters({ parameters: specs }, s.parameters) };
    if (s.type === "at") {
      check(Array.isArray(s.times) && s.times.length >= 1 && s.times.length <= 100, "Use 1 to 100 schedule times");
      normalized.times = s.times.map(time => instant(time, "schedule.times")).sort();
      unique(normalized.times, "schedule.times");
    } else {
      normalized.startAt = instant(s.startAt, "schedule.startAt");
      integer(s.everySeconds, 60, 31622400, "schedule.everySeconds");
      if (s.count !== undefined) {
        integer(s.count, 1, 1000000, "schedule.count");
        check(Date.parse(normalized.startAt) + (s.count - 1) * s.everySeconds * 1000 <= 8640000000000000, "Schedule exceeds the supported date range");
      }
    }
    return normalized;
  });
  unique(result.map(s => s.id), "schedules");
  return result;
}

export function definition(input) {
  const d = fields(input, ["schemaVersion", "id", "name", "description", "parameters", "trigger", "schedules", "steps"], "definition");
  check(Buffer.byteLength(JSON.stringify(d)) <= definitionLimit, "Definition exceeds 128 KiB");
  check(d.schemaVersion === 1 && identifier.test(d.id), "Use schemaVersion 1 and a valid workflow ID");
  string(d.name, "name", 128);
  string(d.description ?? "", "description", 2048, true);
  const specs = d.parameters ?? {};
  check(specs && typeof specs === "object" && !Array.isArray(specs) && Object.keys(specs).length <= 32, "Use up to 32 parameters");
  for (const [name, spec] of Object.entries(specs)) {
    check(parameterName.test(name) && !["__proto__", "constructor", "prototype"].includes(name), `Invalid parameter name ${name}`);
    fields(spec, ["type", "title", "description", "default", "required", "enum", "maxLength", "minimum", "maximum"], name);
    check(["string", "number", "integer", "boolean"].includes(spec.type), `${name}: unsupported type`);
    check(Object.hasOwn(spec, "default") ? !spec.required : spec.required === true, `${name}: provide a default or required:true`);
    if (spec.required !== undefined) check(typeof spec.required === "boolean", `${name}: required must be boolean`);
    if (spec.title !== undefined) string(spec.title, name + ".title", 128);
    if (spec.description !== undefined) string(spec.description, name + ".description", 2048, true);
    if (spec.enum !== undefined) {
      check(spec.type === "string" && Array.isArray(spec.enum) && spec.enum.length > 0 && spec.enum.length <= 100 && spec.enum.every(v => typeof v === "string"), `${name}: invalid enum`);
      unique(spec.enum, name);
      for (const value of spec.enum) parameterValue(spec, value, name + ".enum");
    }
    if (spec.maxLength !== undefined) { check(spec.type === "string", `${name}: maxLength requires string`); integer(spec.maxLength, 0, 8192, name); }
    for (const key of ["minimum", "maximum"]) if (spec[key] !== undefined)
      check(["number", "integer"].includes(spec.type) && Number.isFinite(spec[key]), `${name}: invalid ${key}`);
    check(spec.minimum === undefined || spec.maximum === undefined || spec.minimum <= spec.maximum, `${name}: invalid range`);
    if (Object.hasOwn(spec, "default")) parameterValue(spec, spec.default, name);
  }
  const trigger = d.trigger ?? { type: "manual" };
  fields(trigger, trigger.type === "git-commit" ? ["type", "branch", "parameters"] : ["type"], "trigger");
  check(["manual", "git-commit"].includes(trigger.type), "Unsupported trigger");
  if (trigger.type === "git-commit") {
    string(trigger.branch, "branch", 128);
    check(!/[\x00-\x20\x7f~^:?*[\]\\]/.test(trigger.branch) && !trigger.branch.includes("..") && !trigger.branch.startsWith("-") && !["HEAD", "@"].includes(trigger.branch) && !trigger.branch.endsWith(".") && trigger.branch.split("/").every(p => p && !p.startsWith(".") && !p.endsWith(".lock")), "Invalid Git branch");
    parameters({ parameters: specs }, trigger.parameters);
  }
  check(Array.isArray(d.steps) && d.steps.length >= 1 && d.steps.length <= 20, "Use 1 to 20 steps");
  const builtIns = ["project.root", "run.id", "run.dir", "step.id", "step.dir"];
  const steps = d.steps.map(s => {
    fields(s, ["id", "name", "cli", "args", "cwd", "timeoutMs", "env", "exports", "result"], "step");
    check(identifier.test(s.id), "Invalid step ID");
    string(s.name, "step.name", 128);
    string(s.cli, "cli", 4096);
    check(s.cli.startsWith("./") ? relative(s.cli, "cli") : !/[\s\\/:$]/.test(s.cli), "cli must be a command name or ./relative executable");
    check(Array.isArray(s.args) && s.args.length <= 128, "args must be an array of up to 128 strings");
    for (const arg of s.args) template(arg, [...builtIns, ...Object.keys(specs).map(name => "params." + name)], "args");
    relative(s.cwd ?? ".", "cwd");
    integer(s.timeoutMs ?? 900000, 1000, 86400000, "timeoutMs");
    const env = s.env ?? {};
    check(env && typeof env === "object" && !Array.isArray(env) && Object.keys(env).length <= 64, "Invalid env");
    for (const [key, item] of Object.entries(env)) {
      check(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !/^ATK_/i.test(key), "Reserved/invalid environment name");
      fields(item, Object.hasOwn(item ?? {}, "value") ? ["value"] : ["fromEnv", "required"], "env." + key);
      if (Object.hasOwn(item, "value")) string(item.value, key, 8192, true);
      else {
        check(typeof item.fromEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(item.fromEnv) && !/^ATK_/i.test(item.fromEnv), "Invalid fromEnv");
        check(item.required === undefined || typeof item.required === "boolean", "Invalid required");
      }
    }
    const exports = s.exports ?? [];
    check(Array.isArray(exports) && exports.length <= 16, "Use up to 16 exports");
    for (const item of exports) {
      fields(item, ["id", "path", "kind", "required"], "export");
      check(identifier.test(item.id) && ["file", "directory"].includes(item.kind) && typeof item.required === "boolean", "Invalid export");
      template(item.path, builtIns.filter(name => name.startsWith("run.") || name.startsWith("step.")), "export.path");
      check(!item.path.includes("\\") && !item.path.split("/").includes("..") && !/^(?:\/|[a-z]:)/i.test(item.path), "Invalid export path");
    }
    unique(exports.map(e => e.id), "exports");
    const result = s.result ?? { protocol: "exit-code" };
    fields(result, result.protocol === "exit-code" ? ["protocol"] : ["protocol", "exportId"], "result");
    check(["exit-code", "atk-ci-result/v1"].includes(result.protocol), "Unknown result protocol");
    if (result.protocol !== "exit-code") check(exports.some(e => e.id === result.exportId && e.kind === "file" && e.required), "Result must reference a required file export");
    return { ...s, cwd: s.cwd ?? ".", timeoutMs: s.timeoutMs ?? 900000, env, exports, result };
  });
  unique(steps.map(s => s.id), "steps");
  return { ...d, description: d.description ?? "", parameters: specs, trigger, schedules: schedules(d.schedules ?? [], specs), steps };
}

export function resultReport(report, runId, stepId) {
  fields(report, ["schemaVersion", "runId", "stepId", "status", "summary", "checks"], "report");
  check(report.schemaVersion === 1 && report.runId === runId && report.stepId === stepId && ["passed", "failed"].includes(report.status), "Report identity/status mismatch", "RESULT_INVALID");
  if (report.summary !== undefined) string(report.summary, "report.summary", 2048, true);
  check(report.checks === undefined || Array.isArray(report.checks) && report.checks.length <= 10000, "Invalid checks", "RESULT_INVALID");
  for (const item of report.checks ?? []) {
    fields(item, ["id", "name", "status", "durationMs", "message"], "check");
    check(identifier.test(item.id) && ["passed", "failed", "skipped"].includes(item.status), "Invalid check", "RESULT_INVALID");
    string(item.name, "check.name", 128);
    if (item.durationMs !== undefined) integer(item.durationMs, 0, Number.MAX_SAFE_INTEGER, "check.durationMs");
    if (item.message !== undefined) string(item.message, "check.message", 2048, true);
  }
  unique((report.checks ?? []).map(c => c.id), "checks");
  check(report.status !== "passed" || !(report.checks ?? []).some(c => c.status === "failed"), "Passed report contains failed checks", "RESULT_INVALID");
  return report;
}
