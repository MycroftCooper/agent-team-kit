import { app, BrowserWindow, dialog, ipcMain, nativeTheme, utilityProcess } from "electron";
import { fileURLToPath } from "node:url";

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

function start() {
  let worker, window, stopping = false, failed = false;
  app.on("second-instance", () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (!worker) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    worker.postMessage({ type: "stop" });
    const timeout = setTimeout(() => worker?.kill(), 6000);
    timeout.unref();
  });

  function fail(message) {
    if (failed) return;
    failed = true;
    console.error(`ATK desktop: ${message}`);
    if (!testProfile) dialog.showErrorBox("Agent Team Kit", message);
    if (worker) app.quit();
    else app.exit(1);
  }

  app.whenReady().then(() => {
    worker = utilityProcess.fork(fileURLToPath(new URL("./runtime.mjs", import.meta.url)), [], {
      serviceName: "ATK Development Runtime",
      stdio: ["ignore", "pipe", "pipe"],
    });
    worker.stdout?.pipe(process.stdout);
    worker.stderr?.pipe(process.stderr);
    worker.once("exit", (code) => {
      worker = null;
      if (stopping) failed ? app.exit(1) : app.quit();
      else fail(`Development runtime exited (${code}). See the dev.bat console.`);
    });
    worker.on("message", (message) => {
      if (stopping || failed) return;
      if (message.type === "error") return fail(message.error);
      if (message.type !== "ready" || window) return;
      const url = new URL(message.url);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port)
        return fail("Refusing an unexpected development URL.");
      window = new BrowserWindow({
        title: "Agent Team Kit · Dev",
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
      installWindowControls(window, url.origin);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const restrictNavigation = (event) => {
        if (new URL(event.url).origin !== url.origin) event.preventDefault();
      };
      window.webContents.on("will-navigate", restrictNavigation);
      window.webContents.on("will-redirect", restrictNavigation);
      window.loadURL(url.href).then(() => {
        if (!window.isDestroyed() && !testProfile) window.show();
      }).catch(() => {
        if (!stopping && !window.isDestroyed()) fail("Could not load the local development UI.");
      });
    });
  }).catch((error) => fail(error.message));
}

function installWindowControls(window, origin) {
  const channel = "atk:window-control";
  const contents = window.webContents;
  const state = () => ({ maximized: window.isMaximized(), minimized: window.isMinimized() });
  function publish() {
    if (!contents.isDestroyed()) contents.send("atk:window-state", state());
  }
  for (const event of ["maximize", "unmaximize", "minimize", "restore"])
    window.on(event, publish);
  ipcMain.handle(channel, (event, action) => {
    if (event.sender !== contents || !event.senderFrame ||
        event.senderFrame !== contents.mainFrame || new URL(event.senderFrame.url).origin !== origin)
      throw new Error("Window controls are available only to the desktop workspace.");
    switch (action) {
      case "state": return state();
      case "minimize": window.minimize(); break;
      case "toggle-maximize":
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
        break;
      case "close": window.close(); break;
      default: throw new Error("Unknown window action.");
    }
  });
  window.once("closed", () => ipcMain.removeHandler(channel));
}
