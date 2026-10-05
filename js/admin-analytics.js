// «Аналитика» (только директор): оформленные заявки за выбранный период, продажи и работа каждого сотрудника.
// Заявка оформлена, когда сотрудник её принял; продажи — сколько по этим заявкам оплачено кнопкой «Оплатить»,
// за вычетом возвратов. Прибыль — продажи минус закупочная цена проданных вещей (если она указана в «Товарах»).
import { $, formatPrice, formatDate, escapeHtml, pluralize, haptic, toast } from "./core.js?v=20261001b";
import { state, api } from "./state.js?v=20261001b";
import { sheetBody, openSheet } from "./nav.js?v=20261001b";

const TABS = [["orders", "Заявки"], ["staff", "Сотрудники"]];
const PERIODS = [["today", "Сегодня"], ["week", "7 дней"], ["month", "Этот месяц"], ["all", "Всё время"], ["custom", "Свой период"]];
const STATUS = { awaiting_payment: "Ждёт оплаты", paid: "Оплачен", delivered: "Вручён", cancelled: "Отменён",
  return_requested: "Просят возврат", returned: "Возврат" };
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
const isPaid = (r) => r.paid != null && ["paid", "delivered", "return_requested", "returned"].includes(r.status);
const net = (r) => (Number(r.paid) || 0) - (Number(r.refund) || 0); // оплачено минус возвращено
/** Себестоимость проданного: вещь, вернувшаяся на склад, не в расходах */
const costOf = (r) => (r.status === "returned" && r.restocked ? 0 : Number(r.cost) || 0);

/** Продажи, прибыль, возвраты и количество заявок */
function summary(list) {
  const paid = list.filter(isPaid), waiting = list.filter((r) => r.status === "awaiting_payment");
  const sum = (items, f) => items.reduce((s, r) => s + (Number(f(r)) || 0), 0);
  const withCost = paid.filter((r) => r.cost != null), returned = list.filter((r) => Number(r.refund) > 0);
  return {
    count: list.length, turnover: sum(paid, net), paidCount: paid.length,
    cash: sum(paid.filter((r) => r.method === "cash"), net), card: sum(paid.filter((r) => r.method === "card"), net),
    waitingCount: waiting.length, waitingSum: sum(waiting, (r) => r.total),
    profit: sum(withCost, (r) => net(r) - costOf(r)), withCost: withCost.length,
    refunds: sum(returned, (r) => r.refund), refundCount: returned.length,
    requests: list.filter((r) => r.status === "return_requested").length,
  };
}

function summaryHtml(list) {
  const s = summary(list);
  return `<div class="an-grid an-top">
      <div class="an-total"><span>Продаж</span><b>${formatPrice(s.turnover)}</b><small>оплачено ${s.paidCount} из ${s.count}</small></div>
      <div class="an-total"><span>Заявок</span><b>${s.count}</b><small>${s.waitingCount ? `ждут оплаты ${s.waitingCount} на ${formatPrice(s.waitingSum)}` : "все оплачены"}</small></div>
      ${s.withCost ? `<div class="an-total"><span>Прибыль</span><b>${formatPrice(Math.round(s.profit))}</b><small>${s.withCost === s.paidCount
        ? `маржа ${s.turnover ? Math.round(s.profit / s.turnover * 100) : 0}%` : `по ${s.withCost} из ${s.paidCount}: у остальных нет закупочной цены`}</small></div>` : ""}
      ${s.refundCount || s.requests ? `<div class="an-total"><span>Возвраты</span><b>${formatPrice(s.refunds)}</b><small>${[
        s.refundCount && `${s.refundCount} ${pluralize(s.refundCount, "заказ", "заказа", "заказов")}`,
        s.requests && `ждут решения ${s.requests}`].filter(Boolean).join(" · ")}</small></div>` : ""}
    </div>
    ${s.turnover ? `<p class="adm-sub an-split">Наличными ${formatPrice(s.cash)} · картой ${formatPrice(s.card)}${
      s.paidCount && !s.withCost ? " · чтобы видеть прибыль, укажите закупочные цены в «Товарах»" : ""}</p>` : ""}`;
}

/** Откуда пришли покупатели заявок за период (ответ при первом заказе или отметка в карточке клиента) */
function sourcesHtml(list) {
  const by = new Map();
  for (const r of list) {
    const key = r.source || "Не указано", item = by.get(key) || { count: 0, sales: 0 };
    item.count++; if (isPaid(r)) item.sales += net(r);
    by.set(key, item);
  }
  if (!list.length || (by.size === 1 && by.has("Не указано"))) return "";
  return `<h3 class="an-h">Откуда клиенты</h3>${[...by].sort((a, b) => (a[0] === "Не указано") - (b[0] === "Не указано") || b[1].sales - a[1].sales)
    .map(([name, v]) => `<div class="an-day"><span><b>${escapeHtml(name)}</b><small>${applications(v.count)}</small></span><span>${formatPrice(v.sales)}</span></div>`).join("")}`;
}

const orderRow = (r, withManager = true) => `<div class="an-day an-order">
  <span><b>№${r.id} · ${formatPrice(Number(isPaid(r) ? net(r) : r.total) || 0)}</b>
    <small>${formatDate(r.at)} · ${escapeHtml(r.customer || "")}</small>
    <small>${isPaid(r) && PAY_METHOD[r.method] ? `${STATUS[r.status]} ${PAY_METHOD[r.method]}` : STATUS[r.status] || ""}${
      Number(r.refund) > 0 ? ` · вернули ${formatPrice(Number(r.refund))}` : ""}</small></span>
  ${withManager ? `<span class="an-mgr">${escapeHtml(r.manager)}</span>` : ""}</div>`;

const ordersList = (list, withManager) => list.length
  ? list.map((r) => orderRow(r, withManager)).join("")
  : `<p class="adm-sub" style="margin-top:12px">За этот период оформленных заявок нет.</p>`;

/** Сотрудники за период: сколько заявок оформил и продажи, больше продаж — выше */
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
    <span>${formatPrice(m.turnover)}<small>продаж ›</small></span></button>`).join("")}
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
    : tab === "orders" ? `${summaryHtml(rows)}${sourcesHtml(rows)}<h3 class="an-h">Заявки</h3>${ordersList(rows, true)}` : staffHtml(rows);
  sheetBody.innerHTML = `<div class="grab"></div><h2 class="p-name">Аналитика</h2>
    <div class="an-tabs" role="tablist">${TABS.map(([id, title]) =>
      `<button class="way" role="tab" data-an-tab="${id}" aria-checked="${id === tab}"><b>${title}</b></button>`).join("")}</div>
    ${periodHtml()}
    ${period === "custom" && !custom ? "" : `<button class="ghost an-export" data-export>Выгрузить в Excel</button>`}
    ${body}`;
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
  if (t.closest("[data-export]")) return exportExcel(t.closest("[data-export]"));
  const staff = t.closest("[data-manager]");
  if (staff) { haptic(); manager = staff.dataset.manager; render(); return $("sheet").scrollTo({ top: 0 }); }
  if (t.closest("[data-manager-back]")) { haptic(); manager = null; return render(); }
}

/** Excel за выбранный период: заказы, позиции и клиенты. Модуль и библиотека грузятся только по нажатию. */
async function exportExcel(button) {
  haptic();
  button.disabled = true;
  button.textContent = "Готовим файл…";
  try {
    const { exportToExcel } = await import("./admin-export.js?v=20261001b");
    const [from, to] = periodRange();
    const done = await exportToExcel(from, to);
    toast(done.csv ? "Скачан файл CSV, он открывается в Excel" : "Файл Excel скачан");
  } catch (error) {
    toast(error?.code === "no_function" ? "Выгрузка не настроена: запустите supabase-crm.sql в Supabase"
      : error?.code === "empty" ? "За этот период заказов нет" : "Не удалось выгрузить. Повторите через минуту.");
  }
  button.disabled = false;
  button.textContent = "Выгрузить в Excel";
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
