// @ts-check
/**
 * VOLAR on the shop's computers.
 *
 * A thin, locked-down window around the hosted dashboard: every change deployed to the
 * dashboard reaches every branch at once, without reinstalling. What a browser can't do
 * lives here, behind a small bridge (preload.js):
 *
 *   - printing receipts and barcode labels straight to the branch's printers, no dialog
 *   - this computer's own settings (which printer prints what, full screen, start with Windows)
 *
 * The window only ever shows the dashboard's own address; anything else opens in the
 * normal browser. The bridge answers only pages from that address.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require("electron");
const path = require("node:path");
const config = require("./config");
const updates = require("./updates");

/** @type {BrowserWindow | null} */
let win = null;
/** @type {BrowserWindow | null} */
let settingsWin = null;
let cfg = /** @type {import("./config").Config} */ (/** @type {unknown} */ (null));

// one VOLAR per computer: a second start brings the open one forward
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

/** `--server=http://localhost:3002` while developing. */
const serverArg = () => {
  const a = process.argv.find((x) => x.startsWith("--server="));
  return a ? config.cleanUrl(a.slice("--server=".length)) : null;
};
const origin = () => config.cleanUrl(cfg.serverUrl);

/** The bridge answers the dashboard only (never another site the window was sent to). */
function fromDashboard(/** @type {Electron.IpcMainInvokeEvent | Electron.IpcMainEvent} */ e) {
  try {
    return !!origin() && e.senderFrame !== null && new URL(e.senderFrame.url).origin === origin();
  } catch {
    return false;
  }
}

function applyStartup() {
  // only for the installed app: a development run mustn't add itself to Windows' startup
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: cfg.startWithWindows });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: "VOLAR",
    backgroundColor: "#FFFCF6",
    autoHideMenuBar: true,
    kiosk: cfg.kiosk,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => {
    if (!cfg.kiosk) win?.maximize();
    win?.show();
  });

  const wc = win.webContents;
  // stay on the dashboard; links elsewhere open in the normal browser
  wc.on("will-navigate", (e, url) => {
    if (sameOrigin(url)) return;
    e.preventDefault();
    openOutside(url);
  });
  // a server redirect elsewhere is stopped too (it doesn't pass through will-navigate)
  wc.on("will-redirect", (e, url, _inPlace, isMain) => {
    if (isMain && !sameOrigin(url)) e.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) {
      void win?.loadURL(url);
    } else openOutside(url);
    return { action: "deny" };
  });
  // the shop's internet dropped, or the address is wrong: a quiet page that keeps trying
  wc.on("did-fail-load", (_e, code, _desc, url, isMain) => {
    if (!isMain || code === -3) return; // -3: a navigation replaced by another
    void win?.loadFile(path.join(__dirname, "offline.html"), { query: { url: url || origin() || "" } });
  });
  wc.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    if (input.control && input.shift && key === "s") { e.preventDefault(); openSettings(); }
    else if (key === "f5" || (input.control && key === "r")) { e.preventDefault(); wc.reload(); }
    else if (input.control && input.shift && key === "i" && !app.isPackaged) { e.preventDefault(); wc.toggleDevTools(); }
    else if (key === "f11" && !cfg.kiosk) { e.preventDefault(); win?.setFullScreen(!win.isFullScreen()); }
  });

  start();
}

const sameOrigin = (/** @type {string} */ url) => {
  try {
    return new URL(url).origin === origin();
  } catch {
    return false;
  }
};
const openOutside = (/** @type {string} */ url) => {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
};

/** The dashboard, or the settings first when this computer doesn't know where it is yet. */
function start() {
  const o = origin();
  if (!o) return openSettings(true);
  void win?.loadURL(`${o}/`);
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
    backgroundColor: "#FFFCF6",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "settings-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  void settingsWin.loadFile(path.join(__dirname, "settings.html"));
  settingsWin.on("closed", () => {
    settingsWin = null;
    // closed without an address on the very first run: nothing to show
    if (!origin()) app.quit();
  });
}

/** The Windows printers this computer can print to. */
async function printers() {
  const wc = (settingsWin ?? win)?.webContents;
  if (!wc) return [];
  return (await wc.getPrintersAsync()).map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
}

/**
 * Prints a page (the dashboard's print styles decide what's on paper): to the printer this
 * computer set for that kind of paper, with no dialog; with the usual dialog when none is set.
 * @param {Electron.WebContents} wc
 * @param {"receipt" | "labels" | "page"} kind
 */
function printOn(wc, kind) {
  const deviceName = kind === "receipt" ? cfg.receiptPrinter : kind === "labels" ? cfg.labelPrinter : "";
  return new Promise((resolve) => {
    wc.print({ silent: !!deviceName, deviceName: deviceName || undefined, printBackground: true }, (ok, reason) =>
      resolve(ok ? { ok: true } : { ok: false, error: reason === "cancelled" ? "cancelled" : reason || "failed" }),
    );
  });
}

// ─── the bridge (preload.js) ────────────────────────────────────────────────────

ipcMain.handle("desktop:info", (e) => {
  if (!fromDashboard(e)) return null;
  return { version: app.getVersion(), deviceId: cfg.deviceId, printers: { receipt: !!cfg.receiptPrinter, labels: !!cfg.labelPrinter } };
});
ipcMain.handle("desktop:print", async (e, kind) => {
  if (!fromDashboard(e) || !["receipt", "labels", "page"].includes(kind)) return { ok: false, error: "refused" };
  return printOn(e.sender, kind);
});
ipcMain.on("desktop:settings", (e) => {
  if (fromDashboard(e)) openSettings();
});

// ─── the settings window (settings-preload.js) ─────────────────────────────────

const fromSettings = (/** @type {Electron.IpcMainInvokeEvent} */ e) => !!settingsWin && e.sender === settingsWin.webContents;

ipcMain.handle("settings:get", (e) => (fromSettings(e) ? { ...cfg, version: app.getVersion(), update: updates.status() } : null));
ipcMain.on("settings:install-update", (e) => {
  if (fromSettings(e)) updates.installNow();
});
ipcMain.handle("settings:printers", (e) => (fromSettings(e) ? printers() : []));
ipcMain.handle("settings:save", (e, next) => {
  if (!fromSettings(e) || typeof next !== "object" || !next) return { ok: false, error: "refused" };
  const url = config.cleanUrl(next.serverUrl);
  if (!url) return { ok: false, error: "عنوان اللوحة لازم يكون https://… (أو http://localhost وقت التطوير)" };
  const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v.slice(0, 200) : "");
  const moved = url !== origin();
  const kioskChanged = !!next.kiosk !== cfg.kiosk;
  cfg = { ...cfg, serverUrl: url, receiptPrinter: str(next.receiptPrinter), labelPrinter: str(next.labelPrinter), kiosk: !!next.kiosk, startWithWindows: !!next.startWithWindows };
  config.save(cfg);
  applyStartup();
  if (win && kioskChanged) win.setKiosk(cfg.kiosk);
  if (moved) start();
  return { ok: true };
});
ipcMain.handle("settings:test", async (e, kind) => {
  if (!fromSettings(e)) return { ok: false, error: "refused" };
  const deviceName = kind === "labels" ? cfg.labelPrinter : cfg.receiptPrinter;
  if (!deviceName) return { ok: false, error: "اختار الطابعة واحفظ الأول" };
  // a small page printed on its own, never shown
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
  const dev = serverArg();
  if (dev) cfg = { ...cfg, serverUrl: dev };
  applyStartup();
  Menu.setApplicationMenu(null);
  updates.start();
  // the dashboard asks for nothing beyond copying text (passwords, codes)
  session.defaultSession.setPermissionRequestHandler((wc, permission, done) => {
    done(sameOrigin(wc.getURL()) && permission === "clipboard-sanitized-write");
  });
  createWindow();
});

app.on("window-all-closed", () => app.quit());

process.on("uncaughtException", (err) => {
  dialog.showErrorBox("VOLAR", `حصلت مشكلة: ${err.message}`);
});
