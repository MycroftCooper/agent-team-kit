// Runtime paths for the ATK local service.
//
// ADR-008: the session token lives in a user-scoped directory, never in the
// repository and never in a system-wide path. On Windows that is
// %LOCALAPPDATA%\AgentTeamKit\runtime\session-token (the contract in
// docs/architecture/m1-contracts.md §2); other platforms get the usual data
// directory so the same code runs in CI.
import os from "node:os";
import path from "node:path";

/** Base per-user application-data directory. */
export function appDataRoot(env = process.env) {
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    return localAppData && localAppData.trim() !== "" ? localAppData : path.join(os.homedir(), "AppData", "Local");
  }
  const xdgData = env.XDG_DATA_HOME;
  if (xdgData && xdgData.trim() !== "") return xdgData;
  return path.join(os.homedir(), ".local", "share");
}

/**
 * Every path the backend writes. Kept in one place so `doctor` can report the
 * same values `serve`/`migrate` actually use.
 */
export function runtimePaths(env = process.env) {
  const root = path.join(appDataRoot(env), "AgentTeamKit");
  return {
    root,
    dataDir: path.join(root, "data"),
    runtimeDir: path.join(root, "runtime"),
    dbFile: path.join(root, "data", "atk.db"),
    tokenFile: path.join(root, "runtime", "session-token"),
  };
}
