import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
export function readBrowserAccess(dataDir) {
  const file = path.join(dataDir, "runtime", "browser-access.json"),
    stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Invalid browser access file");
  const { accessKey } = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!/^[A-Za-z0-9_-]{43}$/.test(accessKey))
    throw new Error("Invalid browser access key");
  return accessKey;
}
export function ensureBrowserAccess(dataDir) {
  const file = path.join(dataDir, "runtime", "browser-access.json");
  if (fs.existsSync(file)) return readBrowserAccess(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const accessKey = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(file, JSON.stringify({ accessKey }), { flag: "wx", mode: 0o600 });
  return accessKey;
}
export const browserUrl = (url, accessKey) => `${url}/#access=${accessKey}`;
export function appDataRoot(env = process.env) {
  return (
    env.LOCALAPPDATA ||
    env.XDG_DATA_HOME ||
    path.join(os.homedir(), ".local", "share")
  );
}
export function runtimePaths(env = process.env) {
  const root = env.ATK_DATA_DIR
    ? path.resolve(env.ATK_DATA_DIR)
    : path.join(appDataRoot(env), "AgentTeamKit", "Next");
  return {
    root,
    dataDir: path.join(root, "data"),
    runtimeDir: path.join(root, "runtime"),
    dbFile: path.join(root, "data", "next.db"),
  };
}
export function argumentsOf(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      result[key] =
        argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else result._.push(arg);
  }
  return result;
}
