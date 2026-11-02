// @ts-check
/** The settings window's own bridge (a local page, never the dashboard). */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("settings", {
  get: () => ipcRenderer.invoke("settings:get"),
  printers: () => ipcRenderer.invoke("settings:printers"),
  save: (/** @type {unknown} */ next) => ipcRenderer.invoke("settings:save", next),
  test: (/** @type {"receipt" | "labels"} */ kind) => ipcRenderer.invoke("settings:test", kind),
  installUpdate: () => ipcRenderer.send("settings:install-update"),
});

