import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
const root = path.resolve("artifacts", "test-temp");
fs.mkdirSync(root, { recursive: true });
const files = fs
  .readdirSync("test")
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => path.join("test", f));
const concurrency =
  process.env.ATK_TEST_CONCURRENCY ?? (process.platform === "win32" ? "4" : "");
const child = spawn(
  process.execPath,
  [
    "--test",
    ...(concurrency ? [`--test-concurrency=${concurrency}`] : []),
    "--test-reporter=tap",
    ...files,
  ],
  {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, TEMP: root, TMP: root, ATK_TEST_ROOT: root },
  },
);
child.on("error", (e) => {
  console.error(e);
  process.exitCode = 1;
});
child.on("exit", (code) => process.exit(code ?? 1));
