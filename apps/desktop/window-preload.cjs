const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) {
  const invoke = (action, ...args) => ipcRenderer.invoke("atk:window-control", action, ...args);
  contextBridge.exposeInMainWorld("atkDesktop", {
    getWindowState: () => invoke("state"),
    chooseProjectFolder: (currentPath) => invoke("choose-project-folder", currentPath),
    minimize: () => invoke("minimize"),
    toggleMaximize: () => invoke("toggle-maximize"),
    close: () => invoke("close"),
    onWindowState(callback) {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("atk:window-state", listener);
      return () => ipcRenderer.removeListener("atk:window-state", listener);
    },
  });
}
