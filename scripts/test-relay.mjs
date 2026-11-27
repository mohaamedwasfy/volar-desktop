// The fingerprint relay (src/iclock-relay.js) against a fake API, with plain Node (no Electron):
//   node scripts/test-relay.mjs
// The forward here does what api.js's relayIclock does (path under /v1/attendance/iclock-relay, the computer's
// key, the device's address), so what reaches the "API" and what the device gets back are both checked.
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createRelay, isPrivate, lanAddresses, MAX_BODY } = require("../src/iclock-relay.js");

/** @type {Array<{ method: string, url: string, headers: http.IncomingHttpHeaders, body: string }>} */
const seen = [];
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf8");
  seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
  if (req.headers["x-device-key"] !== "computer-key") {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end('{"success":false,"error":{"code":"DEVICE_UNKNOWN"}}');
  }
  if ((req.url ?? "").includes("SN=NOPE")) {
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("Unknown device");
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(req.method === "POST" ? `OK: ${body.split("\n").filter(Boolean).length}` : "GET OPTION FROM: ZK1\nDelay=10");
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", () => r(null)));
const up = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (upstream.address()).port}`;
let upstreamDown = false;

const relay = createRelay({
  forward: async (f) => {
    if (upstreamDown) throw new Error("fetch failed");
    const h = { "X-Device-Key": "computer-key", "X-Iclock-Device-Ip": f.deviceIp, ...(f.body !== undefined && { "Content-Type": f.contentType || "text/plain" }) };
    const res = await fetch(`${up}/v1/attendance/iclock-relay${f.path}`, { method: f.method, headers: h, body: f.body });
    return { status: res.status, contentType: res.headers.get("content-type") ?? "text/plain", body: await res.text() };
  },
});
assert.equal(await relay.start(18081), true);
const port = relay.status().port;
const base = `http://127.0.0.1:${port}`;
const at = async (method, path, body) => {
  const r = await fetch(`${base}${path}`, { method, body, headers: body ? { "content-type": "text/plain" } : {} });
  return { status: r.status, text: await r.text() };
};

// the handshake: passed on, the answer as it is
const hs = await at("GET", "/iclock/cdata?SN=ZK1&options=all&pushver=2.4.1");
assert.equal(hs.status, 200);
assert.equal(hs.text, "GET OPTION FROM: ZK1\nDelay=10");
assert.equal(seen.at(-1).url, "/v1/attendance/iclock-relay/cdata?SN=ZK1&options=all&pushver=2.4.1");
assert.equal(seen.at(-1).headers["x-iclock-device-ip"], "127.0.0.1");

// punches: the body as it came
const punches = "201\t2026-11-26 09:05:00\t0\t1\t0\t0\n201\t2026-11-26 17:00:00\t0\t1\t0\t0";
const post = await at("POST", "/iclock/cdata?SN=ZK1&table=ATTLOG&Stamp=9999", punches);
assert.deepEqual(post, { status: 200, text: "OK: 2" });
assert.equal(seen.at(-1).method, "POST");
assert.equal(seen.at(-1).body, punches);
assert.equal(seen.at(-1).url, "/v1/attendance/iclock-relay/cdata?SN=ZK1&table=ATTLOG&Stamp=9999");

// the path in another case reaches the API's lower-case one; getrequest and devicecmd too
assert.equal((await at("GET", "/iclock/GetRequest?SN=ZK1")).status, 200);
assert.equal(seen.at(-1).url, "/v1/attendance/iclock-relay/getrequest?SN=ZK1");
assert.equal((await at("POST", "/iclock/devicecmd?SN=ZK1", "ID=1&Return=0")).status, 200);

// the API refusing: its status and text, verbatim (the device retries later)
assert.deepEqual(await at("GET", "/iclock/cdata?SN=NOPE"), { status: 403, text: "Unknown device" });

// only /iclock/*: everything else 404, never passed on
const before = seen.length;
for (const p of ["/", "/v1/health", "/iclockx", "/iclock", "/admin", "/iclock/../v1/auth/login"]) assert.equal((await at("GET", p)).status, 404, p);
assert.equal((await at("PUT", "/iclock/cdata?SN=ZK1", "x")).status, 404);
assert.equal(seen.length, before);

// a body over 2 MB: 413 and the connection closed (the client may see the reset first), never passed on
const big = await at("POST", "/iclock/cdata?SN=ZK1&table=ATTLOG", "x".repeat(MAX_BODY + 10)).catch((e) => ({ status: e?.cause?.code === "ECONNRESET" ? 413 : 0, text: "" }));
assert.equal(big.status, 413);
assert.equal(seen.length, before);

// the API not answering: never 200, so the device keeps its punches
upstreamDown = true;
const down = await at("POST", "/iclock/cdata?SN=ZK1&table=ATTLOG", punches);
assert.equal(down.status, 503);
upstreamDown = false;
const st = relay.status();
assert.equal(st.lastDeviceIp, "127.0.0.1");
assert.equal(st.lastSn, "ZK1");
assert.ok(st.lastSeenAt && st.failed === 1);

// who may call: the shop's network and this computer only
for (const a of ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.20", "127.0.0.1", "::ffff:192.168.1.20", "::1"]) assert.equal(isPrivate(a), true, a);
for (const a of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.1.1", "41.33.10.20", "fe80::1", "", undefined]) assert.equal(isPrivate(a), false, String(a));

// the port in use: said, not crashed
const other = createRelay({ forward: async () => ({ status: 200, contentType: "text/plain", body: "" }) });
assert.equal(await other.start(port), false);
assert.match(other.status().error ?? "", /مستخدم/);

console.log("addresses to type in the device:", lanAddresses().map((a) => `${a.address}:${port}`).join(", ") || "(none)");
await relay.stop();
assert.equal(relay.status().listening, false);
await new Promise((r) => upstream.close(() => r(null)));
console.log("relay: all checks passed");
