const state = {
  settings: {},
  products: [],
  cart: new Map(),
  receiveType: "now",
  paymentMethod: "wechat",
  toastTimer: null,
};

const money = (value) => `¥${Number(value || 0).toFixed(2)}`;
const digitsOnly = (value) => value.replace(/\D/g, "");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "操作失败");
  return data;
}

function productImage(product) {
  if (product.image) return `<img class="product-image" src="${product.image}" alt="${product.name}">`;
  return `<div class="product-image product-placeholder">暂无图片</div>`;
}

function renderBooth() {
  document.title = state.settings.booth_name || "摊位点单";
  document.querySelector("#boothName").textContent = state.settings.booth_name || "摊位点单";
  document.querySelector("#welcome").textContent = state.settings.welcome || "";
  const logo = document.querySelector("#boothLogo");
  if (state.settings.logo) {
    logo.src = state.settings.logo;
    logo.hidden = false;
  }
}

function renderFilters() {
  const select = document.querySelector("#categoryFilter");
  const categories = [...new Set(state.products.map((p) => p.category).filter(Boolean))].sort();
  select.innerHTML = `<option value="">全部分类</option>${categories.map((c) => `<option value="${c}">${c}</option>`).join("")}`;
}

function renderProducts() {
  const search = document.querySelector("#searchInput").value.trim().toLowerCase();
  const category = document.querySelector("#categoryFilter").value;
  const grid = document.querySelector("#productGrid");
  const products = state.products.filter((product) => {
    const text = `${product.name} ${product.author} ${product.tags} ${product.category}`.toLowerCase();
    return (!category || product.category === category) && (!search || text.includes(search));
  });
  grid.innerHTML = products.map((product) => {
    const soldOut = product.stock <= 0;
    const inCart = state.cart.get(product.id)?.quantity || 0;
    const tags = [product.category, product.author, product.tags].filter(Boolean).join(" · ");
    return `
      <article class="product-card ${soldOut ? "sold-out" : ""}">
        ${inCart ? `<div class="in-cart-badge">已选 ${inCart}</div>` : ""}
        ${productImage(product)}
        <div>
          <div class="product-title">${escapeHtml(product.name)}</div>
          <div class="product-meta">${escapeHtml(tags || "未分类")}</div>
        </div>
        <div class="price-row">
          <span class="price">${money(product.price)}</span>
          <span class="product-meta">库存 ${product.stock}</span>
        </div>
        <button class="primary-btn add-btn" data-add="${product.id}" ${soldOut ? "disabled" : ""}>${soldOut ? "已售罄" : inCart ? `再加一件 (${inCart})` : "加入购物车"}</button>
      </article>
    `;
  }).join("") || `<p class="small-muted">没有找到商品</p>`;
}

function renderCart() {
  const box = document.querySelector("#cartItems");
  const lines = [...state.cart.values()];
  if (!lines.length) {
    box.className = "cart-items empty";
    box.textContent = "还没有选择商品";
  } else {
    box.className = "cart-items";
    box.innerHTML = lines.map(({ product, quantity }) => `
      <div class="cart-line">
        <div>
          <strong>${product.name}</strong>
          <div class="product-meta">${money(product.price)} / 件</div>
        </div>
        <div class="qty-controls">
          <button class="icon-btn" data-minus="${product.id}" type="button">-</button>
          <span>${quantity}</span>
          <button class="icon-btn" data-plus="${product.id}" type="button">+</button>
        </div>
      </div>
    `).join("");
  }
  const total = lines.reduce((sum, line) => sum + line.product.price * line.quantity, 0);
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const countBadge = document.querySelector("#cartCount");
  countBadge.hidden = count === 0;
  countBadge.textContent = count;
  document.querySelector("#cartTotal").textContent = money(total);
  document.querySelector("#submitOrder").disabled = lines.length === 0;
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.hidden = false;
  toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toast.classList.remove("show");
    toast.hidden = true;
  }, 1400);
}

function animateAddButton(button, quantity) {
  const original = button.textContent;
  button.textContent = `已加入 ×${quantity}`;
  button.classList.add("just-added");
  setTimeout(() => {
    button.classList.remove("just-added");
    button.textContent = original;
    renderProducts();
  }, 520);
}

function setupPickupTimes() {
  const select = document.querySelector("#pickupTimeInput");
  const options = ['15分钟后', '30分钟后', '45分钟后', '1小时后', '1.5小时后', '2小时后', '闭展前'];
  select.innerHTML = `<option value="">请选择预计领取时间</option>${options.map((item) => `<option value="${item}">${item}</option>`).join("")}`;
}

function addToCart(productId, button) {
  const product = state.products.find((item) => item.id === productId);
  if (!product || product.stock <= 0) return;
  const existing = state.cart.get(productId) || { product, quantity: 0 };
  if (existing.quantity >= product.stock) {
    showToast(`${product.name} 已经达到库存上限`);
    return;
  }
  existing.quantity += 1;
  state.cart.set(productId, existing);
  renderCart();
  showToast(`已加入：${product.name} ×${existing.quantity}`);
  if (button) animateAddButton(button, existing.quantity);
  else renderProducts();
}

function changeQuantity(productId, delta) {
  const line = state.cart.get(productId);
  if (!line) return;
  line.quantity += delta;
  if (line.quantity <= 0) state.cart.delete(productId);
  if (line.quantity > line.product.stock) line.quantity = line.product.stock;
  renderCart();
  renderProducts();
}

function renderOrder(order) {
  const payText = { wechat: "微信", alipay: "支付宝", cash: "现金" }[order.payment_method];
  const receiveText = { now: "现在领取", later: "稍后领取" }[order.receive_type];
  const qr = [];
  if (order.payment_method === "wechat" && state.settings.wechat_qr) qr.push(["微信收款码", state.settings.wechat_qr]);
  if (order.payment_method === "alipay" && state.settings.alipay_qr) qr.push(["支付宝收款码", state.settings.alipay_qr]);
  document.querySelector("#orderResult").innerHTML = `
    <p class="small-muted">下单成功，请保存取单码</p>
    <div class="pickup-code">${order.pickup_code}</div>
    <p><strong>合计 ${money(order.total)}</strong> · ${receiveText} · ${payText}</p>
    ${order.phone ? `<p class="small-muted">联系电话：${order.phone}</p>` : ""}
    ${order.phone_tail ? `<p class="small-muted">核对尾号：${order.phone_tail}</p>` : ""}
    ${order.pickup_time ? `<p class="small-muted">预计领取：${order.pickup_time}</p>` : ""}
    ${qr.length ? `<div class="qr-row">${qr.map(([label, src]) => `<div class="qr-box"><img src="${src}" alt="${label}"><strong>${label}</strong></div>`).join("")}</div>` : ""}
    <p class="small-muted">${order.payment_method === "cash" ? "现金订单请在取货时付款。" : "请完成付款，取货时向摊主出示付款成功页面。"}</p>
    <ol class="order-items">${order.items.map((item) => `<li>${item.name} × ${item.quantity}，${money(item.price)} / 件</li>`).join("")}</ol>
  `;
  document.querySelector("#orderDialog").showModal();
}

async function submitOrder(event) {
  event.preventDefault();
  const phone = digitsOnly(document.querySelector("#phoneInput").value);
  const phoneTail = digitsOnly(document.querySelector("#phoneTailInput").value);
  if (state.receiveType === "later" && phone.length !== 11) {
    alert("请填写正确的手机号");
    return;
  }
  if (state.receiveType === "later" && !document.querySelector("#pickupTimeInput").value) {
    alert("请选择预计领取时间");
    return;
  }
  if (state.receiveType === "now" && phoneTail.length !== 4) {
    alert("现在领取请填写手机号后四位，方便取货核对");
    return;
  }
  const items = [...state.cart.values()].map((line) => ({
    product_id: line.product.id,
    quantity: line.quantity,
  }));
  try {
    const order = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        items,
        receive_type: state.receiveType,
        phone: state.receiveType === "later" ? phone : "",
        phone_tail: state.receiveType === "now" ? phoneTail : phone.slice(-4),
        pickup_time: state.receiveType === "later" ? document.querySelector("#pickupTimeInput").value : "",
        payment_method: state.paymentMethod,
        note: document.querySelector("#noteInput").value,
      }),
    });
    state.cart.clear();
    await load();
    renderCart();
    renderOrder(order);
  } catch (error) {
    alert(error.message);
  }
}

async function load() {
  const [settings, products] = await Promise.all([
    api("/api/settings"),
    api("/api/products"),
  ]);
  state.settings = settings;
  state.products = products;
  renderBooth();
  renderFilters();
  renderProducts();
}

document.addEventListener("click", (event) => {
  const add = event.target.closest("[data-add]");
  const plus = event.target.closest("[data-plus]");
  const minus = event.target.closest("[data-minus]");
  const receive = event.target.closest("[data-receive]");
  const pay = event.target.closest("[data-pay]");
  if (add) addToCart(Number(add.dataset.add), add);
  if (plus) changeQuantity(Number(plus.dataset.plus), 1);
  if (minus) changeQuantity(Number(minus.dataset.minus), -1);
  if (receive) {
    state.receiveType = receive.dataset.receive;
    document.querySelectorAll("[data-receive]").forEach((btn) => btn.classList.toggle("active", btn === receive));
    document.querySelector("#phoneLabel").hidden = state.receiveType !== "later";
    document.querySelector("#pickupTimeLabel").hidden = state.receiveType !== "later";
    document.querySelector("#tailLabel").hidden = state.receiveType !== "now";
    if (state.receiveType === "now") {
      document.querySelector("#phoneInput").value = "";
      document.querySelector("#pickupTimeInput").value = "";
    } else {
      document.querySelector("#phoneTailInput").value = "";
    }
  }
  if (pay) {
    state.paymentMethod = pay.dataset.pay;
    document.querySelectorAll("[data-pay]").forEach((btn) => btn.classList.toggle("active", btn === pay));
  }
});

document.querySelector("#searchInput").addEventListener("input", renderProducts);
document.querySelector("#categoryFilter").addEventListener("change", renderProducts);
document.querySelector("#checkoutForm").addEventListener("submit", submitOrder);
document.querySelector("#closeDialog").addEventListener("click", () => document.querySelector("#orderDialog").close());
document.querySelector("#phoneInput").addEventListener("input", (event) => {
  event.target.value = digitsOnly(event.target.value).slice(0, 11);
});
document.querySelector("#phoneTailInput").addEventListener("input", (event) => {
  event.target.value = digitsOnly(event.target.value).slice(0, 4);
});
document.querySelector("#clearPickupTime").addEventListener("click", () => {
  document.querySelector("#pickupTimeInput").value = "";
});

setupPickupTimes();
load().catch((error) => alert(error.message));
