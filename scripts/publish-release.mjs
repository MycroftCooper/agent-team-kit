import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

const repo = process.env.ATK_RELEASE_REPO ?? "MycroftCooper/agent-team-kit";
const apiBase = (process.env.ATK_RELEASE_API ?? "https://api.github.com").replace(/\/+$/, "");
const uploadBase = (process.env.ATK_RELEASE_UPLOAD_API ?? "https://uploads.github.com").replace(/\/+$/, "");
const artifactDir = path.resolve(root, positional[0] ?? "artifacts/release");
const dryRun = flags.has("--dry-run");
const deleteExisting = flags.has("--delete-existing");
const deleteOnly = flags.has("--delete-only");
const allowPrerelease = flags.has("--allow-prerelease");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const tag = `v${version}`;
const isPrerelease = version.includes("-");

if (isPrerelease && !allowPrerelease) {
  console.error(`Refusing to publish prerelease ${tag} without --allow-prerelease.`);
  process.exit(2);
}

function resolveToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const filled = spawnSync(
    "git",
    ["credential", "fill"],
    { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8", windowsHide: true },
  );
  const match = /^password=(.+)$/m.exec(filled.stdout ?? "");
  if (match) return match[1].trim();
  return null;
}

const token = resolveToken();
if (!token) {
  console.error(
    "No GitHub token. Set GH_TOKEN, or sign in so `git credential fill` can return one.",
  );
  process.exit(2);
}

const headers = {
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "user-agent": "atk-release-publisher",
  "x-github-api-version": "2022-11-28",
};

async function api(method, endpoint, { body, contentType, url } = {}) {
  const response = await fetch(url ?? apiBase + endpoint, {
    method,
    headers: contentType ? { ...headers, "content-type": contentType } : headers,
    body,
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return { ok: response.ok, status: response.status, payload };
}

function requiredAssets() {
  const names = [
    `Agent-Team-Kit-Setup-${version}.exe`,
    `agent-team-kit-${version}.tgz`,
    "SHA256SUMS.txt",
    "release-manifest.json",
  ];
  const missing = names.filter((name) => !fs.existsSync(path.join(artifactDir, name)));
  if (missing.length) {
    console.error(
      `Missing release artifacts in ${artifactDir}:\n  ${missing.join("\n  ")}\n` +
        `Run: node scripts/build-desktop.mjs && node scripts/prepare-release.mjs ${path.relative(root, artifactDir)}`,
    );
    process.exit(1);
  }
  const notesPath = path.join(artifactDir, "RELEASE_NOTES.md");
  if (!fs.existsSync(notesPath)) {
    console.error(`Missing ${notesPath}. Run scripts/prepare-release.mjs first.`);
    process.exit(1);
  }
  return { names, notes: fs.readFileSync(notesPath, "utf8") };
}

async function findRelease() {
  const { ok, status, payload } = await api("GET", `/repos/${repo}/releases/tags/${tag}`);
  if (ok) return payload;
  if (status === 404) return null;
  throw new Error(`Release lookup failed (${status}): ${JSON.stringify(payload)}`);
}

async function deleteRelease(release) {
  const result = await api("DELETE", `/repos/${repo}/releases/${release.id}`);
  if (!result.ok && result.status !== 404) {
    throw new Error(`Could not delete release (${result.status}): ${JSON.stringify(result.payload)}`);
  }
  console.log(`Deleted existing GitHub Release ${tag} (id ${release.id}).`);
}

async function deleteTag() {
  const result = await api("DELETE", `/repos/${repo}/git/refs/tags/${tag}`);
  if (result.ok) {
    console.log(`Deleted remote tag ${tag}.`);
  } else if (result.status !== 404 && result.status !== 422) {
    throw new Error(`Could not delete tag (${result.status}): ${JSON.stringify(result.payload)}`);
  } else {
    console.log(`Remote tag ${tag} was already absent.`);
  }
}

async function upsertRelease(notes) {
  const existing = await findRelease();
  if (existing) {
    const result = await api("PATCH", `/repos/${repo}/releases/${existing.id}`, {
      body: JSON.stringify({
        name: tag,
        body: notes,
        prerelease: isPrerelease,
        draft: false,
      }),
      contentType: "application/json",
    });
    if (!result.ok) {
      throw new Error(`Could not update release (${result.status}): ${JSON.stringify(result.payload)}`);
    }
    console.log(`Updated GitHub Release ${tag} (id ${existing.id}).`);
    return result.payload;
  }
  const created = await api("POST", `/repos/${repo}/releases`, {
    body: JSON.stringify({
      tag_name: tag,
      name: tag,
      body: notes,
      prerelease: isPrerelease,
      draft: false,
    }),
    contentType: "application/json",
  });
  if (!created.ok) {
    throw new Error(`Could not create release (${created.status}): ${JSON.stringify(created.payload)}`);
  }
  console.log(`Created GitHub Release ${tag} (id ${created.payload.id}).`);
  return created.payload;
}

async function replaceAssets(release, names) {
  const existing = Array.isArray(release.assets) ? release.assets : [];
  for (const asset of existing) {
    if (!names.includes(asset.name)) continue;
    const removed = await api("DELETE", `/repos/${repo}/releases/assets/${asset.id}`);
    if (!removed.ok && removed.status !== 404) {
      throw new Error(`Could not replace asset ${asset.name} (${removed.status})`);
    }
    console.log(`Removed stale asset ${asset.name}.`);
  }
  const uploadEndpoint = release.upload_url
    ? release.upload_url.replace(/\{[^}]*\}$/, "")
    : `${uploadBase}/repos/${repo}/releases/${release.id}/assets`;
  const uploaded = [];
  for (const name of names) {
    const bytes = fs.readFileSync(path.join(artifactDir, name));
    const contentType = name.endsWith(".exe")
      ? "application/vnd.microsoft.portable-executable"
      : name.endsWith(".tgz")
        ? "application/gzip"
        : name.endsWith(".json")
          ? "application/json"
          : "text/plain; charset=utf-8";
    const result = await api(
      "POST",
      null,
      {
        url: `${uploadEndpoint}?name=${encodeURIComponent(name)}`,
        body: bytes,
        contentType,
      },
    );
    if (!result.ok) {
      throw new Error(`Upload failed for ${name} (${result.status}): ${JSON.stringify(result.payload)}`);
    }
    uploaded.push({ name, size: bytes.length, url: result.payload.browser_download_url });
    console.log(
      `Uploaded ${name} (${(bytes.length / (1024 * 1024)).toFixed(1)} MiB).`,
    );
  }
  return uploaded;
}

if (deleteOnly) {
  const current = await findRelease();
  if (current) {
    await deleteRelease(current);
  } else {
    console.log(`GitHub Release ${tag} was already absent.`);
  }
  await deleteTag();
  process.exit(0);
}

const { names, notes } = requiredAssets();
console.log(`Preparing GitHub Release ${tag} for ${repo} from ${artifactDir}`);
if (dryRun) {
  console.log("--dry-run: validated local artifacts, no API changes made.");
  console.log(`  release: ${names.join(", ")}`);
  process.exit(0);
}

const current = await findRelease();
if (current && deleteExisting) {
  await deleteRelease(current);
  await deleteTag();
} else if (current) {
  console.log(`Release ${tag} already exists; refreshing notes and replacing matching assets.`);
}

const release = await upsertRelease(notes);
const uploaded = await replaceAssets(release, names);
const final = await findRelease();

console.log(
  JSON.stringify(
    {
      tag,
      url: final?.html_url ?? `https://github.com/${repo}/releases/tag/${tag}`,
      prerelease: isPrerelease,
      assets: final?.assets?.map((a) => ({ name: a.name, size: a.size })) ?? uploaded,
    },
    null,
    2,
  ),
);
