const displayState = {
  code: "----",
  expiresAt: 0,
  mode: "",
  wakeLock: null,
};

const adminPath = window.location.pathname.replace(/\/display\/?$/, "") || "/admin";

async function displayApi(path) {
  const response = await fetch(path, { cache: "no-store" });
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (error) {
    throw new Error("现场码页面暂时无法读取数据");
  }
  if (!response.ok) {
    const requestError = new Error(data.error || "现场码页面暂时无法读取数据");
    requestError.status = response.status;
    throw requestError;
  }
  return data;
}

function showUnavailable(title, message) {
  document.querySelector("#onsiteDisplay").hidden = true;
  document.querySelector("#onsiteUnavailable").hidden = false;
  document.querySelector("#onsiteUnavailableTitle").textContent = title;
  document.querySelector("#onsiteUnavailableText").textContent = message;
}

function renderDisplay(data) {
  displayState.code = data.code || "----";
  displayState.expiresAt = Number(data.expires_at || 0);
  displayState.mode = data.mode || "";
  document.title = `${data.booth_name || "摊位"} · 现场下单码`;
  document.querySelector("#onsiteBoothName").textContent = data.booth_name || "摊位点单";
  document.querySelector("#onsiteCode").textContent = displayState.code;
  const logo = document.querySelector("#onsiteLogo");
  if (data.logo) {
    logo.src = data.logo;
    logo.hidden = false;
  } else {
    logo.hidden = true;
  }
  if (displayState.mode !== "onsite") {
    showUnavailable("现场码暂未开启", "请先在摊主后台开启“现场码接单”。");
    return;
  }
  document.querySelector("#onsiteUnavailable").hidden = true;
  document.querySelector("#onsiteDisplay").hidden = false;
  updateCountdown();
}

function updateCountdown() {
  const remaining = Math.max(0, displayState.expiresAt - Math.floor(Date.now() / 1000));
  const minutes = String(Math.floor(remaining / 60)).padStart(2, "0");
  const seconds = String(remaining % 60).padStart(2, "0");
  document.querySelector("#onsiteCountdown").textContent = `${minutes}:${seconds}`;
}

async function loadDisplay() {
  try {
    const me = await displayApi("/api/admin/me");
    if (!me.ok) {
      showUnavailable("请先登录后台", "这台平板登录摊主后台后，就可以打开现场码屏。内容不会展示订单或库存。 ");
      return;
    }
    renderDisplay(await displayApi("/api/admin/onsite-code"));
  } catch (error) {
    if (error.status === 401) {
      showUnavailable("请先登录后台", "这台平板登录摊主后台后，就可以打开现场码屏。");
    } else {
      showUnavailable("连接暂时中断", error.message);
    }
  }
}

async function enterFullscreen() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    if ("wakeLock" in navigator) displayState.wakeLock = await navigator.wakeLock.request("screen");
    document.querySelector("#onsiteFullscreen").textContent = "正在全屏展示";
  } catch (error) {
    document.querySelector("#onsiteFullscreen").textContent = "再次尝试全屏";
  }
}

document.querySelector("#onsiteAdminLink").href = adminPath;
document.querySelector("#onsiteFullscreen").addEventListener("click", enterFullscreen);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadDisplay();
});

setInterval(updateCountdown, 1000);
setInterval(loadDisplay, 5000);
loadDisplay();
