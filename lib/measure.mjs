// Workflow measurement: append JSONL rows to artifactDir/metrics.jsonl and
// summarise them per batch. The board reads the same file, so rows stay small
// and append-only.
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { ensureDir, parseArgs, readJsonl } from "./util.mjs";

const USAGE = [
  "Usage: atk measure <command> [options]",
  "",
  "Commands:",
  "  record --batch <id> --role <R> --event <e> [--files N] [--tokens N]",
  "         [--rounds N] [--gateMs N] [--note <text>]",
  "                              Append one measurement row",
  "  summary [--batch <id>]      Aggregate rows per batch (JSON)",
  "",
  "Exit codes: 0 ok, 2 usage error.",
].join("\n");

const NUMERIC_FLAGS = ["files", "tokens", "rounds", "gateMs", "readLines"];

function metricsFile(ctx) {
  return path.join(ctx.paths.artifactDir, "metrics.jsonl");
}

function toNumber(value, flag) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`measure: --${flag} must be a number, got "${value}"`);
  return number;
}

async function cmdRecord(ctx, args) {
  if (!args.batch || !args.role || !args.event) {
    ctx.log.err("measure record: --batch, --role and --event are required");
    ctx.log.out(USAGE);
    return 2;
  }
  const entry = {
    at: new Date().toISOString(),
    batch: String(args.batch),
    role: String(args.role).toUpperCase(),
    event: String(args.event),
  };
  for (const flag of NUMERIC_FLAGS) {
    const value = toNumber(args[flag], flag);
    if (value !== undefined) entry[flag] = value;
  }
  if (args.note !== undefined && args.note !== true) entry.note = String(args.note);
  const file = metricsFile(ctx);
  await ensureDir(path.dirname(file));
  await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  ctx.log.out(JSON.stringify(entry));
  return 0;
}

async function cmdSummary(ctx, args) {
  let rows = await readJsonl(metricsFile(ctx));
  if (args.batch !== undefined && args.batch !== true) {
    rows = rows.filter((row) => row.batch === String(args.batch));
  }
  const buckets = new Map();
  for (const row of rows) {
    const bucket = buckets.get(row.batch) ?? {
      batch: row.batch,
      events: 0,
      files: 0,
      tokens: 0,
      rounds: 0,
      gateMs: 0,
      readLines: 0,
    };
    bucket.events += 1;
    bucket.files += row.files ?? 0;
    bucket.tokens += row.tokens ?? 0;
    bucket.rounds += row.rounds ?? 0;
    bucket.gateMs += row.gateMs ?? 0;
    bucket.readLines += row.readLines ?? 0;
    buckets.set(row.batch, bucket);
  }
  const batches = [...buckets.values()].sort((a, b) => String(a.batch).localeCompare(String(b.batch), "en"));
  ctx.log.json({ schemaVersion: 1, batches, samples: rows.length });
  return 0;
}

export async function run(argv, ctx) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    ctx.log.out(USAGE);
    return 2;
  }
  const args = parseArgs(rest);
  try {
    if (command === "record") return await cmdRecord(ctx, args);
    if (command === "summary") return await cmdSummary(ctx, args);
  } catch (error) {
    ctx.log.err(error.message);
    return 2;
  }
  ctx.log.err(`measure: unknown command "${command}"`);
  ctx.log.out(USAGE);
  return 2;
}
