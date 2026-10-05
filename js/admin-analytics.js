// «Аналитика» (только директор): оформленные заявки за выбранный период, оборот и работа каждого сотрудника.
// Заявка оформлена, когда сотрудник её принял; оборот — сколько по этим заявкам оплачено кнопкой «Оплатить».
import { $, formatPrice, formatDate, escapeHtml, pluralize, haptic } from "./core.js?v=20261001b";
import { state, api } from "./state.js?v=20261001b";
import { sheetBody, openSheet } from "./nav.js?v=20261001b";

const TABS = [["orders", "Заявки"], ["staff", "Сотрудники"]];
const PERIODS = [["today", "Сегодня"], ["week", "7 дней"], ["month", "Этот месяц"], ["all", "Всё время"], ["custom", "Свой период"]];
const STATUS = { awaiting_payment: "Ждёт оплаты", paid: "Оплачен", delivered: "Вручён", cancelled: "Отменён" };
const PAY_METHOD = { cash: "наличными", card: "картой" };

let tab = "orders";
let period = "today";
let custom = null;     // { from, to } — свой период, "ГГГГ-ММ-ДД"
let manager = null;    // открытый сотрудник во вкладке «Сотрудники»
let rows = null;       // заявки за период
let loadError = "";

const ERRORS = {
  no_function: "Аналитика не настроена: в Supabase нужно запустить supabase-payments.sql",
  forbidden: "Аналитику видит только директор",
  network: "Нет связи с базой. Проверьте интернет и повторите.",
};

/** Дата "ГГГГ-ММ-ДД" по Москве — так же считает база */
const moscowDay = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(date);
function periodRange() {
  const today = moscowDay(new Date());
  if (period === "today") return [today, today];
  if (period === "week") return [moscowDay(new Date(Date.now() - 6 * 864e5)), today];
  if (period === "month") return [today.slice(0, 8) + "01", today];
  if (period === "custom") return [custom?.from || null, custom?.to || null];
  return [null, null];
}

const applications = (n) => `${n} ${pluralize(n, "заявка", "заявки", "заявок")}`;
const isPaid = (r) => r.paid != null && (r.status === "paid" || r.status === "delivered");

/** Оборот и количество заявок */
function summary(list) {
  const paid = list.filter(isPaid), waiting = list.filter((r) => r.status === "awaiting_payment");
  const sum = (items, key) => items.reduce((s, r) => s + (Number(r[key]) || 0), 0);
  return {
    count: list.length, turnover: sum(paid, "paid"), paidCount: paid.length,
    cash: sum(paid.filter((r) => r.method === "cash"), "paid"), card: sum(paid.filter((r) => r.method === "card"), "paid"),
    waitingCount: waiting.length, waitingSum: sum(waiting, "total"),
  };
}

function summaryHtml(list) {
  const s = summary(list);
  return `<div class="an-grid an-top">
      <div class="an-total"><span>Оборот</span><b>${formatPrice(s.turnover)}</b><small>оплачено ${s.paidCount} из ${s.count}</small></div>
      <div class="an-total"><span>Заявок</span><b>${s.count}</b><small>${s.waitingCount ? `ждут оплаты ${s.waitingCount} на ${formatPrice(s.waitingSum)}` : "все оплачены"}</small></div>
    </div>
    ${s.turnover ? `<p class="adm-sub an-split">Наличными ${formatPrice(s.cash)} · картой ${formatPrice(s.card)}</p>` : ""}`;
}

const orderRow = (r, withManager = true) => `<div class="an-day an-order">
  <span><b>№${r.id} · ${formatPrice(Number(isPaid(r) ? r.paid : r.total) || 0)}</b>
    <small>${formatDate(r.at)} · ${escapeHtml(r.customer || "")}</small>
    <small>${isPaid(r) && PAY_METHOD[r.method] ? `${STATUS[r.status]} ${PAY_METHOD[r.method]}` : STATUS[r.status] || ""}</small></span>
  ${withManager ? `<span class="an-mgr">${escapeHtml(r.manager)}</span>` : ""}</div>`;

const ordersList = (list, withManager) => list.length
  ? list.map((r) => orderRow(r, withManager)).join("")
  : `<p class="adm-sub" style="margin-top:12px">За этот период оформленных заявок нет.</p>`;

/** Сотрудники за период: сколько заявок оформил и оборот, больше оборот — выше */
function managersOf(list) {
  const byName = new Map();
  for (const r of list) byName.set(r.manager, [...(byName.get(r.manager) || []), r]);
  return [...byName].map(([name, items]) => ({ name, items, ...summary(items) }))
    .sort((a, b) => b.turnover - a.turnover || b.count - a.count);
}

function staffHtml(list) {
  const managers = managersOf(list);
  const open = manager && managers.find((m) => m.name === manager);
  if (open) return `<button class="link an-back" data-manager-back>← Все сотрудники</button>
    <h3 class="an-h">${escapeHtml(open.name)}</h3>${summaryHtml(open.items)}${ordersList(open.items, false)}`;
  if (!managers.length) return `<p class="adm-sub" style="margin-top:12px">За этот период оформленных заявок нет.</p>`;
  return `${summaryHtml(list)}${managers.map((m) => `<button class="an-day an-staff" data-manager="${escapeHtml(m.name)}">
    <span><b>${escapeHtml(m.name)}</b><small>оформил ${applications(m.count)}</small></span>
    <span>${formatPrice(m.turnover)}<small>оборот ›</small></span></button>`).join("")}
    <p class="adm-sub" style="margin-top:8px">Заявка засчитывается сотруднику, который её принял и отправил реквизиты.</p>`;
}

function periodHtml() {
  return `<div class="order-groups" role="tablist">${PERIODS.map(([id, title]) =>
      `<button class="chip" role="tab" data-period="${id}" aria-pressed="${id === period}">${title}</button>`).join("")}</div>
    ${period === "custom" ? `<div class="an-range">
      <label class="field"><span>С</span><input type="date" id="anFrom" value="${custom?.from || ""}" max="${moscowDay(new Date())}"></label>
      <label class="field"><span>По</span><input type="date" id="anTo" value="${custom?.to || ""}" max="${moscowDay(new Date())}"></label>
      <button class="primary sm" data-range-apply>Показать</button></div>
      <p class="hint" id="anHint"></p>` : ""}`;
}

function render() {
  if (state.view !== "analytics") return;
  const body = loadError ? `<p class="hint">${loadError}</p>`
    : period === "custom" && !custom ? `<p class="adm-sub">Выберите даты и нажмите «Показать».</p>`
    : !rows ? `<p class="adm-sub">Загружаем…</p>`
    : tab === "orders" ? `${summaryHtml(rows)}${ordersList(rows, true)}` : staffHtml(rows);
  sheetBody.innerHTML = `<div class="grab"></div><h2 class="p-name">Аналитика</h2>
    <div class="an-tabs" role="tablist">${TABS.map(([id, title]) =>
      `<button class="way" role="tab" data-an-tab="${id}" aria-checked="${id === tab}"><b>${title}</b></button>`).join("")}</div>
    ${periodHtml()}${body}`;
}

async function load() {
  rows = null;
  loadError = "";
  render();
  if (period === "custom" && !custom) return;
  const key = JSON.stringify([period, custom]);
  try {
    const data = await api.analyticsOrders(...periodRange());
    if (key === JSON.stringify([period, custom])) rows = Array.isArray(data) ? data : [];
  } catch (error) {
    if (key === JSON.stringify([period, custom])) loadError = ERRORS[error?.code] || "Не удалось загрузить. Повторите через минуту.";
  }
  render();
}

function applyRange() {
  const from = $("anFrom").value, to = $("anTo").value;
  if (!from || !to) { $("anHint").textContent = "Выберите обе даты"; return haptic("medium"); }
  custom = from <= to ? { from, to } : { from: to, to: from };
  haptic();
  load();
}

function onClick(e) {
  const t = e.target;
  const tabButton = t.closest("[data-an-tab]");
  if (tabButton) {
    if (tabButton.dataset.anTab === tab) return;
    haptic(); tab = tabButton.dataset.anTab; manager = null; return render();
  }
  const id = t.closest("[data-period]")?.dataset.period;
  if (id) {
    if (id === period) return;
    haptic(); period = id;
    return load(); // «Свой период» без дат — сначала покажет выбор дат
  }
  if (t.closest("[data-range-apply]")) return applyRange();
  const staff = t.closest("[data-manager]");
  if (staff) { haptic(); manager = staff.dataset.manager; render(); return $("sheet").scrollTo({ top: 0 }); }
  if (t.closest("[data-manager-back]")) { haptic(); manager = null; return render(); }
}

export function openAnalytics() {
  manager = null;
  sheetBody.onclick = onClick;
  openSheet("analytics");
  load();
}

export function initAnalytics() {
  $("adminAnalyticsButton").onclick = () => { haptic(); openAnalytics(); };
}
