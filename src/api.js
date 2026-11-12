// @ts-check
/**
 * The program talks to the VOLAR API itself (the screens hand it every request), as the
 * staff member using the computer right now.
 *
 * Each person who works on this computer has their own sign-in here: the API's "app" tokens,
 * kept encrypted with Windows' protection in the program's data folder and never handed to
 * the screens. Each sign-in is the phone's QR, or the password (and the 2FA code when it's on):
 * nothing here opens a session without the API. A sign-in kept here only sends, later and as
 * that person, what they did while the internet was down.
 */
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

/** Requests from the screens are written against this; it stands for the configured API. */
const PLACEHOLDER = "https://api.volar.app/v1";

/**
 * @typedef {{ access: string, refresh: string, name?: string }} Account
 * @typedef {{ current: string | null, accounts: Record<string, Account>, deviceKey?: string }} Store
 */
/** @type {Store} */
let store = { current: null, accounts: {} };
let loaded = false;
const file = () => path.join(app.getPath("userData"), "session.bin");

/** Windows' encryption works only once the program is ready: read the file on first use. */
function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(file());
    const json = JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString("utf8"));
    // the first version kept one sign-in: { access, refresh }
    store = json && json.accounts ? json : { current: null, accounts: {} };
    // the till always opens locked: someone picks their name and types their PIN
    store.current = null;
  } catch {
    store = { current: null, accounts: {} };
  }
}
function persist() {
  try {
    const json = JSON.stringify(store);
    fs.writeFileSync(file(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : json);
  } catch {
    /* written again on the next change */
  }
}
const me = () => (store.current ? store.accounts[store.current] ?? null : null);


// headers the screens may not set: the program decides who is calling
const DROP = new Set(["host", "cookie", "origin", "referer", "authorization", "x-client-type", "content-length", "connection"]);

/** @param {() => string} apiBase the API's address ("http://…/v1") */
function createApi(apiBase) {
  /** @type {Map<string, Promise<"refreshed" | "expired" | "failed">>} */
  const refreshing = new Map();

  /** Renews one person's tokens. "expired": refused for good, they type their password again. */
  function refreshFor(/** @type {string} */ userId) {
    const acc = store.accounts[userId];
    if (!acc?.refresh) return Promise.resolve(/** @type {const} */ ("expired"));
    if (!refreshing.has(userId)) {
      refreshing.set(
        userId,
        (async () => {
          try {
            const res = await fetch(`${apiBase()}/auth/refresh`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Client-Type": "app" },
              body: JSON.stringify({ refreshToken: acc.refresh }),
              signal: AbortSignal.timeout(15_000),
            });
            if (res.ok) {
              const d = (await res.json())?.data ?? {};
              if (d.accessToken && d.refreshToken) {
                acc.access = d.accessToken;
                acc.refresh = d.refreshToken;
                persist();
                return /** @type {const} */ ("refreshed");
              }
            }
            if (res.status >= 400 && res.status < 500 && res.status !== 429) {
              // the sign-in is gone (signed out elsewhere, 30 days passed): keep the name, drop the tokens
              delete store.accounts[userId];
              if (store.current === userId) store.current = null;
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
   * @param {string} method
   * @param {string} pathAndQuery
   * @param {Record<string, string>} headers
   * @param {string | Buffer | undefined} body
   * @param {string | null} userId
   */
  async function send(method, pathAndQuery, headers, body, userId) {
    const acc = userId ? store.accounts[userId] : null;
    /** @type {Record<string, string>} */
    const h = { "X-Client-Type": "app", ...headers };
    if (acc?.access) h.Authorization = `Bearer ${acc.access}`;
    // this computer's own key: its sign-ins belong to it (the owner can end them from the dashboard)
    if (store.deviceKey) h["X-Device-Key"] = store.deviceKey;
    return fetch(`${apiBase()}${pathAndQuery}`, { method, headers: h, body, signal: AbortSignal.timeout(30_000) });
  }

  /**
   * A request from the screens, as whoever is using the computer.
   * @param {{ method: string, url: string, headers: Record<string, string>, body: string | ArrayBuffer | null }} r
   */
  async function request(r) {
    load();
    if (typeof r?.url !== "string" || !r.url.startsWith(PLACEHOLDER)) return { networkError: true, message: "refused" };
    const pathAndQuery = r.url.slice(PLACEHOLDER.length);
    const method = String(r.method || "GET").toUpperCase();
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [k, v] of Object.entries(r.headers ?? {})) if (!DROP.has(k.toLowerCase())) headers[k] = String(v);
    const body = method === "GET" || method === "HEAD" || r.body === null ? undefined : typeof r.body === "string" ? r.body : Buffer.from(r.body);
    const isLogin = /^\/auth\/login/.test(pathAndQuery);
    const who = isLogin ? null : store.current;

    let res;
    try {
      res = await send(method, pathAndQuery, headers, body, who);
      if (res.status === 401 && who && !/^\/auth\/(refresh|logout)/.test(pathAndQuery)) {
        if ((await refreshFor(who)) === "refreshed") res = await send(method, pathAndQuery, headers, body, who);
      }
    } catch (e) {
      return { networkError: true, message: String(/** @type {Error} */ (e)?.message ?? e) };
    }

    let text = await res.text();
    if (res.ok) {
      try {
        const json = JSON.parse(text);
        const d = json?.data;
        // signing in on this computer: their tokens stay here, they're the one using it now
        if (isLogin && d?.accessToken && d?.user?.id) {
          const prev = store.accounts[d.user.id] ?? {};
          store.accounts[d.user.id] = { ...prev, access: d.accessToken, refresh: d.refreshToken, name: d.user.name };
          store.current = d.user.id;
          persist();
        }
        // a new password gives a new access token
        if (/^\/auth\/change-password/.test(pathAndQuery) && d?.accessToken && me()) {
          /** @type {Account} */ (me()).access = d.accessToken;
          persist();
        }
        if (d && (d.accessToken || d.refreshToken)) {
          delete d.accessToken;
          delete d.refreshToken;
          text = JSON.stringify(json);
        }
      } catch {
        /* not JSON */
      }
    }
    if (/^\/auth\/logout/.test(pathAndQuery) && store.current) {
      delete store.accounts[store.current];
      store.current = null;
      persist();
    }
    return { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "" }, body: text };
  }

  /** The owner signed everyone out of this computer: every sign-in here is forgotten. */
  function forgetAll() {
    load();
    store.accounts = {};
    store.current = null;
    persist();
  }

  /**
   * This computer checks in: on, its version, who is using it; answers what the owner asked.
   * "removed": the server no longer knows this computer's key (the owner deleted it).
   * @returns {Promise<{ id: string, name: string, branch: { id: string, name: string }, disabled: boolean, command: "LOCK" | "SIGN_OUT" | null } | "removed" | null>}
   */
  async function checkIn(/** @type {string} */ appVersion, /** @type {string[]} */ staffIds) {
    load();
    if (!store.deviceKey) return null;
    try {
      const res = await fetch(`${apiBase()}/devices/check-in`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Client-Type": "app", "X-Device-Key": store.deviceKey },
        body: JSON.stringify({ appVersion, currentUserId: store.current, staffIds }),
        signal: AbortSignal.timeout(10_000),
      });
      const json = await res.json().catch(() => null);
      if (res.status === 401 && json?.error?.code === "DEVICE_REMOVED") return "removed";
      if (!res.ok) return null;
      return json?.data ?? null;
    } catch {
      return null;
    }
  }

  /** QR codes this computer is showing: id → secret (the secret never leaves the program except inside the QR). */
  /** @type {Map<string, string>} */
  const qrSecrets = new Map();

  /**
   * A sign-in QR for the phone app (good for two minutes, once).
   * @returns {Promise<{ id: string, url: string, expiresAt: string } | { error: string }>}
   */
  async function qrStart() {
    load();
    if (!store.deviceKey) return { error: "not-set-up" };
    try {
      const res = await fetch(`${apiBase()}/auth/device-logins`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Client-Type": "app", "X-Device-Key": store.deviceKey },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return { error: json?.error?.message ?? String(res.status) };
      const d = json.data;
      qrSecrets.clear();
      qrSecrets.set(d.id, d.secret);
      return { id: d.id, url: d.url, expiresAt: d.expiresAt };
    } catch {
      return { error: "offline" };
    }
  }

  /**
   * Did someone confirm on their phone? If so this computer gets its own sign-in for them,
   * kept like a password sign-in, and they're the one using it now.
   * @param {string} id
   * @param {(userId: string) => boolean} allowed  is this person one of this computer's staff?
   * @returns {Promise<{ status: "WAITING" | "EXPIRED" | "OFFLINE" | "NOT_STAFF" } | { status: "SIGNED_IN", userId: string, name: string }>}
   */
  async function qrClaim(id, allowed) {
    load();
    const secret = qrSecrets.get(id);
    if (!secret || !store.deviceKey) return { status: "EXPIRED" };
    try {
      const res = await fetch(`${apiBase()}/auth/device-logins/${encodeURIComponent(id)}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Client-Type": "app", "X-Device-Key": store.deviceKey },
        body: JSON.stringify({ secret }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { status: res.status >= 500 ? "OFFLINE" : "EXPIRED" };
      const d = (await res.json())?.data;
      if (d?.status !== "SIGNED_IN" || !d.user?.id || !d.accessToken) return { status: d?.status === "WAITING" ? "WAITING" : "EXPIRED" };
      qrSecrets.delete(id);
      if (!allowed(d.user.id)) {
        // not one of the people the owner chose for this computer: that sign-in ends at once
        await fetch(`${apiBase()}/auth/logout`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Client-Type": "app", Authorization: `Bearer ${d.accessToken}` },
          body: "{}",
          signal: AbortSignal.timeout(10_000),
        }).catch(() => {});
        return { status: "NOT_STAFF" };
      }
      const prev = store.accounts[d.user.id] ?? {};
      store.accounts[d.user.id] = { ...prev, access: d.accessToken, refresh: d.refreshToken, name: d.user.name };
      store.current = d.user.id;
      persist();
      return { status: "SIGNED_IN", userId: d.user.id, name: d.user.name };
    } catch {
      return { status: "OFFLINE" };
    }
  }

  /** Nobody is using the computer now (the names screen shows). */
  function lock() {
    load();
    store.current = null;
    persist();
  }

  /** Does the API answer right now? */
  async function ping() {
    try {
      // the API answers, and its database too (503 while the database is out of reach)
      const res = await fetch(`${apiBase().replace(/\/v1$/, "")}/health`, { signal: AbortSignal.timeout(5_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  return {
    request,
    lock,
    ping,
    qrStart,
    qrClaim,
    forgetAll,
    checkIn,
    /** the key the API gave this computer when the owner set it up (kept encrypted, never shown) */
    setDeviceKey: (/** @type {string | null} */ key) => {
      load();
      store.deviceKey = key;
      persist();
    },
    hasDeviceKey: () => {
      load();
      return !!store.deviceKey;
    },
    refresh: () => (store.current ? refreshFor(store.current) : Promise.resolve(/** @type {const} */ ("expired"))),
    current: () => {
      load();
      return store.current;
    },
    /** who has a sign-in on this computer (what they did offline is sent as them) */
    accounts: () => {
      load();
      return Object.fromEntries(Object.keys(store.accounts).map((id) => [id, {}]));
    },
  };
}

module.exports = { createApi, PLACEHOLDER };
