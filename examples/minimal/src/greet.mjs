// Tiny demo module for examples/minimal. No third-party dependencies.
export function greet(name) {
  const who = String(name ?? "").trim();
  if (!who) return "Hello, stranger!";
  return `Hello, ${who}!`;
}
