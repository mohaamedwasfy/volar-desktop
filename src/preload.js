// @ts-check
/**
 * What the screens can ask of the program, as `window.volarDesktop`. Nothing else of
 * Electron or Node reaches them, and the main process checks every call comes from the
 * program's own screens (volar://app).
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("volarDesktop", {
  /** The API, called by the program (signed in as an app; the tokens never come here). */
  api: {
    request: (/** @type {unknown} */ r) => ipcRenderer.invoke("api:request", r),
    refresh: () => ipcRenderer.invoke("api:refresh"),
    ping: () => ipcRenderer.invoke("api:ping"),
  },
  /** This computer: its branch and staff (set up once by the owner), and who is using it. */
  device: {
    state: () => ipcRenderer.invoke("device:state"),
    setup: (/** @type {unknown} */ d) => ipcRenderer.invoke("device:setup", d),
    lock: () => ipcRenderer.invoke("device:lock"),
    /** a sign-in QR for the phone app */
    qrStart: () => ipcRenderer.invoke("device:qr-start"),
    /** was it confirmed on a phone? (then that person is signed in here) */
    qrClaim: (/** @type {string} */ id) => ipcRenderer.invoke("device:qr-claim", id),
    /** the owner locked it, signed everyone out or stopped it from the dashboard */
    onChange: (/** @type {() => void} */ cb) => {
      const h = () => cb();
      ipcRenderer.on("device:changed", h);
      return () => ipcRenderer.removeListener("device:changed", h);
    },
  },
  /** { version, deviceId, printers: { receipt, labels } } */
  info: () => ipcRenderer.invoke("desktop:info"),
  /**
   * Print the page as its print styles lay it out: receipts and labels straight to their
   * printer (no dialog), "page" with the usual dialog.
   * @param {"receipt" | "labels" | "page"} kind
   */
  print: (kind, page) => ipcRenderer.invoke("desktop:print", kind, page),
  openSettings: () => ipcRenderer.send("desktop:settings"),
});
