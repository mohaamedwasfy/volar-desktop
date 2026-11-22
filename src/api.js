// @ts-check
/**
 * The program talks to the VOLAR API itself (the screens hand it every request), as the
 * staff member using the computer right now.
 *
 * Each person who signs in on this computer has their own session here: the API's tokens
 * (`X-Client-Type: desktop`, so they come in the body, never as cookies), kept encrypted with
 * Windows' protection in the program's data folder and never handed to the screens. A sign-in is
 * the phone's QR, or a name picked from the branch's list and its password (or username and
 * password; the 2FA code when it's on): nothing here opens a session without the API. Only staff
 * of this computer's branch get in, and every session here belongs to this computer: the password
 * sign-ins carry its key (X-Device-Key), so the API binds them to it (the till needs that).
 *
 * The computer itself proves who it is with its device key, from its setup (a QR an administrator
 * approves from the phone, or here); it is sent only on the device routes and the password
 * sign-ins, never with the screens' other requests. Before it is set up, an administrator may sign
 * in here only to set it up: that session is never written to disk and ends once it is set up.
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
/** @type {() => boolean} the computer is set up (set by createApi): until then nobody's sign-in is written to disk */
let setUp = () => false;
function persist() {
  try {
    const json = JSON.stringify(setUp() ? store : { v: 2, current: null, accounts: {} });
    fs.writeFileSync(file(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : json);
  } catch {
    /* written again on the next change */
  }
}

// headers the screens may not set: the program decides who is calling
const DROP = new Set(["host", "cookie", "origin", "referer", "authorization", "x-client-type", "x-device-key", "content-length", "connection", "user-agent"]);
/** Sign-ins whose answer carries tokens: they stay here, and the screens get the answer without them. */
const SIGN_IN = /^\/v1\/(auth\/login|auth\/mfa|auth\/passkeys\/login\/verify|core\/setup)(\?|$)/;
/** Routes only the program itself calls (they hand out sessions or the device key, or need its key or the setup QR's secrets). */
const PROGRAM_ONLY = /^\/v1\/auth\/device\/(claim|approve|pair|pair\/claim|qr|setup|setup\/[a-z]+|staff|login)(\?|$)/;
const PASSKEY = /^\/v1\/auth\/passkeys\/login\/verify(\?|$)/;
const PASSWORD = /^\/v1\/auth\/login(\?|$)/;
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
  setUp = () => !!o.deviceKey();

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
  async function send(method, pathAndQuery, headers, body, userId, withKey = false) {
    const acc = userId ? store.accounts[userId] : null;
    /** @type {Record<string, string>} */
    const h = { ...headers, "X-Client-Type": "desktop", "User-Agent": ua };
    if (acc?.access) h.Authorization = `Bearer ${acc.access}`;
    const key = withKey ? o.deviceKey() : null;
    if (key) h["X-Device-Key"] = key;
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
    const paired = !!o.deviceKey();
    // a passkey sign-in can't carry this computer's key: the screens don't offer it here
    if (signIn && paired && PASSKEY.test(pathAndQuery)) return apiError(403, "PASSKEY_DESKTOP", "ادخل بالموبايل أو بكلمة المرور على الكمبيوتر ده");
    // the password sign-in carries the key, so the API binds the session to this computer (and refuses
    // another branch's staff); the 2FA step is bound by its challenge. Not set up yet: a sign-in here is
    // only to set the computer up (never written to disk, ended once it is set up).
    const who = signIn ? null : store.current;

    let res;
    try {
      res = await send(method, pathAndQuery, headers, body, who, signIn && paired && PASSWORD.test(pathAndQuery));
      if (signIn && res.status === 401) {
        const code = (await res.clone().json().catch(() => null))?.error?.code;
        if (code === "DEVICE_UNKNOWN" || code === "DEVICE_DISABLED") o.onDeviceGone();
      }
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
          // the person signing in on this computer: their tokens stay here
          const got = await adopt(t, { checkBranch: paired && !isSetup });
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
   * Who this computer is: its branch, till number, whether it is a cashier, and its till screen.
   * @returns {Promise<import("./config").Device | "gone" | null>} null: no answer right now
   */
  async function deviceMe() {
    if (!o.deviceKey()) return "gone";
    try {
      const r = await call("GET", "/v1/core/devices/me", { device: true, timeout: 10_000 });
      if (deviceRefused(r)) return "gone";
      const d = r.status === 200 ? r.json?.data : null;
      if (!d?.id) return null;
      const screens = d.screens ?? [];
      return { id: d.id, name: d.name, tillNumber: d.tillNumber, branch: d.branch, cashier: d.cashier ?? screens.length > 0, screen: d.screen ?? screens[0] ?? null, screens, pairedAt: "" };
    } catch {
      return null;
    }
  }

  // ─── setting this computer up: a QR an administrator scans with the phone app (or approves here) ───

  /**
   * The setup QR this computer shows. Its id and secret are in the QR itself (the screens draw it);
   * the poll secret, which collects the key, never leaves the program.
   * @type {{ id: string, secret: string, pollSecret: string, url: string, expiresAt: string } | null}
   */
  let setup = null;

  /** @returns {Promise<{ id: string, url: string, expiresAt: string } | { error: string }>} */
  async function setupStart(/** @type {boolean} */ fresh) {
    if (!fresh && setup && Date.parse(setup.expiresAt) - Date.now() > 30_000) return { id: setup.id, url: setup.url, expiresAt: setup.expiresAt };
    try {
      const r = await call("POST", "/v1/auth/device/setup", { body: { computerName: os.hostname().slice(0, 60) || "VOLAR" } });
      const d = r.json?.data;
      if ((r.status !== 200 && r.status !== 201) || !d?.setupId) return { error: r.status === 429 ? "busy" : (r.json?.error?.message ?? "مقدرناش نجيب كود دلوقتي. جرّب تاني بعد شوية.") };
      setup = { id: d.setupId, secret: d.secret, pollSecret: d.pollSecret, url: d.url, expiresAt: d.expiresAt };
      return { id: setup.id, url: setup.url, expiresAt: setup.expiresAt };
    } catch {
      return { error: "offline" };
    }
  }

  /**
   * Was the setup approved (from a phone, or here)? Then this computer collects its key, once.
   * @returns {Promise<{ status: "WAITING" | "OFFLINE" } | { status: "EXPIRED" | "USED", message: string } | { status: "DONE", key: string, deviceId: string, branch: { id: string, name: string, code: string }, tillNumber: number, cashier: boolean, screenId: string | null }>}
   */
  async function setupClaim() {
    const p = setup;
    if (!p) return { status: "EXPIRED", message: "الكود خلص وقته" };
    try {
      const r = await call("POST", "/v1/auth/device/setup/claim", { body: { id: p.id, pollSecret: p.pollSecret } });
      const d = r.json?.data;
      if (r.status === 200 && d?.waiting) return { status: "WAITING" };
      if (r.status === 200 && d?.key) {
        setup = null;
        return { status: "DONE", key: d.key, deviceId: d.deviceId, branch: d.branch, tillNumber: d.tillNumber, cashier: !!d.cashier, screenId: d.screenId ?? null };
      }
      if (r.status === 429 || r.status >= 500) return { status: r.status === 429 ? "WAITING" : "OFFLINE" };
      setup = null;
      return { status: r.json?.error?.code === "SETUP_USED" ? "USED" : "EXPIRED", message: r.json?.error?.message ?? "الكود خلص وقته" };
    } catch {
      return { status: "OFFLINE" };
    }
  }

  /** A call as the person signed in here (the administrator setting the computer up), renewed once if needed. */
  async function asCurrent(/** @type {string} */ method, /** @type {string} */ p, /** @type {unknown} */ body) {
    load();
    const id = store.current;
    if (!id || !store.accounts[id]) return { status: 401, json: { error: { code: "UNAUTHENTICATED", message: "سجّل دخول الأول" } } };
    let r = await call(method, p, { token: store.accounts[id].access, body });
    if (r.status === 401 && (await refreshFor(id)) === "refreshed") r = await call(method, p, { token: store.accounts[id].access, body });
    return r;
  }
  const failure = (/** @type {{ status: number, json: any }} */ r) => ({ ok: /** @type {const} */ (false), status: r.status, code: r.json?.error?.code ?? "ERROR", message: r.json?.error?.message ?? "حصلت مشكلة، جرّب تاني" });
  const offline = () => ({ ok: /** @type {const} */ (false), status: 0, code: "NETWORK", message: "مفيش اتصال بالسيرفر. اتأكد من النت وجرّب تاني." });
  const expired = () => ({ ok: /** @type {const} */ (false), status: 410, code: "SETUP_EXPIRED", message: "الكود خلص وقته: استنى الكود الجديد" });

  /** What the administrator signed in here may choose for this computer's QR: the branches (with registers), or why not. */
  async function setupPreview() {
    if (!setup) return expired();
    try {
      const r = await asCurrent("POST", "/v1/auth/device/setup/preview", { id: setup.id, secret: setup.secret });
      return r.status === 200 ? { ok: /** @type {const} */ (true), data: r.json.data } : failure(r);
    } catch {
      return offline();
    }
  }

  /**
   * The administrator signed in here sets this computer up (its own QR): branch, name, cashier or not
   * (then the register). The key is then collected by setupClaim, as when a phone approves it.
   * @param {unknown} input
   */
  async function setupApprove(input) {
    const i = /** @type {any} */ (input) ?? {};
    if (!setup) return expired();
    const body = {
      id: setup.id, secret: setup.secret, branchId: String(i.branchId ?? ""), name: String(i.name ?? "").slice(0, 60), cashier: !!i.cashier,
      ...(i.cashier && typeof i.registerId === "string" && { registerId: i.registerId }),
      // a drawer another computer uses is shared only when asked (otherwise the API makes a new one)
      ...(i.cashier && typeof i.registerId === "string" && i.shareRegister === true && { shareRegister: true }),
    };
    try {
      const r = await asCurrent("POST", "/v1/auth/device/setup/approve", body);
      return r.status === 200 || r.status === 201 ? { ok: /** @type {const} */ (true), data: r.json.data } : failure(r);
    } catch {
      return offline();
    }
  }

  /** Whoever signed in only to set the computer up is signed out (the next person signs in on the branch's screen). */
  async function endSession() {
    load();
    const id = store.current;
    const acc = id ? store.accounts[id] : null;
    if (acc) await call("POST", "/v1/auth/logout", { token: acc.access, body: {} }).catch(() => {});
    store.accounts = {};
    store.current = null;
    persist();
    o.onChange();
  }

  // ─── signing in from the branch's list (no phone) ───

  /** The branch's people for the sign-in list: { id, name, initials } only. */
  async function staff() {
    if (!o.deviceKey()) return { ok: /** @type {const} */ (false), status: 403, code: "DEVICE_UNPAIRED", message: "الكمبيوتر لسه متجهزش" };
    try {
      const r = await call("GET", "/v1/auth/device/staff", { device: true, timeout: 10_000 });
      if (deviceRefused(r)) {
        o.onDeviceGone();
        return failure(r);
      }
      return r.status === 200 && Array.isArray(r.json?.data) ? { ok: /** @type {const} */ (true), people: r.json.data } : failure(r);
    } catch {
      return offline();
    }
  }

  /**
   * A name picked from the list and its password: the API opens a session bound to this computer
   * (or asks for the 2FA code: the screens send it to POST /v1/auth/mfa, which keeps the computer).
   * @param {unknown} input { userId, password }
   */
  async function deviceLogin(input) {
    load();
    const i = /** @type {any} */ (input) ?? {};
    if (!o.deviceKey()) return { ok: /** @type {const} */ (false), status: 403, code: "DEVICE_UNPAIRED", message: "الكمبيوتر لسه متجهزش" };
    if (typeof i.userId !== "string" || typeof i.password !== "string" || i.userId.length > 64 || !i.password || i.password.length > 200) {
      return { ok: /** @type {const} */ (false), status: 400, code: "VALIDATION", message: "اكتب كلمة المرور" };
    }
    try {
      const r = await call("POST", "/v1/auth/device/login", { device: true, body: { userId: i.userId, password: i.password } });
      if (deviceRefused(r)) {
        o.onDeviceGone();
        return failure(r);
      }
      const d = r.status === 200 ? r.json?.data : null;
      if (!d) return failure(r);
      if (d.mfaRequired) return { ok: /** @type {const} */ (true), mfaRequired: true, challenge: String(d.challenge) };
      const got = await adopt(d.tokens, { checkBranch: true });
      return got.ok ? { ok: /** @type {const} */ (true), mfaRequired: false } : { ok: /** @type {const} */ (false), status: got.status, code: got.code, message: got.message };
    } catch {
      return offline();
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
    setupStart,
    setupClaim,
    setupPreview,
    setupApprove,
    endSession,
    staff,
    deviceLogin,
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
