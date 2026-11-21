import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const DEFAULT_UPDATE_REPO = "MycroftCooper/agent-team-kit";
export const DEFAULT_GITHUB_API = "https://api.github.com";

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const SAFE_ASSET_RE = /^[A-Za-z0-9._-]+\.tgz$/;

export function parseSemver(input) {
  if (typeof input !== "string") return null;
  const match = SEMVER_RE.exec(input.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) {
    throw new Error(`Invalid semantic version comparison: ${a} vs ${b}`);
  }
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const len = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < len; i++) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    if (lNum && rNum) return Number(l) > Number(r) ? 1 : -1;
    if (lNum) return -1;
    if (rNum) return 1;
    return l > r ? 1 : -1;
  }
  return 0;
}

export function detectInstallMode(packageRoot) {
  try {
    return fs.existsSync(path.join(packageRoot, ".git")) ? "source" : "package";
  } catch {
    return "package";
  }
}

export function parseSha256Sums(text, fileName) {
  if (typeof text !== "string" || !fileName) return null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
    if (!match) continue;
    const candidate = match[2].trim().replace(/^\.\//, "");
    if (candidate === fileName || path.basename(candidate) === fileName) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

export function extractChangelogSection(changelogText, version) {
  if (typeof changelogText !== "string" || !version) return "";
  const normalized = version.replace(/^v/, "");
  const lines = changelogText.split(/\r?\n/);
  let capturing = false;
  const out = [];
  for (const line of lines) {
    const heading = /^##\s+v?([^\s(]+)/.exec(line);
    if (heading) {
      if (capturing) break;
      if (heading[1] === normalized) {
        capturing = true;
        continue;
      }
    } else if (capturing) {
      out.push(line);
    }
  }
  return out.join("\n").trim();
}

function assertAllowedDownloadUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol === "https:") return url;
  if (
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
  ) {
    return url;
  }
  throw new Error(`Refusing insecure update URL: ${rawUrl}`);
}

function releaseHeaders() {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "agent-team-kit-updater",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

function pickReleaseAsset(release, version) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const expectedName = `agent-team-kit-${version}.tgz`;
  const tarball =
    assets.find((a) => a?.name === expectedName) ??
    assets.find((a) => typeof a?.name === "string" && /^agent-team-kit-.*\.tgz$/.test(a.name)) ??
    assets.find((a) => typeof a?.name === "string" && a.name.endsWith(".tgz"));
  if (!tarball || typeof tarball.browser_download_url !== "string") {
    return null;
  }
  if (!SAFE_ASSET_RE.test(tarball.name)) {
    throw new Error(`Unsafe release asset name: ${tarball.name}`);
  }
  const sha256Asset = assets.find((a) => a?.name === "SHA256SUMS.txt");
  const manifestAsset = assets.find((a) => a?.name === "release-manifest.json");
  return {
    name: tarball.name,
    url: tarball.browser_download_url,
    size: typeof tarball.size === "number" ? tarball.size : null,
    sha256Url: typeof sha256Asset?.browser_download_url === "string" ? sha256Asset.browser_download_url : null,
    manifestUrl: typeof manifestAsset?.browser_download_url === "string" ? manifestAsset.browser_download_url : null,
  };
}

export async function checkForUpdate({
  currentVersion,
  repo = process.env.ATK_UPDATE_REPO || DEFAULT_UPDATE_REPO,
  apiBase = process.env.ATK_UPDATE_API_BASE || DEFAULT_GITHUB_API,
  includePrerelease = false,
  fetchImpl = fetch,
  timeoutMs = 15000,
}) {
  if (!parseSemver(currentVersion)) {
    throw new Error(`Invalid current version: ${currentVersion}`);
  }
  const base = apiBase.replace(/\/+$/, "");
  const endpoint = includePrerelease
    ? `${base}/repos/${repo}/releases?per_page=10`
    : `${base}/repos/${repo}/releases/latest`;
  assertAllowedDownloadUrl(endpoint);
  const response = await fetchImpl(endpoint, {
    headers: releaseHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404) {
    return {
      currentVersion,
      latestVersion: currentVersion,
      tagName: null,
      updateAvailable: false,
      prerelease: false,
      publishedAt: null,
      releaseUrl: `https://github.com/${repo}/releases`,
      notes: "",
      asset: null,
      checkedAt: new Date().toISOString(),
    };
  }
  if (!response.ok) {
    throw new Error(`GitHub Release check failed (${response.status})`);
  }
  const payload = await response.json();
  let release = payload;
  if (Array.isArray(payload)) {
    release = payload.find((item) => item && !item.draft) ?? null;
  }
  if (!release || release.draft || typeof release.tag_name !== "string") {
    return {
      currentVersion,
      latestVersion: currentVersion,
      tagName: null,
      updateAvailable: false,
      prerelease: false,
      publishedAt: null,
      releaseUrl: `https://github.com/${repo}/releases`,
      notes: "",
      asset: null,
      checkedAt: new Date().toISOString(),
    };
  }
  const latestVersion = release.tag_name.replace(/^v/, "");
  if (!parseSemver(latestVersion)) {
    throw new Error(`Release tag is not a valid semver version: ${release.tag_name}`);
  }
  const updateAvailable = compareSemver(latestVersion, currentVersion) > 0;
  return {
    currentVersion,
    latestVersion,
    tagName: release.tag_name,
    updateAvailable,
    prerelease: Boolean(release.prerelease),
    publishedAt: typeof release.published_at === "string" ? release.published_at : null,
    releaseUrl:
      typeof release.html_url === "string"
        ? release.html_url
        : `https://github.com/${repo}/releases/tag/${release.tag_name}`,
    notes: typeof release.body === "string" ? release.body.slice(0, 8000) : "",
    asset: pickReleaseAsset(release, latestVersion),
    checkedAt: new Date().toISOString(),
  };
}

async function resolveExpectedSha256(asset, fetchImpl, timeoutMs) {
  if (asset.manifestUrl) {
    assertAllowedDownloadUrl(asset.manifestUrl);
    const res = await fetchImpl(asset.manifestUrl, {
      headers: releaseHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const manifest = await res.json();
      if (
        manifest &&
        manifest.asset === asset.name &&
        typeof manifest.sha256 === "string" &&
        /^[a-fA-F0-9]{64}$/.test(manifest.sha256)
      ) {
        return manifest.sha256.toLowerCase();
      }
    }
  }
  if (asset.sha256Url) {
    assertAllowedDownloadUrl(asset.sha256Url);
    const res = await fetchImpl(asset.sha256Url, {
      headers: releaseHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const parsed = parseSha256Sums(await res.text(), asset.name);
      if (parsed) return parsed;
    }
  }
  return null;
}

export async function downloadAndVerifyRelease({
  release,
  destDir,
  fetchImpl = fetch,
  timeoutMs = 120000,
  requireChecksum = true,
}) {
  const asset = release?.asset;
  if (!asset || !asset.url || !SAFE_ASSET_RE.test(asset.name)) {
    throw new Error("Release does not include a downloadable tarball asset.");
  }
  assertAllowedDownloadUrl(asset.url);
  const expectedSha = await resolveExpectedSha256(asset, fetchImpl, Math.min(timeoutMs, 15000));
  if (requireChecksum && !expectedSha) {
    throw new Error("Release checksum metadata (SHA256SUMS.txt or release-manifest.json) is missing.");
  }
  fs.mkdirSync(destDir, { recursive: true });
  const finalPath = path.join(destDir, asset.name);
  const partPath = `${finalPath}.part-${Date.now()}`;
  const response = await fetchImpl(asset.url, {
    headers: { "user-agent": "agent-team-kit-updater" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Failed to download update package (${response.status})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const actualSha = crypto.createHash("sha256").update(buffer).digest("hex");
  if (expectedSha && actualSha !== expectedSha) {
    throw new Error(
      `UPDATE_CHECKSUM_MISMATCH: expected ${expectedSha}, got ${actualSha}`,
    );
  }
  fs.writeFileSync(partPath, buffer);
  fs.renameSync(partPath, finalPath);
  return {
    filePath: finalPath,
    sha256: actualSha,
    verified: Boolean(expectedSha),
    size: buffer.length,
  };
}

export function findNpmCli() {
  const executableDir = path.dirname(process.execPath);
  const candidate = [
    process.env.npm_execpath,
    path.join(executableDir, "node_modules/npm/bin/npm-cli.js"),
    path.join(executableDir, "../lib/node_modules/npm/bin/npm-cli.js"),
    "/usr/share/nodejs/npm/bin/npm-cli.js",
  ].find((p) => p && fs.existsSync(p));
  if (!candidate) {
    throw new Error("npm CLI was not found alongside Node.js.");
  }
  return candidate;
}

export function installUpdateTarball({
  tarballPath,
  prefix,
  npmCli = findNpmCli(),
  execImpl = execFileSync,
  timeoutMs = 180000,
}) {
  if (!tarballPath || !fs.existsSync(tarballPath)) {
    throw new Error(`Update tarball not found: ${tarballPath}`);
  }
  const args = [npmCli, "install", "--global"];
  if (prefix) args.push("--prefix", prefix);
  args.push("--no-audit", "--no-fund", tarballPath);
  const output = execImpl(process.execPath, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
  });
  return {
    installed: true,
    tarballPath,
    output: typeof output === "string" ? output.trim() : "",
  };
}
