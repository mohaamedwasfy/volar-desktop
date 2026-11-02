// Back to the dashboard (the window only allows its own address).
const target = new URLSearchParams(location.search).get("url");
const go = () => {
  if (target && /^https?:\/\//.test(target)) location.href = target;
};
document.getElementById("retry").addEventListener("click", go);
setInterval(go, 15000);
