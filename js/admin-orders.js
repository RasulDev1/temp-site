// Администратор: заказы. Принять и отправить реквизиты для оплаты или отказать, если товара нет.
import { $, formatPrice, formatDate, escapeHtml, pluralize, haptic, toast, storage, openLink } from "./core.js?v=20261001b";
import { state, api, errorMessage, useSupabase } from "./state.js?v=20261001b";
import { watchOrders } from "./supabase.js?v=20261001b";
import { refreshCatalog } from "./catalog.js?v=20261001b";
import { orderItemsHtml, paymentDetails } from "./cart.js?v=20261001b";
import { sheetBody, openSheet } from "./nav.js?v=20261001b";

const STATUS = { new: "Новый", accepted: "Ждёт оплаты", paid: "Оплачен", rejected: "Отказ" };
let openForm = null; // { num, type: "accept" | "reject", text, note }

const newOrdersCount = () => state.adminOrders.filter((o) => o.status === "new").length;
const rejectionText = (num) =>
  `Здравствуйте! К сожалению, товара из заказа №${num} сейчас нет в наличии. Приносим извинения. Будем рады видеть вас снова в ТЕМП.`;

export async function loadAdminOrders() {
  try {
    const { orders = [] } = await api.adminOrders();
    state.adminOrders = orders.sort((a, b) => (b.status === "new") - (a.status === "new") || b.num - a.num);
    updateOrdersButton();
    if (state.view === "adminOrders" && !openForm) renderOrders();
  } catch {}
}

function updateOrdersButton() {
  const n = newOrdersCount(), button = $("adminOrdersButton");
  button.textContent = n ? `Заказы · ${n} ${pluralize(n, "новый", "новых", "новых")}` : "Заказы";
  button.classList.toggle("has-new", n > 0);
}

/** Ссылка на покупателя: по имени пользователя, по Telegram ID или телефону */
function customerLink({ user = {}, phone }) {
  if (user.username) return [`https://t.me/${encodeURIComponent(user.username)}`, `Написать покупателю @${escapeHtml(user.username)}`];
  if (user.id) return [`tg://user?id=${Number(user.id)}`, "Открыть покупателя в Telegram"];
  return phone ? [`tel:${String(phone).replace(/[^+\d]/g, "")}`, "Позвонить покупателю"] : null;
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
  const link = customerLink(o);
  return `<div class="ord-res">
    <p>${o.status === "rejected" ? `Отказ: «${escapeHtml(o.message)}»`
      : `${o.status === "paid" ? "Оплачен" : "Принят"}. Реквизиты для оплаты:<span class="req-t">${escapeHtml(paymentDetails(o))}</span>`}</p>
    ${o.status === "accepted" && api.markPaid ? `<div class="ord-actions"><button class="primary sm" data-paid="${o.num}">Оплата получена</button></div>` : ""}
    <p class="adm-sub">${useSupabase ? "Покупатель видит статус и реквизиты во вкладке «Мои заказы»."
      : o.delivered ? "Сообщение доставлено покупателю в Telegram."
      : "Сообщение не доставлено: покупатель не разрешил боту писать ему. Напишите ему сами по ссылке ниже."}</p>
    ${link ? `<a class="ord-link" href="${link[0]}" data-customer-link>${link[1]}</a>` : ""}</div>`;
}

const orderHtml = (o) => `<article class="ord st-${o.status}" id="order-${o.num}">
  <div class="ord-top"><b>№${o.num}</b><span class="ord-st">${STATUS[o.status]}</span><time>${formatDate(o.date)}</time></div>
  <p class="ord-who">${escapeHtml(o.name)}, ${escapeHtml(o.phone)}</p>
  <p class="ord-way">${escapeHtml(o.way)}${o.addr ? ": " + escapeHtml(o.addr) : ""}</p>
  ${orderItemsHtml(o)}
  <p class="ord-sum">Итого <b>${formatPrice(Number(o.total) || 0)}</b></p>
  ${decisionFormHtml(o)}${decisionResultHtml(o)}
</article>`;

function renderOrders() {
  const n = newOrdersCount();
  sheetBody.innerHTML = `<div class="grab"></div><h2 class="p-name">Заказы</h2>
    <p class="adm-sub">${state.adminOrders.length
      ? `${n ? `${n} ${pluralize(n, "новый заказ ждёт", "новых заказа ждут", "новых заказов ждут")} решения.` : "Новых заказов нет."} Принятый заказ — покупатель получает реквизиты для оплаты, отказ — сообщение, товар возвращается на склад.`
      : "Заказов пока нет. Когда покупатель оформит заказ, он появится здесь."}</p>
    ${state.adminOrders.map(orderHtml).join("")}`;
}

export function openAdminOrders(focusNum) {
  openForm = null;
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
  const link = t.closest("[data-customer-link]");
  if (link) { e.preventDefault(); return openLink(link.href); }
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
  if (useSupabase) watchOrders("staff", async ({ id, op }) => {
    await loadAdminOrders();
    if (op === "insert") { haptic("success"); toast(`Новый заказ №${id}`); }
  }, loadAdminOrders);
}
