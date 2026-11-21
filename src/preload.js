// @ts-check
/**
 * What the screens can ask of the program, as `window.volarDesktop`. Nothing else of
 * Electron or Node reaches them, and the main process checks every call comes from the
 * program's own screens (volar://app). Volar-admin's desktop mode (src/lib/desktop.ts) uses it.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("volarDesktop", {
  /** This bridge's shape (the admin checks it before using it). */
  protocol: 2,
  /** The API's address ("https://…", no /v1), for what the screens load straight from it (photos). */
  apiUrl: String(ipcRenderer.sendSync("desktop:api-url") || ""),
  /** The API, called by the program as whoever is signed in (the tokens never come here). */
  api: {
    /** { method, path: "/v1/…", headers, body: string | Uint8Array | null } → { status, headers, body } | { networkError } */
    request: (/** @type {unknown} */ r) => ipcRenderer.invoke("api:request", r),
    refresh: () => ipcRenderer.invoke("api:refresh"),
    ping: () => ipcRenderer.invoke("api:ping"),
  },
  /** This computer: paired with a branch (and its till), and who is using it. */
  device: {
    /** { paired, device: { id, name, tillNumber, branch, screens } | null, current: { id, name } | null, computerName } */
    state: () => ipcRenderer.invoke("device:state"),
    /** a pairing code to show (an admin types it in Settings → Devices) */
    pairStart: (/** @type {boolean} */ fresh) => ipcRenderer.invoke("device:pair-start", !!fresh),
    /** was the code approved? (then this computer keeps its key and is paired) */
    pairClaim: () => ipcRenderer.invoke("device:pair-claim"),
    /** a sign-in QR for the phone app */
    qrStart: () => ipcRenderer.invoke("device:qr-start"),
    /** was it approved on a phone? (then that person is signed in here) */
    qrClaim: (/** @type {string} */ id) => ipcRenderer.invoke("device:qr-claim", id),
    /** nobody is using the computer now: back to the branch's sign-in screen */
    lock: () => ipcRenderer.invoke("device:lock"),
    /** paired, signed in, locked, or stopped in the admin */
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
   * printer (no dialog), "page" with the usual dialog. page: { widthMm, heightMm } or { paper: "A4" }.
   * @param {"receipt" | "labels" | "page"} kind
   * @param {unknown} [page]
   */
  print: (kind, page) => ipcRenderer.invoke("desktop:print", kind, page),
  openSettings: () => ipcRenderer.send("desktop:settings"),
});
