// @ts-check
/**
 * This computer's settings, kept next to the app's data (%APPDATA%\VOLAR\config.json):
 * which branch it belongs to and who works on it, which printer prints what, and how the
 * window behaves. The API's address is built in (API_URL), not something staff choose.
 * Nothing secret is kept here.
 */
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/** The VOLAR API this program talks to (the online server). `--api=` overrides it only while developing. */
const API_URL = "https://nnlqcfqvk6juiacdncat1el4.storiza.store/v1";

/**
 * @typedef {{ id: string, name: string, username: string, role: string }} StaffMember
 * @typedef {{ id?: string, name?: string, branchId: string, branchName: string, staff: StaffMember[], setupBy: string, setupAt: string, disabled?: boolean }} Device
 * @typedef {{
 *   device: Device | null,
 *   receiptPrinter: string,
 *   labelPrinter: string,
 *   kiosk: boolean,
 *   startWithWindows: boolean,
 *   deviceId: string,
 * }} Config
 */

const file = () => path.join(app.getPath("userData"), "config.json");

/** @returns {Config} */
const defaults = () => ({ device: null, receiptPrinter: "", labelPrinter: "", kiosk: false, startWithWindows: false, deviceId: crypto.randomUUID() });

/** @returns {Config} */
function load() {
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
  if (!saved || !("deviceId" in saved)) save(cfg);
  return cfg;
}

/** @param {Config} cfg */
function save(cfg) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cfg, null, 2));
}

/**
 * The API's address as typed ("https://api.example.com/v1"): http(s), no query, no trailing slash.
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
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

module.exports = { load, save, cleanUrl, API_URL };
