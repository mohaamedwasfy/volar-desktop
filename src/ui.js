// @ts-check
/**
 * The screens, packaged with the program (a production build of Volar-admin, in `ui/`),
 * served from this computer by the program itself and shown at volar://app. Nothing about
 * them needs the internet: only the data does.
 *
 * `--ui=http://localhost:3002` (development) shows the dashboard's dev server instead.
 */
const { app, net, protocol, utilityProcess } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const netModule = require("node:net");

const SCHEME = "volar";
const ORIGIN = `${SCHEME}://app`;

// before the app is ready: a real, secure origin, so the screens' saved data (IndexedDB) stays put
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

/** A free port on this computer for the screens' server. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = netModule.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => resolve(typeof a === "object" && a ? a.port : 0));
    });
  });

/** Where the packaged screens are: next to the program when installed, `ui/` while developing. */
const uiDir = () => (app.isPackaged ? path.join(process.resourcesPath, "ui") : path.join(__dirname, "..", "ui"));

/** @type {Electron.UtilityProcess | null} */
let server = null;

/**
 * Starts the screens' server and maps volar://app to it.
 * @param {string | null} devUrl the dashboard's dev server while developing
 * @returns {Promise<string>} the address to open
 */
async function startUi(devUrl) {
  let base = devUrl;
  if (!base) {
    const dir = uiDir();
    // start.js finds the server's packages in deps/ (see scripts/build-ui.mjs)
    const entry = path.join(dir, "start.js");
    if (!fs.existsSync(entry)) throw new Error(`الشاشات مش موجودة جوه البرنامج (${entry}). شغّل npm run build:ui.`);
    const port = await freePort();
    // Electron's own Node runs the server, in the background: nothing else to install on the computer
    server = utilityProcess.fork(entry, [], {
      env: { ...process.env, NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", NEXT_TELEMETRY_DISABLED: "1" },
      stdio: "ignore",
      serviceName: "VOLAR screens",
    });
    base = `http://127.0.0.1:${port}`;
    await waitFor(base);
  }
  const target = base.replace(/\/$/, "");
  protocol.handle(SCHEME, (req) => {
    const u = new URL(req.url);
    /** @type {Record<string, string>} */
    const headers = {};
    req.headers.forEach((v, k) => {
      if (k !== "origin" && k !== "host") headers[k] = v;
    });
    return net.fetch(`${target}${u.pathname}${u.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      // @ts-expect-error a streamed body needs it
      duplex: "half",
      bypassCustomProtocolHandlers: true,
    });
  });
  return `${ORIGIN}/`;
}

/** Waits until the screens' server answers (it takes a second or two to start). */
async function waitFor(base) {
  // a small file, not a page: the first page render takes a few seconds
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(`${base}/sw.js`, { signal: AbortSignal.timeout(3_000) });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error("الشاشات مفتحتش");
}

function stopUi() {
  server?.kill();
  server = null;
}

module.exports = { startUi, stopUi, ORIGIN };
