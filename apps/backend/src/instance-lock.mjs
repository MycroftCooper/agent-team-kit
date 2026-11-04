import fs from "node:fs";
import path from "node:path";
import { requireThat } from "../../../packages/contracts/src/index.mjs";
import { atomicJson } from "../../../packages/project-files/src/index.mjs";
export function acquireInstance(dataDir, instanceId) {
  const file = path.join(dataDir, "runtime", "backend.lock");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    let old;
    try {
      old = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      requireThat(
        false,
        "INSTANCE_UNCERTAIN",
        "Backend ownership file is corrupt; inspect the old service before removing it",
        409,
      );
    }
    requireThat(
      Number.isInteger(old.pid) && old.pid > 0,
      "INSTANCE_UNCERTAIN",
      "Invalid backend ownership file",
      409,
    );
    let alive = true;
    try {
      process.kill(old.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") alive = false;
    }
    requireThat(
      !alive,
      "INSTANCE_ACTIVE",
      "This data directory already has a live backend",
      409,
    );
    fs.unlinkSync(file);
  }
  const fd = fs.openSync(file, "wx", 0o600);
  let info = {
    pid: process.pid,
    instanceId,
    startedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(fd, JSON.stringify(info));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return {
    update(extra) {
      info = { ...info, ...extra };
      atomicJson(file, info);
    },
    release() {
      try {
        if (JSON.parse(fs.readFileSync(file, "utf8")).instanceId === instanceId)
          fs.unlinkSync(file);
      } catch {}
    },
  };
}
