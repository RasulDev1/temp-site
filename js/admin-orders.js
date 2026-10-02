// Администратор: заказы. Принять и отправить реквизиты для оплаты или отказать, если товара нет.
import { $, formatPrice, formatDate, escapeHtml, pluralize, haptic, toast, storage, on } from "./core.js?v=20261001b";
import { state, api, errorMessage, useSupabase } from "./state.js?v=20261001b";
import { watchOrders } from "./supabase.js?v=20261001b";
import { refreshCatalog } from "./catalog.js?v=20261001b";
import { orderItemsHtml, paymentDetails } from "./cart.js?v=20261001b";
import { sheetBody, openSheet } from "./nav.js?v=20261001b";
import { chatButtonHtml, openChat, onChatEvent, hasUnread } from "./chat.js?v=20261001b";

const STATUS = { new: "Новый", accepted: "Ждёт оплаты", paid: "Оплачен", rejected: "Отказ" };
let openForm = null; // { num, type: "accept" | "reject", text, note }
let showArchived = false; // смотрим скрытые заказы
let archived = [];        // скрытые заказы, когда их открыли
let archivedCount = 0;
let canArchive = false;   // в базе настроены скрытые заказы

const newOrdersCount = () => state.adminOrders.filter((o) => o.status === "new").length;
const rejectionText = (num) =>
  `Здравствуйте! К сожалению, товара из заказа №${num} сейчас нет в наличии. Приносим извинения. Будем рады видеть вас снова в ТЕМП.`;

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
  button.textContent = (n ? `Заказы · ${n} ${pluralize(n, "новый", "новых", "новых")}` : "Заказы") + (chats ? ` · 💬 ${chats}` : "");
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
  if (openForm?.num !== o.num) return o.status === "new"
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

function decisionResultHtml(o) {
  if (o.status === "new") return "";
  return `<div class="ord-res">
    <p>${o.status === "rejected" ? `Отказ: «${escapeHtml(o.message)}»`
      : `${o.status === "paid" ? "Оплачен" : "Принят"}. Реквизиты для оплаты:<span class="req-t">${escapeHtml(paymentDetails(o))}</span>`}</p>
    ${o.status === "accepted" && api.markPaid ? `<div class="ord-actions"><button class="primary sm" data-paid="${o.num}">Оплата получена</button></div>` : ""}
    <p class="adm-sub">${useSupabase ? "Покупатель видит статус и реквизиты во вкладке «Мои заказы»."
      : o.delivered ? "Сообщение доставлено покупателю в Telegram."
      : "Сообщение не доставлено: покупатель не разрешил боту писать ему. Напишите ему сами, контакты выше."}</p>
    ${useSupabase ? chatButtonHtml(o, "staff") : ""}</div>`;
}

const orderHtml = (o) => `<article class="ord st-${o.status}" id="order-${o.num}">
  <div class="ord-top"><b>№${o.num}</b><span class="ord-st">${STATUS[o.status]}</span><time>${formatDate(o.date)}</time></div>
  <p class="ord-who">${escapeHtml(o.name)}</p>
  ${contactsHtml(o)}
  <p class="ord-way">${escapeHtml(o.way)}${o.addr ? ": " + escapeHtml(o.addr) : ""}</p>
  ${orderItemsHtml(o)}
  <p class="ord-sum">Итого <b>${formatPrice(Number(o.total) || 0)}</b></p>
  ${showArchived ? `<div class="ord-res">${useSupabase ? chatButtonHtml(o, "staff") : ""}
    <button class="ghost" data-unarchive="${o.num}" style="width:100%">Вернуть в список</button></div>`
    : `${decisionFormHtml(o)}${decisionResultHtml(o)}`}
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
  sheetBody.innerHTML = `<div class="grab"></div><h2 class="p-name">Заказы</h2>
    <p class="adm-sub">${state.adminOrders.length
      ? `${n ? `${n} ${pluralize(n, "новый заказ ждёт", "новых заказа ждут", "новых заказов ждут")} решения.` : "Новых заказов нет."} Принятый заказ — покупатель получает реквизиты для оплаты, отказ — сообщение, товар возвращается на склад.`
      : "Заказов пока нет. Когда покупатель оформит заказ, он появится здесь."}</p>
    ${listToolsHtml()}${state.adminOrders.map(orderHtml).join("")}`;
}

export function openAdminOrders(focusNum) {
  openForm = null;
  showArchived = false;
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
  if (t.hasAttribute("data-clear")) return clearList(t);
  if (t.hasAttribute("data-show-archived")) return switchList(true);
  if (t.hasAttribute("data-show-active")) return switchList(false);
  if (t.dataset.unarchive) return unarchive(t);
  if (t.dataset.accept) openForm = { num: Number(t.dataset.accept), type: "accept", text: storage.get("temp_last_pay", "") };
  else if (t.dataset.reject) openForm = { num: Number(t.dataset.reject), type: "reject", text: rejectionText(t.dataset.reject) };
  else if (t.hasAttribute("data-cancel")) openForm = null;
  else if (t.dataset.send) return sendDecision(t);
  else if (t.dataset.paid) return markPaid(t);
  else return;
  renderOrders();
  $("formText")?.focus();
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
    openForm = null;
    await loadAdminOrders();
    renderOrders();
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

async function markPaid(button) {
  button.disabled = true;
  button.textContent = "Сохраняем…";
  try {
    await api.markPaid(Number(button.dataset.paid));
    haptic("success");
    toast("Отмечено: оплачен");
  } catch (error) {
    toast(errorMessage(error));
  }
  await loadAdminOrders();
  renderOrders();
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
