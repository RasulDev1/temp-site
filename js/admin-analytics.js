// «Аналитика» (только директор): сколько оплатили наличными и картой за период и сколько оформил каждый менеджер.
// Данные — из кнопки «Оплатить» у менеджера (способ и сумма сохраняются в заказе, supabase-payments.sql).
import { $, formatPrice, escapeHtml, pluralize, haptic } from "./core.js?v=20261001b";
import { state, api } from "./state.js?v=20261001b";
import { sheetBody, openSheet } from "./nav.js?v=20261001b";

const PERIODS = [["today", "Сегодня"], ["week", "7 дней"], ["month", "Этот месяц"], ["all", "Всё время"]];
let period = "today";
let stats = null;
let loadError = "";

const ERRORS = {
  no_function: "Аналитика не настроена: в Supabase нужно запустить supabase-payments.sql",
  forbidden: "Аналитику видит только директор",
  network: "Нет связи с базой. Проверьте интернет и повторите.",
};

/** Дата "ГГГГ-ММ-ДД" по Москве — так же считает база */
const moscowDay = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(date);
function periodRange(id) {
  const today = moscowDay(new Date());
  if (id === "today") return [today, today];
  if (id === "week") return [moscowDay(new Date(Date.now() - 6 * 864e5)), today];
  if (id === "month") return [today.slice(0, 8) + "01", today];
  return [null, null];
}

const applications = (n) => `${n} ${pluralize(n, "заявку", "заявки", "заявок")}`;
const orders = (n) => `${n} ${pluralize(n, "заказ", "заказа", "заказов")}`;
const dayTitle = (day) => new Date(day + "T12:00:00").toLocaleDateString("ru-RU", { day: "numeric", month: "long", weekday: "short" });

function render() {
  if (state.view !== "analytics") return;
  const s = stats && { cash: Number(stats.cash_sum) || 0, card: Number(stats.card_sum) || 0,
    cashN: Number(stats.cash_count) || 0, cardN: Number(stats.card_count) || 0, days: stats.days || [], managers: stats.managers || [] };
  sheetBody.innerHTML = `<div class="grab"></div><h2 class="p-name">Аналитика</h2>
    <p class="adm-sub">Оплаты, которые менеджеры отметили кнопкой «Оплатить», и работа каждого менеджера.</p>
    <div class="order-groups" role="tablist">${PERIODS.map(([id, title]) =>
      `<button class="chip" role="tab" data-period="${id}" aria-pressed="${id === period}">${title}</button>`).join("")}</div>
    ${loadError ? `<p class="hint">${loadError}</p>` : !s ? `<p class="adm-sub">Загружаем…</p>` : `
    <div class="an-total"><span>Получено всего</span><b>${formatPrice(s.cash + s.card)}</b><small>${orders(s.cashN + s.cardN)}</small></div>
    <div class="an-grid">
      <div class="an-card"><span>Наличные</span><b>${formatPrice(s.cash)}</b><small>${orders(s.cashN)}</small></div>
      <div class="an-card"><span>Карта</span><b>${formatPrice(s.card)}</b><small>${orders(s.cardN)}</small></div>
    </div>
    ${s.managers.length ? `<h3 class="an-h">По менеджерам</h3>${s.managers.map((m) => `<div class="an-day">
      <span>${escapeHtml(m.name)}<small>оформил ${applications(Number(m.orders))}</small></span>
      <span>${formatPrice(Number(m.sales))}<small>${m.paid ? `продажи · ${orders(Number(m.paid))} оплачено` : "оплат пока нет"}</small></span></div>`).join("")}
      <p class="adm-sub" style="margin-top:8px">Заявка засчитывается менеджеру, который её принял и отправил реквизиты. Продажи — сколько оплачено по его заявкам за период.</p>` : ""}
    ${s.days.length > 1 ? `<h3 class="an-h">По дням</h3>${s.days.map((d) => `<div class="an-day">
      <span>${escapeHtml(dayTitle(d.day))}</span>
      <span>${formatPrice(Number(d.cash) + Number(d.card))}<small>нал. ${formatPrice(Number(d.cash))} · карта ${formatPrice(Number(d.card))}</small></span></div>`).join("")}`
      : s.cashN + s.cardN ? "" : `<p class="adm-sub" style="margin-top:12px">За этот период оплат нет.</p>`}`}`;
}

async function load() {
  stats = null;
  loadError = "";
  render();
  const requested = period;
  try {
    const data = await api.paymentsStats(...periodRange(period));
    if (requested === period) stats = data;
  } catch (error) {
    if (requested === period) loadError = ERRORS[error?.code] || "Не удалось загрузить. Повторите через минуту.";
  }
  render();
}

export function openAnalytics() {
  sheetBody.onclick = (e) => {
    const id = e.target.closest("[data-period]")?.dataset.period;
    if (!id || id === period) return;
    haptic();
    period = id;
    load();
  };
  openSheet("analytics");
  load();
}

export function initAnalytics() {
  $("adminAnalyticsButton").onclick = () => { haptic(); openAnalytics(); };
}
