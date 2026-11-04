import os from "node:os";
import path from "node:path";
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
