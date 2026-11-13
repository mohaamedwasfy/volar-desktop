// @ts-check
/**
 * VOLAR on the shop's computers: a program of its own.
 *
 *   - The screens are packaged inside it (ui.js) and open with no internet at all.
 *   - The program calls the API itself (api.js): signed in as an app, its tokens encrypted
 *     on this computer, out of reach of the screens.
 *   - When the API can't be reached the screens work from what they saved and queue what
 *     the till does; it's all sent when the API answers again (Volar-admin src/lib/offline).
 *   - Receipts and labels print straight to the printers chosen on this computer.
 *   - Updates come by themselves (updates.js).
 *
 * The window shows only the program's own screens; any other address opens in the browser.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require("electron");
const path = require("node:path");
const config = require("./config");
const updates = require("./updates");
const { startUi, stopUi, ORIGIN } = require("./ui");
const { createApi } = require("./api");

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

/** `--api=http://localhost:4000/v1` and `--ui=http://localhost:3002` while developing. */
const arg = (/** @type {string} */ name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};

// the built-in address; `--api=` only while developing (an installed program ignores it: a
// changed shortcut must not point the till at another server that would collect passwords)
const API = (!app.isPackaged && config.cleanUrl(arg("api"))) || config.API_URL;
const api = createApi(() => API);

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
    else if (key === "f5" || (input.control && key === "r")) { e.preventDefault(); wc.reload(); }
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
    height: 720,
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
 * @returns {{ pageSize: string | { width: number, height: number }, margins?: { marginType: "none" } } | {}}
 */
function paperOf(page) {
  if (typeof page !== "object" || !page) return {};
  const { widthMm, heightMm, paper } = /** @type {any} */ (page);
  if (paper === "A4") return { pageSize: "A4" };
  const ok = (/** @type {unknown} */ n, /** @type {number} */ min, /** @type {number} */ max) => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
  if (!ok(widthMm, 20, 300) || !ok(heightMm, 10, 2000)) return {};
  // Electron takes microns here
  return { pageSize: { width: Math.round(widthMm * 1000), height: Math.round(heightMm * 1000) }, margins: { marginType: "none" } };
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

// ─── this computer: its branch, its staff, who is using it ─────────────────────

ipcMain.handle("device:state", (e) => {
  if (!fromScreens(e)) return null;
  // set up by an older version (before computers were registered): no key, so no QR and no
  // remote control until the owner sets it up again
  return { device: cfg.device, current: api.current(), accounts: api.accounts(), registered: !!cfg.device?.id && api.hasDeviceKey() };
});
/** Only the owner (or whoever runs the settings) sets the computer up, signed in on it right now. */
ipcMain.handle("device:setup", async (e, d) => {
  if (!fromScreens(e) || typeof d !== "object" || !d) return { ok: false, error: "refused" };
  const meRes = await api.request({ method: "GET", url: "https://api.volar.app/v1/auth/me", headers: {}, body: null });
  if ("networkError" in meRes) return { ok: false, error: "الإعداد محتاج نت" };
  const who = JSON.parse(meRes.body || "{}")?.data;
  if (!who || !(who.isOwner || who.permissions?.includes("settings.manage"))) return { ok: false, error: "إعداد الجهاز للمالك بس" };
  const str = (/** @type {unknown} */ v, n = 120) => (typeof v === "string" ? v.slice(0, n) : "");
  const staff = (Array.isArray(d.staff) ? d.staff : []).slice(0, 200).map((/** @type {any} */ s) => ({ id: str(s?.id, 64), name: str(s?.name), username: str(s?.username, 60), role: str(s?.role, 60) })).filter((s) => s.id && s.name);
  if (!str(d.branchId, 64) || !staff.length) return { ok: false, error: "اختار الفرع وواحد على الأقل من الموظفين" };
  // registered with the API: the owner sees it in the dashboard and can lock, stop or sign out of it
  const reg = await api.request({
    method: "POST",
    url: "https://api.volar.app/v1/devices",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branchId: str(d.branchId, 64), staffIds: staff.map((s) => s.id), ...(cfg.device?.id && { replaces: cfg.device.id }) }),
  });
  const registered = "networkError" in reg ? null : JSON.parse(reg.body || "{}")?.data;
  if (!registered?.id || !registered?.key) return { ok: false, error: "مقدرتش أسجل الجهاز في السيستم. جرّب تاني." };
  api.setDeviceKey(registered.key);
  cfg = { ...cfg, device: { id: registered.id, name: registered.name, branchId: str(d.branchId, 64), branchName: str(d.branchName), staff, setupBy: who.id, setupAt: new Date().toISOString(), disabled: false } };
  config.save(cfg);
  void checkInNow();
  return { ok: true };
});
/** Sign-in with the phone app: the QR to show, then (every two seconds) whether it was confirmed. */
ipcMain.handle("device:qr-start", async (e) => {
  if (!fromScreens(e) || !cfg.device || cfg.device.disabled) return { error: "refused" };
  const r = await api.qrStart();
  // refused (not just offline): it may have been removed; ask right away instead of at the next check-in
  if ("error" in r && r.error !== "offline") void checkInNow();
  return r;
});
ipcMain.handle("device:qr-claim", async (e, id) => {
  if (!fromScreens(e) || typeof id !== "string" || id.length > 64 || !cfg.device) return { status: "EXPIRED" };
  const staff = cfg.device.staff;
  const r = await api.qrClaim(id, (userId) => userId === cfg.device?.setupBy || staff.some((s) => s.id === userId));
  if (r.status === "SIGNED_IN") void checkInNow();
  return r;
});
ipcMain.handle("device:lock", (e) => {
  if (fromScreens(e)) {
    api.lock();
    void checkInNow();
  }
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

/** Tells the screens the computer's state changed (locked, signed out, stopped from the dashboard). */
const changed = () => win?.webContents.send("device:changed");

/** Every half minute: on, its version, who is using it; and what the owner asked from the dashboard. */
async function checkInNow() {
  if (!cfg?.device || !api.hasDeviceKey() || !app.isReady()) return;
  const r = await api.checkIn(app.getVersion(), cfg.device.staff.map((s) => s.id));
  if (!r) return;
  // deleted from the dashboard: back to a new computer, exactly like the first start
  if (r === "removed") {
    api.forgetAll();
    api.setDeviceKey(null);
    cfg = { ...cfg, device: null };
    config.save(cfg);
    changed();
    return;
  }
  let dirty = false;
  if (!!r.disabled !== !!cfg.device.disabled) {
    cfg = { ...cfg, device: { ...cfg.device, disabled: r.disabled } };
    dirty = true;
  }
  if (r.branch && (r.branch.id !== cfg.device.branchId || r.branch.name !== cfg.device.branchName || r.name !== cfg.device.name)) {
    cfg = { ...cfg, device: { ...cfg.device, branchId: r.branch.id, branchName: r.branch.name, name: r.name } };
    dirty = true;
  }
  if (dirty) config.save(cfg);
  if (r.command === "SIGN_OUT" || r.disabled) api.forgetAll();
  else if (r.command === "LOCK") api.lock();
  if (dirty || r.command) changed();
}
setInterval(() => void checkInNow(), 30_000);

// ─── the settings window (settings-preload.js) ─────────────────────────────────

const fromSettings = (/** @type {Electron.IpcMainInvokeEvent | Electron.IpcMainEvent} */ e) => !!settingsWin && e.sender === settingsWin.webContents;

ipcMain.handle("settings:get", (e) => (fromSettings(e) ? { ...cfg, version: app.getVersion(), update: updates.status() } : null));
ipcMain.on("settings:install-update", (e) => {
  if (fromSettings(e)) updates.installNow();
});
ipcMain.handle("settings:printers", (e) => (fromSettings(e) ? printers() : []));
ipcMain.handle("settings:save", async (e, next) => {
  if (!fromSettings(e) || typeof next !== "object" || !next) return { ok: false, error: "refused" };
  const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v.slice(0, 200) : "");
  const kioskChanged = !!next.kiosk !== cfg.kiosk;
  cfg = { ...cfg, receiptPrinter: str(next.receiptPrinter), labelPrinter: str(next.labelPrinter), kiosk: !!next.kiosk, startWithWindows: !!next.startWithWindows };
  config.save(cfg);
  applyStartup();
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
  Menu.setApplicationMenu(null);
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
  setTimeout(() => void checkInNow(), 3_000);
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => stopUi());

process.on("uncaughtException", (err) => {
  dialog.showErrorBox("VOLAR", `حصلت مشكلة: ${err.message}`);
});
