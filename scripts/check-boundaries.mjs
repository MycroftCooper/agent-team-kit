import fs from "node:fs";
import path from "node:path";
const roots = {
  web: "apps/web",
  backend: "apps/backend",
  launcher: "apps/launcher",
  "agent-cli": "apps/agent-cli",
  contracts: "packages/contracts",
  domain: "packages/domain",
  database: "packages/database",
  "scheduler-core": "packages/scheduler-core",
  "project-files": "packages/project-files",
  "agent-client": "packages/agent-client",
  platform: "packages/platform",
};
const allowed = {
  web: ["contracts"],
  backend: [
    "contracts",
    "domain",
    "database",
    "scheduler-core",
    "project-files",
    "platform",
  ],
  launcher: ["contracts", "platform"],
  "agent-cli": ["agent-client", "platform"],
  contracts: [],
  domain: ["contracts", "scheduler-core"],
  database: ["contracts"],
  "scheduler-core": [],
  "project-files": ["domain", "contracts"],
  "agent-client": [],
  platform: [],
};
const edges = new Set(),
  errors = [];
function scan(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "test"].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (/\.(mjs|ts|tsx)$/.test(file) && !file.endsWith(".d.ts")) {
      const content = fs.readFileSync(file, "utf8");
      const from = Object.keys(roots).find((n) =>
        file.replaceAll("\\", "/").startsWith(roots[n] + "/"),
      );
      for (const m of content.matchAll(
        /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g,
      )) {
        const spec = m[1];
        let target;
        if (spec.startsWith(".")) {
          const resolved = path.resolve(path.dirname(file), spec);
          target = Object.keys(roots).find((n) =>
            resolved.startsWith(path.resolve(roots[n]) + path.sep),
          );
        } else if (spec.startsWith("@atk/"))
          target = spec.slice(5).split("/")[0];
        if (target && target !== from) {
          edges.add(`${from}->${target}`);
          if (!allowed[from]?.includes(target))
            errors.push(`${file}: forbidden ${from} -> ${target}`);
        }
      }
    }
  }
}
for (const root of Object.values(roots)) scan(root);
const visiting = new Set(),
  visited = new Set();
function visit(n) {
  if (visiting.has(n)) throw new Error(`Dependency cycle: ${n}`);
  if (visited.has(n)) return;
  visiting.add(n);
  for (const edge of edges) {
    const [a, b] = edge.split("->");
    if (a === n) visit(b);
  }
  visiting.delete(n);
  visited.add(n);
}
try {
  for (const n of Object.keys(roots)) visit(n);
} catch (e) {
  errors.push(e.message);
}
for (const obsolete of [
  "apps/runtime-host/cli.mjs",
  "apps/scheduler/cli.mjs",
  "packages/runtime-sdk/package.json",
  "packages/workspace/package.json",
  "lib/dispatch.mjs",
  "plugins/dsh-agent-board/package.json",
])
  if (fs.existsSync(obsolete))
    errors.push(`Obsolete production entry exists: ${obsolete}`);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `PASS: ${Object.keys(roots).length} modules, ${edges.size} edges, no cycles, no obsolete runtime entries`,
  );
