// JSON.parse silently accepts duplicate keys. Configuration files must not.
export function parseStrictJson(text, limit = 128 * 1024) {
  if (Buffer.byteLength(text) > limit) throw new SyntaxError("JSON exceeds size limit");
  const parsed = JSON.parse(text);
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) ?? [];
  let at = 0;
  function value(depth) {
    if (depth >= 64) throw new SyntaxError("JSON nesting limit exceeded");
    const token = tokens[at++];
    if (token === "{") {
      const keys = new Set();
      while (tokens[at] !== "}") {
        const key = JSON.parse(tokens[at++]);
        if (keys.has(key)) throw new SyntaxError("Duplicate JSON key: " + key);
        keys.add(key); at++; value(depth + 1);
        if (tokens[at] !== ",") break;
        at++;
      }
      at++;
    } else if (token === "[") {
      while (tokens[at] !== "]") { value(depth + 1); if (tokens[at] !== ",") break; at++; }
      at++;
    }
  }
  value(0);
  return parsed;
}
