// @ts-check
/* global settings */
/** @type {any} */
const api = /** @type {any} */ (window).settings;
const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

const msg = (/** @type {string} */ text, ok = false) => {
  $("msg").textContent = text;
  $("msg").className = `msg ${ok ? "ok" : text ? "bad" : ""}`;
};

async function fill() {
  const [cfg, printers] = await Promise.all([api.get(), api.printers()]);
  if (!cfg) return;
  $("branch").textContent = cfg.device ? `${cfg.device.branchName} · ${cfg.device.staff.length} موظف` : "لسه متعملهوش إعداد";
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
  $("startWithWindows").checked = !!cfg.startWithWindows;
  $("about").textContent = `VOLAR ${cfg.version} · رقم الجهاز ${String(cfg.deviceId).slice(0, 8)}`;
  const u = cfg.update || { state: "idle" };
  const text = {
    checking: "بيدوّر على تحديث…",
    downloading: `بينزّل الإصدار ${u.version}…`,
    ready: `الإصدار ${u.version} جاهز: هيتثبت لوحده لما تقفل البرنامج.`,
    latest: "عندك آخر إصدار.",
    error: "مقدرتش أدوّر على تحديثات دلوقتي.",
  }[u.state];
  if (text) {
    $("update").hidden = false;
    $("updateText").textContent = text;
    $("installUpdate").hidden = u.state !== "ready";
  }
}

async function save() {
  msg("");
  const r = await api.save({
    receiptPrinter: $("receiptPrinter").value,
    labelPrinter: $("labelPrinter").value,
    kiosk: $("kiosk").checked,
    startWithWindows: $("startWithWindows").checked,
  });
  if (r.ok) msg(r.reachable ? "اتحفظ، والسيرفر بيرد." : "اتحفظ، بس السيرفر مش بيرد دلوقتي (النت أو العنوان).", r.reachable);
  else msg(r.error || "مقدرتش أحفظ");
  return r.ok;
}

$("save").addEventListener("click", () => void save());
$("installUpdate").addEventListener("click", () => api.installUpdate());
for (const b of document.querySelectorAll("[data-test]")) {
  b.addEventListener("click", async () => {
    if (!(await save())) return;
    const r = await api.test(/** @type {HTMLElement} */ (b).dataset.test);
    msg(r.ok ? "اتبعتت ورقة تجربة للطابعة." : `مطبعتش: ${r.error}`, r.ok);
  });
}
void fill();
