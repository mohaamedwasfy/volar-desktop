// @ts-check
/**
 * VOLAR on the shop's computers: a program of its own.
 *
 *   - The screens are packaged inside it (ui.js) and open with no internet at all.
 *   - The computer is set up once: it shows a QR an administrator scans with the phone app (or an
 *     administrator signs in on it), choosing its branch and whether it is a cashier (then its till
 *     screen on a register). Its device key is kept encrypted in the settings (config.js).
 *   - The program calls the API itself (api.js) as whoever signed in on the branch's sign-in
 *     screen (the phone's QR, or a name from the branch's list and its password), its tokens encrypted on this computer, out of reach
 *     of the screens. Lock: the next cashier signs in.
 *   - When the API can't be reached the screens work from what they saved and queue what
 *     the till does; it's all sent when the API answers again (Volar-admin, the till's offline.ts).
 *   - Receipts and labels print straight to the printers chosen on this computer.
 *   - Updates come by themselves (updates.js).
 *   - The fingerprint device can reach the server through it (iclock-relay.js): it listens on the shop's
 *     network (port 8081) while a device is linked to this computer in the admin (or «استقبل البصمة من
 *     الجهاز» is on in its settings), and passes the device's requests on with its own key.
 *
 * The window shows only the program's own screens; any other address opens in the browser.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, net, session, shell } = require("electron");
const os = require("node:os");
const { exec, execFile } = require("node:child_process");
const path = require("node:path");
const config = require("./config");
const updates = require("./updates");
const { startUi, stopUi, ORIGIN } = require("./ui");
const { createApi } = require("./api");
const { createRelay, lanAddresses } = require("./iclock-relay");

/** The VOLAR icon (the same as the phone app's), in the taskbar and the window corner. */
const ICON = path.join(__dirname, "assets", "icon.ico");

/** @type {BrowserWindow | null} */
let win = null;
/** @type {BrowserWindow | null} */
let settingsWin = null;
let cfg = /** @type {import("./config").Config} */ (/** @type {unknown} */ (null));

// `--profile=test` (development): a separate data folder, so it never clashes with an installed VOLAR
const profile = process.argv.find((x) => x.startsWith("--profile="))?.slice(10).replace(/[^\w-]/g, "");
if (profile) app.setPath("userData", path.join(app.getPath("appData"), `VOLAR-${profile}`));

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

/** `--api=http://localhost:4200` and `--ui=http://localhost:3200` while developing. */
const arg = (/** @type {string} */ name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};

// the built-in address; `--api=` only while developing (an installed program ignores it: a
// changed shortcut must not point the till at another server that would collect passwords)
const API = (!app.isPackaged && config.cleanUrl(arg("api"))) || config.cleanUrl(config.API_URL);
/** The device key from pairing (kept encrypted in the settings). */
const deviceKey = () => (cfg ? config.openKey(cfg.deviceKey) : null);
const api = createApi({
  base: () => API,
  deviceKey: () => deviceKey(),
  branchId: () => cfg?.device?.branch.id ?? null,
  onChange: () => changed(),
  onDeviceGone: () => void checkDevice(),  // also on a session refused for good: was the computer stopped?
});

/** volar://app/… (Node calls a custom scheme's origin "null", so scheme and host are compared). */
const isOurs = (/** @type {string} */ url) => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}` === ORIGIN;
  } catch {
    return false;
  }
};
/** The bridge answers the program's own screens only. */
const fromScreens = (/** @type {Electron.IpcMainInvokeEvent | Electron.IpcMainEvent} */ e) => e.senderFrame !== null && isOurs(e.senderFrame.url);

function applyStartup() {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: cfg.startWithWindows });
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: "VOLAR",
    icon: ICON,
    backgroundColor: "#FFFCF6",
    autoHideMenuBar: true,
    kiosk: cfg.kiosk,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.once("ready-to-show", () => {
    if (!cfg.kiosk) win?.maximize();
    win?.show();
  });

  const wc = win.webContents;
  wc.on("will-navigate", (e, url) => {
    if (isOurs(url)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  wc.on("will-redirect", (e, url, _inPlace, isMain) => {
    if (isMain && !isOurs(url)) e.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (isOurs(url)) void win?.loadURL(url);
    else if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    if (input.control && input.shift && key === "s") { e.preventDefault(); openSettings(); }
    // F1–F10 and Esc belong to the screens (the till's F5 is «دوّر على منتج»): only Ctrl+R / Ctrl+Shift+R reload
    else if (input.control && !input.alt && key === "r") { e.preventDefault(); if (input.shift) wc.reloadIgnoringCache(); else wc.reload(); }
    else if (input.control && input.shift && key === "i" && !app.isPackaged) { e.preventDefault(); wc.toggleDevTools(); }
    else if (key === "f11" && !cfg.kiosk) { e.preventDefault(); win?.setFullScreen(!win.isFullScreen()); }
  });

  try {
    const start = await startUi(arg("ui"));
    await win.loadURL(start);
  } catch (err) {
    dialog.showErrorBox("VOLAR", String(/** @type {Error} */ (err)?.message ?? err));
    app.quit();
  }
}

function openSettings(firstRun = false) {
  if (settingsWin) return settingsWin.focus();
  settingsWin = new BrowserWindow({
    width: 560,
    height: 820,
    parent: win ?? undefined,
    modal: !!win && !firstRun,
    resizable: false,
    minimizable: false,
    title: "إعدادات الجهاز",
    icon: ICON,
    backgroundColor: "#FFFCF6",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "settings-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  void settingsWin.loadFile(path.join(__dirname, "settings.html"));
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
}

async function printers() {
  const wc = (settingsWin ?? win)?.webContents;
  if (!wc) return [];
  return (await wc.getPrintersAsync()).map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
}

/** How receipt and label printers usually name themselves, to find them when none was chosen in the settings. */
const PRINTER_NAMES = {
  receipt: /receipt|thermal|\bpos\b|pos-?\d|tm-?[a-z]?\d|xp-?80|80mm/i,
  labels: /label|barcode|zebra|tsc|godex|gprinter|xp-?3\d\d|xp-?4\d\d/i,
};

/**
 * The printer for a kind: the one chosen in the settings; none chosen, the only printer whose name
 * says it's that kind. Two candidates or none: the usual dialog, never a guess.
 * @param {Electron.WebContents} wc
 * @param {"receipt" | "labels" | "page"} kind
 */
async function printerFor(wc, kind) {
  if (kind === "page") return "";
  const chosen = kind === "receipt" ? cfg.receiptPrinter : cfg.labelPrinter;
  if (chosen) return chosen;
  const found = (await wc.getPrintersAsync()).filter((p) => PRINTER_NAMES[kind].test(p.name));
  return found.length === 1 ? found[0].name : "";
}

/**
 * The paper comes from the screen that knows it (a receipt's real length, the label size), so a
 * printer's own default can't turn it sideways or feed blank paper. Checked: it comes from a page.
 * @param {unknown} page
 * @returns {{ pageSize: string | { width: number, height: number }, landscape?: boolean, margins?: { marginType: "none" } } | {}}
 */
function paperOf(page) {
  if (typeof page !== "object" || !page) return {};
  const { widthMm, heightMm, paper } = /** @type {any} */ (page);
  if (paper === "A4") return { pageSize: "A4" };
  const ok = (/** @type {unknown} */ n, /** @type {number} */ min, /** @type {number} */ max) => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
  if (!ok(widthMm, 20, 300) || !ok(heightMm, 10, 2000)) return {};
  // Electron takes microns here. A page wider than tall (a 38×25 sticker) is given upright and turned
  // (landscape): Chromium swaps a custom size whose width is over its height, and the sticker printer
  // then got a sideways or empty page (owner's note 6: «زرار الطباعة مش شغال»).
  const w = Math.round(widthMm * 1000);
  const h = Math.round(heightMm * 1000);
  if (w > h) return { pageSize: { width: h, height: w }, landscape: true, margins: { marginType: "none" } };
  return { pageSize: { width: w, height: h }, margins: { marginType: "none" } };
}

/**
 * @param {Electron.WebContents} wc
 * @param {"receipt" | "labels" | "page"} kind
 * @param {unknown} [page]
 */
async function printOn(wc, kind, page) {
  const deviceName = await printerFor(wc, kind);
  return new Promise((resolve) => {
    wc.print({ silent: !!deviceName, deviceName: deviceName || undefined, printBackground: true, landscape: false, copies: 1, ...paperOf(page) }, (ok, reason) =>
      resolve(ok ? { ok: true } : { ok: false, error: reason === "cancelled" ? "cancelled" : reason || "failed" }),
    );
  });
}

// ─── the screens' bridge (preload.js) ───────────────────────────────────────────

ipcMain.handle("api:request", (e, r) => (fromScreens(e) ? api.request(r) : { networkError: true, message: "refused" }));
ipcMain.handle("api:refresh", (e) => (fromScreens(e) ? api.refresh() : "failed"));
ipcMain.handle("api:ping", (e) => (fromScreens(e) ? api.ping() : false));
// Why the server can't be reached: is this computer online at all, and what the server answered (null: nothing).
ipcMain.handle("api:diagnose", async (e) => (fromScreens(e) ? { online: net.isOnline(), status: await api.serverStatus() } : { online: false, status: null }));
/** The API's address, for what the screens show straight from it (product photos). */
ipcMain.on("desktop:api-url", (e) => {
  e.returnValue = fromScreens(e) ? API : "";
});

// ─── this computer: its branch and till (from pairing), who is using it ─────────

/** Tells the screens the computer's state changed (paired, signed in, locked, stopped in the admin). */
function changed() {
  win?.webContents.send("device:changed");
}

/** Unpaired (removed or stopped in the admin, or its key unreadable): back to a new computer. */
function forgetDevice() {
  if (!cfg.device && !cfg.deviceKey) return;
  cfg = { ...cfg, device: null, deviceKey: "", fingerprintLinked: false };
  void syncRelay();
  config.save(cfg);
  api.forgetAll();
  changed();
}

ipcMain.handle("device:state", (e) => {
  if (!fromScreens(e)) return null;
  // the screens just opened (or reloaded): ask the API who this computer is, at most every 10 seconds
  if (Date.now() - lastCheck > 10_000) void checkDevice();
  const paired = !!cfg.device && !!deviceKey();
  const d = paired && cfg.device ? cfg.device : null;
  // set up by an older version: cashier = it has a till screen (until the API's answer comes)
  const device = d ? { ...d, cashier: d.cashier ?? d.screens.length > 0, screen: d.screen ?? d.screens[0] ?? null } : null;
  return { paired, device, current: api.current(), computerName: os.hostname() };
});
/** The setup QR to show (the same one while it is still good, unless a new one is asked for). */
ipcMain.handle("device:setup-start", (e, fresh) => (fromScreens(e) && !cfg.device ? api.setupStart(!!fresh) : { error: "refused" }));
/**
 * Polled every few seconds while the setup QR shows: approved (from a phone, or here), this computer
 * keeps its key (encrypted) and learns who it is. Whoever signed in here to set it up is signed out:
 * the next person signs in on the branch's screen, with a session of this computer.
 */
ipcMain.handle("device:setup-claim", async (e) => {
  if (!fromScreens(e) || cfg.device) return { status: "EXPIRED", message: "refused" };
  const r = await api.setupClaim();
  if (r.status !== "DONE" || !("key" in r)) return r;
  cfg = {
    ...cfg,
    deviceKey: config.sealKey(r.key),
    device: { id: r.deviceId, name: os.hostname(), tillNumber: r.tillNumber, branch: r.branch, cashier: r.cashier, screen: null, screens: [], pairedAt: new Date().toISOString() },
  };
  config.save(cfg);
  await api.endSession();
  await checkDevice();
  void syncRelay();
  changed();
  return { status: "DONE", device: cfg.device };
});
/** The administrator signed in here: what they may choose for this computer, then their choice. */
ipcMain.handle("device:setup-preview", (e) => (fromScreens(e) && !cfg.device ? api.setupPreview() : { ok: false, status: 403, code: "FORBIDDEN", message: "refused" }));
ipcMain.handle("device:setup-approve", (e, input) => (fromScreens(e) && !cfg.device ? api.setupApprove(input) : { ok: false, status: 403, code: "FORBIDDEN", message: "refused" }));
/** Signing in without a phone: the branch's people, then a name and its password. */
ipcMain.handle("device:staff", (e) => (fromScreens(e) && cfg.device ? api.staff() : { ok: false, status: 403, code: "FORBIDDEN", message: "refused" }));
ipcMain.handle("device:login", (e, input) => (fromScreens(e) && cfg.device ? api.deviceLogin(input) : { ok: false, status: 403, code: "FORBIDDEN", message: "refused" }));
/** Sign-in with the phone app: the QR to show, then (every few seconds) whether it was approved. */
ipcMain.handle("device:qr-start", (e) => (fromScreens(e) && cfg.device ? api.qrStart() : { error: "refused" }));
ipcMain.handle("device:qr-claim", (e, id) => {
  if (!fromScreens(e) || typeof id !== "string" || id.length > 64 || !cfg.device) return { status: "EXPIRED" };
  return api.qrClaim(id);
});
ipcMain.handle("device:lock", async (e) => {
  // the sign-in screen shows at once; the person's session on the server ends too (later, if offline)
  if (fromScreens(e)) await api.lock();
  return true;
});
ipcMain.handle("desktop:info", (e) =>
  fromScreens(e) ? { version: app.getVersion(), deviceId: cfg.deviceId, printers: { receipt: !!cfg.receiptPrinter, labels: !!cfg.labelPrinter } } : null,
);
ipcMain.handle("desktop:print", async (e, kind, page) => {
  if (!fromScreens(e) || !["receipt", "labels", "page"].includes(kind)) return { ok: false, error: "refused" };
  return printOn(e.sender, kind, page);
});
ipcMain.on("desktop:settings", (e) => {
  if (fromScreens(e)) openSettings();
});

/**
 * Who this computer is, from the API (at start and every few minutes): stopped or removed in the
 * admin → back to pairing; its branch renamed or a till screen added → kept up to date.
 */
let lastCheck = 0;
async function checkDevice() {
  if (!cfg?.device || !app.isReady()) return;
  lastCheck = Date.now();
  if (!deviceKey()) return forgetDevice();
  const r = await api.deviceMe();
  if (!r) return;
  if (r === "gone") return forgetDevice();
  if (r === "stopped" || r === "removed") return stoppedInAdmin(r);
  if (!cfg.device) return;
  const next = { ...r, pairedAt: cfg.device.pairedAt };
  if (JSON.stringify(next) !== JSON.stringify(cfg.device)) {
    cfg = { ...cfg, device: next };
    config.save(cfg);
    changed();
  }
}
setInterval(() => void checkDevice(), 3 * 60_000);

// ─── the fingerprint device through this computer (iclock-relay.js) ─────────────

const relay = createRelay({
  forward: (f) => api.relayIclock(f),
  log: (msg, extra) => console.warn(msg, extra ?? ""),
});
/** The devices linked to this computer, as the API last said (shown in the settings). */
let relayDevices = /** @type {Array<{ id: string, name: string, serialNumber: string, active: boolean, lastSeenAt: string | null, lastIp: string | null, online: boolean }>} */ ([]);
let relayCheckedAt = /** @type {string | null} */ (null);

/**
 * Listens for the fingerprint device while this computer is set up and the admin linked a device to it
 * (or «استقبل البصمة من الجهاز» is on); stops otherwise. With no answer from the API, what it said last.
 */
let relaySyncing = Promise.resolve();
function syncRelay() {
  // one at a time (the timer, a saved setting and a setup may ask together): never two servers on one port
  relaySyncing = relaySyncing.then(syncRelayNow, syncRelayNow);
  return relaySyncing;
}
async function syncRelayNow() {
  if (!cfg) return;
  const paired = !!cfg.device && !!deviceKey();
  if (paired) {
    const r = await api.relayStatus();
    if (r) {
      relayDevices = r.devices;
      relayCheckedAt = new Date().toISOString();
      const linked = r.devices.some((d) => d.active);
      if (linked !== cfg.fingerprintLinked) {
        cfg = { ...cfg, fingerprintLinked: linked };
        config.save(cfg);
      }
    }
  } else {
    relayDevices = [];
  }
  if (paired && (cfg.fingerprintRelay || cfg.fingerprintLinked)) {
    if (await relay.start(cfg.fingerprintPort)) void ensureFirewall();
  } else await relay.stop();
}
setInterval(() => void syncRelay(), 3 * 60_000);

/**
 * The Windows firewall: the device on the shop's network must be let in to this program's port. A rule
 * (this program, TCP <port>, from the local network only) is added when Windows lets us without an
 * administrator (the program run as one); otherwise the settings say how, with a button that asks Windows
 * for an administrator once (UAC). Windows may also ask by itself the first time the program listens.
 */
const RULE = "VOLAR fingerprint device";
const sh = (/** @type {string} */ cmd) =>
  new Promise((resolve) => exec(cmd, { windowsHide: true, timeout: 20_000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? "") })));
const ruleCmd = (/** @type {number} */ port) =>
  `netsh advfirewall firewall add rule name="${RULE}" dir=in action=allow protocol=TCP localport=${port} remoteip=localsubnet profile=any program="${process.execPath}" enable=yes`;
async function firewallRuleThere(/** @type {number} */ port) {
  const r = /** @type {{ ok: boolean, out: string }} */ (await sh(`netsh advfirewall firewall show rule name="${RULE}" verbose`));
  return r.ok && new RegExp(`\\b${port}\\b`).test(r.out);
}
let firewallChecked = 0;
async function ensureFirewall() {
  if (process.platform !== "win32" || firewallChecked === cfg.fingerprintPort) return;
  firewallChecked = cfg.fingerprintPort;
  let state = /** @type {import("./config").Config["firewall"]} */ ("exists");
  if (!(await firewallRuleThere(cfg.fingerprintPort))) {
    const r = /** @type {{ ok: boolean }} */ (await sh(ruleCmd(cfg.fingerprintPort)));
    state = r.ok && (await firewallRuleThere(cfg.fingerprintPort)) ? "added" : "needs-admin";
  }
  if (state !== cfg.firewall) {
    cfg = { ...cfg, firewall: state };
    config.save(cfg);
  }
}
/** «افتح البورت في الجدار الناري»: Windows asks for an administrator once, then the rule is checked again. */
async function addFirewallRuleAsAdmin() {
  if (process.platform !== "win32") return cfg.firewall;
  const line = `netsh advfirewall firewall delete rule name="${RULE}" & ${ruleCmd(cfg.fingerprintPort)}`;
  const ps = `Start-Process -FilePath cmd.exe -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '/c ${line.replace(/'/g, "''")}'`;
  // its own arguments (no shell in between): refused or cancelled at the Windows prompt, the rule just isn't there
  await new Promise((resolve) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 120_000 }, () => resolve(null)));
  cfg = { ...cfg, firewall: (await firewallRuleThere(cfg.fingerprintPort)) ? "added" : "failed" };
  config.save(cfg);
  firewallChecked = cfg.fingerprintPort;
  return cfg.firewall;
}

/** What the settings show: whether it listens, the addresses to type in the device, when it last called. */
function relayInfo() {
  const st = relay.status();
  return {
    ...st,
    enabled: cfg.fingerprintRelay,
    linked: cfg.fingerprintLinked,
    paired: !!cfg.device && !!deviceKey(),
    port: cfg.fingerprintPort,
    addresses: lanAddresses().map((a) => ({ name: a.name, address: a.address })),
    devices: relayDevices,
    checkedAt: relayCheckedAt,
    firewall: cfg.firewall,
    windows: process.platform === "win32",
  };
}

/** Stopped (or removed) from the admin: said clearly, then back to setting the computer up. */
let tellingStopped = false;
async function stoppedInAdmin(/** @type {"stopped" | "removed"} */ why) {
  if (tellingStopped) return;
  tellingStopped = true;
  try {
    const message = why === "stopped" ? "الجهاز ده اتوقف من الإدارة" : "الجهاز ده اتشال من الإدارة";
    const detail = "كل اللي كانوا داخلين عليه خرجوا. عشان يشتغل تاني لازم يتجهز من جديد بكود QR (أو يتشغّل من الإدارة الأول).";
    if (win && !win.isDestroyed()) await dialog.showMessageBox(win, { type: "warning", buttons: ["تمام"], defaultId: 0, title: "VOLAR", message, detail });
    forgetDevice();
  } finally {
    tellingStopped = false;
  }
}

// ─── the settings window (settings-preload.js) ─────────────────────────────────

const fromSettings = (/** @type {Electron.IpcMainInvokeEvent | Electron.IpcMainEvent} */ e) => !!settingsWin && e.sender === settingsWin.webContents;

ipcMain.handle("settings:get", (e) => {
  if (!fromSettings(e)) return null;
  const { deviceKey: _key, ...shown } = cfg;
  return { ...shown, version: app.getVersion(), update: updates.status(), relay: relayInfo() };
});
/** The fingerprint device's state now (the settings refresh it every few seconds); `check`: ask the API again. */
ipcMain.handle("settings:relay", async (e, check) => {
  if (!fromSettings(e)) return null;
  if (check) await syncRelay();
  return relayInfo();
});
ipcMain.handle("settings:firewall", async (e) => {
  if (!fromSettings(e)) return null;
  await addFirewallRuleAsAdmin();
  return relayInfo();
});
/** Unpair this computer here: the server is told (the computer is stopped there, its sessions end), then back to the setup QR. */
ipcMain.handle("settings:unpair", async (e) => {
  if (!fromSettings(e) || !settingsWin || !cfg.device) return false;
  const { response } = await dialog.showMessageBox(settingsWin, {
    type: "warning", buttons: ["فك الربط", "رجوع"], defaultId: 1, cancelId: 1, title: "فك ربط الكمبيوتر",
    message: "الكمبيوتر هيرجع زي الجديد: كل اللي داخلين عليه هيخرجوا، ولازم يتجهز تاني بكود QR.",
  });
  if (response !== 0) return false;
  if ((await api.unpair()) === "offline") {
    const { response: anyway } = await dialog.showMessageBox(settingsWin, {
      type: "warning", buttons: ["فكّه من هنا بس", "رجوع"], defaultId: 1, cancelId: 1, title: "فك ربط الكمبيوتر",
      message: "مقدرناش نوصل للسيرفر عشان نبلّغه.",
      detail: "لو فكّيته من هنا بس، هيفضل شغال في الإدارة لحد ما حد يوقّفه من هناك (الإدارة ← الأجهزة).",
    });
    if (anyway !== 0) return false;
  }
  forgetDevice();
  return true;
});
ipcMain.on("settings:install-update", (e) => {
  if (fromSettings(e)) updates.installNow();
});
ipcMain.handle("settings:printers", (e) => (fromSettings(e) ? printers() : []));
ipcMain.handle("settings:save", async (e, next) => {
  if (!fromSettings(e) || typeof next !== "object" || !next) return { ok: false, error: "refused" };
  const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v.slice(0, 200) : "");
  const kioskChanged = !!next.kiosk !== cfg.kiosk;
  const port = Number(next.fingerprintPort);
  const fingerprintPort = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : cfg.fingerprintPort;
  cfg = {
    ...cfg, receiptPrinter: str(next.receiptPrinter), labelPrinter: str(next.labelPrinter), kiosk: !!next.kiosk, startWithWindows: !!next.startWithWindows,
    fingerprintRelay: !!next.fingerprintRelay, fingerprintPort, ...(fingerprintPort !== cfg.fingerprintPort && { firewall: /** @type {const} */ ("") }),
  };
  config.save(cfg);
  applyStartup();
  await syncRelay();
  if (win && kioskChanged) win.setKiosk(cfg.kiosk);
  return { ok: true, reachable: await api.ping() };
});
ipcMain.handle("settings:test", async (e, kind) => {
  if (!fromSettings(e)) return { ok: false, error: "refused" };
  const deviceName = kind === "labels" ? cfg.labelPrinter : cfg.receiptPrinter;
  if (!deviceName) return { ok: false, error: "اختار الطابعة واحفظ الأول" };
  const test = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await test.loadFile(path.join(__dirname, "test-print.html"), { query: { kind } });
  const r = await new Promise((resolve) =>
    test.webContents.print({ silent: true, deviceName, printBackground: true }, (ok, reason) => resolve(ok ? { ok: true } : { ok: false, error: reason || "failed" })),
  );
  test.destroy();
  return r;
});

// ─── start ──────────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  cfg = config.load();
  applyStartup();
  // no menu bar; a Mac still needs the app and Edit menus, or Cmd+C / Cmd+V / Cmd+Q do nothing
  Menu.setApplicationMenu(process.platform === "darwin" ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }]) : null);
  updates.start();
  // Windows shows notifications under the app's own name only with its id set
  if (process.platform === "win32") app.setAppUserModelId("com.volar.desktop");
  // our own screens may copy, show notifications (sales, requests…) when the person turned them on,
  // and use the microphone for a voice message to the assistant (sound only, never the camera)
  session.defaultSession.setPermissionRequestHandler((wc, permission, done, details) => {
    const voice = permission === "media" && Array.isArray(details?.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every((t) => t === "audio");
    done(isOurs(wc.getURL()) && (permission === "clipboard-sanitized-write" || permission === "notifications" || voice));
  });
  void createWindow();
  setTimeout(() => void checkDevice(), 3_000);
  setTimeout(() => void syncRelay(), 5_000);
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  stopUi();
  void relay.stop();
});

process.on("uncaughtException", (err) => {
  dialog.showErrorBox("VOLAR", `حصلت مشكلة: ${err.message}`);
});
