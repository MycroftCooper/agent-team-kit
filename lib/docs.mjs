// Document rotation: keep long-lived markdown docs (handoff logs, narrative
// journals) short by moving old content into a monthly archive file.
//
// Entries come from `rotation` in the project config. Two modes are supported:
//   sections   keep the newest N sections (split on headings of headingLevel)
//   narrative  move everything before the `startMarker` heading into the archive
//
// Default is a dry run; `--apply` writes. Before writing, the live file is
// stat()ed again (mtime + size) and the run refuses with exit code 3 when
// somebody changed the file while it was being read.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { assertInsideRoot } from "./config.mjs";
import { ensureDir, localIso, normalizeRel, parseArgs, readTextOr, toPosix, writeText } from "./util.mjs";

export const DOCS_SCHEMA_VERSION = 1;
export const CONCURRENCY_EXIT_CODE = 3;

function monthOf(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}`;
}

function headingPrefix(level) {
  return `${"#".repeat(level)} `;
}

/** Split a markdown file into `{ header, sections }` on headings of `level`. */
export function splitSections(lines, level = 2) {
  const prefix = headingPrefix(level);
  let firstHeading = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith(prefix)) {
      firstHeading = index;
      break;
    }
  }
  if (firstHeading === -1) return { header: [...lines], sections: [] };
  const header = lines.slice(0, firstHeading);
  const sections = [];
  for (const line of lines.slice(firstHeading)) {
    if (line.startsWith(prefix)) {
      sections.push({ title: line.slice(prefix.length).trim(), lines: [line] });
    } else if (sections.length) {
      sections.at(-1).lines.push(line);
    }
  }
  return { header, sections };
}

/** `{ header, moved, kept }` for narrative mode; `error` when the structure is wrong. */
export function splitNarrative(lines, entry) {
  const level = entry.headingLevel ?? 2;
  const prefix = headingPrefix(level);
  const firstHeading = lines.findIndex((line) => line.startsWith(prefix));
  if (firstHeading === -1) {
    return { error: `no level-${level} heading found; nothing can be rotated` };
  }
  const marker = entry.startMarker;
  if (!marker) return { error: "narrative mode requires startMarker" };
  const markerIndex = lines.findIndex(
    (line) => /^#{1,6}\s+/.test(line) && line.replace(/^#{1,6}\s+/, "").trim() === String(marker).trim(),
  );
  if (markerIndex === -1) return { error: `startMarker heading "${marker}" not found` };
  if (markerIndex <= firstHeading) {
    return { header: lines.slice(0, markerIndex), moved: [], kept: lines.slice(markerIndex), empty: true };
  }
  return {
    header: lines.slice(0, firstHeading),
    moved: lines.slice(firstHeading, markerIndex),
    kept: lines.slice(markerIndex),
  };
}

function defaultArchivePrefix(entry) {
  const base = path.posix.basename(normalizeRel(entry.path));
  return base.replace(/\.[^.]+$/, "") || "archive";
}

function archiveLink(liveRel, archiveRel) {
  const from = path.posix.dirname(normalizeRel(liveRel));
  const link = toPosix(path.posix.relative(from, normalizeRel(archiveRel)));
  return link || path.posix.basename(normalizeRel(archiveRel));
}

function substituteTokens(text, values) {
  let out = String(text);
  for (const [token, value] of Object.entries(values)) out = out.split(`{{${token}}}`).join(String(value));
  return out;
}

function pointerLines(entry, values) {
  if (entry.pointer !== undefined && entry.pointer !== null && String(entry.pointer).trim()) {
    return substituteTokens(String(entry.pointer), values).replace(/\r?\n$/, "").split(/\r?\n/);
  }
  if (entry.mode === "narrative") {
    return [
      `> Rotated ${values.date}: ${values.count} narrative section(s) moved to [${values.archive}](${values.archive}).`,
      `> This file starts at the "${values.marker}" ledger; older narrative stays in the archive.`,
    ];
  }
  return [
    `> Rotated ${values.date}: ${values.count} older section(s) moved to [${values.archive}](${values.archive}).`,
    `> This file keeps the newest ${values.keep} section(s); full history lives in the archive.`,
  ];
}

/** Everything that will be written for one rotation entry (no side effects). */
export function buildRotationPlan(entry, text, { root, now = new Date() } = {}) {
  const mode = entry.mode ?? (entry.startMarker ? "narrative" : "sections");
  const liveRel = normalizeRel(entry.path);
  const liveAbs = assertInsideRoot({ root }, path.resolve(root, liveRel));
  const archiveDirRel = normalizeRel(entry.archiveDir ?? "");
  if (!archiveDirRel) throw new Error("rotation entry is missing archiveDir");
  const archiveDirAbs = assertInsideRoot({ root }, path.resolve(root, archiveDirRel));
  const month = monthOf(now);
  const prefix = String(entry.archivePrefix || defaultArchivePrefix(entry));
  const archiveRel = `${archiveDirRel}/${prefix}-${month}.md`;
  const archiveAbs = assertInsideRoot({ root }, path.join(archiveDirAbs, `${prefix}-${month}.md`));
  const date = localIso(now);

  const lines = text.split(/\r?\n/);
  let header;
  let moved;
  let kept;
  let keep = null;

  if (mode === "narrative") {
    const split = splitNarrative(lines, entry);
    if (split.error) {
      return { entry, mode, error: split.error, liveAbs, archiveAbs, archiveRel, liveRel, status: "error" };
    }
    header = split.header;
    moved = split.moved;
    kept = split.kept;
  } else {
    keep = Number.isInteger(entry.keep) ? entry.keep : 2;
    const split = splitSections(lines, entry.headingLevel ?? 2);
    if (!split.sections.length) {
      return {
        entry,
        mode,
        keep,
        error: `no level-${entry.headingLevel ?? 2} heading found; nothing to rotate`,
        liveAbs,
        archiveAbs,
        archiveRel,
        liveRel,
        status: "no-op",
      };
    }
    header = split.header;
    moved = split.sections.slice(keep).flatMap((section) => section.lines);
    kept = split.sections.slice(0, keep).flatMap((section) => section.lines);
  }

  const movedSections = moved.filter((line) => /^#{1,6}\s+/.test(line)).length;
  const values = {
    archive: archiveLink(liveRel, archiveRel),
    count: String(movedSections),
    keep: String(keep ?? ""),
    month,
    date,
    marker: String(entry.startMarker ?? ""),
  };
  const headerText = header.join("\n").trimEnd();
  const movedText = moved.join("\n").trimEnd();
  const keptText = kept.join("\n").trimEnd();
  const pointer = pointerLines({ ...entry, mode }, values);
  const nextLive = [headerText, pointer.join("\n"), keptText].filter(Boolean).join("\n\n");

  return {
    entry,
    mode,
    keep,
    liveRel,
    liveAbs,
    archiveRel,
    archiveAbs,
    movedSections,
    movedChars: movedText.length,
    liveBeforeChars: text.length,
    liveAfterChars: `${nextLive}\n`.length,
    archiveHeader: `# ${prefix} archive (${month})\n\n> Rotated by \`atk docs rotate\` from ${liveRel}; read-only history.\n\n`,
    archiveAppend: `${movedText}\n`,
    nextLive: `${nextLive}\n`,
    status: movedSections ? "would-rotate" : "no-op",
  };
}

/** Stat guard used before writing: true when mtime and size are unchanged. */
export async function isUnchanged(file, before) {
  try {
    const after = await stat(file);
    return after.mtimeMs === before.mtimeMs && after.size === before.size;
  } catch {
    return false;
  }
}

function selectEntries(entries, args) {
  let selected = entries;
  if (typeof args.flavor === "string") {
    selected = selected.filter((entry) => String(entry.flavor ?? "") === args.flavor);
  }
  if (typeof args.entry === "string") {
    selected = selected.filter((entry) => normalizeRel(entry.path) === normalizeRel(args.entry));
  }
  return selected;
}

function reportEntry(plan) {
  if (plan.status === "error") {
    return { path: plan.liveRel ?? plan.entry.path, mode: plan.mode, status: "error", error: plan.error };
  }
  return {
    path: plan.liveRel,
    mode: plan.mode,
    ...(plan.keep !== null && plan.keep !== undefined && plan.mode === "sections" ? { keep: plan.keep } : {}),
    movedSections: plan.movedSections,
    movedChars: plan.movedChars,
    archiveFile: plan.archiveRel,
    liveBeforeChars: plan.liveBeforeChars,
    liveAfterChars: plan.liveAfterChars,
    status: plan.status,
  };
}

export function usage() {
  return [
    "Usage: atk docs rotate [--apply] [--keep <n>] [--flavor <name>] [--entry <path>]",
    "",
    "Rotate the long-lived documents listed in `rotation` in the project config.",
    "Dry run by default: nothing is written without --apply.",
    "",
    "  --apply           write the archive files and the trimmed live files",
    "  --keep <n>        override how many newest sections sections-mode entries keep",
    "  --flavor <name>   only the rotation entries whose `flavor` is <name>",
    "  --entry <path>    only the rotation entry with this project-relative path",
    "",
    "Modes:",
    "  sections   split on headings of `headingLevel` (default 2); the newest",
    "             `keep` sections stay, older ones move to",
    "             <archiveDir>/<archivePrefix>-YYYY-MM.md",
    "  narrative  move everything before the `startMarker` heading into the archive",
    "",
    "Archives are appended to, never overwritten; the live file keeps a pointer line.",
    "A live file changed between read and write aborts the run with exit code 3.",
  ].join("\n");
}

export async function run(argv, ctx) {
  const args = parseArgs(argv);
  const sub = args._[0];
  if (sub === "help" || sub === "--help" || args.help === true) {
    ctx.log.out(usage());
    return 2;
  }
  if (sub !== "rotate") {
    if (sub) ctx.log.err(`Unknown docs sub-command "${sub}".\n`);
    else ctx.log.err("Missing docs sub-command.\n");
    ctx.log.out(usage());
    return 2;
  }

  const apply = args.apply === true;
  let keepOverride = null;
  if (args.keep !== undefined) {
    const parsed = Number(args.keep);
    if (!Number.isInteger(parsed) || parsed < 0) {
      ctx.log.err(`--keep must be a non-negative integer, got "${args.keep}".\n`);
      ctx.log.out(usage());
      return 2;
    }
    keepOverride = parsed;
  }

  const configured = Array.isArray(ctx.config.rotation) ? ctx.config.rotation : [];
  if (!configured.length) {
    ctx.log.out("No rotation entries configured (rotation is empty). Nothing to rotate.");
    return 0;
  }
  const entries = selectEntries(configured, args);
  if (!entries.length) {
    ctx.log.err("No rotation entry matches the given --flavor/--entry filter.");
    return 2;
  }

  const now = new Date();
  const plans = [];
  const errors = [];
  for (const entry of entries) {
    const liveRel = normalizeRel(entry.path);
    const liveAbs = assertInsideRoot(ctx, path.resolve(ctx.root, liveRel));
    let text;
    let before;
    try {
      text = await readFile(liveAbs, "utf8");
      before = await stat(liveAbs);
    } catch (error) {
      plans.push({ entry, liveRel, liveAbs, mode: entry.mode ?? null, status: "error", error: `cannot read ${liveRel}: ${error.message}` });
      errors.push(`${liveRel}: ${error.message}`);
      continue;
    }
    const effective = keepOverride === null ? entry : { ...entry, keep: keepOverride };
    let plan;
    try {
      plan = buildRotationPlan(effective, text, { root: ctx.root, now });
    } catch (error) {
      plans.push({ entry, liveRel, liveAbs, mode: effective.mode ?? null, status: "error", error: error.message });
      errors.push(`${liveRel}: ${error.message}`);
      continue;
    }
    plan.before = before;
    plan.originalText = text;
    if (plan.status === "error") errors.push(`${liveRel}: ${plan.error}`);
    else if (plan.status === "no-op" && plan.error) errors.push(`${liveRel}: ${plan.error}`);
    plans.push(plan);
  }

  const report = {
    schemaVersion: DOCS_SCHEMA_VERSION,
    dryRun: !apply,
    entries: plans.map(reportEntry),
    note: "",
  };

  if (!apply) {
    report.note = "Dry run: no files written. Pass --apply to rotate.";
    ctx.log.json(report);
    return errors.length ? 1 : 0;
  }

  // Concurrency guard: re-stat every live file before writing anything.
  for (const plan of plans) {
    if (plan.status !== "would-rotate") continue;
    const unchanged = await isUnchanged(plan.liveAbs, plan.before);
    if (!unchanged) {
      ctx.log.err(`${plan.liveRel} changed while reading it; refusing to overwrite (concurrency guard).`);
      return CONCURRENCY_EXIT_CODE;
    }
  }

  for (const plan of plans) {
    if (plan.status !== "would-rotate") continue;
    await ensureDir(path.dirname(plan.archiveAbs));
    const existing = await readTextOr(plan.archiveAbs, plan.archiveHeader);
    const text = existing.trim() ? `${existing.trimEnd()}\n\n${plan.archiveAppend}` : `${plan.archiveHeader}${plan.archiveAppend}`;
    await writeText(plan.archiveAbs, text);
    await writeText(plan.liveAbs, plan.nextLive);
    plan.status = "rotated";
  }

  report.entries = plans.map(reportEntry);
  const rotated = plans.filter((plan) => plan.status === "rotated").length;
  report.note = rotated ? `Rotation applied to ${rotated} file(s).` : "Nothing to rotate; no files written.";
  ctx.log.json(report);
  return errors.length ? 1 : 0;
}
