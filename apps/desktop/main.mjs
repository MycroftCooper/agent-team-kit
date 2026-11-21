import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path, { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { startProdRuntime } from "./prod-runtime.mjs";

const isProd = app.isPackaged || process.env.ATK_DESKTOP_PROD === "1";
const testProfile = process.env.ATK_DESKTOP_TEST;
if (testProfile) {
  app.setPath("userData", testProfile);
  app.commandLine.appendSwitch("remote-debugging-port", "0");
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function resolveWindowIcon() {
  const candidate = fileURLToPath(new URL("./build/icon.ico", import.meta.url));
  return fs.existsSync(candidate) ? candidate : undefined;
}

function start() {
  let runtime, window, stopping = false, failed = false, pendingUpdate = null, installingUpdate = false;
  app.on("second-instance", () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (!runtime) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    void runtime.close().catch((error) => { failed = true; console.error(error); }).then(() => {
      runtime = null;
      if (failed) app.exit(1);
      else app.quit();
    });
  });

  function fail(message) {
    if (failed) return;
    failed = true;
    console.error(`ATK desktop: ${message}`);
    if (!testProfile) dialog.showErrorBox("Agent Team Kit", message);
    if (runtime) app.quit();
    else app.exit(1);
  }

  async function launchUpdateInstaller() {
    if (installingUpdate) return false;
    const installerPath = pendingUpdate?.installerPath;
    if (
      typeof installerPath !== "string" ||
      !installerPath.toLowerCase().endsWith(".exe") ||
      !fs.existsSync(installerPath)
    ) {
      throw new Error("No verified desktop update installer is ready.");
    }
    installingUpdate = true;
    stopping = true;
    const active = runtime;
    runtime = null;
    if (active) {
      await active.close().catch(console.error);
    }
    const installer = spawn(installerPath, ["/S", "--updated", "--force-run"], {
      cwd: path.dirname(installerPath),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    installer.unref();
    app.exit(0);
    return true;
  }

  app.whenReady().then(async () => {
    if (isProd) {
      runtime = startProdRuntime({
        onReady: openWindow,
        onError: fail,
        onUpdateReady: (info) => { pendingUpdate = info; },
      });
    } else {
      const { startDesktopRuntime } = await import("./dev-runtime.mjs");
      runtime = startDesktopRuntime({ onReady: openWindow, onError: fail });
    }
  }).catch((error) => fail(error.message));

  function openWindow(address) {
    if (stopping || failed || window) return;
    const url = new URL(address);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port)
      return fail("Refusing an unexpected local workspace URL.");
    window = new BrowserWindow({
      title: isProd ? "Agent Team Kit" : "Agent Team Kit · Dev",
      icon: resolveWindowIcon(),
      width: 1440,
      height: 960,
      minWidth: 900,
      minHeight: 600,
      frame: false,
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0c0e" : "#f7f8fb",
      autoHideMenuBar: true,
      webPreferences: {
        preload: fileURLToPath(new URL("./window-preload.cjs", import.meta.url)),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // The existing human-task lease timer must continue when minimized.
        backgroundThrottling: false,
      },
    });
    installWindowControls(window, url.origin, { isProd, launchUpdateInstaller });
    window.webContents.setWindowOpenHandler(({ url: target }) => {
      try {
        const parsed = new URL(target);
        if (parsed.protocol === "https:" && (parsed.hostname === "github.com" || parsed.hostname.endsWith(".github.com"))) {
          void shell.openExternal(parsed.href);
        }
      } catch {}
      return { action: "deny" };
    });
    const restrictNavigation = (event) => {
      if (new URL(event.url).origin !== url.origin) event.preventDefault();
    };
    window.webContents.on("will-navigate", restrictNavigation);
    window.webContents.on("will-redirect", restrictNavigation);
    window.loadURL(url.href).then(() => {
      if (!window.isDestroyed() && !testProfile) window.show();
    }).catch(() => {
      if (!stopping && !window.isDestroyed()) fail("Could not load the local workspace UI.");
    });
  }
}

function installWindowControls(window, origin, { isProd, launchUpdateInstaller }) {
  const channel = "atk:window-control";
  const contents = window.webContents;
  const state = () => ({
    maximized: window.isMaximized(),
    minimized: window.isMinimized(),
    mode: isProd ? "production" : "development",
  });
  function publish() {
    if (!contents.isDestroyed()) contents.send("atk:window-state", state());
  }
  for (const event of ["maximize", "unmaximize", "minimize", "restore"])
    window.on(event, publish);
  ipcMain.handle(channel, async (event, action, currentPath) => {
    if (event.sender !== contents || !event.senderFrame ||
        event.senderFrame !== contents.mainFrame || new URL(event.senderFrame.url).origin !== origin)
      throw new Error("Window controls are available only to the desktop workspace.");
    switch (action) {
      case "state": return state();
      case "choose-project-folder": {
        const { canceled, filePaths } = await dialog.showOpenDialog(window, {
          properties: ["openDirectory"],
          defaultPath: typeof currentPath === "string" && isAbsolute(currentPath) ? currentPath : undefined,
        });
        return canceled ? null : (filePaths[0] ?? null);
      }
      case "minimize": window.minimize(); break;
      case "toggle-maximize":
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
        break;
      case "close": window.close(); break;
      case "install-update":
        return launchUpdateInstaller();
      default: throw new Error("Unknown window action.");
    }
  });
  window.once("closed", () => ipcMain.removeHandler(channel));
}
