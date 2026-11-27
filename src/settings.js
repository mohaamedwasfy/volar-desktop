// @ts-check
/* global settings */
/** @type {any} */
const api = /** @type {any} */ (window).settings;
const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

const msg = (/** @type {string} */ text, ok = false) => {
  $("msg").textContent = text;
  $("msg").className = `msg ${ok ? "ok" : text ? "bad" : ""}`;
};

/** When something happened, in words («من 3 دقايق»). */
const ago = (/** @type {string | null} */ iso) => {
  if (!iso) return "";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return "من لحظات";
  if (m < 60) return `من ${m} دقيقة`;
  const h = Math.round(m / 60);
  if (h < 24) return `من ${h} ساعة`;
  return new Date(iso).toLocaleString("ar-EG");
};

/**
 * The fingerprint device through this computer: whether it listens, the addresses to type in the device
 * (each IPv4 of this computer and the port), when the device last called, and the Windows firewall.
 * @param {any} r
 */
function showRelay(r) {
  if (!r) return;
  const st = $("fpState");
  const wanted = r.paired && (r.enabled || r.linked);
  st.textContent = !r.paired ? "الكمبيوتر لسه متجهزش" : r.listening ? "بيستقبل" : wanted ? "مش شغال" : "مقفول";
  st.className = `badge ${r.listening ? "on" : wanted ? "bad" : ""}`;
  $("fpInfo").hidden = !r.listening && !r.error;
  const list = $("fpAddresses");
  list.innerHTML = "";
  const addrs = r.addresses.length ? r.addresses : [{ name: "", address: "مفيش شبكة" }];
  for (const a of addrs) {
    const li = document.createElement("li");
    li.textContent = `${a.address}  :  ${r.port}`;
    if (a.name) {
      const sm = document.createElement("small");
      sm.textContent = a.name;
      li.append(sm);
    }
    list.append(li);
  }
  const seen = [];
  if (r.error) seen.push(`مش قادر يستقبل: ${r.error}`);
  if (r.lastSeenAt) seen.push(`آخر مرة الجهاز كلّم الكمبيوتر ${ago(r.lastSeenAt)} (من ${r.lastDeviceIp}${r.lastSn ? `، ${r.lastSn}` : ""})`);
  else if (r.listening) seen.push("الجهاز لسه مكلّمش الكمبيوتر من ساعة ما البرنامج اتفتح.");
  if (r.lastFailure && r.lastFailureAt) seen.push(`آخر مشكلة ${ago(r.lastFailureAt)}: ${r.lastFailure} (البصمات بتفضل على الجهاز وبيبعتها تاني)`);
  $("fpSeen").textContent = seen.join(" · ");
  const devs = $("fpDevices");
  devs.innerHTML = "";
  for (const d of r.devices ?? []) {
    const li = document.createElement("li");
    li.textContent = `${d.name} (${d.serialNumber}): ${!d.active ? "موقوف" : d.lastSeenAt ? `السيرفر شافه ${ago(d.lastSeenAt)}` : "السيرفر لسه مشافهوش"}`;
    devs.append(li);
  }
  if (r.paired && r.linked === false && !(r.devices ?? []).length && r.enabled) {
    const li = document.createElement("li");
    li.textContent = "مفيش جهاز بصمة متربط بالكمبيوتر ده في الإدارة لسه: البصمات هتترفض لحد ما تربطه.";
    devs.append(li);
  }
  const fw = r.windows && r.listening && (r.firewall === "needs-admin" || r.firewall === "failed");
  $("fpFirewall").hidden = !fw;
  if (fw) {
    $("fpFirewallText").textContent = r.firewall === "failed"
      ? "الجدار الناري لسه قافل البورت. دوس الزرار ووافق على رسالة ويندوز (محتاج حساب مدير)، أو افتح «Windows Defender Firewall» ← Advanced settings ← Inbound Rules ← New Rule ← Port ← TCP " + r.port + " ← Allow."
      : "ويندوز ممكن يقفل البورت ده قدام جهاز البصمة. دوس الزرار ووافق على رسالة ويندوز مرة واحدة (محتاج حساب مدير).";
  }
}

async function fill() {
  const [cfg, printers] = await Promise.all([api.get(), api.printers()]);
  if (!cfg) return;
  const d = cfg.device;
  const scr = d ? (d.screen ?? d.screens?.[0] ?? null) : null;
  $("branch").textContent = d ? `${d.branch.name} · ${scr ? `كاشير ${d.tillNumber} · ${scr.registerName} (${scr.name})` : "مش كاشير"}` : "لسه متجهزش";
  $("unpair").hidden = !cfg.device;
  for (const id of ["receiptPrinter", "labelPrinter"]) {
    const sel = $(id);
    sel.innerHTML = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "— اسأل كل مرة —";
    sel.append(none);
    for (const p of printers) {
      const o = document.createElement("option");
      o.value = p.name;
      o.textContent = p.displayName + (p.isDefault ? " (الافتراضية)" : "");
      sel.append(o);
    }
    // a printer that's unplugged right now stays chosen
    if (cfg[id] && !printers.some((/** @type {{ name: string }} */ p) => p.name === cfg[id])) {
      const o = document.createElement("option");
      o.value = cfg[id];
      o.textContent = `${cfg[id]} (مش متوصلة دلوقتي)`;
      sel.append(o);
    }
    sel.value = cfg[id] || "";
  }
  $("kiosk").checked = !!cfg.kiosk;
  $("fingerprintRelay").checked = !!cfg.fingerprintRelay;
  $("fingerprintPort").value = String(cfg.fingerprintPort || 8081);
  showRelay(cfg.relay);
  $("startWithWindows").checked = !!cfg.startWithWindows;
  $("about").textContent = `VOLAR ${cfg.version} · رقم الجهاز ${String(cfg.deviceId).slice(0, 8)}`;
  const u = cfg.update || { state: "idle" };
  const text = {
    checking: "بيدوّر على تحديث…",
    downloading: `بينزّل الإصدار ${u.version}…`,
    ready: `الإصدار ${u.version} جاهز: هيتثبت لوحده لما تقفل البرنامج.`,
    manual: `فيه إصدار جديد ${u.version}: نزّله وثبّته فوق القديم.`,
    latest: "عندك آخر إصدار.",
    error: "مقدرتش أدوّر على تحديثات دلوقتي.",
  }[u.state];
  if (text) {
    $("update").hidden = false;
    $("updateText").textContent = text;
    $("installUpdate").hidden = u.state !== "ready" && u.state !== "manual";
    $("installUpdate").textContent = u.state === "manual" ? "صفحة التنزيل" : "ثبّته دلوقتي";
  }
}

async function save() {
  msg("");
  const r = await api.save({
    receiptPrinter: $("receiptPrinter").value,
    labelPrinter: $("labelPrinter").value,
    kiosk: $("kiosk").checked,
    startWithWindows: $("startWithWindows").checked,
    fingerprintRelay: $("fingerprintRelay").checked,
    fingerprintPort: Number($("fingerprintPort").value),
  });
  showRelay(await api.relay(false));
  if (r.ok) msg(r.reachable ? "اتحفظ، والسيرفر بيرد." : "اتحفظ، بس السيرفر مش بيرد دلوقتي (النت أو العنوان).", r.reachable);
  else msg(r.error || "مقدرتش أحفظ");
  return r.ok;
}

$("save").addEventListener("click", () => void save());
$("unpair").addEventListener("click", async () => {
  if (await api.unpair()) void fill();
});
$("installUpdate").addEventListener("click", () => api.installUpdate());
$("fpFirewallBtn").addEventListener("click", async () => {
  msg("وافق على رسالة ويندوز…", true);
  const r = await api.firewall();
  showRelay(r);
  msg(r?.firewall === "added" ? "البورت اتفتح في الجدار الناري." : "البورت لسه مقفول: جرّب تاني بحساب مدير.", r?.firewall === "added");
});
// the device calls every few seconds: its state stays fresh while the settings are open (the API asked once a minute)
let ticks = 0;
setInterval(async () => showRelay(await api.relay(++ticks % 12 === 0)), 5_000);
for (const b of document.querySelectorAll("[data-test]")) {
  b.addEventListener("click", async () => {
    if (!(await save())) return;
    const r = await api.test(/** @type {HTMLElement} */ (b).dataset.test);
    msg(r.ok ? "اتبعتت ورقة تجربة للطابعة." : `مطبعتش: ${r.error}`, r.ok);
  });
}
void fill();
