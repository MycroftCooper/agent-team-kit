import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  extractChangelogSection,
  validateBilingualChangelog,
  findNpmCli,
} from "../packages/platform/src/updater.mjs";

const root = process.cwd();
const positional = [];
const flags = new Set();
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--")) flags.add(arg);
  else positional.push(arg);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const tag = `v${version}`;
const outDir = path.resolve(root, positional[0] ?? "artifacts/release");
const requireDesktop = flags.has("--require-desktop") || process.platform === "win32";

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
const tarballSha256 = crypto.createHash("sha256").update(tarballBytes).digest("hex");

const shaLines = [`${tarballSha256}  ${tarballName}`];
const assets = {
  tarball: {
    name: tarballName,
    sha256: tarballSha256,
    size: tarballBytes.length,
  },
};

const desktopExeName = `Agent-Team-Kit-Setup-${version}.exe`;
const desktopSourcePath = path.join(root, "artifacts/desktop/dist", desktopExeName);
let desktopOutPath = null;
if (fs.existsSync(desktopSourcePath)) {
  desktopOutPath = path.join(outDir, desktopExeName);
  fs.copyFileSync(desktopSourcePath, desktopOutPath);
  const exeBytes = fs.readFileSync(desktopOutPath);
  const exeSha256 = crypto.createHash("sha256").update(exeBytes).digest("hex");
  shaLines.push(`${exeSha256}  ${desktopExeName}`);
  assets.winExe = {
    name: desktopExeName,
    sha256: exeSha256,
    size: exeBytes.length,
  };
} else if (requireDesktop) {
  throw new Error(
    `Missing Windows desktop installer: ${desktopSourcePath}. Run "pnpm run desktop:build" first.`,
  );
}

const sha256Path = path.join(outDir, "SHA256SUMS.txt");
fs.writeFileSync(sha256Path, shaLines.join("\n") + "\n", "utf8");

const manifest = {
  format: "atk-release-manifest-1",
  name: pkg.name,
  version,
  tag,
  prerelease: version.includes("-"),
  asset: tarballName,
  sha256: tarballSha256,
  size: tarballBytes.length,
  assets,
  publishedAt: new Date().toISOString(),
};
const manifestPath = path.join(outDir, "release-manifest.json");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

const changelogPath = path.join(root, "CHANGELOG.md");
const changelog = fs.existsSync(changelogPath)
  ? fs.readFileSync(changelogPath, "utf8")
  : "";
const section = extractChangelogSection(changelog, version);
const validation = validateBilingualChangelog(section);
if (!validation.ok) {
  throw new Error(`CHANGELOG.md validation failed for ${version}: ${validation.reason}`);
}

const notes = [
  section,
  "",
  "---",
  "",
  "### 安装与更新（中文）",
  ...(assets.winExe
    ? [
        `- **Windows 桌面版（推荐）**：下载并双击 \`${desktopExeName}\` 安装（自带配套卸载程序，支持在应用「设置与运维 → 运行信息与更新」中通过 GitHub Release 自动检查并一键更新）。`,
      ]
    : []),
  `- **CLI / 跨平台 Node.js 版**：`,
  "```sh",
  `# 从 GitHub Release 全新安装`,
  `npm install -g ./${tarballName}`,
  "",
  "# 或自动更新已有安装",
  "atk update",
  "```",
  "",
  "### Install & Update (English)",
  ...(assets.winExe
    ? [
        `- **Windows Desktop (Recommended)**: Download and double-click \`${desktopExeName}\` (includes a companion Windows uninstaller and built-in GitHub Release auto-updates under **Settings & operations → Application & updates**).`,
      ]
    : []),
  `- **CLI / Cross-platform Node.js**:`,
  "```sh",
  `# Fresh install from GitHub Release`,
  `npm install -g ./${tarballName}`,
  "",
  "# Or auto-update an existing installation",
  "atk update",
  "```",
  "",
  "### SHA-256",
  ...shaLines.map((line) => `- \`${line}\``),
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
      desktopInstaller: desktopOutPath,
      sha256: tarballSha256,
      desktopSha256: assets.winExe?.sha256 ?? null,
      sha256File: sha256Path,
      manifestFile: manifestPath,
      notesFile: notesPath,
    },
    null,
    2,
  ),
);
