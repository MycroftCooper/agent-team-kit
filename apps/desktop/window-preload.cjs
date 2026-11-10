const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) {
  const invoke = (action) => ipcRenderer.invoke("atk:window-control", action);
  contextBridge.exposeInMainWorld("atkDesktop", {
    getWindowState: () => invoke("state"),
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
