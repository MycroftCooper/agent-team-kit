import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createContext } from "../lib/context.mjs";
import { PLUGIN_SOURCE, cordisPatch, resolvePluginDir, run, substitute } from "../lib/plugin.mjs";
import { createProject, memoryLogger } from "./helpers.mjs";

const CUSTOM_PLUGIN = {
  id: "demo-board",
  route: "/demo-board",
  title: "Demo Board",
  tabKind: "demoBoard",
  commandId: "demo.board",
  dir: "tools/demo-board",
};

test("substitute replaces every identity token", async () => {
  const { root, configPath } = await createProject({ config: { plugin: CUSTOM_PLUGIN } });
  const ctx = await createContext({ cwd: root, configPath });
  const text = substitute("__PLUGIN_ID__ __PLUGIN_ROUTE__ __PLUGIN_TITLE__ __PLUGIN_TAB_KIND__ __PLUGIN_COMMAND_ID__ __PLUGIN_PACKAGE__", ctx.config);
  assert.equal(text, "demo-board /demo-board Demo Board demoBoard demo.board dsh-demo-board");
  assert.ok(resolvePluginDir(ctx.config).endsWith(path.join("tools", "demo-board")));
});

test("cordisPatch keeps the required insert wrapper", async () => {
  const { root, configPath } = await createProject({ config: { plugin: CUSTOM_PLUGIN } });
  const ctx = await createContext({ cwd: root, configPath });
  const patch = cordisPatch(ctx.config);
  assert.match(patch, /- insert:/);
  assert.match(patch, /id: demo-board/);
  assert.match(patch, new RegExp(`workspace: ${root.replace(/\\/g, "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("plugin sync copies and rewrites the plugin package, verify passes, tampering fails", async () => {
  const sourceExists = await readFile(path.join(PLUGIN_SOURCE, "package.json"), "utf8").then(
    () => true,
    () => false,
  );
  assert.ok(sourceExists, "bundled plugin source is missing");

  const { root, configPath } = await createProject({ config: { plugin: CUSTOM_PLUGIN } });
  const log = memoryLogger();
  const ctx = await createContext({ cwd: root, configPath, logger: log });
  assert.equal(await run(["sync", "--force"], ctx), 0);

  const dir = path.join(root, "tools", "demo-board");
  const manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  assert.equal(manifest.name, "dsh-demo-board");
  const host = await readFile(path.join(dir, "lib", "index.js"), "utf8");
  assert.ok(!host.includes("__PLUGIN_ID__"), "tokens must be substituted in the host bundle");
  assert.ok(host.includes("demo-board"));
  const patch = await readFile(path.join(dir, "cordis.patch.yml"), "utf8");
  assert.match(patch, /- insert:/);

  assert.equal(await run(["verify"], ctx), 0, "fresh copy must verify");

  await writeFile(path.join(dir, "lib", "index.js"), "// tampered\n", "utf8");
  const tampered = memoryLogger();
  const ctx2 = await createContext({ cwd: root, configPath, logger: tampered });
  assert.equal(await run(["verify"], ctx2), 1, "tampered copy must fail verification");
  assert.match(tampered.errorText(), /outdated/);
});
