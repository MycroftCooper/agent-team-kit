// JSON file reading for the backend CLI.
//
// Windows editors (Notepad, PowerShell 5.1 `Set-Content`) happily write a UTF-8
// BOM; `JSON.parse` then fails on the invisible first character. M0 established
// `stripBom` in lib/util.mjs and M1 must be exactly as forgiving (QA2-04). The
// package boundary forbids importing lib/**, so the three-line convention is
// re-implemented here deliberately: strip one leading U+FEFF only.
import fs from "node:fs";

/** Remove a UTF-8 BOM. Same convention as lib/util.mjs#stripBom (M0). */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Error raised by readJsonFile; `code` is ENOENT / INVALID_JSON / the fs error code. */
export class JsonFileError extends Error {
  constructor(message, { code, file, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "JsonFileError";
    this.code = code;
    this.file = file;
  }
}

function lineColumnOf(text, offset) {
  const consumed = text.slice(0, offset);
  const line = consumed.split("\n").length;
  const column = offset - consumed.lastIndexOf("\n");
  return { line, column };
}

/**
 * V8 already reports "at position N (line L column C)" for most syntax errors.
 * The remaining shapes ("Unexpected token 'x', ... is not valid JSON") get a
 * best-effort location from the offending token so the message always names a
 * line/offset, which is what a user needs to find the problem.
 */
function describeParseError(text, error) {
  const message = String(error?.message ?? error);
  const reported = /(?:at position|position)\s+(\d+)/i.exec(message);
  let offset = reported ? Number(reported[1]) : null;
  if (offset === null) {
    const token = /Unexpected token '([^']+)'/.exec(message)?.[1];
    if (token) {
      const index = text.indexOf(token);
      if (index >= 0) offset = index;
    }
  }
  if (offset === null || offset < 0) {
    // "Unexpected end of JSON input" points at the end; anything else is
    // reported at the document start rather than without a location at all.
    offset = /end of json input/i.test(message) ? text.length : 0;
  }
  const { line, column } = lineColumnOf(text, offset);
  const hasPosition = /line\s+\d+/i.test(message);
  const location = hasPosition ? `(offset ${offset})` : `(line ${line}, column ${column}, offset ${offset})`;
  return `${message} ${location}`;
}

/**
 * Read a UTF-8 JSON file, tolerate a BOM, and turn fs/parse failures into
 * errors that name the file and the reason.
 *
 * @param {string} file
 * @param {{ optional?: boolean }} [options] `optional` returns null for ENOENT
 * @returns {unknown|null}
 */
export function readJsonFile(file, { optional = false } = {}) {
  if (typeof file !== "string" || file === "") {
    throw new TypeError("readJsonFile: file must be a non-empty path string");
  }
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (optional) return null;
      throw new JsonFileError(`JSON file not found: ${file}`, { code: "ENOENT", file, cause: error });
    }
    throw new JsonFileError(`Cannot read JSON file ${file}: ${error?.message ?? error}`, {
      code: error?.code ?? "READ_ERROR",
      file,
      cause: error,
    });
  }
  const body = stripBom(text);
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new JsonFileError(`Invalid JSON in ${file}: ${describeParseError(body, error)}`, {
      code: "INVALID_JSON",
      file,
      cause: error,
    });
  }
}
