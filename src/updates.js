// @ts-check
/**
 * Updates from the repo's GitHub Releases (the `publish` setting in package.json).
 *
 * A new version downloads quietly in the background and installs when VOLAR closes, so a
 * cashier is never interrupted mid-sale; the settings window can install it right away.
 * Only the installed app updates itself (never `npm start`).
 */
const { app } = require("electron");
const { autoUpdater } = require("electron-updater");

/** @type {{ state: "idle" | "checking" | "downloading" | "ready" | "latest" | "error", version?: string, error?: string }} */
let status = { state: "idle" };
const EVERY = 4 * 60 * 60 * 1000;

function start() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => (status = { ...status, state: status.state === "ready" ? "ready" : "checking" }));
  autoUpdater.on("update-available", (i) => (status = { state: "downloading", version: i.version }));
  autoUpdater.on("update-not-available", () => (status = { state: "latest" }));
  autoUpdater.on("update-downloaded", (i) => (status = { state: "ready", version: i.version }));
  autoUpdater.on("error", (e) => (status = { ...status, state: status.state === "ready" ? "ready" : "error", error: String(e?.message ?? e).slice(0, 200) }));
  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, EVERY);
}

/** Installs the downloaded version now (closes and reopens VOLAR). */
function installNow() {
  if (status.state === "ready") autoUpdater.quitAndInstall(false, true);
}

module.exports = { start, installNow, status: () => status };
