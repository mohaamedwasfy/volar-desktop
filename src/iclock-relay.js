// @ts-check
/**
 * The fingerprint device's way to the server through this computer (relay mode).
 *
 * The shop's internet has no fixed or public address, so the ZKTeco device can't reach the server by
 * itself safely. Instead it pushes (iclock/ADMS) to this computer on the shop's own network —
 * http://<this computer's LAN address>:8081/iclock/… — and this small server passes every request on to
 * the API (`forward`: /v1/attendance/iclock-relay/<same path>, over HTTPS with this computer's own key),
 * then hands the device the API's answer as it is (status and text). Nothing is opened on the router.
 *
 *   - only /iclock/* is served (404 for anything else), GET and POST only;
 *   - only from the private network (10/8, 172.16/12, 192.168/16) and this computer itself (127.0.0.1);
 *   - a body is at most 2 MB (the API's own limit);
 *   - the API not answering: 503, so the device keeps its punches and sends them again later.
 *
 * No Electron here (tested with plain Node: scripts/test-relay.mjs).
 */
const http = require("node:http");
const os = require("node:os");

const MAX_BODY = 2 * 1024 * 1024;
const DEFAULT_PORT = 8081;

/** An address of the shop's own network (or this computer): the only callers taken. */
function isPrivate(/** @type {string | undefined} */ address) {
  if (!address) return false;
  const a = address.replace(/^::ffff:/i, "");
  if (a === "::1" || a === "127.0.0.1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
}

/** This computer's IPv4 addresses on its networks (what to type in the device), private ones first. */
function lanAddresses() {
  /** @type {Array<{ name: string, address: string }>} */
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) out.push({ name, address: i.address });
  }
  return out.sort((a, b) => Number(isPrivate(b.address)) - Number(isPrivate(a.address)));
}

/**
 * @typedef {{ method: string, path: string, contentType: string, body: Buffer | undefined, deviceIp: string }} Forward
 * @typedef {{ status: number, contentType: string, body: string }} Reply
 * @typedef {{
 *   listening: boolean, port: number, error: string | null,
 *   lastSeenAt: string | null, lastDeviceIp: string | null, lastSn: string | null,
 *   lastStatus: number | null, lastFailure: string | null, lastFailureAt: string | null, forwarded: number, failed: number,
 * }} RelayStatus
 */

/**
 * @param {{ forward: (f: Forward) => Promise<Reply>, log?: (msg: string, extra?: object) => void }} o
 */
function createRelay(o) {
  /** @type {http.Server | null} */
  let server = null;
  /** @type {RelayStatus} */
  const st = {
    listening: false, port: DEFAULT_PORT, error: null,
    lastSeenAt: null, lastDeviceIp: null, lastSn: null, lastStatus: null, lastFailure: null, lastFailureAt: null, forwarded: 0, failed: 0,
  };
  const log = o.log ?? (() => {});

  const plain = (/** @type {http.ServerResponse} */ res, /** @type {number} */ status, /** @type {string} */ text) => {
    res.writeHead(status, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(text), Connection: "close" });
    res.end(text);
  };

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handle(req, res) {
    const from = (req.socket.remoteAddress ?? "").replace(/^::ffff:/i, "");
    if (!isPrivate(from)) {
      req.resume();
      log("iclock relay: refused a caller outside the shop's network", { from });
      return plain(res, 403, "Forbidden");
    }
    const url = new URL(req.url ?? "/", "http://device");
    // /iclock/cdata, /iclock/getrequest… (the device may write it in any case: the API's paths are lower case)
    const m = /^\/iclock(\/[A-Za-z0-9_.-]+)+$/i.exec(url.pathname);
    if (!m || url.pathname.includes("..")) {
      req.resume();
      return plain(res, 404, "Not Found");
    }
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      req.resume();
      return plain(res, 404, "Not Found");
    }
    if (Number(req.headers["content-length"] || 0) > MAX_BODY) {
      req.resume();
      return plain(res, 413, "Too large");
    }
    /** @type {Buffer | undefined} */
    let body;
    if (method === "POST") {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += /** @type {Buffer} */ (chunk).length;
        if (size > MAX_BODY) return plain(res, 413, "Too large");
        chunks.push(/** @type {Buffer} */ (chunk));
      }
      body = Buffer.concat(chunks);
    } else req.resume();

    st.lastSeenAt = new Date().toISOString();
    st.lastDeviceIp = from;
    st.lastSn = url.searchParams.get("SN") ?? url.searchParams.get("sn");
    const path = url.pathname.slice("/iclock".length).toLowerCase() + url.search;
    try {
      const r = await o.forward({ method, path, contentType: String(req.headers["content-type"] ?? ""), body, deviceIp: from });
      st.lastStatus = r.status;
      st.forwarded++;
      if (r.status >= 400) {
        st.lastFailure = `السيرفر رد ${r.status}`;
        st.lastFailureAt = st.lastSeenAt;
      }
      res.writeHead(r.status, { "Content-Type": r.contentType || "text/plain", "Content-Length": Buffer.byteLength(r.body), Connection: "close" });
      res.end(r.body);
    } catch (e) {
      // the server can't be reached: never OK, so the device keeps its punches and tries again
      st.failed++;
      st.lastStatus = 503;
      st.lastFailure = String(/** @type {Error} */ (e)?.message ?? e);
      st.lastFailureAt = st.lastSeenAt;
      log("iclock relay: the API didn't answer", { error: st.lastFailure });
      plain(res, 503, "Server unreachable");
    }
  }

  /** Listens on every network of this computer at `port` (restarted when the port changes). */
  function start(/** @type {number} */ port = DEFAULT_PORT) {
    if (server && st.port === port && st.listening) return Promise.resolve(true);
    return stop().then(
      () =>
        new Promise((resolve) => {
          st.port = port;
          st.error = null;
          const s = http.createServer((req, res) => {
            handle(req, res).catch((e) => {
              log("iclock relay: request failed", { error: String(e?.message ?? e) });
              if (!res.headersSent) plain(res, 500, "Error");
              else res.destroy();
            });
          });
          s.requestTimeout = 60_000;
          s.headersTimeout = 15_000;
          s.maxHeadersCount = 50;
          s.once("error", (/** @type {NodeJS.ErrnoException} */ e) => {
            st.listening = false;
            st.error = e.code === "EADDRINUSE" ? `البورت ${port} مستخدم من برنامج تاني` : e.code === "EACCES" ? `مش مسموح نفتح البورت ${port}` : String(e.message);
            server = null;
            resolve(false);
          });
          s.listen(port, "0.0.0.0", () => {
            server = s;
            st.listening = true;
            resolve(true);
          });
        }),
    );
  }

  /** @returns {Promise<void>} */
  function stop() {
    const s = server;
    server = null;
    st.listening = false;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections?.();
    });
  }

  return { start, stop, status: () => ({ ...st }), running: () => !!server };
}

module.exports = { createRelay, lanAddresses, isPrivate, DEFAULT_PORT, MAX_BODY };
