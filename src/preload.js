// @ts-check
/**
 * What the dashboard can ask of this computer, as `window.volarDesktop`. Nothing else of
 * Electron or Node reaches the page. The main process checks every call comes from the
 * dashboard's own address.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("volarDesktop", {
  /** { version, deviceId, printers: { receipt, labels } } — whether a printer is set for each */
  info: () => ipcRenderer.invoke("desktop:info"),
  /**
   * Print the page as its print styles lay it out: "receipt" and "labels" go straight to the
   * printer chosen for them (no dialog), "page" (A4 and anything else) shows the usual dialog.
   * @param {"receipt" | "labels" | "page"} kind
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  print: (kind) => ipcRenderer.invoke("desktop:print", kind),
  /** This computer's settings window (printers, full screen, start with Windows). */
  openSettings: () => ipcRenderer.send("desktop:settings"),
});
