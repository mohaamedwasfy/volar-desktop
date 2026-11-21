// @ts-check
/**
 * This computer's settings, kept next to the app's data (%APPDATA%\VOLAR\config.json):
 * which branch and till it was paired with, which printer prints what, and how the window
 * behaves. The API's address is built in (API_URL), not something staff choose.
 *
 * The one secret, the device key the API gave this computer when it was paired, is kept here
 * encrypted with Windows' protection (safeStorage): only this Windows account can read it.
 */
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/**
 * The VOLAR API this program talks to (the online server), written with its version like the
 * other apps' settings. The program's paths carry "/v1/…" themselves, so `cleanUrl` drops the
 * trailing /v1 before use. `--api=` overrides it only while developing.
 */
const API_URL = "https://api.volar-eg.com/v1";

/** Settings written by the versions before the new system (0.5.x) are read as a fresh computer. */
const SCHEMA = 2;

/**
 * @typedef {{ id: string, name: string, registerId: string, registerName: string }} Screen
 * @typedef {{ id: string, name: string, tillNumber: number, branch: { id: string, code: string, name: string }, screens: Screen[], pairedAt: string }} Device
 * @typedef {{
 *   schema: number,
 *   device: Device | null,
 *   deviceKey: string,
 *   receiptPrinter: string,
 *   labelPrinter: string,
 *   kiosk: boolean,
 *   startWithWindows: boolean,
 *   deviceId: string,
 * }} Config
 */

const file = () => path.join(app.getPath("userData"), "config.json");

/** @returns {Config} */
const defaults = () => ({ schema: SCHEMA, device: null, deviceKey: "", receiptPrinter: "", labelPrinter: "", kiosk: false, startWithWindows: false, deviceId: crypto.randomUUID() });

/** @returns {Config} */
function load() {
  /** @type {any} */
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    /* first run */
  }
  const cfg = { ...defaults(), ...saved };
  // earlier versions kept an address typed in the settings
  delete (/** @type {any} */ (cfg)).serverUrl;
  delete (/** @type {any} */ (cfg)).apiUrl;
  // the old system's computer (its branch and staff, chosen by the owner on it): pair it again
  if (saved.schema !== SCHEMA) {
    cfg.schema = SCHEMA;
    cfg.device = null;
    cfg.deviceKey = "";
  }
  if (saved.schema !== SCHEMA || !("deviceId" in saved)) save(cfg);
  return cfg;
}

/** @param {Config} cfg */
function save(cfg) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cfg, null, 2));
}

/** The device key as kept in the settings (encrypted; plain only where Windows offers no encryption). */
function sealKey(/** @type {string} */ key) {
  if (!key) return "";
  return safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(key).toString("base64")}` : `raw:${key}`;
}
function openKey(/** @type {string} */ kept) {
  if (!kept) return null;
  try {
    if (kept.startsWith("enc:")) return safeStorage.decryptString(Buffer.from(kept.slice(4), "base64"));
    if (kept.startsWith("raw:")) return kept.slice(4);
  } catch {
    /* another Windows account or a damaged file: the computer is paired again */
  }
  return null;
}

/**
 * The API's address as typed ("https://api.example.com"): http(s), no query, no trailing slash,
 * and no "/v1" (the paths carry it).
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
    return `${u.origin}${u.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}`;
  } catch {
    return null;
  }
}

module.exports = { load, save, cleanUrl, sealKey, openKey, API_URL };
