// Администратор: заказы. Принять и отправить реквизиты для оплаты или отказать, если товара нет.
import { $, formatPrice, formatDate, escapeHtml, pluralize, haptic, toast, storage, on } from "./core.js?v=20261001b";
import { state, api, errorMessage, useSupabase } from "./state.js?v=20261001b";
import { watchOrders } from "./supabase.js?v=20261001b";
import { refreshCatalog } from "./catalog.js?v=20261001b";
import { orderItemsHtml, paymentDetails } from "./cart.js?v=20261001b";
import { sheetBody, openSheet } from "./nav.js?v=20261001b";
import { chatButtonHtml, openChat, onChatEvent, hasUnread } from "./chat.js?v=20261001b";
import { openCustomer } from "./admin-customers.js?v=20261001b";

const STATUS = { new: "Новый", accepted: "Ждёт оплаты", paid: "Оплачен", delivered: "Вручён", rejected: "Отказ" };
/** Вкладки списка заказов. «Новые» видны, только когда есть заказы, которые нужно принять или отклонить. */
const STAFF_GROUPS = [["new", "Новые"], ["rejected", "Отменённые"], ["paid", "Принятые"], ["accepted", "Ожидают оплаты"], ["delivered", "Вручённые"]];
const GROUP_EMPTY = { rejected: "Отменённых заказов нет.", paid: "Оплаченных заказов, ждущих вручения, нет.",
  accepted: "Заказов, ожидающих оплаты, нет.", delivered: "Вручённых заказов нет." };
const staffGroupOf = (o) => o.status;
let staffGroup = null; // выбранная вкладка; null — выбрать самую нужную
let openForm = null; // { num, type: "accept" | "reject", text, note } или { num, type: "pay", method, amount }
let showArchived = false; // смотрим скрытые заказы
let archived = [];        // скрытые заказы, когда их открыли
let archivedCount = 0;
let canArchive = false;   // в базе настроены скрытые заказы

const PAY_METHODS = [["cash", "Наличные", "Отдали в руки"], ["card", "Карта", "Перевод или терминал"]];
const PAY_METHOD = { cash: "наличными", card: "картой" };

const newOrdersCount = () => state.adminOrders.filter((o) => o.status === "new").length;
const rejectionText = (order) =>
  `Здравствуйте! К сожалению, ${(order?.items || []).map((l) => l.name).join(", ") || "товара из вашего заказа"} сейчас нет в наличии, поэтому мы отменили заказ. Приносим извинения и будем рады помочь подобрать замену: просто напишите нам.`;

export async function loadAdminOrders() {
  try {
    const { orders = [], canArchive: ready } = await api.adminOrders();
    state.adminOrders = orders.sort((a, b) => (b.status === "new") - (a.status === "new") || b.num - a.num);
    canArchive = Boolean(ready && api.archiveOrders);
    if (canArchive) archivedCount = await api.archivedCount();
    if (showArchived) archived = (await api.adminOrders(true)).orders || [];
    updateOrdersButton();
    if (state.view === "adminOrders" && !openForm) renderOrders();
  } catch {}
}

function updateOrdersButton() {
  const n = newOrdersCount(), button = $("adminOrdersButton");
  const chats = state.adminOrders.filter((o) => hasUnread(o, "staff")).length; // заказы с непрочитанными сообщениями
  button.textContent = `Заказы${n ? ` · ${n}` : ""}${chats ? ` · 💬${chats}` : ""}`;
  button.title = [n && `${n} ${pluralize(n, "новый заказ", "новых заказа", "новых заказов")}`,
    chats && `${chats} ${pluralize(chats, "чат", "чата", "чатов")} с новыми сообщениями`].filter(Boolean).join(", ");
  button.classList.toggle("has-new", n + chats > 0);
}

/** Контакты покупателя текстом: логин Telegram (или ID, если логина нет) и телефон */
function contactsHtml({ user = {}, phone }) {
  const telegramLogin = user.username ? `@${escapeHtml(user.username)}` : user.id ? `ID ${Number(user.id)}` : "";
  return `<dl class="ord-contacts">
    ${telegramLogin ? `<dt>Telegram</dt><dd>${telegramLogin}</dd>` : ""}
    ${phone ? `<dt>Телефон</dt><dd>${escapeHtml(phone)}</dd>` : ""}</dl>`;
}

function decisionFormHtml(o) {
  if (openForm?.num !== o.num || openForm.type === "pay") return o.status === "new"
    ? `<div class="ord-actions"><button class="primary sm" data-accept="${o.num}">Принять</button><button class="ghost" data-reject="${o.num}">Нет в наличии</button></div>` : "";
  const accept = openForm.type === "accept";
  return `<div class="ord-form">
    <label class="field"><span>${accept ? "Реквизиты для оплаты" : "Сообщение покупателю"}</span>
      <textarea id="formText" maxlength="${accept ? 500 : 1000}" placeholder="${accept ? "Номер карты, банк и получатель. Или ссылка на оплату" : ""}">${escapeHtml(openForm.text)}</textarea></label>
    ${accept ? `<label class="field"><span>Комментарий для покупателя, если нужен</span>
      <textarea id="formNote" maxlength="500" placeholder="Например: отправим в течение дня после оплаты">${escapeHtml(openForm.note || "")}</textarea></label>`
      : useSupabase ? "" : `<p class="adm-sub">Товар из заказа вернётся на склад.</p>`}
    <p class="hint" id="formHint"></p>
    <div class="ord-actions"><button class="primary sm${accept ? "" : " danger"}" data-send="${o.num}">${accept ? "Отправить реквизиты" : "Отправить отказ"}</button>
      <button class="ghost" data-cancel>Отмена</button></div></div>`;
}

/** «Оплатить»: способ оплаты и сумма (по умолчанию — сумма заказа) */
function payFormHtml(o) {
  return `<div class="ord-form">
    <div class="field"><span>Способ оплаты</span>
      <div class="ways" role="radiogroup" aria-label="Способ оплаты">${PAY_METHODS.map(([id, title, hint]) =>
        `<button class="way" role="radio" data-pay-method="${id}" aria-checked="${openForm.method === id}"><b>${title}</b><small>${hint}</small></button>`).join("")}</div></div>
    <label class="field"><span>Сумма, ₽</span>
      <input id="payAmount" type="number" inputmode="decimal" min="1" step="0.01" value="${escapeHtml(String(openForm.amount ?? o.total))}"></label>
    <p class="hint" id="formHint"></p>
    <div class="ord-actions"><button class="primary sm" data-pay-save="${o.num}">Оплачено</button>
      <button class="ghost" data-cancel>Отмена</button></div></div>`;
}

/** Как оплатили: «Оплачено картой · 5 000 ₽ · Иванов, 05.10 14:30» */
const paymentHtml = (o) => o.payment
  ? `<p class="ord-pay">Оплачено ${PAY_METHOD[o.payment.method] || ""} · <b>${formatPrice(o.payment.amount)}</b>${
    o.payment.amount !== Number(o.total) ? ` <small>(сумма заказа ${formatPrice(Number(o.total) || 0)})</small>` : ""}${
    o.payment.by || o.payment.at ? `<br><small>${[escapeHtml(o.payment.by), o.payment.at && formatDate(o.payment.at)].filter(Boolean).join(", ")}</small>` : ""}</p>` : "";

function decisionResultHtml(o) {
  if (o.status === "new") return "";
  return `<div class="ord-res">
    <p>${o.status === "rejected" ? `Отказ: «${escapeHtml(o.message)}»`
      : `${{ paid: "Оплачен", delivered: "Оплачен и вручён" }[o.status] || "Принят"}. Реквизиты для оплаты:<span class="req-t">${escapeHtml(paymentDetails(o))}</span>`}</p>
    ${paymentHtml(o)}
    ${o.status === "accepted" && api.markPaid ? openForm?.num === o.num && openForm.type === "pay" ? payFormHtml(o)
      : `<div class="ord-actions"><button class="primary sm" data-pay="${o.num}">Оплатить</button></div>` : ""}
    ${o.status === "paid" && api.markDelivered ? `<div class="ord-actions"><button class="primary sm" data-deliver="${o.num}">Вручить</button></div>` : ""}
    <p class="adm-sub">${useSupabase ? "Покупатель видит статус и реквизиты во вкладке «Мои заказы»."
      : o.delivered ? "Сообщение доставлено покупателю в Telegram."
      : "Сообщение не доставлено: покупатель не разрешил боту писать ему. Напишите ему сами, контакты выше."}</p>
    ${useSupabase ? chatButtonHtml(o, "staff") : ""}</div>`;
}

const orderHtml = (o) => `<article class="ord st-${o.status}" id="order-${o.num}">
  <div class="ord-top"><b>№${o.num}</b><span class="ord-st">${STATUS[o.status]}</span><time>${formatDate(o.date)}</time></div>
  <p class="ord-who">${useSupabase && o.user?.id ? `<button class="link ord-client" data-client="${Number(o.user.id)}" data-client-order="${o.num}">${escapeHtml(o.name)} ›</button>` : escapeHtml(o.name)}</p>
  ${contactsHtml(o)}
  <p class="ord-way">${escapeHtml(o.way)}${o.addr ? ": " + escapeHtml(o.addr) : ""}</p>
  ${orderItemsHtml(o)}
  <p class="ord-sum">Итого <b>${formatPrice(Number(o.total) || 0)}</b></p>
  ${showArchived ? `<div class="ord-res">${useSupabase ? chatButtonHtml(o, "staff") : ""}
    <button class="ghost" data-unarchive="${o.num}" style="width:100%">Вернуть в список</button></div>`
    : `${decisionFormHtml(o)}${decisionResultHtml(o)}${canArchive && openForm?.num !== o.num
      ? `<button class="link ord-hide" data-hide="${o.num}">Скрыть заказ</button>` : ""}`}
</article>`;

/** Заказы, которые уберёт «Очистить список»: все, кроме новых (их ещё нужно принять или отклонить) */
const clearable = () => state.adminOrders.filter((o) => o.status !== "new");

function listToolsHtml() {
  if (!canArchive) return "";
  if (showArchived) return `<div class="ord-tools"><button class="ghost" data-show-active>← К заказам</button></div>`;
  const n = clearable().length;
  return `<div class="ord-tools">
    ${n ? `<button class="ghost danger" data-clear data-label="Очистить список">Очистить список</button>` : ""}
    ${archivedCount ? `<button class="link" data-show-archived>Скрытые заказы · ${archivedCount}</button>` : ""}</div>`;
}

function renderOrders() {
  if (showArchived) {
    sheetBody.innerHTML = `<div class="grab"></div><h2 class="p-name">Скрытые заказы</h2>
      <p class="adm-sub">${archived.length ? "Эти заказы убраны из списка. Покупатель их по-прежнему видит. Если он напишет в чат, заказ сам вернётся в список."
        : "Скрытых заказов нет."}</p>
      ${listToolsHtml()}${archived.map(orderHtml).join("")}`;
    return;
  }
  const n = newOrdersCount();
  const counts = Object.fromEntries(STAFF_GROUPS.map(([id]) => [id, state.adminOrders.filter((o) => staffGroupOf(o) === id).length]));
  const groups = STAFF_GROUPS.filter(([id]) => id !== "new" || counts.new);
  if (!groups.some(([id]) => id === staffGroup)) // по умолчанию: новые, иначе первая непустая вкладка
    staffGroup = counts.new ? "new" : groups.find(([id]) => counts[id])?.[0] || "paid";
  const list = state.adminOrders.filter((o) => staffGroupOf(o) === staffGroup);
  sheetBody.innerHTML = `<div class="grab"></div><h2 class="p-name">Заказы</h2>
    <p class="adm-sub">${state.adminOrders.length
      ? `${n ? `${n} ${pluralize(n, "новый заказ ждёт", "новых заказа ждут", "новых заказов ждут")} решения.` : "Новых заказов нет."} Принятый заказ — покупатель получает реквизиты для оплаты, отказ — сообщение, товар возвращается на склад.`
      : "Список пуст. Новые заказы появятся здесь сами."}</p>
    ${listToolsHtml()}
    <div class="order-groups" role="tablist">${groups.map(([id, title]) =>
      `<button class="chip" role="tab" data-staff-group="${id}" aria-pressed="${id === staffGroup}">${title} · ${counts[id]}</button>`).join("")}</div>
    ${list.length ? list.map(orderHtml).join("") : `<p class="adm-sub" style="margin-top:12px">${GROUP_EMPTY[staffGroup] || ""}</p>`}`;
}

export function openAdminOrders(focusNum) {
  openForm = null;
  showArchived = false;
  const focused = focusNum && state.adminOrders.find((o) => o.num === focusNum);
  if (focused) staffGroup = staffGroupOf(focused); // вернулись из чата — открываем раздел этого заказа
  renderOrders();
  sheetBody.onclick = onOrdersClick;
  openSheet("adminOrders");
  loadAdminOrders();
  if (focusNum) setTimeout(() => {
    const card = $(`order-${focusNum}`);
    card?.scrollIntoView({ block: "start" });
    card?.classList.add("flash");
  }, 350);
}

async function onOrdersClick(e) {
  const t = e.target;
  const chatButton = t.closest("[data-chat]");
  const chatOrder = chatButton && [...state.adminOrders, ...archived].find((o) => o.num === Number(chatButton.dataset.chat));
  if (chatOrder) { haptic(); return openChat(chatOrder, "staff", () => openAdminOrders(chatOrder.num)); }
  if (t.dataset.client) { haptic(); const num = Number(t.dataset.clientOrder); return openCustomer(t.dataset.client, () => openAdminOrders(num)); }
  if (t.hasAttribute("data-clear")) return clearList(t);
  if (t.hasAttribute("data-show-archived")) return switchList(true);
  if (t.hasAttribute("data-show-active")) return switchList(false);
  if (t.dataset.unarchive) return unarchive(t);
  if (t.dataset.hide) return hideOne(t);
  const group = t.closest("[data-staff-group]")?.dataset.staffGroup;
  if (group) { if (group !== staffGroup) { haptic(); staffGroup = group; renderOrders(); } return; }
  if (t.dataset.deliver) return markDelivered(t);
  if (t.dataset.accept) openForm = { num: Number(t.dataset.accept), type: "accept", text: storage.get("temp_last_pay", "") };
  else if (t.dataset.reject) openForm = { num: Number(t.dataset.reject), type: "reject", text: rejectionText(state.adminOrders.find((o) => o.num === Number(t.dataset.reject))) };
  else if (t.hasAttribute("data-cancel")) openForm = null;
  else if (t.dataset.send) return sendDecision(t);
  else if (t.dataset.pay) openForm = { num: Number(t.dataset.pay), type: "pay", method: null, amount: null };
  else if (t.closest("[data-pay-method]")) { openForm.method = t.closest("[data-pay-method]").dataset.payMethod; openForm.amount = $("payAmount").value; haptic(); }
  else if (t.dataset.paySave) return markPaid(t);
  else return;
  renderOrders();
  (openForm?.type === "pay" ? null : $("formText"))?.focus();
}

async function sendDecision(button) {
  const accept = openForm.type === "accept";
  openForm.text = $("formText").value.trim();
  openForm.note = $("formNote")?.value.trim();
  if (openForm.text.length < (accept ? 6 : 1)) {
    $("formHint").textContent = accept ? "Впишите реквизиты: номер карты и банк или ссылку на оплату" : "Напишите сообщение покупателю";
    return haptic("medium");
  }
  button.disabled = true;
  button.textContent = "Отправляем…";
  try {
    if (accept) {
      storage.set("temp_last_pay", openForm.text); // реквизиты обычно одни и те же — подставим в следующий раз
      await api.acceptOrder(openForm.num, openForm.text, openForm.note);
    } else {
      await api.rejectOrder(openForm.num, openForm.text);
      refreshCatalog(); // товар вернулся на склад
    }
    haptic("success");
    toast(accept ? "Заказ принят" : "Отказ отправлен");
    const num = openForm.num;
    openForm = null;
    await showOrder(num);
  } catch (error) {
    button.disabled = false;
    button.textContent = accept ? "Отправить реквизиты" : "Отправить отказ";
    $("formHint").textContent = errorMessage(error);
  }
}

/** «Очистить список»: первое нажатие спрашивает, второе скрывает обработанные заказы */
async function clearList(button) {
  const orders = clearable();
  if (!button.hasAttribute("data-armed")) {
    button.setAttribute("data-armed", "");
    button.textContent = `Скрыть ${orders.length} ${pluralize(orders.length, "заказ", "заказа", "заказов")}? Нажмите ещё раз`;
    return haptic("medium");
  }
  button.disabled = true;
  button.textContent = "Очищаем…";
  try {
    await api.archiveOrders(orders.map((o) => o.num));
    haptic("success");
    toast("Список очищен. Новые заказы остались");
  } catch (error) {
    toast(errorMessage(error));
  }
  await loadAdminOrders();
  renderOrders();
}

/** Скрыть один заказ: первое нажатие спрашивает, второе скрывает */
async function hideOne(button) {
  const num = Number(button.dataset.hide);
  if (!button.hasAttribute("data-armed")) {
    sheetBody.querySelectorAll(".ord-hide[data-armed]").forEach((b) => { b.removeAttribute("data-armed"); b.textContent = "Скрыть заказ"; });
    button.setAttribute("data-armed", "");
    button.textContent = state.adminOrders.find((o) => o.num === num)?.status === "new"
      ? "Заказ ещё не обработан. Всё равно скрыть? Нажмите ещё раз" : "Скрыть заказ? Нажмите ещё раз";
    return haptic("medium");
  }
  button.disabled = true;
  try {
    await api.archiveOrders([num]);
    haptic("success");
    toast(`Заказ №${num} скрыт`);
  } catch (error) {
    button.disabled = false;
    return toast(errorMessage(error));
  }
  await loadAdminOrders();
  renderOrders();
}

async function switchList(toArchived) {
  haptic();
  showArchived = toArchived;
  if (toArchived) {
    sheetBody.querySelector("[data-show-archived]")?.setAttribute("disabled", "");
    try { archived = (await api.adminOrders(true)).orders || []; } catch { archived = []; toast("Не удалось загрузить скрытые заказы"); }
  }
  renderOrders();
  $("sheet").scrollTop = 0;
}

async function unarchive(button) {
  button.disabled = true;
  try {
    await api.unarchiveOrder(Number(button.dataset.unarchive));
    haptic("success");
    toast("Заказ вернулся в список");
  } catch (error) {
    button.disabled = false;
    return toast(errorMessage(error));
  }
  await loadAdminOrders();
  renderOrders();
}

/** После смены статуса заказ переходит в другую вкладку — переходим за ним и показываем его же */
async function showOrder(num) {
  await loadAdminOrders();
  const order = state.adminOrders.find((o) => o.num === num);
  if (order) staffGroup = staffGroupOf(order);
  renderOrders();
  const card = $(`order-${num}`);
  if (!card) return;
  card.scrollIntoView({ block: "start", behavior: "smooth" });
  card.classList.add("flash");
}

/** Почему не получилось вручить — понятным текстом, чтобы было ясно, что чинить */
function deliverError(error) {
  if (error.code === "conflict") return "Заказ уже изменён другим сотрудником";
  if (error.raw?.code === "23514") return "В базе нет статуса «Вручён»: запустите supabase-delivered.sql в Supabase";
  if (error.code === "not_staff") return "Нет прав: войдите как сотрудник по ссылке …/staff.html";
  return errorMessage(error);
}

/** «Вручить»: оплаченный заказ отдан покупателю и переходит во «Вручённые» */
async function markDelivered(button) {
  button.disabled = true;
  button.textContent = "Сохраняем…";
  try {
    await api.markDelivered(Number(button.dataset.deliver));
    haptic("success");
    toast(`Заказ №${button.dataset.deliver} вручён`);
  } catch (error) {
    toast(deliverError(error));
  }
  await showOrder(Number(button.dataset.deliver));
}

/** Почему не получилось отметить оплату */
function payError(error) {
  if (error.code === "conflict") return "Заказ уже изменён другим сотрудником";
  if (error.code === "no_payments") return "Оплаты не настроены: запустите supabase-payments.sql в Supabase";
  if (error.code === "forbidden") return "Нет прав: войдите как сотрудник по ссылке …/staff.html";
  return errorMessage(error);
}

/** «Оплачено»: заказ переходит в «Принятые», способ и сумма сохраняются для аналитики */
async function markPaid(button) {
  const amount = Number(String($("payAmount").value).replace(",", "."));
  openForm.amount = $("payAmount").value;
  const problem = !openForm.method ? "Выберите способ оплаты: наличные или карта" : !(amount > 0) ? "Впишите полученную сумму" : "";
  if (problem) { $("formHint").textContent = problem; return haptic("medium"); }
  button.disabled = true;
  button.textContent = "Сохраняем…";
  try {
    await api.markPaid(Number(button.dataset.paySave), openForm.method, amount);
    haptic("success");
    toast(`Оплачено ${PAY_METHOD[openForm.method]}: ${formatPrice(amount)}`);
    openForm = null;
  } catch (error) {
    button.disabled = false;
    button.textContent = "Оплачено";
    $("formHint").textContent = payError(error);
    return haptic("medium");
  }
  await showOrder(Number(button.dataset.paySave));
}

export function initAdminOrders() {
  $("adminOrdersButton").onclick = () => { haptic(); openAdminOrders(); };
  loadAdminOrders();
  setInterval(() => !document.hidden && loadAdminOrders(), 30000);
  document.addEventListener("visibilitychange", () => !document.hidden && loadAdminOrders());
  // Supabase Realtime: новый или изменённый заказ появляется сразу, без ожидания
  if (useSupabase) watchOrders("staff", async (payload) => {
    await loadAdminOrders();
    if (onChatEvent(payload, "staff")) return;
    if (payload.op === "insert") { haptic("success"); toast(`Новый заказ №${payload.id}`); }
  }, loadAdminOrders);
  on("chatseen", updateOrdersButton);
}
