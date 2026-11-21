import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  extractChangelogSection,
  findNpmCli,
} from "../packages/platform/src/updater.mjs";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const tag = `v${version}`;
const outDir = path.resolve(root, process.argv[2] ?? "artifacts/release");

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const npmCli = findNpmCli();
const packRaw = execFileSync(
  process.execPath,
  [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", outDir],
  { cwd: root, encoding: "utf8", windowsHide: true },
);
const packed = JSON.parse(packRaw)[0];
const tarballName = packed.filename;
const tarballPath = path.join(outDir, tarballName);
const tarballBytes = fs.readFileSync(tarballPath);
const sha256 = crypto.createHash("sha256").update(tarballBytes).digest("hex");

const sha256Path = path.join(outDir, "SHA256SUMS.txt");
fs.writeFileSync(sha256Path, `${sha256}  ${tarballName}\n`, "utf8");

const manifest = {
  format: "atk-release-manifest-1",
  name: pkg.name,
  version,
  tag,
  prerelease: version.includes("-"),
  asset: tarballName,
  sha256,
  size: tarballBytes.length,
  publishedAt: new Date().toISOString(),
};
const manifestPath = path.join(outDir, "release-manifest.json");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

const changelogPath = path.join(root, "CHANGELOG.md");
const changelog = fs.existsSync(changelogPath)
  ? fs.readFileSync(changelogPath, "utf8")
  : "";
const section = extractChangelogSection(changelog, version);
const notes = [
  section || `Release ${tag}`,
  "",
  "### Install / Update",
  "```sh",
  `# Fresh install from GitHub Release`,
  `npm install -g ./${tarballName}`,
  "",
  "# Or auto-update an existing installation",
  "atk update",
  "```",
  "",
  `SHA-256 (\`${tarballName}\`): \`${sha256}\``,
].join("\n");
const notesPath = path.join(outDir, "RELEASE_NOTES.md");
fs.writeFileSync(notesPath, notes + "\n", "utf8");

console.log(
  JSON.stringify(
    {
      outDir,
      version,
      tag,
      tarball: tarballPath,
      sha256,
      sha256File: sha256Path,
      manifestFile: manifestPath,
      notesFile: notesPath,
    },
    null,
    2,
  ),
);
