// @ts-check
/**
 * The program talks to the VOLAR API itself (the screens hand it every request), as the
 * staff member using the computer right now.
 *
 * Each person who signs in on this computer has their own session here: the API's tokens
 * (`X-Client-Type: desktop`, so they come in the body, never as cookies), kept encrypted with
 * Windows' protection in the program's data folder and never handed to the screens. A sign-in is
 * the phone's QR, or the password (and the 2FA code when it's on): nothing here opens a session
 * without the API. Only staff of this computer's branch get in, and every session here belongs to
 * this computer (a password sign-in is traded for one, see bindToDevice): the till needs that.
 *
 * The computer itself proves who it is with its device key (X-Device-Key), from pairing; it is
 * sent only on the device routes (who am I, the sign-in QR), never with the screens' requests.
 */
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * @typedef {{ access: string, refresh: string, name: string }} Account
 * @typedef {{ v: 2, current: string | null, accounts: Record<string, Account> }} Store
 * @typedef {{ accessToken: string, refreshToken: string }} Tokens
 * @typedef {{ status: number, headers: Record<string, string>, body: string | Buffer }} Answer
 */
/** @type {Store} */
let store = { v: 2, current: null, accounts: {} };
let loaded = false;
const file = () => path.join(app.getPath("userData"), "session.bin");

/** Windows' encryption works only once the program is ready: read the file on first use. */
function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(file());
    const json = JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString("utf8"));
    // the old system's sign-ins (0.5.x) don't work on the new API
    store = json && json.v === 2 && json.accounts ? json : { v: 2, current: null, accounts: {} };
  } catch {
    store = { v: 2, current: null, accounts: {} };
  }
  // the computer always opens locked: the next person scans the QR or types their password
  store.current = null;
}
function persist() {
  try {
    const json = JSON.stringify(store);
    fs.writeFileSync(file(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : json);
  } catch {
    /* written again on the next change */
  }
}

// headers the screens may not set: the program decides who is calling
const DROP = new Set(["host", "cookie", "origin", "referer", "authorization", "x-client-type", "x-device-key", "content-length", "connection", "user-agent"]);
/** Sign-ins whose answer carries tokens: they stay here, and the screens get the answer without them. */
const SIGN_IN = /^\/v1\/(auth\/login|auth\/mfa|auth\/passkeys\/login\/verify|core\/setup)(\?|$)/;
/** Routes only the program itself calls (they hand out sessions or the device key). */
const PROGRAM_ONLY = /^\/v1\/auth\/device\/(claim|pair|pair\/claim|qr)(\?|$)/;
const REFUSED_BRANCH = "الكمبيوتر ده في فرع مش من فروعك: ادخل من كمبيوتر فرعك";

/** An answer the program writes itself, shaped like the API's. */
const answer = (/** @type {number} */ status, /** @type {unknown} */ body) => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
const apiError = (/** @type {number} */ status, /** @type {string} */ code, /** @type {string} */ message) => answer(status, { success: false, error: { code, message } });

/**
 * @param {{
 *   base: () => string,
 *   deviceKey: () => string | null,
 *   branchId: () => string | null,
 *   onChange: () => void,
 *   onDeviceGone: () => void,
 * }} o
 */
function createApi(o) {
  const ua = `VOLAR-desktop/${app.getVersion()} (${os.hostname()})`;
  const url = (/** @type {string} */ p) => `${o.base()}${p}`;

  /** A call the program makes on its own (the device routes, sign-in checks). */
  async function call(/** @type {string} */ method, /** @type {string} */ p, /** @type {{ body?: unknown, token?: string, device?: boolean, timeout?: number }} */ opt = {}) {
    /** @type {Record<string, string>} */
    const h = { "X-Client-Type": "desktop", "User-Agent": ua };
    if (opt.body !== undefined) h["Content-Type"] = "application/json";
    if (opt.token) h.Authorization = `Bearer ${opt.token}`;
    if (opt.device) {
      const key = o.deviceKey();
      if (key) h["X-Device-Key"] = key;
    }
    const res = await fetch(url(p), { method, headers: h, body: opt.body === undefined ? undefined : JSON.stringify(opt.body), signal: AbortSignal.timeout(opt.timeout ?? 15_000) });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  /** @type {Map<string, Promise<"refreshed" | "expired" | "failed">>} */
  const refreshing = new Map();

  /** Renews one person's tokens. "expired": refused for good, they sign in again. */
  function refreshFor(/** @type {string} */ userId) {
    const acc = store.accounts[userId];
    if (!acc?.refresh) return Promise.resolve(/** @type {const} */ ("expired"));
    if (!refreshing.has(userId)) {
      refreshing.set(
        userId,
        (async () => {
          try {
            const r = await call("POST", "/v1/auth/refresh", { body: { refreshToken: acc.refresh } });
            const d = r.json?.data;
            if (r.status === 200 && d?.accessToken && d?.refreshToken) {
              acc.access = d.accessToken;
              acc.refresh = d.refreshToken;
              persist();
              return /** @type {const} */ ("refreshed");
            }
            if (r.status >= 400 && r.status < 500 && r.status !== 429) {
              // the session is gone (signed out elsewhere, the computer stopped, 30 days passed)
              delete store.accounts[userId];
              if (store.current === userId) {
                store.current = null;
                o.onChange();
              }
              persist();
              return /** @type {const} */ ("expired");
            }
            return /** @type {const} */ ("failed");
          } catch {
            return /** @type {const} */ ("failed");
          } finally {
            refreshing.delete(userId);
          }
        })(),
      );
    }
    return /** @type {Promise<"refreshed" | "expired" | "failed">} */ (refreshing.get(userId));
  }

  /**
   * A password sign-in opens a session of its own, not tied to any computer; the till's screen of
   * this computer only works with a session of THIS computer. So the computer trades it, through the
   * same steps as the phone's QR: it asks for a QR with its key, the person approves it with the
   * session they just opened (the API checks they're staff of this branch, and says why not), the
   * computer collects its own session for them, and the first one is signed out.
   * @param {Tokens} t
   * @returns {Promise<{ ok: true, tokens: Tokens } | { ok: false, status: number, code: string, message: string }>}
   */
  async function bindToDevice(t) {
    const fail = (/** @type {number} */ status, /** @type {any} */ json) => ({
      ok: /** @type {const} */ (false),
      status: status >= 400 && status < 600 ? status : 503,
      code: json?.error?.code ?? "DEVICE_BIND",
      message: json?.error?.message ?? "مقدرناش ندخّلك على الكمبيوتر ده دلوقتي. جرّب تاني.",
    });
    try {
      const qr = await call("POST", "/v1/auth/device/qr", { device: true });
      if (qr.status !== 200 || !qr.json?.data?.id) {
        if (deviceRefused(qr)) o.onDeviceGone();
        return fail(qr.status, qr.json);
      }
      const ticket = { id: qr.json.data.id, secret: qr.json.data.secret };
      const approved = await call("POST", "/v1/auth/device/approve", { token: t.accessToken, body: ticket });
      if (approved.status !== 200) return fail(approved.status, approved.json);
      const claimed = await call("POST", "/v1/auth/device/claim", { device: true, body: ticket });
      const tokens = claimed.json?.data?.tokens;
      if (claimed.status !== 200 || !tokens?.accessToken) return fail(claimed.status, claimed.json);
      return { ok: true, tokens };
    } catch {
      return { ok: false, status: 503, code: "NETWORK", message: "مفيش اتصال بالسيرفر. اتأكد من النت وجرّب تاني." };
    } finally {
      // the session the password opened is never kept: this computer has its own now (or nothing)
      await call("POST", "/v1/auth/logout", { token: t.accessToken, body: {} }).catch(() => {});
    }
  }

  /** The person signed in before this computer was paired (the owner, at the shop's first setup): their session becomes this computer's. */
  async function bindCurrent() {
    load();
    const id = store.current;
    const acc = id ? store.accounts[id] : null;
    if (!id || !acc || !o.deviceKey()) return;
    if ((await refreshFor(id)) !== "refreshed") return;
    const b = await bindToDevice({ accessToken: acc.access, refreshToken: acc.refresh });
    if (b.ok) {
      store.accounts[id] = { ...acc, access: b.tokens.accessToken, refresh: b.tokens.refreshToken };
    } else {
      delete store.accounts[id];
      store.current = null;
    }
    persist();
    o.onChange();
  }

  /**
   * New tokens from a sign-in: who they belong to, and whether that person may work on this
   * computer (staff of its branch; the owner and all-branches staff anywhere). Refused: that
   * session ends at once.
   * @param {Tokens} t
   * @param {{ checkBranch: boolean }} opt
   * @returns {Promise<{ ok: true, id: string, name: string } | { ok: false, status: number, code: string, message: string }>}
   */
  async function adopt(t, opt) {
    let me;
    try {
      const r = await call("GET", "/v1/auth/me", { token: t.accessToken });
      me = r.status === 200 ? r.json?.data : null;
    } catch {
      me = null;
    }
    if (!me?.id) return { ok: false, status: 503, code: "NETWORK", message: "مقدرناش نتأكد من حسابك دلوقتي. جرّب تاني." };
    const branchId = o.branchId();
    const allowed = me.isOwner || me.allBranches || (!!branchId && (me.branches ?? []).some((/** @type {{ id: string }} */ b) => b.id === branchId));
    if (opt.checkBranch && !allowed) {
      await call("POST", "/v1/auth/logout", { token: t.accessToken, body: {} }).catch(() => {});
      return { ok: false, status: 403, code: "DEVICE_BRANCH", message: REFUSED_BRANCH };
    }
    store.accounts[me.id] = { access: t.accessToken, refresh: t.refreshToken, name: me.name };
    store.current = me.id;
    persist();
    o.onChange();
    return { ok: true, id: me.id, name: me.name };
  }

  /**
   * @param {string} method
   * @param {string} pathAndQuery
   * @param {Record<string, string>} headers
   * @param {Buffer | string | undefined} body
   * @param {string | null} userId
   */
  async function send(method, pathAndQuery, headers, body, userId) {
    const acc = userId ? store.accounts[userId] : null;
    /** @type {Record<string, string>} */
    const h = { ...headers, "X-Client-Type": "desktop", "User-Agent": ua };
    if (acc?.access) h.Authorization = `Bearer ${acc.access}`;
    return fetch(url(pathAndQuery), { method, headers: h, body, signal: AbortSignal.timeout(60_000) });
  }

  /** Text stays text for the screens; anything else (a photo, a PDF, a spreadsheet) goes as bytes. */
  const isText = (/** @type {string} */ ct) => !ct || /^text\/|json|xml|javascript|csv/i.test(ct);

  /**
   * A request from the screens, as whoever is using the computer.
   * @param {unknown} input { method, path: "/v1/…", headers, body: string | Uint8Array | null }
   * @returns {Promise<Answer | { networkError: true, message: string }>}
   */
  async function request(input) {
    load();
    const r = /** @type {any} */ (input);
    const pathAndQuery = typeof r?.path === "string" ? r.path : "";
    if (!pathAndQuery.startsWith("/v1/") || pathAndQuery.includes("..") || pathAndQuery.length > 8000) return { networkError: true, message: "refused" };
    const method = String(r.method || "GET").toUpperCase();
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return { networkError: true, message: "refused" };
    if (PROGRAM_ONLY.test(pathAndQuery)) return apiError(403, "FORBIDDEN", "refused");

    // renewing is the program's job (the screens never hold a refresh token)
    if (/^\/v1\/auth\/refresh(\?|$)/.test(pathAndQuery)) {
      const out = store.current ? await refreshFor(store.current) : "expired";
      if (out === "refreshed") return answer(200, { success: true, data: { ok: true } });
      if (out === "failed") return { networkError: true, message: "refresh failed" };
      return apiError(401, "UNAUTHENTICATED", "الجلسة خلصت، سجّل دخول تاني");
    }

    /** @type {Record<string, string>} */
    const headers = {};
    for (const [k, v] of Object.entries(r.headers ?? {})) if (!DROP.has(k.toLowerCase())) headers[k] = String(v);
    const body = method === "GET" || method === "HEAD" || r.body === null || r.body === undefined ? undefined : typeof r.body === "string" ? r.body : Buffer.from(r.body);
    const signIn = method === "POST" && SIGN_IN.test(pathAndQuery);
    const isSetup = /^\/v1\/core\/setup/.test(pathAndQuery);
    // a password sign-in only on a paired computer (the shop's very first setup excepted)
    if (signIn && !isSetup && !o.deviceKey()) return apiError(403, "DEVICE_UNPAIRED", "اربط الكمبيوتر بفرع الأول");
    const who = signIn ? null : store.current;

    let res;
    try {
      res = await send(method, pathAndQuery, headers, body, who);
      if (res.status === 401 && who && !/^\/v1\/auth\/logout/.test(pathAndQuery)) {
        if ((await refreshFor(who)) === "refreshed") res = await send(method, pathAndQuery, headers, body, who);
        // still refused: the computer may have been stopped in the admin (its sessions end with it)
        if (res.status === 401) o.onDeviceGone();
      }
    } catch (e) {
      return { networkError: true, message: String(/** @type {Error} */ (e)?.message ?? e) };
    }

    const ct = res.headers.get("content-type") ?? "";
    /** @type {Record<string, string>} */
    const outHeaders = { "content-type": ct };
    const cd = res.headers.get("content-disposition");
    if (cd) outHeaders["content-disposition"] = cd;
    if (!isText(ct)) return { status: res.status, headers: outHeaders, body: Buffer.from(await res.arrayBuffer()) };

    let text = await res.text();
    if (res.ok && signIn) {
      try {
        const json = JSON.parse(text);
        const t = json?.data?.tokens;
        if (t?.accessToken && t?.refreshToken) {
          // a password sign-in becomes this computer's own session (the shop's first setup: none to bind to yet)
          let mine = t;
          if (!isSetup) {
            const bound = await bindToDevice(t);
            if (!bound.ok) return apiError(bound.status, bound.code, bound.message);
            mine = bound.tokens;
          }
          // the person signing in on this computer: their tokens stay here
          const got = await adopt(mine, { checkBranch: !isSetup });
          if (!got.ok) return apiError(got.status, got.code, got.message);
          delete json.data.tokens;
          text = JSON.stringify(json);
        }
      } catch {
        /* not JSON */
      }
    }
    if (/^\/v1\/auth\/logout/.test(pathAndQuery) && store.current) {
      delete store.accounts[store.current];
      store.current = null;
      persist();
      o.onChange();
    }
    return { status: res.status, headers: outHeaders, body: text };
  }

  /** Every sign-in on this computer is forgotten (it was unpaired or stopped). */
  function forgetAll() {
    load();
    const had = !!store.current;
    store.accounts = {};
    store.current = null;
    persist();
    if (had) o.onChange();
  }

  // ─── the device routes ───

  /** A refused device key (unknown, or the computer was stopped): back to pairing. */
  const deviceRefused = (/** @type {{ status: number, json: any }} */ r) => r.status === 401 && ["DEVICE_UNKNOWN", "DEVICE_DISABLED"].includes(r.json?.error?.code);

  /**
   * Who this computer is: its branch, till number and till screens.
   * @returns {Promise<import("./config").Device | "gone" | null>} null: no answer right now
   */
  async function deviceMe() {
    if (!o.deviceKey()) return "gone";
    try {
      const r = await call("GET", "/v1/core/devices/me", { device: true, timeout: 10_000 });
      if (deviceRefused(r)) return "gone";
      const d = r.status === 200 ? r.json?.data : null;
      if (!d?.id) return null;
      return { id: d.id, name: d.name, tillNumber: d.tillNumber, branch: d.branch, screens: d.screens ?? [], pairedAt: "" };
    } catch {
      return null;
    }
  }

  /** The code this computer shows while it waits to be paired (kept here: the poll secret never reaches the screens). */
  /** @type {{ pairId: string, pollSecret: string, code: string, expiresAt: string } | null} */
  let pairing = null;

  /** @returns {Promise<{ code: string, expiresAt: string } | { error: string }>} */
  async function pairStart(/** @type {boolean} */ fresh) {
    if (!fresh && pairing && Date.parse(pairing.expiresAt) - Date.now() > 20_000) return { code: pairing.code, expiresAt: pairing.expiresAt };
    try {
      const r = await call("POST", "/v1/auth/device/pair", { body: { name: os.hostname().slice(0, 60) || "VOLAR" } });
      const d = r.json?.data;
      if (r.status !== 200 || !d?.pairId) return { error: r.json?.error?.message ?? "مقدرناش نجيب كود دلوقتي. جرّب تاني بعد شوية." };
      pairing = { pairId: d.pairId, pollSecret: d.pollSecret, code: d.code, expiresAt: d.expiresAt };
      return { code: d.code, expiresAt: d.expiresAt };
    } catch {
      return { error: "offline" };
    }
  }

  /**
   * Was the code approved? Then this computer collects its key (once).
   * @returns {Promise<{ status: "WAITING" | "OFFLINE" } | { status: "EXPIRED" | "USED", message: string } | { status: "PAIRED", key: string, deviceId: string, branch: { id: string, name: string, code: string }, tillNumber: number }>}
   */
  async function pairClaim() {
    const p = pairing;
    if (!p) return { status: "EXPIRED", message: "الكود خلص وقته" };
    try {
      const r = await call("POST", "/v1/auth/device/pair/claim", { body: { pairId: p.pairId, pollSecret: p.pollSecret } });
      const d = r.json?.data;
      if (r.status === 200 && d?.waiting) return { status: "WAITING" };
      if (r.status === 200 && d?.key) {
        pairing = null;
        return { status: "PAIRED", key: d.key, deviceId: d.deviceId, branch: d.branch, tillNumber: d.tillNumber };
      }
      if (r.status === 429 || r.status >= 500) return { status: r.status === 429 ? "WAITING" : "OFFLINE" };
      pairing = null;
      return { status: r.json?.error?.code === "PAIR_USED" ? "USED" : "EXPIRED", message: r.json?.error?.message ?? "الكود خلص وقته" };
    } catch {
      return { status: "OFFLINE" };
    }
  }

  /** QR codes this computer is showing: id → secret (the secret leaves the program only inside the QR). */
  /** @type {Map<string, string>} */
  const qrSecrets = new Map();

  /** A sign-in QR for the phone app (good for two minutes, once). */
  async function qrStart() {
    if (!o.deviceKey()) return { error: "not-paired" };
    try {
      const r = await call("POST", "/v1/auth/device/qr", { device: true, timeout: 10_000 });
      if (deviceRefused(r)) {
        o.onDeviceGone();
        return { error: "not-paired" };
      }
      const d = r.json?.data;
      if (r.status !== 200 || !d?.id) return { error: r.json?.error?.message ?? String(r.status) };
      qrSecrets.clear();
      qrSecrets.set(d.id, d.secret);
      return { id: d.id, url: d.url, expiresAt: d.expiresAt };
    } catch {
      return { error: "offline" };
    }
  }

  /**
   * Did someone approve on their phone? Then this computer collects that person's session.
   * @returns {Promise<{ status: "WAITING" | "EXPIRED" | "OFFLINE" } | { status: "REFUSED", message: string } | { status: "SIGNED_IN", name: string }>}
   */
  async function qrClaim(/** @type {string} */ id) {
    load();
    const secret = qrSecrets.get(id);
    if (!secret || !o.deviceKey()) return { status: "EXPIRED" };
    try {
      const r = await call("POST", "/v1/auth/device/claim", { device: true, body: { id, secret }, timeout: 10_000 });
      if (deviceRefused(r)) {
        o.onDeviceGone();
        return { status: "EXPIRED" };
      }
      const d = r.json?.data;
      if (r.status === 200 && d?.waiting) return { status: "WAITING" };
      if (r.status === 429) return { status: "WAITING" };
      if (r.status >= 500) return { status: "OFFLINE" };
      if (r.status !== 200 || !d?.tokens?.accessToken) {
        qrSecrets.delete(id);
        return { status: "EXPIRED" };
      }
      qrSecrets.delete(id);
      const got = await adopt(d.tokens, { checkBranch: true });
      return got.ok ? { status: "SIGNED_IN", name: got.name } : { status: "REFUSED", message: got.message };
    } catch {
      return { status: "OFFLINE" };
    }
  }

  /** Nobody is using the computer now (the branch's sign-in screen shows). */
  function lock() {
    load();
    if (!store.current) return;
    store.current = null;
    persist();
    o.onChange();
  }

  /** Does the API answer right now? */
  async function ping() {
    return (await serverStatus()) === 200;
  }

  /**
   * What the API's health check answers: its HTTP status (200 = fine; 502/503 = the server is up but
   * the API behind it isn't), or null when nothing answered at all (no internet, DNS, timeout).
   * @returns {Promise<number | null>}
   */
  async function serverStatus() {
    try {
      const res = await fetch(url("/v1/health"), { signal: AbortSignal.timeout(8_000) });
      return res.status;
    } catch {
      return null;
    }
  }

  return {
    serverStatus,
    request,
    lock,
    ping,
    forgetAll,
    deviceMe,
    pairStart,
    pairClaim,
    bindCurrent,
    qrStart,
    qrClaim,
    refresh: () => {
      load();
      return store.current ? refreshFor(store.current) : Promise.resolve(/** @type {const} */ ("expired"));
    },
    /** who is using the computer now (their name only) */
    current: () => {
      load();
      return store.current ? { id: store.current, name: store.accounts[store.current]?.name ?? "" } : null;
    },
  };
}

module.exports = { createApi };
