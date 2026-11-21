import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import {
  compareSemver,
  parseSha256Sums,
  extractChangelogSection,
  checkForUpdate,
  downloadAndVerifyRelease,
} from "../packages/platform/src/updater.mjs";
import { createServer } from "../apps/backend/src/server.mjs";
import { readBrowserAccess } from "../packages/platform/src/index.mjs";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startMockReleaseServer({
  tagName = "v0.0.2",
  assetContent = Buffer.from("mock-tarball-payload"),
  tamperChecksum = false,
  includeChecksum = true,
} = {}) {
  const version = tagName.replace(/^v/, "");
  const assetName = `agent-team-kit-${version}.tgz`;
  const realSha = crypto.createHash("sha256").update(assetContent).digest("hex");
  const advertisedSha = tamperChecksum ? "0".repeat(64) : realSha;

  const server = http.createServer((req, res) => {
    const host = `http://127.0.0.1:${server.address().port}`;
    if (req.url === "/repos/MycroftCooper/agent-team-kit/releases/latest") {
      const assets = [
        {
          name: assetName,
          size: assetContent.length,
          browser_download_url: `${host}/download/${assetName}`,
        },
      ];
      if (includeChecksum) {
        assets.push(
          {
            name: "SHA256SUMS.txt",
            size: 100,
            browser_download_url: `${host}/download/SHA256SUMS.txt`,
          },
          {
            name: "release-manifest.json",
            size: 200,
            browser_download_url: `${host}/download/release-manifest.json`,
          },
        );
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          tag_name: tagName,
          draft: false,
          prerelease: version.includes("-"),
          published_at: "2026-11-22T00:00:00Z",
          html_url: `https://github.com/MycroftCooper/agent-team-kit/releases/tag/${tagName}`,
          body: `Release notes for ${tagName}`,
          assets,
        }),
      );
      return;
    }
    if (req.url === `/download/${assetName}`) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(assetContent);
      return;
    }
    if (req.url === "/download/SHA256SUMS.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${advertisedSha}  ${assetName}\n`);
      return;
    }
    if (req.url === "/download/release-manifest.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          format: "atk-release-manifest-1",
          version,
          tag: tagName,
          asset: assetName,
          sha256: advertisedSha,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    realSha,
    assetName,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("compareSemver orders stable and prerelease versions", () => {
  assert.equal(compareSemver("0.0.1", "0.0.1"), 0);
  assert.equal(compareSemver("0.0.2", "0.0.1"), 1);
  assert.equal(compareSemver("0.0.1", "0.0.2"), -1);
  assert.equal(compareSemver("0.0.1", "0.0.1-alpha.1"), 1);
  assert.equal(compareSemver("0.0.1-alpha.2", "0.0.1-alpha.1"), 1);
  assert.equal(compareSemver("v1.0.0", "0.9.9"), 1);
});

test("parseSha256Sums and extractChangelogSection parse standard formats", () => {
  const hash = "a".repeat(64);
  assert.equal(
    parseSha256Sums(`${hash}  agent-team-kit-0.0.1.tgz\n`, "agent-team-kit-0.0.1.tgz"),
    hash,
  );
  assert.equal(
    parseSha256Sums(`${hash} *./agent-team-kit-0.0.1.tgz\n`, "agent-team-kit-0.0.1.tgz"),
    hash,
  );
  const changelog = [
    "# Changelog",
    "",
    "## 0.0.2",
    "- Second release",
    "",
    "## 0.0.1",
    "- First release",
  ].join("\n");
  assert.equal(extractChangelogSection(changelog, "0.0.1"), "- First release");
  assert.equal(extractChangelogSection(changelog, "v0.0.2"), "- Second release");
});

test("checkForUpdate and downloadAndVerifyRelease verify SHA-256 and reject tampered packages", async () => {
  const mock = await startMockReleaseServer({ tagName: "v0.0.2" });
  const temp = makeTempDir("atk-updater-");
  try {
    const check = await checkForUpdate({
      currentVersion: "0.0.1",
      apiBase: mock.url,
    });
    assert.equal(check.updateAvailable, true);
    assert.equal(check.latestVersion, "0.0.2");
    assert.equal(check.asset.name, "agent-team-kit-0.0.2.tgz");

    const downloaded = await downloadAndVerifyRelease({
      release: check,
      destDir: temp,
    });
    assert.equal(downloaded.verified, true);
    assert.equal(downloaded.sha256, mock.realSha);
    assert.ok(fs.existsSync(downloaded.filePath));
  } finally {
    await mock.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const tampered = await startMockReleaseServer({
    tagName: "v0.0.2",
    tamperChecksum: true,
  });
  const tempBad = makeTempDir("atk-updater-bad-");
  try {
    const check = await checkForUpdate({
      currentVersion: "0.0.1",
      apiBase: tampered.url,
    });
    await assert.rejects(
      () => downloadAndVerifyRelease({ release: check, destDir: tempBad }),
      /UPDATE_CHECKSUM_MISMATCH/,
    );
  } finally {
    await tampered.close();
    fs.rmSync(tempBad, { recursive: true, force: true });
  }
});

test("backend update endpoints check, block source auto-install, and apply verified updates", async () => {
  const mock = await startMockReleaseServer({ tagName: "v0.0.2" });
  const dataDir = makeTempDir("atk-updater-srv-");
  const installedPaths = [];
  const srv = createServer({
    dataDir,
    updateOptions: {
      currentVersion: "0.0.1",
      apiBase: mock.url,
      installMode: "package",
      autoCheck: false,
      installer: async ({ tarballPath }) => {
        installedPaths.push(tarballPath);
        return { installed: true, tarballPath };
      },
    },
  });
  try {
    const { url } = await srv.listen({ port: 0 });
    const sessionRes = await fetch(url + "/api/v1/session", {
      headers: { "x-atk-access": readBrowserAccess(dataDir) },
    });
    const session = await sessionRes.json();
    const headers = {
      "content-type": "application/json",
      "x-atk-token": session.token,
      "x-atk-csrf": session.csrf,
    };

    const initial = await fetch(url + "/api/v1/system/update", { headers }).then((r) => r.json());
    assert.equal(initial.currentVersion, "0.0.1");
    assert.equal(initial.status, "idle");

    const checked = await fetch(url + "/api/v1/operations/update/check", {
      method: "POST",
      headers,
      body: "{}",
    }).then((r) => r.json());
    assert.equal(checked.updateAvailable, true);
    assert.equal(checked.latestVersion, "0.0.2");

    const applied = await fetch(url + "/api/v1/operations/update/apply", {
      method: "POST",
      headers,
      body: "{}",
    }).then((r) => r.json());
    assert.equal(applied.installed, true);
    assert.equal(applied.appliedVersion, "0.0.2");
    assert.equal(applied.restartRequired, true);
    assert.equal(installedPaths.length, 1);
  } finally {
    await srv.close();
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
