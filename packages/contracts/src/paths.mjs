// Repository path rules shared by every writer-scope decision (F13).
//
// One implementation, imported by the database store, the scheduler and the
// backend, so "src/ overlaps src/a.ts" cannot mean two different things in two
// processes. Paths are repository-relative POSIX strings; Windows separators are
// normalised in, never out.

/**
 * Canonical repository-relative path used for comparisons.
 *
 * - backslashes become slashes; repeated slashes collapse
 * - leading "./" is dropped; "." and empty segments are removed
 * - ".." is resolved lexically and may not escape the root
 * - surrounding whitespace is trimmed (a padded path is a typo, not a name)
 * - comparison is case-sensitive on every platform: the repository is the
 *   authority for naming, and Windows' case-insensitivity must not silently
 *   widen a write scope
 */
export function normalizeRepoPath(value) {
  if (typeof value !== "string") throw new TypeError("normalizeRepoPath: path must be a string");
  const raw = value.trim().replace(/\\/g, "/");
  if (raw === "") throw new TypeError("normalizeRepoPath: path must not be empty");
  if (raw.startsWith("/")) throw new TypeError(`normalizeRepoPath: "${value}" must be repository-relative`);
  const out = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) throw new TypeError(`normalizeRepoPath: "${value}" escapes the repository root`);
      out.pop();
      continue;
    }
    out.push(segment);
  }
  if (out.length === 0) throw new TypeError(`normalizeRepoPath: "${value}" does not name a path`);
  return out.join("/");
}

/**
 * True when two normalised paths overlap: equal, or one is a path-segment prefix
 * of the other. `src` overlaps `src/a.ts`; `src2/a.ts` does not overlap `src/a.ts`.
 * Callers pass the result of normalizeRepoPath (both sides are normalised here
 * again, which is cheap and makes misuse harmless).
 */
export function pathsOverlap(left, right) {
  const a = normalizeRepoPath(left);
  const b = normalizeRepoPath(right);
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Intersection of two write-scope lists, preserving input order and dropping
 * duplicates. Returns the paths from `left` that overlap anything in `right`.
 */
export function overlappingPaths(left, right) {
  const rights = (Array.isArray(right) ? right : []).map((path) => normalizeRepoPath(path));
  const seen = new Set();
  const result = [];
  for (const path of Array.isArray(left) ? left : []) {
    const normalized = normalizeRepoPath(path);
    if (seen.has(normalized)) continue;
    if (rights.some((other) => pathsOverlap(normalized, other))) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}
