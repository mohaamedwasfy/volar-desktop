// @ts-check
/**
 * VOLAR on the shop's computers: a program of its own.
 *
 *   - The screens are packaged inside it (ui.js) and open with no internet at all.
 *   - The computer is paired with a branch once (a 6-character code an admin approves); its
 *     device key is kept encrypted in the settings (config.js).
 *   - The program calls the API itself (api.js) as whoever signed in on the branch's sign-in
 *     screen (the phone's QR or a password), its tokens encrypted on this computer, out of reach
 *     of the screens. Lock: the next cashier signs in.
 *   - When the API can't be reached the screens work from what they saved and queue what
 *     the till does; it's all sent when the API answers again (Volar-admin, the till's offline.ts).
 *   - Receipts and labels print straight to the printers chosen on this computer.
 *   - Updates come by themselves (updates.js).
 *
 * The window shows only the program's own screens; any other address opens in the browser.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, net, session, shell } = require("electron");
const os = require("node:os");
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
  cfg = { ...cfg, device: null, deviceKey: "" };
  config.save(cfg);
  api.forgetAll();
  changed();
}

ipcMain.handle("device:state", (e) => {
  if (!fromScreens(e)) return null;
  // the screens just opened (or reloaded): ask the API who this computer is, at most every 10 seconds
  if (Date.now() - lastCheck > 10_000) void checkDevice();
  const paired = !!cfg.device && !!deviceKey();
  return { paired, device: paired ? cfg.device : null, current: api.current(), computerName: os.hostname() };
});
/** A pairing code to show (the same one while it is still good, unless a new one is asked for). */
ipcMain.handle("device:pair-start", (e, fresh) => (fromScreens(e) && !cfg.device ? api.pairStart(!!fresh) : { error: "refused" }));
/** Polled every few seconds while the code shows: approved, this computer keeps its key (encrypted) and learns who it is. */
ipcMain.handle("device:pair-claim", async (e) => {
  if (!fromScreens(e) || cfg.device) return { status: "EXPIRED", message: "refused" };
  const r = await api.pairClaim();
  if (r.status !== "PAIRED" || !("key" in r)) return r;
  cfg = {
    ...cfg,
    deviceKey: config.sealKey(r.key),
    device: { id: r.deviceId, name: os.hostname(), tillNumber: r.tillNumber, branch: r.branch, screens: [], pairedAt: new Date().toISOString() },
  };
  config.save(cfg);
  await checkDevice();
  // whoever is signed in already (the owner, right after the shop's first setup) works on this computer now
  await api.bindCurrent();
  changed();
  return { status: "PAIRED", device: cfg.device };
});
/** Sign-in with the phone app: the QR to show, then (every few seconds) whether it was approved. */
ipcMain.handle("device:qr-start", (e) => (fromScreens(e) && cfg.device ? api.qrStart() : { error: "refused" }));
ipcMain.handle("device:qr-claim", (e, id) => {
  if (!fromScreens(e) || typeof id !== "string" || id.length > 64 || !cfg.device) return { status: "EXPIRED" };
  return api.qrClaim(id);
});
ipcMain.handle("device:lock", (e) => {
  if (fromScreens(e)) api.lock();
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
  if (!cfg.device) return;
  const next = { ...r, pairedAt: cfg.device.pairedAt };
  if (JSON.stringify(next) !== JSON.stringify(cfg.device)) {
    cfg = { ...cfg, device: next };
    config.save(cfg);
    changed();
  }
}
setInterval(() => void checkDevice(), 3 * 60_000);

// ─── the settings window (settings-preload.js) ─────────────────────────────────

const fromSettings = (/** @type {Electron.IpcMainInvokeEvent | Electron.IpcMainEvent} */ e) => !!settingsWin && e.sender === settingsWin.webContents;

ipcMain.handle("settings:get", (e) => {
  if (!fromSettings(e)) return null;
  const { deviceKey: _key, ...shown } = cfg;
  return { ...shown, version: app.getVersion(), update: updates.status() };
});
/** Unpair this computer here (it stays in the admin's list until stopped there): back to the pairing code. */
ipcMain.handle("settings:unpair", async (e) => {
  if (!fromSettings(e) || !settingsWin || !cfg.device) return false;
  const { response } = await dialog.showMessageBox(settingsWin, {
    type: "warning", buttons: ["فك الربط", "رجوع"], defaultId: 1, cancelId: 1, title: "فك ربط الكمبيوتر",
    message: "الكمبيوتر هيرجع زي الجديد: كل اللي داخلين عليه هيخرجوا، ولازم يتربط تاني بكود.",
  });
  if (response !== 0) return false;
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
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => stopUi());

process.on("uncaughtException", (err) => {
  dialog.showErrorBox("VOLAR", `حصلت مشكلة: ${err.message}`);
});
