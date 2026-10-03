// Корзина, оформление заказа и «Мои заказы» покупателя.
import { $, telegram, telegramUser, formatPrice, formatDate, escapeHtml, haptic, toast, on, storage, replayAnimation, copyToClipboard, openLink } from "./core.js?v=20261001b";
import { DELIVERY_METHODS } from "./data.js?v=20261001b";
import { state, api, saveCart, findProduct, cartTotal, hasServer, useSupabase, hasOrdersBackend } from "./state.js?v=20261001b";
import { watchOrders } from "./supabase.js?v=20261001b";
import { MANAGER_USERNAME } from "./config.js?v=20261001b";
import { colorName, swatchBackground, stockLeft, refreshCatalog } from "./catalog.js?v=20261001b";
import { productImage } from "./photos.js?v=20261001b";
import { sheetBody, openSheet, closeSheet, setTab, openCart, syncMainButton } from "./nav.js?v=20261001b";
import { chatButtonHtml, openChat, onChatEvent } from "./chat.js?v=20261001b";

const tint = (color) => `color-mix(in srgb, ${color} 14%, var(--bg))`;
const emptyState = (title, text, buttonId) =>
  `<div class="done"><p class="big">${title}</p><p class="p-desc">${text}</p><button class="primary" id="${buttonId}">Перейти к товарам</button></div>`;

/* ---------- Корзина ---------- */
export function renderCartPage() {
  const page = $("cartPage");
  if (!state.cart.length) {
    page.innerHTML = emptyState("Корзина пуста", "Выберите что-нибудь для бега, зала или на каждый день.", "goShopping");
    return;
  }
  page.innerHTML = `<h2 class="p-name">Корзина</h2>
    ${state.cart.map((line, i) => {
      const p = findProduct(line.id);
      return p ? `<div class="line">
        <div class="thumb" style="background:${tint(line.color)}">${productImage(p, line.color, { thumb: true })}
          <i class="dot" style="background:${swatchBackground(p, line.color)}"></i></div>
        <div><p class="t">${p.name}</p><p class="s">${colorName(p, line.color)} · размер ${line.size} · ${formatPrice(p.price)}</p></div>
        <div class="qty"><button data-decrease="${i}" aria-label="Меньше">−</button><span>${line.qty}</span>
          <button data-increase="${i}" aria-label="Больше" ${line.qty >= stockLeft(p, line.color, line.size) ? "disabled" : ""}>+</button></div>
      </div>` : "";
    }).join("")}
    <div class="total"><span>Итого</span><b>${formatPrice(cartTotal())}</b></div>
    <button class="primary browser-only" id="toCheckout">Оформить заказ</button>`;
}

function changeQuantity(index, delta) {
  const line = state.cart[index];
  line.qty += delta;
  if (!line.qty) state.cart.splice(index, 1);
  haptic();
  saveCart();
  renderCartPage();
  syncMainButton();
  if (line.qty) {
    replayAnimation($("cartPage").querySelectorAll(".qty span")[index], "tick");
    replayAnimation($("cartPage").querySelector(".total b"), "tick");
  }
}

/* ---------- Оформление ---------- */
let deliveryMethod = "cdek";
const addressDrafts = {}; // введённый адрес не теряется при переключении способа доставки

export function openCheckout() {
  const name = [telegramUser?.first_name, telegramUser?.last_name].filter(Boolean).join(" ");
  sheetBody.innerHTML = `<div class="grab"></div><h2 class="p-name">Доставка</h2>
    <label class="field"><span>Имя</span><input id="customerName" autocomplete="name" value="${escapeHtml(name)}"></label>
    <label class="field"><span>Телефон</span><input id="customerPhone" type="tel" autocomplete="tel" placeholder="+7 900 000-00-00"></label>
    <p class="label">Способ доставки</p>
    <div class="ways" role="radiogroup" aria-label="Способ доставки">${DELIVERY_METHODS.map((m) =>
      `<button class="way" role="radio" data-delivery="${m.id}" aria-checked="${m.id === deliveryMethod}"><b>${m.title}</b><small>${m.hint}</small></button>`).join("")}</div>
    <div id="addressField"></div>
    <p class="hint" id="hint"></p>
    <div class="total"><span>К оплате</span><b>${formatPrice(cartTotal())}</b></div>
    <button class="primary browser-only" id="placeOrder">Подтвердить заказ</button>`;
  renderAddressField();
  sheetBody.onclick = (e) => {
    const method = e.target.closest("[data-delivery]")?.dataset.delivery;
    if (method) {
      haptic();
      deliveryMethod = method;
      sheetBody.querySelectorAll("[data-delivery]").forEach((b) => b.setAttribute("aria-checked", b.dataset.delivery === method));
      $("hint").textContent = "";
      renderAddressField();
      $("address")?.focus({ preventScroll: true });
    }
    if (e.target.id === "placeOrder") placeOrder();
  };
  openSheet("checkout", openCart);
}

function renderAddressField() {
  const current = $("address");
  if (current) addressDrafts[current.dataset.method] = current.value;
  const m = DELIVERY_METHODS.find((x) => x.id === deliveryMethod);
  $("addressField").innerHTML = m.addressLabel ? `<label class="field"><span>${m.addressLabel}</span>
    <input id="address" data-method="${m.id}" autocomplete="street-address" placeholder="${m.placeholder}" value="${escapeHtml(addressDrafts[m.id] || "")}"></label>` : "";
}

/** Бот может написать покупателю только с его разрешения — оно нужно, чтобы прислать реквизиты */
const askWritePermission = () => new Promise((resolve) => {
  if (!telegram?.requestWriteAccess || telegramUser?.allows_write_to_pm) return resolve();
  try { telegram.requestWriteAccess(() => resolve()); } catch { resolve(); }
});

let placingOrder = false;
export async function placeOrder() {
  if (placingOrder) return;
  const method = DELIVERY_METHODS.find((m) => m.id === deliveryMethod);
  const name = $("customerName").value.trim(), phone = $("customerPhone").value.trim(), addr = $("address")?.value.trim() || "";
  if (!name || !phone || (method.addressLabel && !addr)) {
    $("hint").textContent = method.addressLabel ? `Заполните имя, телефон и поле «${method.addressLabel}»` : "Заполните имя и телефон";
    return haptic("medium");
  }
  const items = state.cart.map((line) => {
    const p = findProduct(line.id);
    return { ...line, name: p.name, colorName: colorName(p, line.color), price: p.price };
  });
  const order = { items, total: cartTotal(), name, phone, way: method.title, addr };
  const button = $("placeOrder");
  placingOrder = button.disabled = true;
  button.textContent = "Оформляем…";
  try {
    if (!hasOrdersBackend) return sendOrderToManager(order);
    if (hasServer) await askWritePermission(); // бот пришлёт реквизиты в чат; с Supabase они придут в «Мои заказы»
    const { num } = await api.placeOrder(order);
    rememberOrder({ ...order, num, date: new Date().toISOString(), status: "new" });
    state.cart = [];
    saveCart();
    showOrderPlaced(num, useSupabase ? "Менеджер проверит наличие и пришлёт реквизиты прямо сюда, во вкладку «Мои заказы»." : undefined);
    refreshCatalog(); // остатки изменились
  } catch (error) {
    haptic("medium");
    if (error.code === "conflict") {
      await refreshCatalog();
      toast("Часть товара закончилась, корзина обновлена");
      return openCart();
    }
    $("hint").textContent = error.code === "unauthorized" ? (LOGIN_ERRORS[error.reason] || LOGIN_ERRORS.server)
      : "Не удалось оформить заказ. Проверьте соединение и повторите.";
  } finally {
    placingOrder = button.disabled = false;
    button.textContent = "Подтвердить заказ";
  }
}

/** Почему не удалось войти в базу заказов (Supabase) — чтобы было понятно, что чинить */
const LOGIN_ERRORS = {
  no_library: "Не загрузилась библиотека базы заказов. Проверьте интернет и перезапустите магазин.",
  no_function: "Магазин не настроен: в базе Supabase нет функции tg_login. Сообщите администратору.",
  bad_signature: "База заказов отклонила вход (код 42501): её правила требуют подписанные данные Telegram, а их нет или токен бота в Supabase Vault неверный.",
  tg_no_header: "Telegram не передал данные входа. Откройте магазин кнопкой «Магазин» в чате с ботом, а не по ссылке.",
  tg_bad_hash: "Подпись Telegram не совпала: магазин открыт из другого бота, или в базе сохранён токен другого бота. Сообщите администратору.",
  tg_expired: "Данные входа устарели. Закройте магазин полностью и откройте снова.",
  tg_no_token: "Магазин не настроен: в базе не задан токен бота. Сообщите администратору.",
  tg_bad_data: "Telegram передал повреждённые данные входа. Перезапустите магазин и повторите.",
  network: "Нет связи с базой заказов. Проверьте интернет и повторите.",
  server: "База заказов ответила ошибкой. Повторите через минуту или сообщите администратору.",
};

/** Без сервера (GitHub Pages): заказ уходит сообщением менеджеру, текст уже вписан в чат */
function sendOrderToManager(order) {
  if (!MANAGER_USERNAME) {
    $("hint").textContent = "Магазин ещё не настроен: укажите MANAGER_USERNAME в js/config.js.";
    return haptic("medium");
  }
  const num = Number(String(Date.now()).slice(-6));
  const text = [`Заказ №${num}`, `${order.name}, ${order.phone}`, `${order.way}${order.addr ? ": " + order.addr : ""}`, "",
    ...order.items.map((l) => `• ${l.name}, ${l.colorName}, ${l.size} — ${l.qty} шт. × ${formatPrice(l.price)}`),
    "", `Итого: ${formatPrice(order.total)}`].join("\n");
  navigator.clipboard?.writeText(text).catch(() => {}); // на случай, если текст не подставится в чат
  openLink(`https://t.me/${MANAGER_USERNAME.replace(/^@/, "")}?text=${encodeURIComponent(text)}`);
  rememberOrder({ ...order, num, date: new Date().toISOString(), status: "new" });
  state.cart = [];
  saveCart();
  showOrderPlaced(num, "Отправьте сообщение в открывшемся чате с менеджером — он подтвердит наличие и пришлёт реквизиты для оплаты. Текст заказа также скопирован.");
}

function showOrderPlaced(num, note = "Когда менеджер проверит наличие, бот пришлёт в этот чат реквизиты для оплаты.") {
  sheetBody.innerHTML = `<div class="grab"></div><div class="done">
    <div class="finish" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
    <svg class="check" viewBox="0 0 54 54" aria-hidden="true"><circle cx="27" cy="27" r="27"/><path d="M16 28 L24 36 L39 19"/></svg>
    <p class="big">Заказ оформлен</p>
    <p class="p-desc">${note}</p>
    <button class="primary" id="showMyOrders">Мои заказы</button></div>`;
  sheetBody.onclick = (e) => { if (e.target.id === "showMyOrders") { closeSheet(); setTab("orders"); } };
  haptic("success");
  openSheet("done");
}

/* ---------- Мои заказы ---------- */
const ORDER_STATUS = { new: "Ждёт подтверждения", accepted: "Принят, ждёт оплаты", paid: "Оплачен, готовим к отправке", delivered: "Вручён", rejected: "Отменён" };
export const paymentDetails = (order) => order.payDetails || order.payUrl || "";
const isPaymentLink = (text) => /^https:\/\/\S+$/.test(text.trim());

function rememberOrder(order) {
  ordersGroup = "new"; // в «Моих заказах» сразу видно только что оформленный заказ
  state.myOrders = [order, ...state.myOrders.filter((o) => o.num !== order.num)].slice(0, 50);
  storage.set("temp_my_orders", state.myOrders);
}

export const orderItemsHtml = (order) =>
  `<ul class="ord-items">${(order.items || []).map((l) => `<li>${escapeHtml(l.name)}, ${escapeHtml(l.colorName)}, ${escapeHtml(l.size)} — ${Number(l.qty)} шт.</li>`).join("")}</ul>`;

function myOrderHtml(o) {
  const status = o.status || "new", details = paymentDetails(o), total = formatPrice(Number(o.total) || 0);
  return `<article class="ord st-${status}">
    <div class="ord-top"><b>№${o.num}</b><span class="ord-st">${ORDER_STATUS[status]}</span><time>${formatDate(o.date)}</time></div>
    ${orderItemsHtml(o)}
    <p class="ord-way">${escapeHtml(o.way)}${o.addr ? ": " + escapeHtml(o.addr) : ""}</p>
    <p class="ord-sum">Итого <b>${total}</b></p>
    ${status === "accepted" && details ? `${o.note ? `<p class="ord-note">${escapeHtml(o.note)}</p>` : ""}
      <div class="req"><p class="req-h">Реквизиты для оплаты · ${total}</p><p class="req-t">${escapeHtml(details)}</p>
      <button class="ghost copy" data-copy="${o.num}">Скопировать реквизиты</button></div>
      ${isPaymentLink(details) ? `<a class="primary pay" href="${escapeHtml(details)}" data-pay>Перейти к оплате</a>` : ""}` : ""}
    ${status === "rejected" && o.message ? `<p class="ord-note">${escapeHtml(o.message)}</p>` : ""}
    ${useSupabase && status === "accepted" ? `<p class="adm-sub" style="margin-top:10px">Оплатили? Отправьте чек менеджеру в чат.</p>` : ""}
    ${useSupabase ? chatButtonHtml(o, "customer") : ""}
    ${status === "new" ? `<p class="adm-sub">${hasOrdersBackend ? "Менеджер проверит наличие и пришлёт реквизиты для оплаты. Статус обновится здесь сам." : "Статус заказа уточняйте у менеджера в Telegram."}</p>` : ""}
  </article>`;
}

/** Заказы покупателя по группам: принятые (в том числе оплаченные), вручённые, отменённые и ещё не подтверждённые */
const ORDER_GROUPS = [["accepted", "Принятые"], ["delivered", "Вручённые"], ["rejected", "Отменённые"], ["new", "Ждут подтверждения"]];
const groupOf = (o) => (o.status === "rejected" || o.status === "delivered" ? o.status
  : o.status === "accepted" || o.status === "paid" ? "accepted" : "new");
let ordersGroup = null; // выбранная группа; null — первая непустая

function myOrdersHtml() {
  const counts = Object.fromEntries(ORDER_GROUPS.map(([id]) => [id, state.myOrders.filter((o) => groupOf(o) === id).length]));
  const groups = ORDER_GROUPS.filter(([id]) => counts[id]);
  if (!counts[ordersGroup]) ordersGroup = groups[0][0];
  return `<h2 class="p-name">Мои заказы</h2>
    <div class="order-groups" role="tablist">${groups.map(([id, title]) =>
      `<button class="chip" role="tab" data-orders-group="${id}" aria-pressed="${id === ordersGroup}">${title} · ${counts[id]}</button>`).join("")}</div>
    ${state.myOrders.filter((o) => groupOf(o) === ordersGroup).map(myOrderHtml).join("")}`;
}

export async function renderMyOrders(reload = false) {
  const page = $("ordersPage");
  const draw = () => (page.innerHTML = state.myOrders.length ? myOrdersHtml()
    : emptyState("Заказов пока нет", "Здесь появятся ваши заказы и реквизиты для оплаты.", "goShopping"));
  draw();
  if (!reload || !hasOrdersBackend) return;
  try {
    state.myOrders = (await api.myOrders()).orders || [];
    storage.set("temp_my_orders", state.myOrders);
    if (state.tab === "orders") draw();
  } catch {}
}

export function initCart() {
  $("cartPage").onclick = (e) => {
    const decrease = e.target.closest("[data-decrease]"), increase = e.target.closest("[data-increase]:not(:disabled)");
    if (decrease) changeQuantity(Number(decrease.dataset.decrease), -1);
    if (increase) changeQuantity(Number(increase.dataset.increase), +1);
    if (e.target.id === "toCheckout") openCheckout();
    if (e.target.id === "goShopping") setTab("shop");
  };
  $("ordersPage").onclick = (e) => {
    if (e.target.id === "goShopping") setTab("shop");
    const group = e.target.closest("[data-orders-group]")?.dataset.ordersGroup;
    if (group && group !== ordersGroup) { haptic(); ordersGroup = group; return renderMyOrders(); }
    const pay = e.target.closest("[data-pay]");
    if (pay) { e.preventDefault(); openLink(pay.href); }
    const chatButton = e.target.closest("[data-chat]");
    const chatOrder = chatButton && state.myOrders.find((o) => o.num === Number(chatButton.dataset.chat));
    if (chatOrder) { haptic(); openChat(chatOrder, "customer"); }
    const copy = e.target.closest("[data-copy]");
    if (copy) copyToClipboard(paymentDetails(state.myOrders.find((o) => o.num === Number(copy.dataset.copy))), copy);
  };
  on("catalog", () => state.tab === "cart" && renderCartPage());
  on("chatseen", () => state.tab === "orders" && renderMyOrders()); // убрать отметку «новое»
  document.addEventListener("visibilitychange", () => !document.hidden && state.tab === "orders" && renderMyOrders(true));
  if (useSupabase) watchMyOrders();
}

/** Supabase: заказ меняется — перечитываем «Мои заказы». Пришли реквизиты или сообщение — сообщаем покупателю. */
function watchMyOrders() {
  watchOrders("user", async (payload) => {
    const { id, op } = payload;
    if (onChatEvent(payload, "customer")) return renderMyOrders(true);
    await renderMyOrders(true);
    const order = state.myOrders.find((o) => o.num === Number(id));
    if (op === "update" && order?.status === "accepted") { haptic("success"); toast(`Заказ №${order.num}: пришли реквизиты`); }
  }, () => renderMyOrders(true)); // после переподключения догружаем пропущенное
}
