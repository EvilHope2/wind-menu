document.querySelectorAll(".js-confirm").forEach((button) => {
  button.addEventListener("click", (event) => {
    const msg = button.getAttribute("data-confirm") || "Confirmar accion?";
    if (!window.confirm(msg)) {
      event.preventDefault();
    }
  });
});

(() => {
  // Prevent accidental double-submit and provide quick visual feedback.
  document.querySelectorAll("form").forEach((form) => {
    form.addEventListener("submit", () => {
      const submitButtons = Array.from(
        form.querySelectorAll("button[type='submit'], input[type='submit']")
      );
      submitButtons.forEach((button) => {
        if (button.disabled) return;
        if (!button.dataset.originalText) {
          button.dataset.originalText = button.textContent || button.value || "";
        }
        button.disabled = true;
        if (button.tagName === "BUTTON") {
          button.textContent = "Procesando...";
        } else {
          button.value = "Procesando...";
        }
      });
    });
  });
})();

if (window.lucide && typeof window.lucide.createIcons === "function") {
  window.lucide.createIcons();
}

(() => {
  const toasts = Array.from(document.querySelectorAll("[data-toast]"));
  if (!toasts.length) return;
  const stack = document.createElement("div");
  stack.className = "toast-stack";
  document.body.appendChild(stack);
  toasts.forEach((toast, index) => {
    stack.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(-6px)";
      setTimeout(() => toast.remove(), 180);
    }, 3200 + index * 300);
  });
})();

(() => {
  const sidebar = document.querySelector(".sidebar");
  const overlay = document.querySelector("[data-sidebar-overlay]");
  if (!sidebar) return;

  const toggle = document.createElement("button");
  toggle.className = "btn btn-ghost sidebar-toggle";
  toggle.type = "button";
  toggle.innerHTML = '<i data-lucide="panel-left"></i>Menu';
  const appContent = document.querySelector(".app-content");
  if (appContent) {
    appContent.prepend(toggle);
  }

  const closeSidebar = () => document.body.classList.remove("sidebar-open");
  toggle.addEventListener("click", () => {
    document.body.classList.toggle("sidebar-open");
  });
  if (overlay) overlay.addEventListener("click", closeSidebar);
  window.addEventListener("resize", () => {
    if (window.innerWidth > 940) closeSidebar();
  });
  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons();
  }
})();

document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", async () => {
    const targetId = button.getAttribute("data-copy-target");
    const target = targetId ? document.getElementById(targetId) : null;
    if (!target) return;
    const text = target.textContent || "";
    try {
      await navigator.clipboard.writeText(text.trim());
      const toast = document.createElement("div");
      toast.className = "toast toast-success";
      toast.textContent = "Link copiado al portapapeles";
      let stack = document.querySelector(".toast-stack");
      if (!stack) {
        stack = document.createElement("div");
        stack.className = "toast-stack";
        document.body.appendChild(stack);
      }
      stack.appendChild(toast);
      setTimeout(() => toast.remove(), 2200);
    } catch (_error) {
      // no-op
    }
  });
});

(function setupPublicMenuCart() {
  const root = document.querySelector("[data-public-menu]");
  if (!root) return;

  const slug = root.dataset.businessSlug || "default";
  const businessName = root.dataset.businessName || "Comercio";
  const businessWhatsapp = (root.dataset.businessWhatsapp || "").replace(/[^0-9]/g, "");
  const deliveryEnabled = root.dataset.deliveryEnabled === "1";
  const pickupEnabled = root.dataset.pickupEnabled === "1";
  const generalMinimum = Number(root.dataset.minimumOrderAmount || 0);
  const generalFreeOver = Number(root.dataset.freeDeliveryOver || 0);
  const cashAllowChange = root.dataset.cashAllowChange === "1";
  const openStatus = parseJson(root.dataset.openStatus, {
    canOrder: true,
    state: "open",
    label: "Abierto ahora",
    message: "",
  });
  const deliveryZones = parseJson(root.dataset.deliveryZones, []);
  const paymentMethods = parseJson(root.dataset.paymentMethods, {
    cash: true,
    transfer: true,
    card: true,
  });
  const transferConfig = parseJson(root.dataset.transferConfig, {
    alias: "",
    cvu: "",
    holder: "",
    note: "",
  });

  const money = new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  });

  const storageKey = `windi_cart_${slug}`;
  const drawer = root.querySelector("[data-cart-drawer]");
  const itemsWrap = root.querySelector("[data-cart-items]");
  const countNode = root.querySelector("[data-cart-count]");
  const subtotalNode = root.querySelector("[data-cart-subtotal]");
  const shippingRow = root.querySelector("[data-shipping-row]");
  const shippingNode = root.querySelector("[data-cart-shipping]");
  const shippingLabel = root.querySelector("[data-shipping-label]");
  const totalNode = root.querySelector("[data-cart-total]");
  const estimatedTimeNode = root.querySelector("[data-estimated-time]");
  const form = root.querySelector("[data-cart-form]");
  const zoneWrap = root.querySelector("[data-zone-wrap]");
  const addressWrap = root.querySelector("[data-address-wrap]");
  const referenceWrap = root.querySelector("[data-reference-wrap]");
  const paymentWrap = root.querySelector("[data-payment-wrap]");
  const paymentOptions = root.querySelector("[data-payment-options]");
  const transferBox = root.querySelector("[data-transfer-box]");
  const cashChangeWrap = root.querySelector("[data-cash-change-wrap]");
  const errorNode = root.querySelector("[data-cart-error]");
  const paymentError = root.querySelector("[data-payment-error]");

  if (!drawer || !itemsWrap || !countNode || !subtotalNode || !shippingNode || !totalNode || !form) return;

  const openCartButtons = root.querySelectorAll("[data-open-cart]");
  const closeCartButtons = root.querySelectorAll("[data-close-cart]");
  const addButtons = root.querySelectorAll(".js-add-cart");
  const orderTypeField = form.querySelector("select[name='order_type']");
  const zoneField = form.querySelector("select[name='delivery_zone_id']");
  const nameField = form.querySelector("input[name='customer_name']");
  const addressField = form.querySelector("input[name='address']");
  const referenceField = form.querySelector("input[name='reference']");
  const notesField = form.querySelector("textarea[name='notes']");
  const cashChangeField = form.querySelector("input[name='cash_change_amount']");
  const submitBtn = form.querySelector("button[type='submit']");

  const enabledPayments = [
    paymentMethods.card ? { id: "card", label: "Tarjeta" } : null,
    paymentMethods.transfer ? { id: "transfer", label: "Transferencia" } : null,
    paymentMethods.cash ? { id: "cash", label: "Efectivo" } : null,
  ].filter(Boolean);

  let cart = loadCart();
  hydrateZoneOptions();
  hydratePaymentOptions();

  function parseJson(source, fallback) {
    try {
      const parsed = JSON.parse(source || "");
      return parsed ?? fallback;
    } catch (_error) {
      return fallback;
    }
  }

  function loadCart() {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item) => Number(item.qty) > 0);
    } catch (_error) {
      return [];
    }
  }

  function saveCart() {
    localStorage.setItem(storageKey, JSON.stringify(cart));
  }

  function setError(message) {
    if (!errorNode) return;
    if (!message) {
      errorNode.classList.add("hidden");
      errorNode.textContent = "";
      return;
    }
    errorNode.textContent = message;
    errorNode.classList.remove("hidden");
  }

  function setPaymentError(message) {
    if (!paymentError) return;
    if (!message) {
      paymentError.classList.add("hidden");
      paymentError.textContent = "";
      return;
    }
    paymentError.textContent = message;
    paymentError.classList.remove("hidden");
  }

  function openCart() {
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
  }

  function closeCart() {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function isDelivery() {
    return orderTypeField.value === "envio";
  }

  function selectedPaymentId() {
    const selected = form.querySelector("input[name='payment_method']:checked");
    return selected ? selected.value : "";
  }

  function paymentLabelFromId(id) {
    if (id === "card") return "Tarjeta";
    if (id === "transfer") return "Transferencia";
    if (id === "cash") return "Efectivo";
    return id;
  }

  function currentZone() {
    const zoneId = Number(zoneField.value || 0);
    if (!zoneId) return null;
    return deliveryZones.find((zone) => Number(zone.id) === zoneId) || null;
  }

  function calcSubtotal() {
    return cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  }

  function effectiveMinimum(zone) {
    if (zone && Number(zone.minimum_order_amount || 0) > 0) return Number(zone.minimum_order_amount);
    return Number(generalMinimum || 0);
  }

  function effectiveFreeOver(zone) {
    if (zone && Number(zone.free_delivery_over_amount || 0) > 0) return Number(zone.free_delivery_over_amount);
    return Number(generalFreeOver || 0);
  }

  function deliverySummary() {
    if (!isDelivery()) {
      return { shipping: 0, shippingLabel: "Sin envio", freeApplied: false, zone: null, minimum: 0, freeOver: 0 };
    }

    const zone = currentZone();
    const subtotal = calcSubtotal();
    const minimum = effectiveMinimum(zone);
    const freeOver = effectiveFreeOver(zone);
    let shipping = zone ? Number(zone.price || 0) : 0;
    let freeApplied = false;

    if (freeOver > 0 && subtotal >= freeOver) {
      shipping = 0;
      freeApplied = true;
    }

    return {
      shipping,
      shippingLabel: zone ? zone.name : "Zona",
      freeApplied,
      zone,
      minimum,
      freeOver,
    };
  }

  function calcTotal() {
    const subtotal = calcSubtotal();
    const summary = deliverySummary();
    return subtotal + summary.shipping;
  }

  function formatTransferInfo() {
    const lines = [];
    if (transferConfig.alias) lines.push(`Alias: ${transferConfig.alias}`);
    if (transferConfig.cvu) lines.push(`CVU: ${transferConfig.cvu}`);
    if (transferConfig.holder) lines.push(`Titular: ${transferConfig.holder}`);
    if (transferConfig.note) lines.push(transferConfig.note);
    return lines.join(" | ");
  }

  function hydrateZoneOptions() {
    if (!zoneField) return;
    zoneField.innerHTML = [
      '<option value="">Seleccionar zona</option>',
      ...deliveryZones.map((zone) => {
        const label = `${escapeHtml(zone.name)} (${money.format(Number(zone.price || 0))})`;
        return `<option value="${zone.id}">${label}</option>`;
      }),
    ].join("");
  }

  function hydratePaymentOptions() {
    if (!paymentWrap || !paymentOptions) return;
    if (!enabledPayments.length) {
      paymentWrap.classList.add("disabled");
      paymentOptions.innerHTML = "";
      submitBtn.disabled = true;
      setPaymentError("Este comercio no tiene metodos de pago activos.");
      return;
    }

    paymentWrap.classList.remove("disabled");
    submitBtn.disabled = false;
    setPaymentError("");
    paymentOptions.innerHTML = enabledPayments
      .map(
        (method, index) => `
          <label class="pay-option">
            <input type="radio" name="payment_method" value="${method.id}" ${index === 0 ? "checked" : ""} required />
            <span>${method.label}</span>
          </label>
        `
      )
      .join("");
    togglePaymentExtras();
  }

  function toggleDeliveryFields() {
    const delivery = isDelivery();
    zoneWrap.classList.toggle("hidden", !delivery);
    addressWrap.classList.toggle("hidden", !delivery);
    referenceWrap.classList.toggle("hidden", !delivery);
    zoneField.required = delivery;
    addressField.required = delivery;
  }

  function togglePaymentExtras() {
    const selected = selectedPaymentId();
    const showTransfer = selected === "transfer";
    const showCashChange = selected === "cash" && cashAllowChange;

    const transferInfo = formatTransferInfo();
    if (showTransfer && transferInfo) {
      transferBox.innerHTML = `<small>${escapeHtml(transferInfo)}</small>`;
      transferBox.classList.remove("hidden");
    } else {
      transferBox.classList.add("hidden");
      transferBox.innerHTML = "";
    }

    cashChangeWrap.classList.toggle("hidden", !showCashChange);
  }

  function render() {
    const totalQty = cart.reduce((sum, item) => sum + item.qty, 0);
    countNode.textContent = String(totalQty);

    if (!cart.length) {
      itemsWrap.innerHTML = '<p class="empty">Todavia no agregaste productos.</p>';
    } else {
      itemsWrap.innerHTML = cart
        .map((item) => {
          const subtotal = item.price * item.qty;
          return `
            <article class="cart-item">
              <div class="cart-item-head">
                <h4>${escapeHtml(item.name)}</h4>
                <button type="button" class="btn btn-danger" data-remove-item="${item.id}">Eliminar</button>
              </div>
              <small>${money.format(item.price)} c/u</small>
              <div class="cart-item-head">
                <div class="cart-qty">
                  <button type="button" data-qty-minus="${item.id}">-</button>
                  <strong>${item.qty}</strong>
                  <button type="button" data-qty-plus="${item.id}">+</button>
                </div>
                <strong>${money.format(subtotal)}</strong>
              </div>
            </article>
          `;
        })
        .join("");
    }

    const subtotal = calcSubtotal();
    const summary = deliverySummary();
    const total = subtotal + summary.shipping;
    const minimum = summary.minimum;

    subtotalNode.textContent = money.format(subtotal);
    totalNode.textContent = money.format(total);

    if (isDelivery()) {
      const shippingText = summary.freeApplied
        ? `${money.format(summary.shipping)} (Envio gratis)`
        : money.format(summary.shipping);
      shippingNode.textContent = shippingText;
      shippingLabel.textContent = summary.zone ? `Envio (${summary.zone.name})` : "Envio";
      shippingRow.classList.remove("hidden");
    } else {
      shippingNode.textContent = money.format(0);
      shippingRow.classList.add("hidden");
    }

    if (summary.zone && summary.zone.estimated_time_min && summary.zone.estimated_time_max) {
      estimatedTimeNode.textContent = `Entrega estimada: ${summary.zone.estimated_time_min}-${summary.zone.estimated_time_max} min`;
      estimatedTimeNode.classList.remove("hidden");
    } else {
      estimatedTimeNode.textContent = "";
      estimatedTimeNode.classList.add("hidden");
    }

    if (minimum > 0 && subtotal < minimum) {
      const base = summary.zone ? `Pedido minimo para ${summary.zone.name}` : "Pedido minimo";
      setError(`${base}: ${money.format(minimum)}.`);
    } else if (!openStatus.canOrder) {
      setError(openStatus.message || "El local esta cerrado por el momento.");
    } else {
      setError("");
    }
  }

  function validateBeforeSend() {
    if (!businessWhatsapp) return "El comercio no configuro WhatsApp.";
    if (!openStatus.canOrder) return openStatus.message || "El local no esta tomando pedidos.";
    if (!cart.length) return "Agrega al menos un producto al carrito.";
    if (!nameField.value.trim()) return "Ingresa tu nombre.";
    if (!selectedPaymentId()) return "Selecciona un metodo de pago.";
    if (!enabledPayments.length) return "No hay metodos de pago disponibles.";
    if (isDelivery() && !deliveryEnabled) return "El envio no esta habilitado.";
    if (!isDelivery() && !pickupEnabled) return "El retiro no esta habilitado.";

    const summary = deliverySummary();
    const subtotal = calcSubtotal();

    if (isDelivery()) {
      if (!deliveryZones.length) return "No hay zonas de envio activas.";
      if (!zoneField.value) return "Selecciona una zona de envio.";
      if (!addressField.value.trim()) return "Ingresa direccion para envio.";
    }

    if (summary.minimum > 0 && subtotal < summary.minimum) {
      const zoneText = summary.zone ? ` para ${summary.zone.name}` : "";
      return `Pedido minimo${zoneText}: ${money.format(summary.minimum)}.`;
    }

    if (selectedPaymentId() === "cash" && cashAllowChange) {
      const raw = String(cashChangeField.value || "").trim();
      if (raw) {
        const amount = Number(raw);
        if (Number.isNaN(amount) || amount <= 0) {
          return "El monto de efectivo debe ser un numero valido.";
        }
        if (amount < calcTotal()) {
          return "El monto de efectivo debe ser mayor o igual al total.";
        }
      }
    }

    return "";
  }

  function buildWhatsappMessage() {
    const subtotal = calcSubtotal();
    const summary = deliverySummary();
    const total = subtotal + summary.shipping;
    const paymentId = selectedPaymentId();
    const paymentLabel = paymentLabelFromId(paymentId);
    const lines = [];

    lines.push("Hola! Quiero hacer este pedido:");
    lines.push("");
    lines.push("Pedido:");

    cart.forEach((item) => {
      const itemSubtotal = item.price * item.qty;
      lines.push(`- ${item.qty}x ${item.name} (${money.format(item.price)}) = ${money.format(itemSubtotal)}`);
    });

    lines.push("");
    lines.push("Resumen:");
    lines.push(`- Subtotal: ${money.format(subtotal)}`);
    if (isDelivery()) {
      const shipLine = summary.freeApplied
        ? `- Envio (${summary.zone ? summary.zone.name : "Zona"}): ${money.format(0)} (Envio gratis)`
        : `- Envio (${summary.zone ? summary.zone.name : "Zona"}): ${money.format(summary.shipping)}`;
      lines.push(shipLine);
    }
    lines.push(`- Total: ${money.format(total)}`);

    lines.push("");
    lines.push("Entrega:");
    lines.push(`- Tipo de pedido: ${isDelivery() ? "Envio a domicilio" : "Retiro en local"}`);
    if (isDelivery()) {
      lines.push(`- Zona: ${summary.zone ? summary.zone.name : ""}`);
      lines.push(`- Direccion: ${addressField.value.trim()}`);
      if (referenceField.value.trim()) lines.push(`- Referencia: ${referenceField.value.trim()}`);
      if (summary.zone && summary.zone.estimated_time_min && summary.zone.estimated_time_max) {
        lines.push(`- Tiempo estimado: ${summary.zone.estimated_time_min}-${summary.zone.estimated_time_max} min`);
      }
    }

    lines.push("");
    lines.push("Pago:");
    lines.push(`- Metodo: ${paymentLabel}`);
    if (paymentId === "transfer") {
      if (transferConfig.alias) lines.push(`- Alias: ${transferConfig.alias}`);
      if (transferConfig.cvu) lines.push(`- CVU: ${transferConfig.cvu}`);
      if (transferConfig.holder) lines.push(`- Titular: ${transferConfig.holder}`);
    }
    if (paymentId === "cash") {
      const raw = String(cashChangeField.value || "").trim();
      if (raw) lines.push(`- Pago con: ${money.format(Number(raw))} (necesita vuelto)`);
    }

    lines.push("");
    lines.push("Cliente:");
    lines.push(`- Nombre: ${nameField.value.trim()}`);
    if (notesField.value.trim()) lines.push(`- Observaciones: ${notesField.value.trim()}`);

    return lines.join("\n");
  }

  function restoreFormSubmitButtons() {
    const lockedButtons = form.querySelectorAll("button[type='submit'], input[type='submit']");
    lockedButtons.forEach((button) => {
      if (!button.disabled) return;
      const original = button.dataset.originalText || "";
      if (original) {
        if (button.tagName === "BUTTON") {
          button.textContent = original;
        } else {
          button.value = original;
        }
      }
      button.disabled = false;
    });
  }

  function addProduct(product) {
    if (product.soldOut) return;
    const existing = cart.find((item) => item.id === product.id);
    if (existing) {
      existing.qty += 1;
    } else {
      cart.push({ id: product.id, name: product.name, price: product.price, qty: 1 });
    }
    saveCart();
    render();
    openCart();
  }

  function changeQty(id, delta) {
    const current = cart.find((item) => item.id === id);
    if (!current) return;
    current.qty += delta;
    if (current.qty <= 0) cart = cart.filter((x) => x.id !== id);
    saveCart();
    render();
  }

  function removeItem(id) {
    cart = cart.filter((x) => x.id !== id);
    saveCart();
    render();
  }

  addButtons.forEach((button) => {
    button.addEventListener("click", () => {
      addProduct({
        id: Number(button.dataset.productId),
        name: button.dataset.productName || "Producto",
        price: Number(button.dataset.productPrice || 0),
        soldOut: button.dataset.productSoldout === "1",
      });
    });
  });

  openCartButtons.forEach((button) => button.addEventListener("click", openCart));
  closeCartButtons.forEach((button) => button.addEventListener("click", closeCart));

  itemsWrap.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.dataset.qtyPlus) changeQty(Number(target.dataset.qtyPlus), 1);
    if (target.dataset.qtyMinus) changeQty(Number(target.dataset.qtyMinus), -1);
    if (target.dataset.removeItem) removeItem(Number(target.dataset.removeItem));
  });

  form.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.getAttribute("name") === "order_type") {
      toggleDeliveryFields();
      render();
      return;
    }
    if (target.getAttribute("name") === "delivery_zone_id") {
      render();
      return;
    }
    if (target.getAttribute("name") === "payment_method") {
      togglePaymentExtras();
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    setError("");
    setPaymentError("");

    const validationError = validateBeforeSend();
    if (validationError) {
      if (validationError.toLowerCase().includes("pago")) setPaymentError(validationError);
      else setError(validationError);
      restoreFormSubmitButtons();
      return;
    }

    const message = buildWhatsappMessage();
    const waUrl = `https://wa.me/${businessWhatsapp}?text=${encodeURIComponent(message)}`;
    const popup = window.open(waUrl, "_blank");
    if (!popup) {
      setError("No se pudo abrir WhatsApp. Habilita popups e intenta nuevamente.");
      restoreFormSubmitButtons();
      return;
    }

    cart = [];
    saveCart();
    form.reset();
    hydratePaymentOptions();
    toggleDeliveryFields();
    render();
    closeCart();
  });

  if (!openStatus.canOrder) {
    submitBtn.disabled = true;
  }
  toggleDeliveryFields();
  togglePaymentExtras();
  render();
})();
