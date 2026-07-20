const state = {
  settings: {},
  products: [],
  cart: new Map(),
  receiveType: "now",
  paymentMethod: "wechat",
  toastTimer: null,
  pendingOrderToken: "",
  submitting: false,
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

async function api(path, options = {}, attempt = 0) {
  const { retrySafe = false, ...fetchOptions } = options;
  const method = String(fetchOptions.method || "GET").toUpperCase();
  const canRetry = method === "GET" || retrySafe;
  let res;
  try {
    res = await fetch(path, {
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...(fetchOptions.headers || {}) },
      ...fetchOptions,
    });
  } catch (error) {
    if (canRetry && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
      return api(path, options, attempt + 1);
    }
    throw new Error("网络连接不稳定，请稍后重试");
  }
  const raw = await res.text();
  let data = {};
  if (raw.trim()) {
    try {
      data = JSON.parse(raw);
    } catch (error) {
      if (canRetry && attempt < 2 && (res.ok || res.status >= 500)) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        return api(path, options, attempt + 1);
      }
      throw new Error("服务器返回内容不完整，请稍后重试");
    }
  } else if (res.ok && canRetry && attempt < 2) {
    await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    return api(path, options, attempt + 1);
  } else if (res.ok) {
    throw new Error("服务器没有返回内容，请稍后重试");
  }
  if (!res.ok && canRetry && attempt < 2 && (res.status === 429 || res.status >= 500)) {
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    return api(path, options, attempt + 1);
  }
  if (!res.ok) throw new Error(data.error || (res.status >= 500 ? "服务器暂时繁忙，请稍后重试" : "操作失败"));
  return data;
}

function newOrderToken() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function productImage(product) {
  if (product.image) return `<img class="product-image" src="${product.image}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async">`;
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

function selectedQuantity(productId) {
  return state.cart.get(productId)?.quantity || 0;
}

function availableStock(product) {
  return Math.max(0, Number(product.stock || 0) - selectedQuantity(product.id));
}

function stockText(product) {
  const stock = Number(product.stock || 0);
  const available = availableStock(product);
  const threshold = product.low_stock_threshold ?? 3;
  if (stock <= 0) return "库存 0";
  if (available <= 0) return "已选完";
  if (available <= threshold) return `仅剩 ${available} 件`;
  return `剩余 ${available} 件`;
}

function renderProducts() {
  const search = document.querySelector("#searchInput").value.trim().toLowerCase();
  const category = document.querySelector("#categoryFilter").value;
  const grid = document.querySelector("#productGrid");
  const products = state.products.filter((product) => {
    const text = `${product.name} ${product.author} ${product.tags} ${product.category}`.toLowerCase();
    return (!category || product.category === category) && (!search || text.includes(search));
  }).sort((a, b) => Number(a.stock <= 0) - Number(b.stock <= 0));
  const count = document.querySelector("#productCount");
  if (count) count.textContent = `${products.length} 件制品`;
  grid.innerHTML = products.map((product) => {
    const soldOut = product.stock <= 0;
    const inCart = selectedQuantity(product.id);
    const canAdd = availableStock(product) > 0;
    const tags = [product.category, product.author, product.tags].filter(Boolean).join(" · ");
    return `
      <article class="product-card ${soldOut ? "sold-out" : ""}">
        <div class="product-media">
          ${productImage(product)}
          ${inCart ? `<div class="in-cart-badge">已选 ${inCart}</div>` : ""}
          ${soldOut ? `<span class="sold-out-badge">已售罄</span>` : ""}
        </div>
        <div class="product-copy">
          <div class="product-title">${escapeHtml(product.name)}</div>
          <div class="product-meta">${escapeHtml(tags || "未分类")}</div>
        </div>
        <div class="product-footer">
          <div class="price-row">
            <span class="price">${money(product.price)}</span>
            <span class="stock-text ${availableStock(product) <= (product.low_stock_threshold ?? 3) ? "low" : ""}">${stockText(product)}</span>
          </div>
          <button class="primary-btn add-btn" data-add="${product.id}" type="button" title="${canAdd ? "加入购物车" : stockText(product)}" aria-label="${canAdd ? `加入购物车：${escapeHtml(product.name)}` : stockText(product)}" ${canAdd ? "" : "disabled"}>${soldOut ? "售罄" : canAdd ? "+" : "选完"}</button>
        </div>
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
        <div class="cart-line-copy">
          <strong>${escapeHtml(product.name)}</strong>
          <div class="product-meta">${money(product.price)} / 件 · 剩余 ${Math.max(0, product.stock - quantity)} 件</div>
        </div>
        <div class="qty-controls">
          <button class="icon-btn" data-minus="${product.id}" type="button">-</button>
          <span>${quantity}</span>
          <button class="icon-btn" data-plus="${product.id}" type="button" ${quantity >= product.stock ? "disabled" : ""}>+</button>
        </div>
      </div>
    `).join("");
  }
  const total = lines.reduce((sum, line) => sum + line.product.price * line.quantity, 0);
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const countBadge = document.querySelector("#cartCount");
  countBadge.hidden = count === 0;
  countBadge.textContent = `${count} 件`;
  document.querySelector("#cartTotal").textContent = money(total);
  const shortcut = document.querySelector("#cartShortcut");
  if (shortcut) {
    shortcut.hidden = count === 0;
    document.querySelector("#shortcutCount").textContent = count;
    document.querySelector("#shortcutTotal").textContent = money(total);
  }
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
  button.textContent = "✓";
  button.setAttribute("aria-label", `已加入，购物车内共 ${quantity} 件`);
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
  renderProducts();
  showToast(`已加入：${product.name} ×${existing.quantity}`);
  const nextButton = document.querySelector(`[data-add="${productId}"]`);
  if (nextButton && !nextButton.disabled) animateAddButton(nextButton, existing.quantity);
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

function giftBadge(item) {
  return item?.item_type === "gift" ? `<span class="gift-badge">赠品</span>` : "";
}

function orderPriceDetails(order) {
  const subtotal = Number(order.subtotal || order.total || 0);
  const discount = Number(order.discount_total || 0);
  const total = Number(order.total || 0);
  if (discount <= 0) {
    return `<p class="order-total-line"><strong>合计 ${money(total)}</strong></p>`;
  }
  return `
    <div class="price-breakdown">
      <div><span>原价</span><strong>${money(subtotal)}</strong></div>
      <div class="discount"><span>满减</span><strong>- ${money(discount)}</strong></div>
      <div class="final"><span>优惠后</span><strong>${money(total)}</strong></div>
    </div>
  `;
}

function renderOrder(order) {
  const payText = { wechat: "微信", alipay: "支付宝", cash: "现金" }[order.payment_method];
  const receiveText = { now: "现在领取", later: "稍后领取" }[order.receive_type];
  const qr = [];
  if (order.payment_method === "wechat" && state.settings.wechat_qr) qr.push(["微信收款码", state.settings.wechat_qr]);
  if (order.payment_method === "alipay" && state.settings.alipay_qr) qr.push(["支付宝收款码", state.settings.alipay_qr]);
  const contact = order.phone
    ? `<div><span>联系电话</span><strong>${escapeHtml(order.phone)}</strong></div>`
    : order.phone_tail
      ? `<div><span>核对尾号</span><strong>${escapeHtml(order.phone_tail)}</strong></div>`
      : "";
  const logo = state.settings.logo
    ? `<img class="receipt-logo" src="${state.settings.logo}" alt="">`
    : `<span class="receipt-mark">票</span>`;
  document.querySelector("#orderResult").innerHTML = `
    <article class="receipt">
      <header class="receipt-header">
        ${logo}
        <div>
          <strong>${escapeHtml(state.settings.booth_name || "摊位点单")}</strong>
          <span>取单凭证</span>
        </div>
      </header>
      <div class="receipt-divider"></div>
      <section class="receipt-code-block">
        <span>取单码</span>
        <div class="pickup-code">${escapeHtml(order.pickup_code)}</div>
        <p>请截图保存，取货时出示</p>
      </section>
      <div class="receipt-meta">
        <div><span>领取方式</span><strong>${receiveText}</strong></div>
        <div><span>支付方式</span><strong>${payText}</strong></div>
        ${contact}
        ${order.pickup_time ? `<div><span>预计领取</span><strong>${escapeHtml(order.pickup_time)}</strong></div>` : ""}
      </div>
      ${qr.length ? `<div class="qr-row">${qr.map(([label, src]) => `<div class="qr-box"><img src="${src}" alt="${label}"><strong>${label}</strong></div>`).join("")}</div>` : ""}
      <p class="receipt-payment-note">${order.payment_method === "cash" ? "现金订单请在取货时付款" : "请完成付款，取货时出示付款成功页面"}</p>
      <div class="receipt-divider"></div>
      <section class="receipt-items">
        <div class="receipt-table-head"><span>制品</span><span>数量</span><span>单价</span></div>
        ${order.items.map((item) => {
      const promo = item.item_type === "gift" && item.promotion_name ? ` <span class="item-promo">来自：${escapeHtml(item.promotion_name)}</span>` : "";
          return `<div class="receipt-item"><span>${giftBadge(item)}${escapeHtml(item.name)}${promo}</span><strong>× ${item.quantity}</strong><span>${Number(item.price) === 0 ? "赠送" : money(item.price)}</span></div>`;
        }).join("")}
      </section>
      ${orderPriceDetails(order)}
      <div class="receipt-divider"></div>
      <div class="order-reminders">
        <p><strong>截图：</strong>忘记取单码的话，摊主也帮不了你哦。</p>
        <p><strong>清点：</strong>离摊前请对照清单清点制品数量。</p>
      </div>
      <footer class="receipt-footer">谢谢光临 · 漫展快乐</footer>
    </article>
  `;
  const dialog = document.querySelector("#orderDialog");
  dialog.showModal();
  document.querySelector("#orderResult").scrollTop = 0;
}

async function submitOrder(event) {
  event.preventDefault();
  if (state.submitting) return;
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
  const submitButton = document.querySelector("#submitOrder");
  state.pendingOrderToken ||= newOrderToken();
  state.submitting = true;
  submitButton.disabled = true;
  submitButton.textContent = "正在生成取单码...";
  try {
    const order = await api("/api/orders", {
      method: "POST",
      retrySafe: true,
      body: JSON.stringify({
        client_token: state.pendingOrderToken,
        items,
        receive_type: state.receiveType,
        phone: state.receiveType === "later" ? phone : "",
        phone_tail: state.receiveType === "now" ? phoneTail : phone.slice(-4),
        pickup_time: state.receiveType === "later" ? document.querySelector("#pickupTimeInput").value : "",
        payment_method: state.paymentMethod,
        note: document.querySelector("#noteInput").value,
      }),
    });
    state.pendingOrderToken = "";
    state.cart.clear();
    renderCart();
    renderOrder(order);
    load().catch(() => showToast("订单已生成，商品库存稍后刷新"));
  } catch (error) {
    alert(error.message);
  } finally {
    state.submitting = false;
    submitButton.textContent = "结算并生成取单码";
    submitButton.disabled = state.cart.size === 0;
  }
}

async function load() {
  const settings = await api("/api/settings");
  const products = await api("/api/products");
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
document.querySelector("#cartShortcut").addEventListener("click", () => {
  document.querySelector(".cart-panel").scrollIntoView({ behavior: "smooth", block: "start" });
});

if ("IntersectionObserver" in window) {
  const shortcut = document.querySelector("#cartShortcut");
  const cartPanel = document.querySelector(".cart-panel");
  new IntersectionObserver(([entry]) => {
    shortcut.classList.toggle("at-cart", entry.isIntersecting);
  }, { threshold: 0.15 }).observe(cartPanel);
}

setupPickupTimes();
load().catch((error) => alert(error.message || "页面加载失败，请刷新后重试"));
