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
  audioContext: null,
  orderDate: "",
  salesDate: "",
  sales: null,
};

const money = (value) => `¥${Number(value || 0).toFixed(2)}`;
const statusText = { new: "新订单", picking: "拣货中", ready: "待取单", completed: "已取单", cancelled: "已取消" };
const payText = { pending: "待核验", verified: "已核验", cash_pending: "现金待收", cash_received: "现金已收" };
const methodText = { wechat: "微信", alipay: "支付宝", cash: "现金" };
const receiveText = { now: "现在领取", later: "稍后领取" };

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "操作失败");
  return data;
}

function fileToDataUrl(input) {
  return new Promise((resolve, reject) => {
    const file = input.files && input.files[0];
    if (!file) return resolve("");
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

async function checkLogin() {
  const data = await api("/api/admin/me");
  document.querySelector("#loginView").hidden = data.ok;
  if (data.ok) {
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
        <div>
          <h1>订单看板</h1>
          <p id="adminSubtitle">新订单会响一声并高亮。</p>
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
          <div class="board-actions">
            <button id="enableNotify" class="ghost-btn" type="button">开启系统通知</button>
            <button id="soundToggle" class="ghost-btn" type="button">声音：开</button>
            <span class="small-muted">订单看板默认显示今天订单。</span>
          </div>
          <div class="kanban">
            <div class="lane"><h2>新订单 <span id="countNew">0</span></h2><div id="laneNew"></div></div>
            <div class="lane"><h2>拣货中 <span id="countPicking">0</span></h2><div id="lanePicking"></div></div>
            <div class="lane"><h2>待取单 <span id="countReady">0</span></h2><div id="laneReady"></div></div>
            <div class="lane"><h2>已完成 <span id="countDone">0</span></h2><div id="laneDone"></div></div>
          </div>
        </section>

        <section id="productsTab" class="tab-panel" hidden>
          <form id="productForm" class="editor-form">
            <input type="hidden" id="productId">
            <label>商品名<input id="productName" required></label>
            <label>价格<input id="productPrice" type="number" min="0" step="0.01" required></label>
            <label>库存<input id="productStock" type="number" min="0" step="1" required></label>
            <label>分类<input id="productCategory" placeholder="徽章 / 纸品 / 套组"></label>
            <label>作者<input id="productAuthor" placeholder="合摊成员名"></label>
            <label>标签<input id="productTags" placeholder="作品、角色、属性，用逗号隔开"></label>
            <label>图片<input id="productImage" type="file" accept="image/*"></label>
            <label class="check-row"><input id="productActive" type="checkbox" checked> 上架</label>
            <button class="primary-btn" type="submit">保存商品</button>
            <button id="resetProduct" class="ghost-btn" type="button">清空表单</button>
          </form>
          <div id="productList" class="admin-list"></div>
        </section>

        <section id="settingsTab" class="tab-panel" hidden>
          <form id="settingsForm" class="editor-form settings-form">
            <label>摊位名<input id="settingBoothName"></label>
            <label>欢迎语<textarea id="settingWelcome" rows="3"></textarea></label>
            <label>Logo<input id="settingLogo" type="file" accept="image/*"></label>
            <label>微信收款码<input id="settingWechat" type="file" accept="image/*"></label>
            <label>支付宝收款码<input id="settingAlipay" type="file" accept="image/*"></label>
            <label>修改后台密码<input id="settingPassword" type="password" placeholder="不改就留空"></label>
            <button class="primary-btn" type="submit">保存摊位设置</button>
          </form>
        </section>

        <section id="salesTab" class="tab-panel" hidden>
          <div class="board-actions">
            <label class="date-filter">销售日期
              <input id="salesDateInput" type="date">
            </label>
            <button id="allSales" class="ghost-btn" type="button">全部历史</button>
            <button id="todaySales" class="ghost-btn" type="button">今天</button>
            <a class="ghost-link" href="/api/admin/export">导出订单明细</a>
            <a class="ghost-link" href="/api/admin/export-summary">导出商品汇总</a>
          </div>
          <div class="sales-summary">
            <div><span>订单数</span><strong id="salesOrderCount">0</strong></div>
            <div><span>售出件数</span><strong id="salesQuantity">0</strong></div>
            <div><span>营业总额</span><strong id="salesTotal">¥0.00</strong></div>
          </div>
          <div id="salesProductList" class="admin-list"></div>
          <h2 class="sales-section-title">订单明细</h2>
          <div id="salesOrderList" class="admin-list"></div>
        </section>
      </main>
    </section>
  `;
  adminState.mounted = true;
  bindAdminViewEvents();
}

async function login(event) {
  event.preventDefault();
  try {
    unlockAudio();
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: document.querySelector("#passwordInput").value }),
    });
    await checkLogin();
  } catch (error) {
    alert(error.message);
  }
}

function orderActionButtons(order) {
  const actions = [];
  if (order.order_status === "new") {
    actions.push(`<button class="primary-btn" data-order-status="${order.id}:picking">待拣货</button>`);
  }
  if (order.order_status === "picking") {
    actions.push(`<button class="primary-btn" data-order-status="${order.id}:ready">待取单</button>`);
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
    const card = document.createElement("article");
    card.className = `order-card ${order.id > adminState.lastOrderId ? "new-flash" : ""}`;
    card.innerHTML = `
      <div class="order-code-row">
        <div>
          <div class="order-code">${order.pickup_code}</div>
          <div class="order-meta">${order.created_at}</div>
        </div>
        <div>
          <span class="badge ${payBadgeClass}">${payText[order.payment_status]}</span>
        </div>
      </div>
      <p class="order-meta">${receiveText[order.receive_type]} · ${methodText[order.payment_method]} · ${order.receive_type === "later" ? `电话 ${order.phone || "未填"}` : `尾号 ${order.phone_tail || "未填"}`}</p>
      ${order.pickup_time ? `<p class="order-meta">预计领取：${order.pickup_time}</p>` : ""}
      <ol class="order-items">${order.items.map((item) => `<li>${item.name} × ${item.quantity}，${money(item.price)}</li>`).join("")}</ol>
      <p><strong>合计 ${money(order.total)}</strong></p>
      ${order.note ? `<p class="order-meta">备注：${order.note}</p>` : ""}
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
}

function renderProducts() {
  const list = document.querySelector("#productList");
  list.innerHTML = adminState.products.map((product) => `
    <article class="admin-product">
      <div class="product-admin-row">
        <div>
          <strong>${product.name}</strong>
          <div class="order-meta">${product.category || "未分类"} · ${product.author || "未填作者"}</div>
          <div class="order-meta">${product.tags || "无标签"}</div>
          <p>${money(product.price)} · 库存 ${product.stock} · ${product.active ? "上架" : "下架"}</p>
        </div>
        ${product.image ? `<img src="${product.image}" alt="${product.name}">` : ""}
      </div>
      <div class="admin-product-actions">
        <button class="ghost-btn" data-edit-product="${product.id}">编辑</button>
        <button class="ghost-btn" data-delete-product="${product.id}">删除</button>
      </div>
    </article>
  `).join("") || `<p class="small-muted">还没有商品</p>`;
}

function renderSales() {
  if (!adminState.sales || !document.querySelector("#salesOrderCount")) return;
  document.querySelector("#salesOrderCount").textContent = adminState.sales.order_count;
  document.querySelector("#salesQuantity").textContent = adminState.sales.sold_quantity;
  document.querySelector("#salesTotal").textContent = money(adminState.sales.sales_total);
  const list = document.querySelector("#salesProductList");
  list.innerHTML = adminState.sales.products.map((product) => `
    <article class="admin-product">
      <div class="product-admin-row">
        <div>
          <strong>${product.name}</strong>
          <div class="order-meta">${product.category || "未分类"} · ${product.author || "未填作者"}</div>
          <p>${money(product.price)} · 售出 ${product.sold_quantity} 件 · <strong>${money(product.sales_total)}</strong></p>
        </div>
      </div>
    </article>
  `).join("") || `<p class="small-muted">这个范围内还没有销售记录</p>`;
  const orderList = document.querySelector("#salesOrderList");
  orderList.innerHTML = adminState.sales.orders.map((order) => `
    <article class="admin-product">
      <div class="order-code-row">
        <div>
          <div class="order-code">${order.pickup_code}</div>
          <div class="order-meta">${order.created_at} · ${statusText[order.order_status]} · ${payText[order.payment_status]}</div>
        </div>
        <strong>${money(order.total)}</strong>
      </div>
      <p class="order-meta">${receiveText[order.receive_type]} · ${methodText[order.payment_method]} · ${order.receive_type === "later" ? `电话 ${order.phone || "未填"}` : `尾号 ${order.phone_tail || "未填"}`}</p>
      ${order.pickup_time ? `<p class="order-meta">预计领取：${order.pickup_time}</p>` : ""}
      <ol class="order-items">${order.items.map((item) => `<li>${item.name} × ${item.quantity}，${money(item.price)}</li>`).join("")}</ol>
    </article>
  `).join("") || `<p class="small-muted">这个范围内还没有订单</p>`;
}

function fillProductForm(product) {
  document.querySelector("#productId").value = product?.id || "";
  document.querySelector("#productName").value = product?.name || "";
  document.querySelector("#productPrice").value = product?.price || "";
  document.querySelector("#productStock").value = product?.stock ?? "";
  document.querySelector("#productCategory").value = product?.category || "";
  document.querySelector("#productAuthor").value = product?.author || "";
  document.querySelector("#productTags").value = product?.tags || "";
  document.querySelector("#productActive").checked = product?.active ?? true;
  document.querySelector("#productImage").value = "";
  adminState.editingImage = product?.image || "";
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

async function saveProduct(event) {
  event.preventDefault();
  try {
    const image = await fileToDataUrl(document.querySelector("#productImage")) || adminState.editingImage;
    const payload = {
      name: document.querySelector("#productName").value,
      price: Number(document.querySelector("#productPrice").value),
      stock: Number(document.querySelector("#productStock").value),
      category: document.querySelector("#productCategory").value,
      author: document.querySelector("#productAuthor").value,
      tags: document.querySelector("#productTags").value,
      image,
      active: document.querySelector("#productActive").checked,
    };
    const id = document.querySelector("#productId").value;
    await api(id ? `/api/admin/products/${id}` : "/api/admin/products", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(payload),
    });
    fillProductForm(null);
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
    alert("保存好了");
    await loadAll(false);
  } catch (error) {
    alert(error.message);
  }
}

async function updateOrder(id, field, value) {
  const payload = field === "status" ? { order_status: value } : { payment_status: value };
  await api(`/api/admin/orders/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
  await loadAll(false);
}

document.querySelector("#loginForm").addEventListener("submit", login);
document.addEventListener("pointerdown", unlockAudio, { once: true });

function bindAdminViewEvents() {
  document.querySelector("#productForm").addEventListener("submit", saveProduct);
  document.querySelector("#settingsForm").addEventListener("submit", saveSettings);
  document.querySelector("#settingsForm").addEventListener("input", () => {
    adminState.settingsDirty = true;
  });
  document.querySelector("#resetProduct").addEventListener("click", () => fillProductForm(null));
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
    adminState.salesDate = new Date().toISOString().slice(0, 10);
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
  const edit = event.target.closest("[data-edit-product]");
  const del = event.target.closest("[data-delete-product]");
  try {
    if (status) {
      const [id, value] = status.dataset.orderStatus.split(":");
      const order = adminState.orders.find((item) => item.id === Number(id));
      const unpaid = order && !["verified", "cash_received"].includes(order.payment_status);
      if (value === "completed" && unpaid && !confirm("这单还没有核验付款，确定标记为已取单吗？")) {
        return;
      }
      await updateOrder(id, "status", value);
    }
    if (pay) {
      const [id, value] = pay.dataset.payStatus.split(":");
      await updateOrder(id, "pay", value);
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
