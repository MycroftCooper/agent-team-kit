import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { attachBrowser } from "./browser.mjs";

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const skipSmoke = args.has("--skip-smoke");

if (process.platform !== "win32") {
  console.error("Windows desktop .exe packaging must run on Windows (win32).");
  process.exit(1);
}

const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const desktopPkg = JSON.parse(fs.readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"));
const version = rootPkg.version;
const electronVersion = String(desktopPkg.devDependencies?.electron ?? "").replace(/^[~^]/, "");
assert.ok(electronVersion, "apps/desktop/package.json must pin an electron version");

const webDist = path.join(root, "apps/web/dist");
if (!fs.existsSync(path.join(webDist, "index.html")) || args.has("--rebuild-web")) {
  console.log("Building web assets before desktop packaging...");
  const buildWeb = spawnSync(process.execPath, ["scripts/build-web.mjs"], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (buildWeb.status !== 0) process.exit(buildWeb.status ?? 1);
}

const workRoot = path.join(root, "artifacts/desktop");
const stageDir = path.join(workRoot, "stage");
const distDir = path.join(workRoot, "dist");
const builderConfigPath = path.join(workRoot, "electron-builder.json");

fs.rmSync(stageDir, { recursive: true, force: true });
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

function copyFiltered(srcRel, destRel = srcRel) {
  const src = path.join(root, srcRel);
  const dest = path.join(stageDir, destRel);
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (item) => {
      const base = path.basename(item);
      if (base === "node_modules" || base === "test" || base === ".vite") return false;
      return true;
    },
  });
}

// Stage minimal, self-contained production payload (zero runtime npm dependencies).
fs.mkdirSync(path.join(stageDir, "apps/desktop"), { recursive: true });
for (const file of ["main.mjs", "prod-runtime.mjs", "runtime.mjs", "window-preload.cjs"]) {
  fs.copyFileSync(
    path.join(root, "apps/desktop", file),
    path.join(stageDir, "apps/desktop", file),
  );
}
copyFiltered("apps/desktop/build");
copyFiltered("apps/backend/src");
copyFiltered("apps/backend/resources");
fs.copyFileSync(
  path.join(root, "apps/backend/cli.mjs"),
  path.join(stageDir, "apps/backend/cli.mjs"),
);
fs.copyFileSync(
  path.join(root, "apps/backend/package.json"),
  path.join(stageDir, "apps/backend/package.json"),
);
copyFiltered("apps/web/dist");
copyFiltered("apps/agent-cli");
for (const pkgName of [
  "contracts",
  "database",
  "domain",
  "platform",
  "project-files",
  "scheduler-core",
  "agent-client",
]) {
  copyFiltered(`packages/${pkgName}`);
}

const stagePkg = {
  name: "agent-team-kit",
  productName: "Agent Team Kit",
  version,
  description: rootPkg.description,
  author: "MycroftCooper",
  license: rootPkg.license ?? "MIT",
  type: "module",
  main: "apps/desktop/main.mjs",
};
fs.writeFileSync(
  path.join(stageDir, "package.json"),
  JSON.stringify(stagePkg, null, 2) + "\n",
  "utf8",
);

const builderConfig = {
  appId: "com.mycroftcooper.agentteamkit",
  productName: "Agent Team Kit",
  electronVersion,
  asar: false,
  npmRebuild: false,
  buildDependenciesFromSource: false,
  directories: {
    app: stageDir,
    output: distDir,
    buildResources: path.join(root, "apps/desktop/build"),
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "icon.ico",
    signAndEditExecutable: true,
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Agent Team Kit",
    uninstallDisplayName: "Agent Team Kit",
    deleteAppDataOnUninstall: false,
    runAfterFinish: true,
    installerIcon: "icon.ico",
    uninstallerIcon: "icon.ico",
    installerHeaderIcon: "icon.ico",
    artifactName: "Agent-Team-Kit-Setup-${version}.exe",
    installerLanguages: ["zh_CN", "en_US"],
    language: "2052",
  },
};
fs.writeFileSync(builderConfigPath, JSON.stringify(builderConfig, null, 2) + "\n", "utf8");

const builderCli = path.join(root, "apps/desktop/node_modules/electron-builder/cli.js");
assert.ok(fs.existsSync(builderCli), `electron-builder CLI not found at ${builderCli}. Run pnpm install.`);

console.log(`Packaging Windows NSIS installer for Agent Team Kit v${version} (Electron ${electronVersion})...`);
const buildResult = spawnSync(
  process.execPath,
  [builderCli, "--win", "nsis", "--x64", "--config", builderConfigPath, "--publish", "never"],
  {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    },
  },
);
if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}

const installerName = `Agent-Team-Kit-Setup-${version}.exe`;
const installerPath = path.join(distDir, installerName);
const unpackedExe = path.join(distDir, "win-unpacked", "Agent Team Kit.exe");
assert.ok(fs.existsSync(installerPath), `Expected NSIS installer missing: ${installerPath}`);
assert.ok(fs.existsSync(unpackedExe), `Expected unpacked executable missing: ${unpackedExe}`);

const installerStat = fs.statSync(installerPath);
assert.ok(installerStat.size > 10 * 1024 * 1024, "NSIS installer appears unexpectedly small");
const installerSha256 = crypto
  .createHash("sha256")
  .update(fs.readFileSync(installerPath))
  .digest("hex");

console.log(
  `Built ${installerName} (${(installerStat.size / (1024 * 1024)).toFixed(1)} MiB, sha256=${installerSha256.slice(0, 12)}...)`,
);

if (!skipSmoke) {
  console.log("Running packaged desktop smoke verification...");
  await verifyPackagedDesktop(unpackedExe, version);
  console.log("PASS packaged desktop app boots in production mode, reports desktop updater mode, and exits cleanly");
}

console.log(
  JSON.stringify(
    {
      version,
      installerName,
      installerPath,
      unpackedExe,
      size: installerStat.size,
      sha256: installerSha256,
    },
    null,
    2,
  ),
);

async function verifyPackagedDesktop(exePath, expectedVersion) {
  const smokeRoot = fs.mkdtempSync(path.join(workRoot, "smoke-"));
  const dataDir = path.join(smokeRoot, "data");
  const profileDir = path.join(smokeRoot, "profile");
  fs.mkdirSync(profileDir, { recursive: true });
  const logFile = path.join(smokeRoot, "desktop.log");
  const logFd = fs.openSync(logFile, "w");
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "ELECTRON_RUN_AS_NODE"),
  );
  const child = spawn(exePath, [], {
    cwd: path.dirname(exePath),
    env: {
      ...childEnv,
      ATK_DESKTOP_TEST: profileDir,
      ATK_DATA_DIR: dataDir,
      ATK_PORT: "0",
      ATK_DISABLE_UPDATE_CHECK: "1",
    },
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  fs.closeSync(logFd);

  let browser;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(fn, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const res = await fn().catch(() => null);
      if (res) return res;
      if (child.exitCode !== null) {
        throw new Error(`Packaged app exited prematurely (${child.exitCode}):\n${fs.readFileSync(logFile, "utf8")}`);
      }
      await sleep(150);
    }
    throw new Error(`Timed out waiting for packaged desktop app:\n${fs.readFileSync(logFile, "utf8")}`);
  }

  try {
    const port = await until(async () => {
      const file = path.join(profileDir, "DevToolsActivePort");
      const activePort = Number(fs.readFileSync(file, "utf8").split(/\r?\n/)[0]);
      const tabs = await fetch(`http://127.0.0.1:${activePort}/json`).then((r) => r.json());
      return tabs.some((tab) => tab.type === "page" && tab.url.startsWith("http://127.0.0.1:")) && activePort;
    }, 45000);

    browser = await attachBrowser({ port, outputDir: smokeRoot });
    await browser.wait("document.body?.innerText.includes('添加本地项目')", 30000);

    const winState = await browser.evaluate("window.atkDesktop.getWindowState()");
    assert.equal(winState.mode, "production", "Packaged desktop must report production mode");
    assert.equal(
      await browser.evaluate("Boolean(document.querySelector('.desktop-title-badge'))"),
      false,
      "Production desktop titlebar must not show DEV badge",
    );
    assert.equal(
      await browser.evaluate("typeof window.atkDesktop.restartAndInstallUpdate"),
      "function",
      "Production desktop preload must expose restartAndInstallUpdate",
    );

    const updateState = await browser.evaluate(`(async () => {
      const access = sessionStorage.getItem('atk-browser-access');
      const session = await fetch('/api/v1/session', { headers: { 'x-atk-access': access } }).then(r => r.json());
      return fetch('/api/v1/system/update', { headers: { 'x-atk-token': session.token } }).then(r => r.json());
    })()`);
    assert.equal(updateState.installMode, "desktop");
    assert.equal(updateState.currentVersion, expectedVersion);
    assert.deepEqual(browser.errors, []);

    await browser.evaluate("setTimeout(() => document.querySelector('.desktop-window-close').click(), 200); true");
    const exitCode = await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      const timer = setTimeout(() => resolve(null), 15000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0, "Packaged desktop app must exit cleanly");
    assert.equal(
      fs.existsSync(path.join(dataDir, "runtime", "backend.lock")),
      false,
      "Closing packaged desktop must release backend.lock",
    );
  } finally {
    await browser?.close();
    if (child.exitCode === null && child.pid) {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    }
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
}
