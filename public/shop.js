const state = {
  settings: {},
  products: [],
  cart: new Map(),
  receiveType: "now",
  paymentMethod: "wechat",
  toastTimer: null,
  pendingOrderToken: "",
  submitting: false,
  orderingMode: "direct",
  onsiteAccessGranted: true,
  onsiteAccessExpiresAt: 0,
};

const money = (value) => `¥${Number(value || 0).toFixed(2)}`;
const digitsOnly = (value) => value.replace(/\D/g, "");
const unixNow = () => Math.floor(Date.now() / 1000);

function hasCurrentOnsiteAccess(ordering) {
  const expiresAt = Number(ordering.access_expires_at || 0);
  return Boolean(ordering.access_granted) && expiresAt > unixNow();
}

function previewOpeningText(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return "现在可以查看制品，现场开售后才能加入购物车和下单。";
  const [, year, month, day, hour, minute] = match;
  const yearText = Number(year) === new Date().getFullYear() ? "" : `${Number(year)}年`;
  return `预计 ${yearText}${Number(month)}月${Number(day)}日 ${hour}:${minute} 开始接单，请到时刷新页面。`;
}

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

function renderOrderingState() {
  const banner = document.querySelector("#orderingBanner");
  const title = document.querySelector("#orderingBannerTitle");
  const text = document.querySelector("#orderingBannerText");
  const accessPanel = document.querySelector("#onsiteAccessPanel");
  const prompt = document.querySelector("#onsiteAccessPrompt");
  const granted = document.querySelector("#onsiteAccessGranted");
  if (state.orderingMode === "onsite" && state.onsiteAccessGranted && state.onsiteAccessExpiresAt <= unixNow()) {
    state.onsiteAccessGranted = false;
    state.onsiteAccessExpiresAt = 0;
  }
  const isPreview = state.orderingMode === "preview";
  const needsAccess = state.orderingMode === "onsite" && !state.onsiteAccessGranted;

  banner.className = `ordering-banner ${isPreview ? "preview" : "onsite"}`;
  banner.hidden = state.orderingMode === "direct";
  if (isPreview) {
    title.textContent = "制品预览中";
    text.textContent = previewOpeningText(state.settings.preview_opening_time);
  } else if (state.orderingMode === "onsite") {
    title.textContent = state.onsiteAccessGranted ? "现场验证已通过" : "现场下单已开放";
    text.textContent = state.onsiteAccessGranted
      ? "请在验证有效期内提交订单。"
      : "选好制品后，请在结算区输入摊位屏幕上的四位下单码。";
  }

  accessPanel.hidden = state.orderingMode !== "onsite";
  prompt.hidden = !needsAccess;
  granted.hidden = needsAccess;
  if (!needsAccess && state.orderingMode === "onsite") updateOnsiteAccessCountdown();
  document.body.classList.toggle("preview-mode", isPreview);
}

function updateOnsiteAccessCountdown() {
  if (state.orderingMode !== "onsite" || !state.onsiteAccessGranted) return;
  const remaining = Math.max(0, state.onsiteAccessExpiresAt - unixNow());
  if (remaining <= 0) {
    state.onsiteAccessGranted = false;
    state.onsiteAccessExpiresAt = 0;
    renderOrderingState();
    renderProducts();
    renderCart();
    showToast("现场验证已过期，请重新输入现场码");
    return;
  }
  const minutes = String(Math.floor(remaining / 60)).padStart(2, "0");
  const seconds = String(remaining % 60).padStart(2, "0");
  const expiry = document.querySelector("#onsiteAccessExpiry");
  if (expiry) expiry.textContent = `本次验证剩余 ${minutes}:${seconds}`;
}

async function verifyOnsiteCode() {
  const input = document.querySelector("#onsiteCodeInput");
  const button = document.querySelector("#onsiteVerifyBtn");
  const code = digitsOnly(input.value).slice(0, 4);
  input.value = code;
  if (code.length !== 4) {
    showToast("请输入四位现场下单码");
    input.focus();
    return;
  }
  button.disabled = true;
  button.textContent = "验证中";
  try {
    const result = await api("/api/onsite/verify", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    state.onsiteAccessExpiresAt = Number(result.access_expires_at || 0);
    state.onsiteAccessGranted = hasCurrentOnsiteAccess(result);
    input.value = "";
    renderOrderingState();
    renderCart();
    renderProducts();
    showToast("现场验证已通过");
  } catch (error) {
    showToast(error.message);
    input.select();
  } finally {
    button.disabled = false;
    button.textContent = "验证";
  }
}

function promotions() {
  try {
    const data = typeof state.settings.promotions === "string"
      ? JSON.parse(state.settings.promotions || "{}")
      : state.settings.promotions || {};
    return {
      bundle_discounts: Array.isArray(data.bundle_discounts) ? data.bundle_discounts : [],
      amount_discounts: Array.isArray(data.amount_discounts) ? data.amount_discounts : [],
    };
  } catch (error) {
    return { bundle_discounts: [], amount_discounts: [] };
  }
}

function bundleRules() {
  const productMap = new Map(state.products.map((product) => [Number(product.id), product]));
  return promotions().bundle_discounts.map((rule) => {
    const productIds = [...new Set((rule.product_ids || []).map(Number).filter(Boolean))];
    const products = productIds.map((id) => productMap.get(id)).filter(Boolean);
    const regularPrice = products.reduce((sum, product) => sum + Number(product.price || 0), 0);
    const bundlePrice = Number(rule.bundle_price || 0);
    return {
      ...rule,
      productIds,
      products,
      regularPrice,
      bundlePrice,
      saving: Math.max(0, regularPrice - bundlePrice),
    };
  }).filter((rule) => (
    rule.active !== false
    && rule.productIds.length >= 2
    && rule.products.length === rule.productIds.length
    && rule.saving > 0
  ));
}

function calculateBundleDiscount(lines) {
  const quantities = new Map(lines.map((line) => [Number(line.product.id), Number(line.quantity || 0)]));
  const remaining = new Map(quantities);
  const details = [];
  bundleRules().forEach((rule) => {
    const count = Math.min(...rule.productIds.map((id) => remaining.get(id) || 0));
    if (count <= 0) return;
    rule.productIds.forEach((id) => remaining.set(id, (remaining.get(id) || 0) - count));
    details.push({
      type: "bundle",
      name: rule.name || "组合套装价",
      count,
      amount: rule.saving * count,
      product_ids: rule.productIds,
    });
  });
  return { details, remaining };
}

function promotionQuote(lines) {
  const subtotal = lines.reduce((sum, line) => sum + Number(line.product.price || 0) * line.quantity, 0);
  const bundle = calculateBundleDiscount(lines);
  const details = [...bundle.details];
  const bundleDiscount = details.reduce((sum, detail) => sum + detail.amount, 0);
  const promotionSubtotal = Math.max(0, subtotal - bundleDiscount);
  let discountTotal = bundleDiscount;
  promotions().amount_discounts.forEach((rule) => {
    const threshold = Number(rule.threshold || 0);
    if (rule.active === false || promotionSubtotal < threshold) return;
    const amount = Math.min(Number(rule.discount || 0), Math.max(0, subtotal - discountTotal));
    if (amount <= 0) return;
    details.push({
      type: "amount",
      name: rule.name || "满额减价",
      count: 1,
      amount,
      product_ids: [],
    });
    discountTotal += amount;
  });
  return {
    subtotal,
    discountTotal: Math.min(subtotal, discountTotal),
    total: Math.max(0, subtotal - discountTotal),
    details,
  };
}

function renderFilters() {
  const categorySelect = document.querySelector("#categoryFilter");
  const authorSelect = document.querySelector("#authorFilter");
  const selectedCategory = categorySelect.value;
  const selectedAuthor = authorSelect.value;
  const categories = [...new Set(state.products.map((p) => p.category).filter(Boolean))].sort();
  const authors = [...new Set(state.products.map((p) => p.author).filter(Boolean))].sort();
  const hasUnassignedAuthor = state.products.some((product) => !String(product.author || "").trim());
  categorySelect.innerHTML = `<option value="">全部分类</option>${categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}`;
  authorSelect.innerHTML = `
    <option value="">全部作者</option>
    ${authors.map((author) => `<option value="${escapeHtml(author)}">${escapeHtml(author)}</option>`).join("")}
    ${hasUnassignedAuthor ? `<option value="__unassigned">未标作者</option>` : ""}
  `;
  if ([...categorySelect.options].some((option) => option.value === selectedCategory)) categorySelect.value = selectedCategory;
  if ([...authorSelect.options].some((option) => option.value === selectedAuthor)) authorSelect.value = selectedAuthor;
}

function renderBundlePromotions() {
  const panel = document.querySelector("#bundlePromotions");
  const rules = bundleRules().filter((rule) => rule.products.every((product) => Number(product.stock || 0) > 0));
  panel.hidden = rules.length === 0;
  panel.innerHTML = rules.length ? `
    <summary class="bundle-promotions-summary">
      <span><strong>套装优惠</strong><small>共 ${rules.length} 项</small></span>
      <span class="bundle-summary-action">
        <span class="bundle-summary-closed">查看</span>
        <span class="bundle-summary-open">收起</span>
        <i aria-hidden="true"></i>
      </span>
    </summary>
    <div class="bundle-promotion-list">
      ${rules.map((rule) => `
        <article class="bundle-promotion">
          <div>
            <strong>${escapeHtml(rule.name || "组合套装价")}</strong>
            <span>${rule.products.map((product) => escapeHtml(product.name)).join(" + ")}</span>
          </div>
          <div class="bundle-promotion-price">
            <strong>${money(rule.bundlePrice)} / 套</strong>
            <span>单买合计 ${money(rule.regularPrice)}</span>
          </div>
        </article>
      `).join("")}
    </div>
  ` : "";
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
  const author = document.querySelector("#authorFilter").value;
  const grid = document.querySelector("#productGrid");
  const products = state.products.filter((product) => {
    const text = `${product.name} ${product.author} ${product.tags} ${product.category}`.toLowerCase();
    const authorMatches = !author
      || (author === "__unassigned" ? !String(product.author || "").trim() : product.author === author);
    return (!category || product.category === category) && authorMatches && (!search || text.includes(search));
  }).sort((a, b) => Number(a.stock <= 0) - Number(b.stock <= 0));
  const bundledProductIds = new Set(bundleRules().flatMap((rule) => rule.productIds));
  const count = document.querySelector("#productCount");
  if (count) count.textContent = `${products.length} 件制品`;
  grid.innerHTML = products.map((product) => {
    const soldOut = product.stock <= 0;
    const inCart = selectedQuantity(product.id);
    const canAdd = state.orderingMode !== "preview" && availableStock(product) > 0;
    const tags = [product.category, product.author, product.tags].filter(Boolean).join(" · ");
    return `
      <article class="product-card ${soldOut ? "sold-out" : ""}">
        <div class="product-media">
          ${productImage(product)}
          ${inCart ? `<div class="in-cart-badge">已选 ${inCart}</div>` : ""}
          ${bundledProductIds.has(product.id) && !soldOut ? `<span class="bundle-badge">可成套</span>` : ""}
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
           <button class="primary-btn add-btn" data-add="${product.id}" type="button" title="${canAdd ? "加入购物车" : state.orderingMode === "preview" ? "暂未开放下单" : stockText(product)}" aria-label="${canAdd ? `加入购物车：${escapeHtml(product.name)}` : state.orderingMode === "preview" ? "暂未开放下单" : stockText(product)}" ${canAdd ? "" : "disabled"}>${soldOut ? "售罄" : state.orderingMode === "preview" ? "预览" : canAdd ? "+" : "选完"}</button>
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
          <button class="icon-btn" data-plus="${product.id}" type="button" ${state.orderingMode === "preview" || quantity >= product.stock ? "disabled" : ""}>+</button>
        </div>
      </div>
    `).join("");
  }
  const quote = promotionQuote(lines);
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const countBadge = document.querySelector("#cartCount");
  countBadge.hidden = count === 0;
  countBadge.textContent = `${count} 件`;
  document.querySelector("#cartTotalLabel").textContent = quote.discountTotal > 0 ? "优惠后合计" : "合计";
  document.querySelector("#cartTotal").textContent = money(quote.total);
  const promotionStatus = document.querySelector("#cartPromotionStatus");
  const applied = quote.details.map((detail) => `
    <div class="cart-promotion-applied">
      <span>${detail.type === "bundle" ? "套装计价：" : "优惠："}${escapeHtml(detail.name)}${detail.type === "bundle" ? ` × ${detail.count} 套` : ""}</span>
      <strong>- ${money(detail.amount)}</strong>
    </div>
  `);
  const quantities = new Map(lines.map((line) => [Number(line.product.id), Number(line.quantity || 0)]));
  const progress = bundleRules().flatMap((rule) => {
    const values = rule.productIds.map((id) => quantities.get(id) || 0);
    const minQuantity = Math.min(...values);
    const maxQuantity = Math.max(...values);
    if (maxQuantity <= minQuantity) return [];
    const missing = rule.products.filter((product) => (quantities.get(product.id) || 0) === minQuantity);
    if (!missing.length || missing.length > 2) return [];
    return [`
      <div class="cart-promotion-progress">
        <small>组合信息：「${escapeHtml(rule.name || "组合套装价")}」尚缺 ${missing.map((product) => escapeHtml(product.name)).join("、")}</small>
      </div>
    `];
  }).slice(0, 2);
  const promotionMarkup = [...applied, ...progress];
  promotionStatus.hidden = promotionMarkup.length === 0;
  promotionStatus.innerHTML = promotionMarkup.join("");
  const shortcut = document.querySelector("#cartShortcut");
  if (shortcut) {
    shortcut.hidden = count === 0;
    document.querySelector("#shortcutCount").textContent = count;
    document.querySelector("#shortcutTotal").textContent = money(quote.total);
  }
  document.querySelector("#submitOrder").disabled = lines.length === 0
    || state.orderingMode === "preview"
    || (state.orderingMode === "onsite" && !state.onsiteAccessGranted);
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
  if (state.orderingMode === "preview") {
    showToast("现在仅供浏览，暂未开放下单");
    return;
  }
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
  if (delta > 0 && state.orderingMode === "preview") return;
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
  const details = Array.isArray(order.discount_details) ? order.discount_details : [];
  const detailRows = details.length
    ? details.map((detail) => `
        <div class="discount">
          <span>${escapeHtml(detail.name || "优惠")}${detail.type === "bundle" && Number(detail.count || 1) > 1 ? ` × ${Number(detail.count)} 套` : ""}</span>
          <strong>- ${money(detail.amount)}</strong>
        </div>
      `).join("")
    : `<div class="discount"><span>优惠</span><strong>- ${money(discount)}</strong></div>`;
  return `
    <div class="price-breakdown">
      <div><span>原价</span><strong>${money(subtotal)}</strong></div>
      ${detailRows}
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
  if (state.orderingMode === "preview") {
    alert("当前仅供浏览，暂未开放下单");
    return;
  }
  if (state.orderingMode === "onsite" && !state.onsiteAccessGranted) {
    alert("请先输入摊位屏幕上的四位现场下单码");
    document.querySelector("#onsiteCodeInput").focus();
    return;
  }
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
    if (error.message.includes("现场下单码")) {
      state.onsiteAccessGranted = false;
      renderOrderingState();
      renderCart();
    }
    alert(error.message);
  } finally {
    state.submitting = false;
    submitButton.textContent = "结算并生成取单码";
    renderCart();
  }
}

async function load() {
  const [settings, products, ordering] = await Promise.all([
    api("/api/settings"),
    api("/api/products"),
    api("/api/ordering-status"),
  ]);
  state.settings = settings;
  state.products = products;
  state.orderingMode = ordering.mode || "direct";
  state.onsiteAccessExpiresAt = Number(ordering.access_expires_at || 0);
  state.onsiteAccessGranted = state.orderingMode !== "onsite" || hasCurrentOnsiteAccess(ordering);
  renderBooth();
  renderOrderingState();
  renderFilters();
  renderBundlePromotions();
  renderProducts();
  renderCart();
}

async function refreshOrderingStatus() {
  if (document.hidden) return;
  try {
    const ordering = await api("/api/ordering-status");
    const nextMode = ordering.mode || "direct";
    const nextExpiry = Number(ordering.access_expires_at || 0);
    const nextAccess = nextMode !== "onsite" || hasCurrentOnsiteAccess(ordering);
    const changed = nextMode !== state.orderingMode
      || nextAccess !== state.onsiteAccessGranted
      || nextExpiry !== state.onsiteAccessExpiresAt;
    state.orderingMode = nextMode;
    state.onsiteAccessGranted = nextAccess;
    state.onsiteAccessExpiresAt = nextExpiry;
    if (changed) {
      renderOrderingState();
      renderProducts();
      renderCart();
    }
  } catch (error) {
    // Keep the current page usable during a brief network interruption.
  }
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
document.querySelector("#authorFilter").addEventListener("change", renderProducts);
document.querySelector("#checkoutForm").addEventListener("submit", submitOrder);
document.querySelector("#onsiteVerifyBtn").addEventListener("click", verifyOnsiteCode);
document.querySelector("#onsiteCodeInput").addEventListener("input", (event) => {
  event.target.value = digitsOnly(event.target.value).slice(0, 4);
});
document.querySelector("#onsiteCodeInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    verifyOnsiteCode();
  }
});
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
setInterval(refreshOrderingStatus, 5000);
setInterval(updateOnsiteAccessCountdown, 1000);
