import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { requireThat } from "../../../packages/contracts/src/index.mjs";
import {
  sha,
  canonical,
  inside,
  atomicJson,
} from "../../../packages/project-files/src/index.mjs";
function idle(service) {
  requireThat(
    !service.automations.busy() && service.store
      .all("runs")
      .every(
        (r) => !["RUNNING", "QUARANTINED", "STOP_REQUESTED"].includes(r.status),
      ),
    "BACKUP_BUSY",
    "Stop and reconcile all active or uncertain runs first",
    409,
  );
  requireThat(
    service.store.all("locks").length === 0,
    "BACKUP_BUSY",
    "Resolve file locks first",
    409,
  );
}
function files(root, relative = "", out = {}) {
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    const rel = path.join(relative, name),
      full = path.join(root, rel);
    requireThat(
      !fs.lstatSync(full).isSymbolicLink(),
      "BACKUP_SYMLINK",
      "Backup does not follow symlinks",
      409,
    );
    if (fs.statSync(full).isDirectory()) files(root, rel, out);
    else out[rel.replaceAll("\\", "/")] = sha(fs.readFileSync(full));
  }
  return out;
}
function resourceFiles(root) {
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  requireThat(!stat || (stat.isDirectory() && !stat.isSymbolicLink()),
    "BACKUP_SYMLINK", "Resource backup requires a real directory", 409);
  return stat ? files(root, "", Object.create(null)) : {};
}
export function backup(service, destination) {
  idle(service);
  service.flushDocuments();
  const dest = canonical(
    destination ??
      path.join(
        service.dataDir,
        "backups",
        `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      ),
  );
  requireThat(
    !fs.existsSync(dest),
    "BACKUP_EXISTS",
    "Choose a new backup directory",
    409,
  );
  const projects = service.store.all("projects");
  for (const p of projects)
    requireThat(
      fs.existsSync(p.docsRoot),
      "PROJECT_UNAVAILABLE",
      "Project artifacts are unavailable; a complete backup cannot be created",
      409,
      { projectId: p.id },
    );
  for (const r of service.store.all("runs"))
    if (r.artifact) service.artifact(r.id);
  requireThat(
    !projects.some((p) => inside(p.docsRoot, dest)) && !inside(service.resources.root, dest),
    "INVALID_PATH",
    "Backup must be outside project data and team resource directories",
  );
  fs.mkdirSync(dest, { recursive: true });
  service.store.snapshot(path.join(dest, "next.db"));
  if (Object.keys(resourceFiles(service.resources.root)).length)
    fs.cpSync(service.resources.root, path.join(dest, "resources"), { recursive: true });
  const entries = [];
  for (const p of projects) {
    const source = path.join(dest, "projects", p.id);
    if (fs.existsSync(p.docsRoot)) {
      files(p.docsRoot);
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.cpSync(p.docsRoot, source, { recursive: true });
    }
    entries.push({
      id: p.id,
      root: p.root,
      docsRoot: p.docsRoot,
      present: fs.existsSync(source),
    });
  }
  const manifest = {
    format: "atk-next-backup-1",
    createdAt: new Date().toISOString(),
    projects: entries,
    files: files(dest),
  };
  atomicJson(path.join(dest, "manifest.json"), manifest);
  return { destination: dest, manifest };
}
export function restore(service, source) {
  idle(service);
  const root = canonical(source),
    manifest = JSON.parse(
      fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
    );
  requireThat(
    manifest.format === "atk-next-backup-1",
    "INVALID_BACKUP",
    "Invalid backup format",
  );
  for (const [rel, hash] of Object.entries(manifest.files)) {
    const full = canonical(path.resolve(root, rel));
    requireThat(
      inside(root, full) && sha(fs.readFileSync(full)) === hash,
      "INVALID_BACKUP",
      "Backup file is missing or modified",
      409,
      { path: rel },
    );
  }
  const resourceSource = path.join(root, "resources"),
    resources = resourceFiles(resourceSource);
  requireThat(Object.entries(resources).every(([rel, hash]) => manifest.files[`resources/${rel}`] === hash),
    "INVALID_BACKUP", "Backup contains unverified team resource files", 409);
  const check = new DatabaseSync(path.join(root, "next.db"), {
    readOnly: true,
  });
  try {
    requireThat(
      check.prepare("SELECT value FROM app_meta WHERE key='format'").get()
        ?.value === "atk-next-1",
      "INVALID_BACKUP",
      "Unsupported backup database",
    );
    const savedProjects = check
      .prepare("SELECT data FROM projects")
      .all()
      .map((row) => JSON.parse(row.data));
    requireThat(
      Array.isArray(manifest.projects) &&
        manifest.projects.length === savedProjects.length &&
        manifest.projects.every((p) =>
          savedProjects.some(
            (saved) =>
              saved.id === p.id &&
              saved.root === p.root &&
              saved.docsRoot === p.docsRoot,
          ),
        ),
      "INVALID_BACKUP",
      "Project paths do not match the backed up database",
      409,
    );
  } finally {
    check.close();
  }
  const safety = backup(service);
  for (const p of manifest.projects) {
    requireThat(
      fs.existsSync(p.root),
      "PROJECT_UNAVAILABLE",
      "Relocate project directories before restoring",
      409,
      { root: p.root },
    );
    if (p.present) {
      fs.mkdirSync(p.docsRoot, { recursive: true });
      fs.cpSync(path.join(root, "projects", p.id), p.docsRoot, {
        recursive: true,
      });
    }
  }
  if (Object.keys(resources).length)
    fs.cpSync(resourceSource, service.resources.root, { recursive: true });
  service.store.close();
  try {
    for (const suffix of ["-wal", "-shm"])
      if (fs.existsSync(service.store.file + suffix))
        fs.unlinkSync(service.store.file + suffix);
    const next = service.store.file + ".restore";
    fs.copyFileSync(path.join(root, "next.db"), next);
    fs.renameSync(next, service.store.file);
  } finally {
    service.store.reopen();
  }
  service.automations.seedAll();
  service.signals.emit("restore");
  return { restored: true, safetyBackup: safety.destination };
}
