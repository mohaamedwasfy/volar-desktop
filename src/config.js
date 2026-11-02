// @ts-check
/**
 * This computer's settings, kept next to the app's data (%APPDATA%\VOLAR\config.json):
 * where the dashboard lives, which printer prints what, and how the window behaves.
 * Nothing secret is kept here.
 */
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/**
 * @typedef {{
 *   serverUrl: string,
 *   receiptPrinter: string,
 *   labelPrinter: string,
 *   kiosk: boolean,
 *   startWithWindows: boolean,
 *   deviceId: string,
 * }} Config
 */

const file = () => path.join(app.getPath("userData"), "config.json");

/** @returns {Config} */
const defaults = () => ({ serverUrl: "", receiptPrinter: "", labelPrinter: "", kiosk: false, startWithWindows: false, deviceId: crypto.randomUUID() });

/** @returns {Config} */
function load() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    /* first run */
  }
  const cfg = { ...defaults(), ...saved };
  if (!saved || !("deviceId" in saved)) save(cfg);
  return cfg;
}

/** @param {Config} cfg */
function save(cfg) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cfg, null, 2));
}

/**
 * Only an http(s) address, without anything after the host's path: "https://admin.example.com".
 * @param {unknown} v
 * @returns {string | null}
 */
function cleanUrl(v) {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    // plain http only for this computer itself (development)
    if (u.protocol === "http:" && !["localhost", "127.0.0.1"].includes(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

module.exports = { load, save, cleanUrl };
