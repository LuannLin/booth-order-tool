const adminState = {
  products: [],
  orders: [],
  settings: {},
  lastOrderId: 0,
  soundOn: true,
  editingImage: "",
  settingImages: {},
  mounted: false,
  settingsDirty: false,
  promotionsDirty: false,
  audioContext: null,
  orderDate: "",
  salesDate: localDateString(),
  sales: null,
  productSearch: "",
  productFilter: "all",
  productAuthorFilter: "",
  selectedProductIds: new Set(),
  staffName: localStorage.getItem("booth_staff_name") || "",
};

const money = (value) => `¥${Number(value || 0).toFixed(2)}`;
const statusText = { new: "新订单", picking: "拣货中", ready: "待取单", completed: "已取单", cancelled: "已取消" };
const payText = { pending: "待核验", verified: "已核验", cash_pending: "现金待收", cash_received: "现金已收" };
const methodText = { wechat: "微信", alipay: "支付宝", cash: "现金" };
const receiveText = { now: "现在领取", later: "稍后领取" };

function localDateString(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}

function splitTags(value = "") {
  return String(value)
    .split(/[,，、]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function uniqueSorted(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) {
    const error = new Error(data.error || "操作失败");
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

function staffMembers() {
  try {
    const members = JSON.parse(adminState.settings.staff_members || "[]");
    return Array.isArray(members) ? members.filter(Boolean) : [];
  } catch (error) {
    return [];
  }
}

function promotions() {
  try {
    const data = JSON.parse(adminState.settings.promotions || "{}");
    return {
      amount_gifts: Array.isArray(data.amount_gifts) ? data.amount_gifts : [],
      quantity_gifts: Array.isArray(data.quantity_gifts) ? data.quantity_gifts : [],
      amount_discounts: Array.isArray(data.amount_discounts) ? data.amount_discounts : [],
    };
  } catch (error) {
    return { amount_gifts: [], quantity_gifts: [], amount_discounts: [] };
  }
}

function giftOptions(selectedId = 0) {
  const gifts = adminState.products.filter((product) => product.is_gift);
  return [`<option value="">选择赠品</option>`, ...gifts.map((product) => (
    `<option value="${product.id}" ${Number(selectedId) === product.id ? "selected" : ""}>${escapeHtml(product.name)}（库存 ${product.stock}${Number(product.stock || 0) <= 0 ? "，已送完" : ""}）</option>`
  ))].join("");
}

function promoGiftOptions(selectedId = 0) {
  const gifts = adminState.products.filter((product) => product.is_gift);
  if (!gifts.length) return `<option value="">先添加赠品商品</option>`;
  return [`<option value="">选择赠品</option>`, ...gifts.map((product) => (
    `<option value="${product.id}" ${Number(selectedId) === product.id ? "selected" : ""}>${escapeHtml(product.name)}（库存 ${product.stock}${Number(product.stock || 0) <= 0 ? "，已送完" : ""}）</option>`
  ))].join("");
}

function promoProductOptions(selectedIds = []) {
  const selected = new Set((selectedIds || []).map(Number));
  return adminState.products.filter((product) => !product.is_gift).map((product) => (
    `<option value="${product.id}" ${selected.has(product.id) ? "selected" : ""}>${escapeHtml(product.name)}（${escapeHtml(product.tags || "无标签")}）</option>`
  )).join("");
}

function promoGiftOptions(selectedId = 0) {
  const gifts = adminState.products.filter((product) => product.is_gift);
  if (!gifts.length) return `<option value="">先添加赠品商品</option>`;
  return [`<option value="">选择赠品</option>`, ...gifts.map((product) => (
    `<option value="${product.id}" ${Number(selectedId) === product.id ? "selected" : ""}>${escapeHtml(product.name)}（库存 ${product.stock}${Number(product.stock || 0) <= 0 ? "，已送完" : ""}）</option>`
  ))].join("");
}

function promoProductOptions(selectedIds = []) {
  const selected = new Set((selectedIds || []).map(Number));
  return adminState.products.filter((product) => !product.is_gift).map((product) => (
    `<option value="${product.id}" ${selected.has(product.id) ? "selected" : ""}>${escapeHtml(product.name)}（${escapeHtml(product.tags || "无标签")}）</option>`
  )).join("");
}

function currentStaffName() {
  return adminState.staffName.trim() || "摊主";
}

function normalizeCurrentStaff() {
  const members = staffMembers();
  if (!members.length) {
    adminState.staffName = "摊主";
    localStorage.setItem("booth_staff_name", adminState.staffName);
    return;
  }
  if (!members.includes(currentStaffName())) {
    adminState.staffName = members[0];
    localStorage.setItem("booth_staff_name", adminState.staffName);
  }
}

function showAdminToast(message) {
  let toast = document.querySelector("#adminToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "adminToast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showAdminToast.timer);
  showAdminToast.timer = setTimeout(() => toast.classList.remove("show"), 1800);
}

function updateStaffBadge() {
  const badge = document.querySelector("#currentStaffBadge");
  if (badge) badge.textContent = `当前摊员：${currentStaffName()}`;
}

function fileToDataUrl(input) {
  return new Promise((resolve, reject) => {
    const file = input.files && input.files[0];
    if (!file) return resolve("");
    if (file.size > 1024 * 1024) {
      showAdminToast("图片超过 1MB，建议压缩后再上传");
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function beep() {
  if (!adminState.soundOn) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const ctx = adminState.audioContext || new AudioContext();
  adminState.audioContext = ctx;
  if (ctx.state === "suspended") ctx.resume();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.3);
}

function unlockAudio() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  adminState.audioContext = adminState.audioContext || new AudioContext();
  if (adminState.audioContext.state === "suspended") adminState.audioContext.resume();
}

function notify(order) {
  beep();
  if (Notification.permission === "granted") {
    new Notification("你有新订单啦", {
      body: `取单码 ${order.pickup_code}，${money(order.total)}`,
    });
  }
}

async function loadLoginStaffChoices() {
  const select = document.querySelector("#loginStaffSelect");
  const input = document.querySelector("#loginStaffInput");
  if (!select || !input) return;
  try {
    const data = await api("/api/admin/staff-list");
    const members = data.staff_members || [];
    select.innerHTML = members.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
    if (members.length) {
      select.hidden = false;
      input.hidden = true;
      const saved = localStorage.getItem("booth_staff_name");
      select.value = members.includes(saved) ? saved : members[0];
    } else {
      select.hidden = true;
      input.hidden = false;
      input.value = "摊主";
    }
  } catch (error) {
    select.hidden = true;
    input.hidden = false;
    input.value = "摊主";
  }
}

function getLoginStaffName() {
  const select = document.querySelector("#loginStaffSelect");
  const input = document.querySelector("#loginStaffInput");
  return (select && !select.hidden ? select.value : input?.value || "").trim();
}

async function checkLogin() {
  const data = await api("/api/admin/me");
  document.querySelector("#loginView").hidden = data.ok;
  if (data.ok) {
    adminState.staffName = localStorage.getItem("booth_staff_name") || adminState.staffName || "摊主";
    mountAdminView();
    await loadAll(false);
  } else {
    document.querySelector("#adminMount").innerHTML = "";
    adminState.mounted = false;
  }
}

function mountAdminView() {
  if (adminState.mounted) return;
  document.querySelector("#adminMount").innerHTML = `
    <section id="adminView">
      <header class="admin-header">
        <div class="admin-header-copy">
          <span class="section-kicker">摊位工作台</span>
          <h1>订单看板</h1>
          <p id="adminSubtitle">今日订单</p>
        </div>
        <nav class="admin-tabs">
          <button class="active" data-tab="orders">订单</button>
          <button data-tab="products">商品</button>
          <button data-tab="settings">摊位</button>
          <button data-tab="sales">销售情况</button>
          <button id="logoutBtn" type="button">退出</button>
        </nav>
      </header>

      <main>
        <section id="ordersTab" class="tab-panel">
          <div class="section-heading admin-section-heading">
            <div>
              <span class="section-kicker">现场处理</span>
              <h2>今日订单</h2>
            </div>
          </div>
          <div class="board-actions">
            <button id="enableNotify" class="ghost-btn" type="button">开启系统通知</button>
            <button id="soundToggle" class="ghost-btn" type="button">声音：开</button>
            <span id="currentStaffBadge" class="staff-badge">当前摊员：${escapeHtml(currentStaffName())}</span>
            <span class="small-muted">订单看板默认显示今天订单。</span>
          </div>
          <div class="kanban">
            <div class="lane"><h2>新订单<span id="countNew">0</span></h2><div id="laneNew"></div></div>
            <div class="lane"><h2>拣货中<span id="countPicking">0</span></h2><div id="lanePicking"></div></div>
            <div class="lane"><h2>待取单<span id="countReady">0</span></h2><div id="laneReady"></div></div>
            <div class="lane"><h2>已完成<span id="countDone">0</span></h2><div id="laneDone"></div></div>
          </div>
        </section>

        <section id="productsTab" class="tab-panel" hidden>
          <div class="section-heading admin-section-heading">
            <div>
              <span class="section-kicker">商品管理</span>
              <h2>商品与库存</h2>
            </div>
          </div>
          <form id="productForm" class="editor-form">
            <input type="hidden" id="productId">
            <label>商品名<input id="productName" required></label>
            <label>价格<input id="productPrice" type="number" min="0" step="0.01" required></label>
            <label>库存<input id="productStock" type="number" min="0" step="1" required></label>
            <label>分类<input id="productCategory" placeholder="徽章 / 纸品 / 套组"></label>
            <label>作者 / 合摊成员<input id="productAuthor" list="authorOptions" placeholder="用于分账统计"></label>
            <datalist id="authorOptions"></datalist>
            <label class="wide-field">标签<input id="productTags" placeholder="作品、角色、属性，用逗号隔开"></label>
            <div id="tagSuggestions" class="tag-suggestions"></div>
            <label class="wide-field">图片
              <input id="productImage" type="file" accept="image/*">
              <span class="form-hint">建议上传实体图，尽量压缩到 1MB 以内。</span>
            </label>
            <label class="check-row"><input id="productActive" type="checkbox" checked> 上架</label>
            <button class="primary-btn" type="submit">保存商品</button>
            <button id="resetProduct" class="ghost-btn" type="button">清空表单</button>
          </form>
          <div class="list-heading"><h2>商品列表</h2></div>
          <div class="product-toolbar">
            <input id="productSearch" type="search" placeholder="搜索商品名、作者、分类或标签">
            <select id="productFilter">
              <option value="all">全部商品</option>
              <option value="active">在售</option>
              <option value="low">低库存</option>
              <option value="soldout">售罄</option>
              <option value="gift">赠品</option>
              <option value="hidden">已下架</option>
            </select>
            <select id="productAuthorFilter">
              <option value="">全部作者</option>
            </select>
            <button id="bulkDeleteProducts" class="ghost-btn danger-action" type="button" disabled>批量删除</button>
            <span id="productBulkState" class="bulk-state">已选 0 个</span>
          </div>
          <div id="productList" class="admin-list product-management-list"></div>
        </section>

        <section id="settingsTab" class="tab-panel" hidden>
          <div class="section-heading admin-section-heading">
            <div>
              <span class="section-kicker">摊位管理</span>
              <h2>展示与收款</h2>
            </div>
          </div>
          <form id="settingsForm" class="editor-form settings-form">
            <label>摊位名<input id="settingBoothName"></label>
            <label>欢迎语<textarea id="settingWelcome" rows="3"></textarea></label>
            <label>Logo<input id="settingLogo" type="file" accept="image/*"></label>
            <label>微信收款码<input id="settingWechat" type="file" accept="image/*"></label>
            <label>支付宝收款码<input id="settingAlipay" type="file" accept="image/*"></label>
            <label>修改后台密码<input id="settingPassword" type="password" placeholder="不改就留空"></label>
            <button class="primary-btn" type="submit">保存摊位设置</button>
          </form>
          <section class="staff-manager">
            <div>
              <h2>摊员管理</h2>
              <p class="small-muted">这里的摊员只用于后台登录和拣货分配，买家页面不会展示。</p>
            </div>
            <div id="staffList" class="staff-list"></div>
            <div class="staff-add-row">
              <input id="newStaffName" type="text" placeholder="摊员名字，如 AA / 小林">
              <button id="addStaffBtn" class="ghost-btn" type="button">添加摊员</button>
            </div>
          </section>
        </section>

        <section id="salesTab" class="tab-panel" hidden>
          <div class="section-heading admin-section-heading">
            <div>
              <span class="section-kicker">经营记录</span>
              <h2>销售情况</h2>
            </div>
          </div>
          <div class="board-actions sales-toolbar">
            <label class="date-filter">销售日期
              <input id="salesDateInput" type="date">
            </label>
            <button id="allSales" class="ghost-btn" type="button">全部历史</button>
            <button id="todaySales" class="ghost-btn" type="button">今天</button>
            <a class="ghost-link" href="/api/admin/export">导出订单明细</a>
            <a class="ghost-link" href="/api/admin/export-summary">导出商品汇总</a>
            <a id="authorExportLink" class="ghost-link" href="/api/admin/export-authors">导出作者分账</a>
            <span id="salesScopeLabel" class="sales-scope">今天</span>
          </div>
          <div class="sales-summary">
            <div><span>订单数</span><strong id="salesOrderCount">0</strong></div>
            <div><span>售出件数</span><strong id="salesQuantity">0</strong></div>
            <div><span>营业总额</span><strong id="salesTotal">¥0.00</strong></div>
          </div>
          <section class="sales-data-section">
            <div class="sales-section-heading">
              <span class="section-kicker">合摊结算</span>
              <h2>作者分账</h2>
            </div>
            <div id="salesAuthorList" class="author-sales-list"></div>
          </section>
          <section class="sales-data-section">
            <div class="sales-section-heading">
              <span class="section-kicker">制品汇总</span>
              <h2>单制品销量统计</h2>
            </div>
            <div id="salesProductList" class="sales-product-list"></div>
          </section>
          <section class="sales-data-section sales-orders-section">
            <div class="sales-section-heading">
              <span class="section-kicker">逐单核对</span>
              <h2>订单明细</h2>
            </div>
            <div id="salesOrderList" class="sales-order-list"></div>
          </section>
        </section>
      </main>
    </section>
  `;
  adminState.mounted = true;
  enhanceAdminForms();
  bindAdminViewEvents();
}

function enhanceAdminForms() {
  const stock = document.querySelector("#productStock");
  if (stock && !document.querySelector("#productLowStock")) {
    stock.closest("label").insertAdjacentHTML("afterend", `
      <label>低库存提醒<input id="productLowStock" type="number" min="0" step="1" value="3"></label>
    `);
  }
  const image = document.querySelector("#productImage");
  if (image && !document.querySelector("#productGift")) {
    image.closest("label").insertAdjacentHTML("afterend", `
      <label class="check-row"><input id="productGift" type="checkbox"> 赠品/不可购买</label>
    `);
  }
  const settingsForm = document.querySelector("#settingsForm");
  if (settingsForm && !document.querySelector("#promotionEditor")) {
    settingsForm.insertAdjacentHTML("afterend", `
      <section id="promotionEditor" class="staff-manager promotion-manager">
        <div>
          <h2>促销规则</h2>
          <p class="small-muted">赠品需要先在商品里添加，并勾选“赠品/不可购买”。每条规则满足后赠送一次。</p>
        </div>
        <div class="promo-block">
          <h3>满额赠品</h3>
          <div id="amountGiftRules" class="promo-list"></div>
          <button class="ghost-btn" type="button" data-add-promo="amount_gifts">添加满额赠品</button>
        </div>
        <div class="promo-block">
          <h3>买件赠品</h3>
          <div id="quantityGiftRules" class="promo-list"></div>
          <button class="ghost-btn" type="button" data-add-promo="quantity_gifts">添加买件赠品</button>
        </div>
        <div class="promo-block">
          <h3>满额减价</h3>
          <div id="amountDiscountRules" class="promo-list"></div>
          <button class="ghost-btn" type="button" data-add-promo="amount_discounts">添加满额减价</button>
        </div>
        <button id="savePromotions" class="primary-btn" type="button">保存促销规则</button>
      </section>
    `);
  }
}

async function login(event) {
  event.preventDefault();
  const staffName = getLoginStaffName();
  if (!staffName) return alert("请先填写或选择摊员身份");
  try {
    unlockAudio();
    const result = await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        password: document.querySelector("#passwordInput").value,
        staff_name: staffName,
      }),
    });
    adminState.staffName = result.staff_name || staffName;
    localStorage.setItem("booth_staff_name", adminState.staffName);
    await checkLogin();
  } catch (error) {
    alert(error.message);
  }
}

function isClaimedByOther(order) {
  return order.picker_name && order.picker_name !== currentStaffName();
}

function pickingProgress(order) {
  const total = order.items.length;
  const done = order.items.filter((item) => item.picked).length;
  return { done, total, complete: total > 0 && done === total };
}

function orderActionButtons(order) {
  const actions = [];
  if (order.order_status === "new") {
    actions.push(`<button class="primary-btn" data-claim-order="${order.id}">开始拣货</button>`);
  }
  if (order.order_status === "picking") {
    if (!order.picker_name) {
      actions.push(`<button class="primary-btn" data-claim-order="${order.id}">开始拣货</button>`);
      actions.push(`<button class="ghost-btn" data-order-status="${order.id}:new">撤回新订单</button>`);
      return actions.join("");
    }
    if (isClaimedByOther(order)) {
      actions.push(`<button class="ghost-btn" data-transfer-order="${order.id}">转交给我</button>`);
    } else {
      const progress = pickingProgress(order);
      actions.push(`<button class="primary-btn" data-order-status="${order.id}:ready">${progress.complete ? "待取单" : "未拣完也待取单"}</button>`);
      actions.push(`<button class="ghost-btn" data-release-order="${order.id}">释放拣货</button>`);
    }
    actions.push(`<button class="ghost-btn" data-order-status="${order.id}:new">撤回新订单</button>`);
  }
  if (order.order_status === "ready") {
    if (order.payment_status === "pending") {
      actions.push(`<button class="ghost-btn" data-pay-status="${order.id}:verified">已核验</button>`);
    }
    if (order.payment_status === "cash_pending") {
      actions.push(`<button class="ghost-btn" data-pay-status="${order.id}:cash_received">现金已收</button>`);
    }
    actions.push(`<button class="primary-btn" data-order-status="${order.id}:completed">已取单</button>`);
    actions.push(`<button class="ghost-btn" data-order-status="${order.id}:picking">撤回拣货中</button>`);
  }
  if (order.order_status === "completed") {
    actions.push(`<button class="ghost-btn" data-order-status="${order.id}:ready">撤回待取单</button>`);
  }
  return actions.join("");
}

function orderItemsMarkup(order, interactive = false) {
  const canPick = interactive && order.order_status === "picking" && !isClaimedByOther(order);
  return `
    <div class="pick-list">
      ${order.items.map((item) => {
        const gift = isGiftItem(item);
        const promotion = gift && item.promotion_name ? `<small>来自：${escapeHtml(item.promotion_name)}</small>` : "";
        return `
        <button class="pick-line ${item.picked ? "picked" : ""} ${gift ? "gift-line" : ""}" type="button" data-pick-item="${item.id}" data-picked="${item.picked ? "1" : "0"}" ${canPick ? "" : "disabled"}>
          <span class="pick-box">${item.picked ? "✓" : ""}</span>
          <span class="pick-text">${gift ? giftBadge() : ""}${escapeHtml(item.name)} × ${item.quantity}${promotion}</span>
          <span class="pick-price">${money(item.price)}</span>
        </button>
      `;
      }).join("")}
    </div>
  `;
}

function pickerMeta(order) {
  const progress = pickingProgress(order);
  if (order.order_status === "picking" && order.picker_name) {
    const time = order.picker_at ? ` · ${order.picker_at.slice(11, 16)}` : "";
    return `<p class="order-meta picker-meta">拣货中：${escapeHtml(order.picker_name)}${time}${progress.total ? ` · ${progress.done}/${progress.total}` : ""}</p>`;
  }
  if (order.order_status === "ready" && order.picker_name) {
    const time = order.ready_at ? ` · ${order.ready_at.slice(11, 16)}` : "";
    return `<p class="order-meta picker-meta">拣货完成：${escapeHtml(order.picker_name)}${time}</p>`;
  }
  return "";
}

function renderOrders() {
  const lanes = {
    new: document.querySelector("#laneNew"),
    picking: document.querySelector("#lanePicking"),
    ready: document.querySelector("#laneReady"),
    completed: document.querySelector("#laneDone"),
  };
  Object.values(lanes).forEach((lane) => lane.innerHTML = "");
  const counts = { new: 0, picking: 0, ready: 0, completed: 0 };
  const sortedOrders = [...adminState.orders].sort((a, b) => {
    if (a.order_status === "ready" && b.order_status === "ready") {
      return (b.ready_at || b.updated_at || "").localeCompare(a.ready_at || a.updated_at || "");
    }
    return b.id - a.id;
  });
  for (const order of sortedOrders) {
    const laneKey = order.order_status === "cancelled" ? "completed" : order.order_status;
    counts[laneKey] = (counts[laneKey] || 0) + 1;
    const payBadgeClass = ["verified", "cash_received"].includes(order.payment_status) ? "ok" : "warn";
    const contact = order.receive_type === "later" ? `电话 ${order.phone || "未填"}` : `尾号 ${order.phone_tail || "未填"}`;
    const card = document.createElement("article");
    card.className = `order-card ${order.id > adminState.lastOrderId ? "new-flash" : ""}`;
    card.innerHTML = `
      <div class="order-code-row">
        <div>
          <div class="order-code">${escapeHtml(order.pickup_code)}</div>
          <div class="order-meta">${escapeHtml(order.created_at)}</div>
        </div>
        <div>
          <span class="badge ${payBadgeClass}">${payText[order.payment_status]}</span>
        </div>
      </div>
      <p class="order-meta">${receiveText[order.receive_type]} · ${methodText[order.payment_method]} · ${escapeHtml(contact)}</p>
      ${pickerMeta(order)}
      ${order.pickup_time ? `<p class="order-meta">预计领取：${escapeHtml(order.pickup_time)}</p>` : ""}
      ${orderItemsMarkup(order, true)}
      ${priceSummaryMarkup(order, true)}
      ${order.note ? `<p class="order-note"><strong>备注：</strong>${escapeHtml(order.note)}</p>` : ""}
      <div class="order-actions">
        ${orderActionButtons(order)}
      </div>
    `;
    lanes[laneKey]?.appendChild(card);
  }
  document.querySelector("#countNew").textContent = counts.new;
  document.querySelector("#countPicking").textContent = counts.picking;
  document.querySelector("#countReady").textContent = counts.ready;
  document.querySelector("#countDone").textContent = counts.completed;
  updateStaffBadge();
}

function renderProducts() {
  const list = document.querySelector("#productList");
  if (!list) return;
  renderProductTools();
  const visibleProducts = filteredProducts();
  list.innerHTML = visibleProducts.map((product) => {
    const giftEmpty = product.is_gift && Number(product.stock || 0) <= 0;
    const lowStock = !product.is_gift && product.active && Number(product.stock || 0) > 0 && Number(product.stock || 0) <= Number(product.low_stock_threshold ?? 3);
    const selected = adminState.selectedProductIds.has(product.id);
    return `
    <article class="admin-product ${giftEmpty ? "gift-empty" : ""}">
      <div class="product-admin-row">
        <label class="product-select" title="选择商品">
          <input type="checkbox" data-select-product="${product.id}" ${selected ? "checked" : ""}>
        </label>
        <div>
          <strong>${escapeHtml(product.name)}${product.is_gift ? giftBadge() : ""}${giftEmpty ? `<span class="stock-alert-badge">赠品已送完</span>` : ""}${lowStock ? `<span class="badge warn">低库存</span>` : ""}</strong>
          <div class="product-author-line">
            <span class="author-pill">作者：${escapeHtml(product.author || "未填作者")}</span>
            <span class="badge">${escapeHtml(product.category || "未分类")}</span>
          </div>
          <div class="product-tag-row">${productTagsMarkup(product.tags)}</div>
          <p>${money(product.price)} · 库存 ${product.stock} · ${product.is_gift ? "不可购买" : (product.active ? "上架" : "下架")}</p>
        </div>
        ${product.image ? `<img src="${product.image}" alt="${escapeHtml(product.name)}">` : ""}
      </div>
      <div class="admin-product-actions">
        <button class="ghost-btn" data-copy-product="${product.id}">复制新增</button>
        <button class="ghost-btn" data-edit-product="${product.id}">编辑</button>
        <button class="ghost-btn danger-text" data-delete-product="${product.id}">删除</button>
      </div>
    </article>
  `;
  }).join("") || `<p class="small-muted">没有找到符合条件的商品</p>`;
}

function salesScopeText() {
  return adminState.salesDate ? `${adminState.salesDate} 订单` : "全部历史订单";
}

function orderDateKey(order) {
  return String(order.created_at || "").slice(0, 10) || "未记录日期";
}

function salesOrderCard(order) {
  const paid = ["verified", "cash_received"].includes(order.payment_status);
  const contact = order.receive_type === "later"
    ? `电话 ${escapeHtml(order.phone || "未填")}`
    : `尾号 ${escapeHtml(order.phone_tail || "未填")}`;
  return `
    <article class="sales-order-card">
      <div class="order-code-row">
        <div>
          <div class="order-code">${escapeHtml(order.pickup_code)}</div>
          <div class="sales-order-badges">
            <span class="badge">${statusText[order.order_status] || order.order_status}</span>
            <span class="badge ${paid ? "ok" : "warn"}">${payText[order.payment_status] || order.payment_status}</span>
          </div>
        </div>
        <strong class="sales-order-total">${money(order.total)}</strong>
      </div>
      <div class="sales-order-facts">
        <span>${escapeHtml(order.created_at)}</span>
        <span>${receiveText[order.receive_type]} · ${methodText[order.payment_method]}</span>
        <span>${contact}</span>
        ${order.pickup_time ? `<span>预计领取 ${escapeHtml(order.pickup_time)}</span>` : ""}
      </div>
      <ol class="sales-order-items">${order.items.map((item) => `<li>${orderItemLine(item)}</li>`).join("")}</ol>
    </article>
  `;
}

function renderSalesOrders(orderList, orders) {
  if (!orders.length) {
    orderList.innerHTML = `<p class="small-muted">这个范围内还没有订单</p>`;
    return;
  }
  if (adminState.salesDate) {
    orderList.innerHTML = `<div class="sales-order-grid">${orders.map(salesOrderCard).join("")}</div>`;
    return;
  }
  const groups = new Map();
  orders.forEach((order) => {
    const key = orderDateKey(order);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(order);
  });
  orderList.innerHTML = [...groups.entries()].map(([date, dayOrders]) => `
    <section class="sales-date-group">
      <h3>${escapeHtml(date)}<span>${dayOrders.length} 单</span></h3>
      <div class="sales-order-grid">${dayOrders.map(salesOrderCard).join("")}</div>
    </section>
  `).join("");
}

function renderSales() {
  if (!adminState.sales || !document.querySelector("#salesOrderCount")) return;
  document.querySelector("#salesOrderCount").textContent = adminState.sales.order_count;
  document.querySelector("#salesQuantity").textContent = adminState.sales.sold_quantity;
  document.querySelector("#salesTotal").textContent = money(adminState.sales.sales_total);
  document.querySelector("#salesDateInput").value = adminState.salesDate;
  document.querySelector("#salesScopeLabel").textContent = salesScopeText();
  const exportQuery = adminState.salesDate ? `?date=${encodeURIComponent(adminState.salesDate)}` : "";
  document.querySelector("#authorExportLink").href = `/api/admin/export-authors${exportQuery}`;

  const authorList = document.querySelector("#salesAuthorList");
  authorList.innerHTML = (adminState.sales.authors || []).map((author) => `
    <article class="author-share-card">
      <div>
        <strong>${escapeHtml(author.author)}</strong>
        <span>${author.order_count} 单 · 售出 ${author.sold_quantity} 件 · 赠品 ${author.gift_quantity} 件</span>
      </div>
      <dl>
        <div><dt>原价</dt><dd>${money(author.gross_sales)}</dd></div>
        <div><dt>分摊优惠</dt><dd>- ${money(author.discount_share)}</dd></div>
        <div><dt>分账金额</dt><dd>${money(author.net_sales)}</dd></div>
      </dl>
    </article>
  `).join("") || `<p class="small-muted">这个范围内还没有作者分账数据</p>`;

  const list = document.querySelector("#salesProductList");
  list.innerHTML = adminState.sales.products.map((product) => `
    <article class="sales-product-row">
      <div class="sales-product-name">
        <strong>${escapeHtml(product.name)}${isGiftItem(product) ? giftBadge() : ""}</strong>
        <div class="product-author-line">
          <span class="author-pill">作者：${escapeHtml(product.author || "未填作者")}</span>
          <span class="badge">${escapeHtml(product.category || "未分类")}</span>
        </div>
      </div>
      <dl class="sales-product-metrics">
        <div><dt>单价</dt><dd>${money(product.price)}</dd></div>
        <div><dt>${isGiftItem(product) ? "赠出数量" : "售出数量"}</dt><dd>${product.sold_quantity} 件</dd></div>
        <div><dt>销售额</dt><dd>${money(product.sales_total)}</dd></div>
      </dl>
    </article>
  `).join("") || `<p class="small-muted">这个范围内还没有销售记录</p>`;
  const orderList = document.querySelector("#salesOrderList");
  renderSalesOrders(orderList, adminState.sales.orders || []);
}

function fillProductForm(product) {
  document.querySelector("#productId").value = product?.id || "";
  document.querySelector("#productName").value = product?.name || "";
  document.querySelector("#productPrice").value = product?.price || "";
  document.querySelector("#productStock").value = product?.stock ?? "";
  if (document.querySelector("#productLowStock")) document.querySelector("#productLowStock").value = product?.low_stock_threshold ?? 3;
  document.querySelector("#productCategory").value = product?.category || "";
  document.querySelector("#productAuthor").value = product?.author || "";
  document.querySelector("#productTags").value = product?.tags || "";
  if (document.querySelector("#productGift")) document.querySelector("#productGift").checked = Boolean(product?.is_gift);
  document.querySelector("#productActive").checked = product?.active ?? true;
  document.querySelector("#productImage").value = "";
  adminState.editingImage = product?.image || "";
}

function copyProductToForm(product) {
  fillProductForm(product);
  document.querySelector("#productId").value = "";
  const nameInput = document.querySelector("#productName");
  window.scrollTo({ top: 0, behavior: "smooth" });
  nameInput.focus();
  nameInput.select();
  showAdminToast("制品信息已复制，修改名称后保存即可新增");
}

function renderStaffManager() {
  const list = document.querySelector("#staffList");
  if (!list) return;
  const members = staffMembers();
  list.innerHTML = members.map((name) => `
    <div class="staff-row">
      <strong>${escapeHtml(name)}</strong>
      <div>
        <button class="ghost-btn" type="button" data-rename-staff="${escapeHtml(name)}">改名</button>
        <button class="ghost-btn" type="button" data-delete-staff="${escapeHtml(name)}">删除</button>
      </div>
    </div>
  `).join("") || `<p class="small-muted">还没有配置摊员。未配置时，登录页会允许直接用“摊主”进入。</p>`;
}

function isGiftItem(item) {
  return item?.item_type === "gift" || item?.is_gift;
}

function giftBadge() {
  return `<span class="gift-badge">赠品</span>`;
}

function productTagsMarkup(tags) {
  const values = splitTags(tags);
  if (!values.length) return `<span class="small-muted">无标签</span>`;
  return values.map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join("");
}

function productMatchesFilter(product) {
  const search = adminState.productSearch.trim().toLowerCase();
  if (search) {
    const haystack = [product.name, product.author, product.category, product.tags]
      .map((value) => String(value || "").toLowerCase())
      .join(" ");
    if (!haystack.includes(search)) return false;
  }
  if (adminState.productAuthorFilter && product.author !== adminState.productAuthorFilter) return false;
  const stock = Number(product.stock || 0);
  const low = Number(product.low_stock_threshold ?? 3);
  if (adminState.productFilter === "active") return product.active && !product.is_gift;
  if (adminState.productFilter === "low") return product.active && !product.is_gift && stock > 0 && stock <= low;
  if (adminState.productFilter === "soldout") return stock <= 0;
  if (adminState.productFilter === "gift") return Boolean(product.is_gift);
  if (adminState.productFilter === "hidden") return !product.active;
  return true;
}

function filteredProducts() {
  return adminState.products.filter(productMatchesFilter);
}

function renderProductTools() {
  const search = document.querySelector("#productSearch");
  const filter = document.querySelector("#productFilter");
  const authorFilter = document.querySelector("#productAuthorFilter");
  const bulkState = document.querySelector("#productBulkState");
  const bulkButton = document.querySelector("#bulkDeleteProducts");
  const authorOptions = document.querySelector("#authorOptions");
  if (!search || !filter || !authorFilter) return;

  search.value = adminState.productSearch;
  filter.value = adminState.productFilter;
  const authors = uniqueSorted(adminState.products.map((product) => product.author));
  authorFilter.innerHTML = `<option value="">全部作者</option>${authors.map((author) => (
    `<option value="${escapeHtml(author)}" ${adminState.productAuthorFilter === author ? "selected" : ""}>${escapeHtml(author)}</option>`
  )).join("")}`;
  if (authorOptions) {
    authorOptions.innerHTML = authors.map((author) => `<option value="${escapeHtml(author)}"></option>`).join("");
  }
  const validIds = new Set(adminState.products.map((product) => product.id));
  adminState.selectedProductIds = new Set([...adminState.selectedProductIds].filter((id) => validIds.has(id)));
  if (bulkState) bulkState.textContent = `已选 ${adminState.selectedProductIds.size} 个`;
  if (bulkButton) bulkButton.disabled = adminState.selectedProductIds.size === 0;
  renderTagSuggestions();
}

function renderTagSuggestions() {
  const mount = document.querySelector("#tagSuggestions");
  if (!mount) return;
  const tags = uniqueSorted(adminState.products.flatMap((product) => splitTags(product.tags))).slice(0, 28);
  mount.innerHTML = tags.length
    ? `<span>常用标签</span>${tags.map((tag) => `<button type="button" data-add-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join("")}`
    : `<span>保存商品后，会在这里显示常用标签。</span>`;
}

function addTagToForm(tag) {
  const input = document.querySelector("#productTags");
  if (!input) return;
  const tags = splitTags(input.value);
  if (!tags.includes(tag)) tags.push(tag);
  input.value = tags.join("，");
  input.focus();
}

function promoGiftOptions(selectedId = 0) {
  const gifts = adminState.products.filter((product) => product.is_gift);
  if (!gifts.length) return `<option value="">先添加赠品商品</option>`;
  return [`<option value="">选择赠品</option>`, ...gifts.map((product) => (
    `<option value="${product.id}" ${Number(selectedId) === product.id ? "selected" : ""}>${escapeHtml(product.name)}（库存 ${product.stock}${Number(product.stock || 0) <= 0 ? "，已送完" : ""}）</option>`
  ))].join("");
}

function promoProductPicker(selectedIds = []) {
  const selected = new Set((selectedIds || []).map(Number));
  const products = adminState.products.filter((product) => !product.is_gift);
  if (!products.length) return `<p class="small-muted">还没有可售商品</p>`;
  return `
    <div class="promo-product-picker">
      ${products.map((product) => {
        const meta = [product.category, product.author, product.tags].filter(Boolean).join(" · ");
        return `
          <label class="promo-product-option">
            <input type="checkbox" data-promo-product value="${product.id}" ${selected.has(product.id) ? "checked" : ""}>
            <span>
              <strong>${escapeHtml(product.name)}</strong>
              ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
            </span>
          </label>
        `;
      }).join("")}
    </div>
  `;
}

function promotionTriggerType(rule) {
  return ["all", "tag", "products"].includes(rule?.trigger_type) ? rule.trigger_type : "all";
}

function syncPromotionRowVisibility(row) {
  if (!row) return;
  const triggerType = row.querySelector('[data-promo-field="trigger_type"]')?.value || "all";
  row.classList.remove("trigger-all", "trigger-tag", "trigger-products");
  row.classList.add(`trigger-${triggerType}`);
}

function priceSummaryMarkup(order, compact = false) {
  const subtotal = Number(order.subtotal || order.total || 0);
  const discount = Number(order.discount_total || 0);
  const total = Number(order.total || 0);
  if (discount <= 0) {
    return `<p class="${compact ? "order-total-line compact" : "order-total-line"}"><strong>合计 ${money(total)}</strong></p>`;
  }
  return `
    <div class="${compact ? "price-breakdown compact" : "price-breakdown"}">
      <div><span>原价</span><strong>${money(subtotal)}</strong></div>
      <div class="discount"><span>满减</span><strong>- ${money(discount)}</strong></div>
      <div class="final"><span>优惠后</span><strong>${money(total)}</strong></div>
    </div>
  `;
}

function orderItemLine(item) {
  const gift = isGiftItem(item);
  const promotion = gift && item.promotion_name ? ` <span class="item-promo">来自：${escapeHtml(item.promotion_name)}</span>` : "";
  return `${gift ? giftBadge() : ""}${escapeHtml(item.name)} × ${item.quantity}：${money(item.price)}${promotion}`;
}

function renderPromotions() {
  if (!document.querySelector("#promotionEditor")) return;
  const data = promotions();
  document.querySelector("#amountGiftRules").innerHTML = data.amount_gifts.map((rule, index) => `
    <div class="promo-row" data-promo-row="amount_gifts:${index}">
      <input data-promo-field="name" value="${escapeHtml(rule.name || "")}" placeholder="规则名">
      <input data-promo-field="threshold" type="number" min="0" step="0.01" value="${rule.threshold || ""}" placeholder="满额">
      <select data-promo-field="gift_product_id">${giftOptions(rule.gift_product_id)}</select>
      <input data-promo-field="gift_quantity" type="number" min="1" step="1" value="${rule.gift_quantity || 1}" placeholder="数量">
      <label class="check-row"><input data-promo-field="active" type="checkbox" ${rule.active === false ? "" : "checked"}> 启用</label>
      <button class="ghost-btn" type="button" data-remove-promo="amount_gifts:${index}">删除</button>
    </div>
  `).join("") || `<p class="small-muted">还没有满额赠品规则</p>`;
  document.querySelector("#quantityGiftRules").innerHTML = data.quantity_gifts.map((rule, index) => `
    <div class="promo-row" data-promo-row="quantity_gifts:${index}">
      <input data-promo-field="name" value="${escapeHtml(rule.name || "")}" placeholder="规则名">
      <input data-promo-field="buy_quantity" type="number" min="1" step="1" value="${rule.buy_quantity || ""}" placeholder="买满件数">
      <select data-promo-field="gift_product_id">${giftOptions(rule.gift_product_id)}</select>
      <input data-promo-field="gift_quantity" type="number" min="1" step="1" value="${rule.gift_quantity || 1}" placeholder="数量">
      <label class="check-row"><input data-promo-field="active" type="checkbox" ${rule.active === false ? "" : "checked"}> 启用</label>
      <button class="ghost-btn" type="button" data-remove-promo="quantity_gifts:${index}">删除</button>
    </div>
  `).join("") || `<p class="small-muted">还没有买件赠品规则</p>`;
  document.querySelector("#amountDiscountRules").innerHTML = data.amount_discounts.map((rule, index) => `
    <div class="promo-row" data-promo-row="amount_discounts:${index}">
      <input data-promo-field="name" value="${escapeHtml(rule.name || "")}" placeholder="规则名">
      <input data-promo-field="threshold" type="number" min="0" step="0.01" value="${rule.threshold || ""}" placeholder="满额">
      <input data-promo-field="discount" type="number" min="0" step="0.01" value="${rule.discount || ""}" placeholder="减价">
      <label class="check-row"><input data-promo-field="active" type="checkbox" ${rule.active === false ? "" : "checked"}> 启用</label>
      <button class="ghost-btn" type="button" data-remove-promo="amount_discounts:${index}">删除</button>
    </div>
  `).join("") || `<p class="small-muted">还没有满额减价规则</p>`;
}

function renderPromotions() {
  if (!document.querySelector("#promotionEditor")) return;
  const data = promotions();
  document.querySelector("#amountGiftRules").innerHTML = data.amount_gifts.map((rule, index) => `
    <div class="promo-row promo-rule" data-promo-row="amount_gifts:${index}">
      <div class="promo-rule-title"><strong>满额赠品</strong><span>第 ${index + 1} 条</span></div>
      <label class="promo-field">规则名
        <input data-promo-field="name" value="${escapeHtml(rule.name || "")}" placeholder="例如 满 100 送明信片">
      </label>
      <label class="promo-field">订单满额
        <input data-promo-field="threshold" type="number" min="0" step="0.01" value="${rule.threshold || ""}" placeholder="满多少元">
      </label>
      <label class="promo-field">赠品
        <select data-promo-field="gift_product_id">${promoGiftOptions(rule.gift_product_id)}</select>
      </label>
      <label class="promo-field">赠送数量
        <input data-promo-field="gift_quantity" type="number" min="1" step="1" value="${rule.gift_quantity || 1}">
      </label>
      <div class="promo-rule-actions">
        <label class="check-row"><input data-promo-field="active" type="checkbox" ${rule.active === false ? "" : "checked"}> 启用</label>
        <button class="ghost-btn" type="button" data-remove-promo="amount_gifts:${index}">删除</button>
      </div>
    </div>
  `).join("") || `<p class="small-muted">还没有满额赠品规则</p>`;

  document.querySelector("#quantityGiftRules").innerHTML = data.quantity_gifts.map((rule, index) => `
    <div class="promo-row promo-rule promo-quantity-rule trigger-${promotionTriggerType(rule)}" data-promo-row="quantity_gifts:${index}">
      <div class="promo-rule-title"><strong>买件赠品</strong><span>第 ${index + 1} 条</span></div>
      <label class="promo-field">规则名
        <input data-promo-field="name" value="${escapeHtml(rule.name || "")}" placeholder="例如 买吧唧送小卡">
      </label>
      <label class="promo-field">买哪些商品
        <select data-promo-field="trigger_type">
        <option value="all" ${(rule.trigger_type || "all") === "all" ? "selected" : ""}>全部商品</option>
        <option value="tag" ${rule.trigger_type === "tag" ? "selected" : ""}>指定标签</option>
        <option value="products" ${rule.trigger_type === "products" ? "selected" : ""}>指定商品</option>
        </select>
      </label>
      <label class="promo-field promo-tag-field">触发标签
        <input data-promo-field="trigger_tag" value="${escapeHtml(rule.trigger_tag || "")}" placeholder="和商品标签完全一致">
      </label>
      <div class="promo-field promo-products-field">
        <span>指定商品</span>
        ${promoProductPicker(rule.trigger_product_ids)}
      </div>
      <label class="promo-field">买满件数
        <input data-promo-field="buy_quantity" type="number" min="1" step="1" value="${rule.buy_quantity || 1}">
      </label>
      <label class="promo-field">赠品
        <select data-promo-field="gift_product_id">${promoGiftOptions(rule.gift_product_id)}</select>
      </label>
      <label class="promo-field">赠送数量
        <input data-promo-field="gift_quantity" type="number" min="1" step="1" value="${rule.gift_quantity || 1}">
      </label>
      <div class="promo-rule-actions">
        <label class="check-row"><input data-promo-field="active" type="checkbox" ${rule.active === false ? "" : "checked"}> 启用</label>
        <button class="ghost-btn" type="button" data-remove-promo="quantity_gifts:${index}">删除</button>
      </div>
    </div>
  `).join("") || `<p class="small-muted">还没有买件赠品规则</p>`;

  document.querySelector("#amountDiscountRules").innerHTML = data.amount_discounts.map((rule, index) => `
    <div class="promo-row promo-rule" data-promo-row="amount_discounts:${index}">
      <div class="promo-rule-title"><strong>满额减价</strong><span>第 ${index + 1} 条</span></div>
      <label class="promo-field">规则名
        <input data-promo-field="name" value="${escapeHtml(rule.name || "")}" placeholder="例如 满 100 减 10">
      </label>
      <label class="promo-field">订单满额
        <input data-promo-field="threshold" type="number" min="0" step="0.01" value="${rule.threshold || ""}" placeholder="满多少元">
      </label>
      <label class="promo-field">减价金额
        <input data-promo-field="discount" type="number" min="0" step="0.01" value="${rule.discount || ""}" placeholder="减多少元">
      </label>
      <div class="promo-rule-actions">
        <label class="check-row"><input data-promo-field="active" type="checkbox" ${rule.active === false ? "" : "checked"}> 启用</label>
        <button class="ghost-btn" type="button" data-remove-promo="amount_discounts:${index}">删除</button>
      </div>
    </div>
  `).join("") || `<p class="small-muted">还没有满额减价规则</p>`;
}

function renderSettings(force = false) {
  if (adminState.settingsDirty && !force) return;
  document.querySelector("#settingBoothName").value = adminState.settings.booth_name || "";
  document.querySelector("#settingWelcome").value = adminState.settings.welcome || "";
  adminState.settingImages = {
    logo: adminState.settings.logo || "",
    wechat_qr: adminState.settings.wechat_qr || "",
    alipay_qr: adminState.settings.alipay_qr || "",
  };
  renderStaffManager();
  if (!adminState.promotionsDirty || force) renderPromotions();
}

async function loadAll(playNotice = true) {
  adminState.orderDate = new Date().toISOString().slice(0, 10);
  const dateQuery = `?date=${encodeURIComponent(adminState.orderDate)}`;
  const [orders, products, settings] = await Promise.all([
    api(`/api/admin/orders${dateQuery}`),
    api("/api/admin/products"),
    api("/api/admin/settings"),
  ]);
  const newest = orders.reduce((max, order) => Math.max(max, order.id), 0);
  const oldLast = adminState.lastOrderId;
  adminState.orders = orders;
  adminState.products = products;
  adminState.settings = settings;
  normalizeCurrentStaff();
  renderOrders();
  renderProducts();
  renderSettings(false);
  if (playNotice && oldLast && newest > oldLast) {
    const newOrder = orders.find((order) => order.id === newest);
    if (newOrder) notify(newOrder);
  }
  adminState.lastOrderId = Math.max(adminState.lastOrderId, newest);
}

async function loadSales() {
  const dateQuery = adminState.salesDate ? `?date=${encodeURIComponent(adminState.salesDate)}` : "";
  adminState.sales = await api(`/api/admin/sales${dateQuery}`);
  renderSales();
}

async function deleteSelectedProducts() {
  const ids = [...adminState.selectedProductIds];
  if (!ids.length) return;
  if (!confirm(`确定删除选中的 ${ids.length} 个商品吗？历史订单不会删除，但这些商品会从当前商品列表移除。`)) return;
  await Promise.all(ids.map((id) => api(`/api/admin/products/${id}`, { method: "DELETE" })));
  adminState.selectedProductIds.clear();
  showAdminToast("已批量删除商品");
  await loadAll(false);
}

async function saveProduct(event) {
  event.preventDefault();
  try {
    const image = await fileToDataUrl(document.querySelector("#productImage")) || adminState.editingImage;
    const payload = {
      name: document.querySelector("#productName").value,
      price: Number(document.querySelector("#productPrice").value),
      stock: Number(document.querySelector("#productStock").value),
      low_stock_threshold: Number(document.querySelector("#productLowStock")?.value || 3),
      category: document.querySelector("#productCategory").value,
      author: document.querySelector("#productAuthor").value,
      tags: document.querySelector("#productTags").value,
      image,
      is_gift: Boolean(document.querySelector("#productGift")?.checked),
      active: document.querySelector("#productActive").checked,
    };
    const id = document.querySelector("#productId").value;
    await api(id ? `/api/admin/products/${id}` : "/api/admin/products", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(payload),
    });
    fillProductForm(null);
    showAdminToast("商品已保存");
    await loadAll(false);
  } catch (error) {
    alert(error.message);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    const logo = await fileToDataUrl(document.querySelector("#settingLogo")) || adminState.settingImages.logo;
    const wechat = await fileToDataUrl(document.querySelector("#settingWechat")) || adminState.settingImages.wechat_qr;
    const alipay = await fileToDataUrl(document.querySelector("#settingAlipay")) || adminState.settingImages.alipay_qr;
    const payload = {
      booth_name: document.querySelector("#settingBoothName").value,
      welcome: document.querySelector("#settingWelcome").value,
      logo,
      wechat_qr: wechat,
      alipay_qr: alipay,
    };
    const password = document.querySelector("#settingPassword").value;
    if (password) payload.admin_password = password;
    await api("/api/admin/settings", { method: "POST", body: JSON.stringify(payload) });
    adminState.settingsDirty = false;
    document.querySelector("#settingPassword").value = "";
    showAdminToast("摊位设置已保存");
    await loadAll(false);
  } catch (error) {
    alert(error.message);
  }
}

async function saveStaffMembers(members) {
  const clean = [];
  const seen = new Set();
  for (const member of members) {
    const name = String(member || "").trim().slice(0, 30);
    if (name && !seen.has(name)) {
      clean.push(name);
      seen.add(name);
    }
  }
  const settings = await api("/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ staff_members: JSON.stringify(clean) }),
  });
  adminState.settings = settings;
  if (clean.length && !clean.includes(currentStaffName())) {
    adminState.staffName = clean[0];
    localStorage.setItem("booth_staff_name", adminState.staffName);
  }
  renderStaffManager();
  renderOrders();
  await loadLoginStaffChoices();
}

function collectPromotions() {
  const data = { amount_gifts: [], quantity_gifts: [], amount_discounts: [] };
  document.querySelectorAll("[data-promo-row]").forEach((row) => {
    const [type] = row.dataset.promoRow.split(":");
    const rule = {};
    row.querySelectorAll("[data-promo-field]").forEach((field) => {
      const key = field.dataset.promoField;
      if (field.multiple) rule[key] = Array.from(field.selectedOptions).map((option) => Number(option.value)).filter(Boolean);
      else if (field.type === "checkbox") rule[key] = field.checked;
      else if (["threshold", "discount"].includes(key)) rule[key] = Number(field.value || 0);
      else if (["gift_product_id", "gift_quantity", "buy_quantity"].includes(key)) rule[key] = Number(field.value || 0);
      else rule[key] = field.value.trim();
    });
    const productChecks = row.querySelectorAll("[data-promo-product]");
    if (productChecks.length) {
      rule.trigger_product_ids = Array.from(productChecks)
        .filter((field) => field.checked)
        .map((field) => Number(field.value))
        .filter(Boolean);
    }
    data[type].push(rule);
  });
  return data;
}

function currentPromotionDraft() {
  return document.querySelector("[data-promo-row]") ? collectPromotions() : promotions();
}

async function savePromotions() {
  const next = collectPromotions();
  const settings = await api("/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ promotions: JSON.stringify(next) }),
  });
  adminState.settings = settings;
  adminState.promotionsDirty = false;
  renderPromotions();
  showAdminToast("促销规则已保存");
}

function addPromotion(type) {
  const data = currentPromotionDraft();
  if (type === "amount_gifts") {
    data.amount_gifts.push({ name: "满额赠品", threshold: 0, gift_product_id: 0, gift_quantity: 1, active: true });
  }
  if (type === "quantity_gifts") {
    data.quantity_gifts.push({ name: "买件赠品", trigger_type: "all", trigger_tag: "", trigger_product_ids: [], buy_quantity: 1, gift_product_id: 0, gift_quantity: 1, active: true });
  }
  if (type === "amount_discounts") {
    data.amount_discounts.push({ name: "满额减价", threshold: 0, discount: 0, active: true });
  }
  adminState.settings.promotions = JSON.stringify(data);
  adminState.promotionsDirty = true;
  renderPromotions();
}

function removePromotion(value) {
  const [type, indexText] = value.split(":");
  const data = currentPromotionDraft();
  data[type].splice(Number(indexText), 1);
  adminState.settings.promotions = JSON.stringify(data);
  adminState.promotionsDirty = true;
  renderPromotions();
}

async function updateOrder(id, field, value, extra = {}) {
  const payload = field === "status" ? { order_status: value } : { payment_status: value };
  Object.assign(payload, extra);
  await api(`/api/admin/orders/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
  await loadAll(false);
}

async function claimOrder(id) {
  try {
    await updateOrder(id, "status", "picking", { picker_name: currentStaffName() });
    showAdminToast(`已分配给 ${currentStaffName()}`);
  } catch (error) {
    if (error.status === 409) {
      showAdminToast(error.message);
      await loadAll(false);
      return;
    }
    throw error;
  }
}

async function transferOrder(id) {
  if (!confirm("确定把这张单转交给自己拣货吗？")) return;
  await updateOrder(id, "status", "picking", { picker_name: currentStaffName(), force_picker: true });
  showAdminToast(`已转交给 ${currentStaffName()}`);
}

async function releaseOrder(id) {
  await api(`/api/admin/orders/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ picker_name: "" }),
  });
  showAdminToast("已释放拣货");
  await loadAll(false);
}

async function togglePicked(itemId, picked) {
  await api(`/api/admin/order-items/${itemId}`, {
    method: "PATCH",
    body: JSON.stringify({ picked }),
  });
  await loadAll(false);
}

document.querySelector("#loginForm").addEventListener("submit", login);
document.addEventListener("pointerdown", unlockAudio, { once: true });
document.addEventListener("input", (event) => {
  if (event.target.closest("#promotionEditor")) adminState.promotionsDirty = true;
});
document.addEventListener("change", (event) => {
  const selectedProduct = event.target.closest("[data-select-product]");
  if (selectedProduct) {
    const id = Number(selectedProduct.dataset.selectProduct);
    if (selectedProduct.checked) adminState.selectedProductIds.add(id);
    else adminState.selectedProductIds.delete(id);
    renderProducts();
  }
  if (event.target.closest("#promotionEditor")) adminState.promotionsDirty = true;
  if (event.target.matches('[data-promo-field="trigger_type"]')) {
    syncPromotionRowVisibility(event.target.closest("[data-promo-row]"));
  }
});

function bindAdminViewEvents() {
  document.querySelector("#productForm").addEventListener("submit", saveProduct);
  document.querySelector("#settingsForm").addEventListener("submit", saveSettings);
  document.querySelector("#settingsForm").addEventListener("input", () => {
    adminState.settingsDirty = true;
  });
  document.querySelector("#addStaffBtn").addEventListener("click", async () => {
    const input = document.querySelector("#newStaffName");
    const name = input.value.trim();
    if (!name) return;
    const members = staffMembers();
    if (members.includes(name)) return showAdminToast("这个摊员已经在名单里了");
    await saveStaffMembers([...members, name]);
    input.value = "";
    showAdminToast("摊员已添加");
  });
  document.querySelector("#resetProduct").addEventListener("click", () => fillProductForm(null));
  document.querySelector("#productSearch").addEventListener("input", (event) => {
    adminState.productSearch = event.target.value;
    renderProducts();
  });
  document.querySelector("#productFilter").addEventListener("change", (event) => {
    adminState.productFilter = event.target.value;
    renderProducts();
  });
  document.querySelector("#productAuthorFilter").addEventListener("change", (event) => {
    adminState.productAuthorFilter = event.target.value;
    renderProducts();
  });
  document.querySelector("#bulkDeleteProducts").addEventListener("click", () => {
    deleteSelectedProducts().catch((error) => alert(error.message));
  });
  document.querySelector("#soundToggle").addEventListener("click", (event) => {
    unlockAudio();
    adminState.soundOn = !adminState.soundOn;
    event.target.textContent = `声音：${adminState.soundOn ? "开" : "关"}`;
    if (adminState.soundOn) beep();
  });
  document.querySelector("#enableNotify").addEventListener("click", async () => {
    unlockAudio();
    if (!("Notification" in window)) return alert("这个浏览器不支持系统通知");
    const result = await Notification.requestPermission();
    alert(result === "granted" ? "通知已开启" : "通知没有开启");
  });
  document.querySelector("#logoutBtn").addEventListener("click", async () => {
    try {
      await api("/api/admin/logout", { method: "POST" });
    } catch (error) {
      console.warn("退出请求失败，已在本页退出登录。", error);
    }
    document.cookie = "booth_admin=; Path=/; Max-Age=0; SameSite=Lax";
    adminState.mounted = false;
    adminState.orders = [];
    adminState.products = [];
    adminState.sales = null;
    document.querySelector("#adminMount").innerHTML = "";
    document.querySelector("#passwordInput").value = "";
    document.querySelector("#loginView").hidden = false;
    await loadLoginStaffChoices();
  });
  document.querySelector("#salesDateInput").addEventListener("change", async (event) => {
    adminState.salesDate = event.target.value;
    await loadSales();
  });
  document.querySelector("#allSales").addEventListener("click", async () => {
    adminState.salesDate = "";
    document.querySelector("#salesDateInput").value = "";
    await loadSales();
  });
  document.querySelector("#todaySales").addEventListener("click", async () => {
    adminState.salesDate = localDateString();
    document.querySelector("#salesDateInput").value = adminState.salesDate;
    await loadSales();
  });
  document.querySelector(".admin-tabs").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-tab]");
    if (!btn) return;
    document.querySelectorAll(".admin-tabs button").forEach((item) => item.classList.toggle("active", item === btn));
    document.querySelectorAll(".tab-panel").forEach((panel) => panel.hidden = true);
    document.querySelector(`#${btn.dataset.tab}Tab`).hidden = false;
    if (btn.dataset.tab === "sales") loadSales().catch((error) => alert(error.message));
  });
}

document.addEventListener("click", async (event) => {
  const status = event.target.closest("[data-order-status]");
  const pay = event.target.closest("[data-pay-status]");
  const claim = event.target.closest("[data-claim-order]");
  const transfer = event.target.closest("[data-transfer-order]");
  const release = event.target.closest("[data-release-order]");
  const pickItem = event.target.closest("[data-pick-item]");
  const copyProduct = event.target.closest("[data-copy-product]");
  const edit = event.target.closest("[data-edit-product]");
  const del = event.target.closest("[data-delete-product]");
  const renameStaff = event.target.closest("[data-rename-staff]");
  const deleteStaff = event.target.closest("[data-delete-staff]");
  const addPromo = event.target.closest("[data-add-promo]");
  const removePromo = event.target.closest("[data-remove-promo]");
  const savePromo = event.target.closest("#savePromotions");
  const addTag = event.target.closest("[data-add-tag]");
  try {
    if (addTag) addTagToForm(addTag.dataset.addTag);
    if (claim) await claimOrder(claim.dataset.claimOrder);
    if (transfer) await transferOrder(transfer.dataset.transferOrder);
    if (release) await releaseOrder(release.dataset.releaseOrder);
    if (pickItem) {
      const nextPicked = pickItem.dataset.picked !== "1";
      await togglePicked(pickItem.dataset.pickItem, nextPicked);
    }
    if (status) {
      const [id, value] = status.dataset.orderStatus.split(":");
      const order = adminState.orders.find((item) => item.id === Number(id));
      const unpaid = order && !["verified", "cash_received"].includes(order.payment_status);
      const progress = order ? pickingProgress(order) : { complete: true };
      const extra = value === "picking" && order && !order.picker_name ? { picker_name: currentStaffName() } : {};
      if (value === "ready" && order?.order_status === "picking" && !progress.complete && !confirm("还有商品没有勾选完成，确定标记为待取单吗？")) return;
      if (value === "completed" && unpaid && !confirm("这单还没有核验付款，确定标记为已取单吗？")) return;
      await updateOrder(id, "status", value, extra);
    }
    if (pay) {
      const [id, value] = pay.dataset.payStatus.split(":");
      await updateOrder(id, "pay", value);
    }
    if (copyProduct) {
      const product = adminState.products.find((item) => item.id === Number(copyProduct.dataset.copyProduct));
      if (product) copyProductToForm(product);
    }
    if (edit) {
      const product = adminState.products.find((item) => item.id === Number(edit.dataset.editProduct));
      fillProductForm(product);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    if (del && confirm("确定删除这个商品吗？")) {
      await api(`/api/admin/products/${del.dataset.deleteProduct}`, { method: "DELETE" });
      await loadAll(false);
    }
    if (renameStaff) {
      const oldName = renameStaff.dataset.renameStaff;
      const nextName = prompt("新的摊员名字", oldName)?.trim();
      if (!nextName || nextName === oldName) return;
      const members = staffMembers().map((name) => name === oldName ? nextName : name);
      await saveStaffMembers(members);
      if (currentStaffName() === oldName) {
        adminState.staffName = nextName;
        localStorage.setItem("booth_staff_name", nextName);
        updateStaffBadge();
      }
      showAdminToast("摊员已改名");
    }
    if (deleteStaff && confirm("确定删除这个摊员吗？")) {
      const oldName = deleteStaff.dataset.deleteStaff;
      const members = staffMembers().filter((name) => name !== oldName);
      await saveStaffMembers(members);
      showAdminToast("摊员已删除");
    }
  } catch (error) {
    alert(error.message);
  }
});

document.addEventListener("click", async (event) => {
  const addPromo = event.target.closest("[data-add-promo]");
  const removePromo = event.target.closest("[data-remove-promo]");
  const savePromo = event.target.closest("#savePromotions");
  if (!addPromo && !removePromo && !savePromo) return;
  try {
    if (addPromo) addPromotion(addPromo.dataset.addPromo);
    if (removePromo) removePromotion(removePromo.dataset.removePromo);
    if (savePromo) await savePromotions();
  } catch (error) {
    alert(error.message);
  }
});

setInterval(() => {
  const adminView = document.querySelector("#adminView");
  if (adminView) loadAll(true).catch(console.error);
}, 5000);

document.querySelector("#loginView").hidden = false;
document.querySelector("#adminMount").innerHTML = "";
adminState.mounted = false;
loadLoginStaffChoices();
