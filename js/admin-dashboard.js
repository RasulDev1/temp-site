// «Главная» (директор и менеджеры): дашборд — заявки, продажи, клиенты, способы оплаты и что требует внимания.
// Всё считается из заказов в базе (видимых и скрытых), отдельный SQL не нужен.
import { $, formatPrice, escapeHtml, pluralize, haptic, toast } from "./core.js?v=20261001b";
import { state, api } from "./state.js?v=20261001b";
import { sheetBody, openSheet } from "./nav.js?v=20261001b";

const PERIODS = [["week", "7 дней"], ["month", "30 дней"], ["half", "6 месяцев"]];
const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

let period = "week";
let orders = null, tasks = null, loadError = "", loading = false;

/* ---------- Данные ---------- */
async function load() {
  if (loading) return;
  loading = true;
  try {
    const [active, archived, myTasks] = await Promise.all([
      api.adminOrders(false), api.adminOrders(true).catch(() => ({ orders: [] })),
      api.tasksList ? api.tasksList(false, null).catch(() => null) : null,
    ]);
    const byNum = new Map([...(active.orders || []), ...(archived.orders || [])].map((o) => [o.num, o]));
    orders = [...byNum.values()];
    tasks = myTasks;
    loadError = "";
  } catch (error) {
    loadError = error?.code === "network" ? "Нет связи с базой. Проверьте интернет и повторите." : "Не удалось загрузить данные. Повторите через минуту.";
  }
  loading = false;
  if (state.view === "dashboard") render();
}

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

/** Столбики периода: дни (7 или 30) или месяцы (6). offset = 1 — такой же предыдущий период, для сравнения. */
function buckets(offset = 0) {
  const list = [], now = new Date();
  if (period === "half") {
    for (let i = 5 + offset * 6; i >= offset * 6; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      list.push({ key: monthKey(d), label: MONTHS[d.getMonth()], title: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, month: true });
    }
  } else {
    const days = period === "week" ? 7 : 30;
    for (let i = days - 1 + offset * days; i >= offset * days; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      list.push({ key: dayKey(d), label: days === 7 ? WEEKDAYS[d.getDay()] : String(d.getDate()), title: d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) });
    }
  }
  return list;
}

const bucketOf = (iso, month) => (iso ? (month ? monthKey(new Date(iso)) : dayKey(new Date(iso))) : null);
const isSale = (o) => o.payment && (o.status === "paid" || o.status === "delivered");

/** Показатели по столбикам: заявки (по дате оформления), продажи (по дате оплаты), новые клиенты (по первому заказу) */
function series(offset = 0) {
  const list = buckets(offset), month = list[0].month, index = new Map(list.map((b, i) => [b.key, i]));
  const zero = () => list.map(() => 0);
  const s = { buckets: list, orders: zero(), sales: zero(), cash: zero(), card: zero(), newClients: zero(), buyers: list.map(() => new Set()), clients: new Set() };
  const firstOrder = new Map();
  for (const o of orders) {
    const id = o.user?.id;
    if (id != null && (!firstOrder.has(id) || o.date < firstOrder.get(id))) firstOrder.set(id, o.date);
    const i = index.get(bucketOf(o.date, month));
    if (i != null && o.status !== "rejected") { s.orders[i]++; if (id != null) { s.clients.add(id); s.buyers[i].add(id); } }
    if (isSale(o)) {
      const j = index.get(bucketOf(o.payment.at || o.date, month));
      if (j != null) { s.sales[j] += o.payment.amount; s[o.payment.method === "cash" ? "cash" : "card"][j] += o.payment.amount; }
    }
  }
  for (const date of firstOrder.values()) { const i = index.get(bucketOf(date, month)); if (i != null) s.newClients[i]++; }
  return s;
}

const total = (arr) => arr.reduce((a, b) => a + b, 0);

/* ---------- Графики ---------- */
/** Изменение к прошлому периоду: ▲ 12% / ▼ 5% */
function delta(now, before) {
  if (!before) return now ? `<small class="db-delta up">новое</small>` : `<small class="db-delta">—</small>`;
  const pct = Math.round(((now - before) / before) * 100);
  return `<small class="db-delta ${pct >= 0 ? "up" : "down"}">${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct)}%</small>`;
}

/** Плавная линия через точки (кривые Безье) */
function smoothPath(points) {
  if (points.length < 2) return "";
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i], cx = (x0 + x1) / 2;
    d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  return d;
}

function sparkline(values, color) {
  const w = 120, h = 40, max = Math.max(...values, 1);
  const pts = values.map((v, i) => [(i / Math.max(values.length - 1, 1)) * w, h - 4 - (v / max) * (h - 8)]);
  const line = smoothPath(pts);
  return `<svg class="db-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${line} L${w},${h} L0,${h} Z" fill="${color}" opacity=".12"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

function bars(values, list, kind, format = (v) => v) {
  const max = Math.max(...values, 1), dense = values.length > 12;
  return `<div class="db-bars${dense ? " dense" : ""}">${values.map((v, i) => `<div class="db-bar" title="${escapeHtml(list[i].title)}: ${escapeHtml(format(v))}">
      <i class="${kind}" style="height:${Math.max(v ? 4 : 2, (v / max) * 100)}%"></i>
      <span>${dense && i % 5 !== 4 && i !== values.length - 1 ? "" : list[i].label}</span></div>`).join("")}</div>`;
}

function lineChart(now, before, list) {
  const w = 600, h = 180, max = Math.max(...now, ...before, 1);
  const pts = (values) => values.map((v, i) => [(i / Math.max(values.length - 1, 1)) * w, h - 8 - (v / max) * (h - 16)]);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line x1="0" x2="${w}" y1="${8 + f * (h - 16)}" y2="${8 + f * (h - 16)}" class="db-grid" vector-effect="non-scaling-stroke"/>`).join("");
  const labels = list.map((b, i) => `<span>${list.length > 12 && i % 5 !== 4 && i !== list.length - 1 ? "" : b.label}</span>`).join("");
  return `<div class="db-line">
    <div class="db-yaxis"><span>${formatShort(max)}</span><span>${formatShort(max / 2)}</span><span>0</span></div>
    <div class="db-plot">
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${grid}
        <path d="${smoothPath(pts(before))}" class="db-l2" vector-effect="non-scaling-stroke"/>
        <path d="${smoothPath(pts(now))}" class="db-l1" vector-effect="non-scaling-stroke"/></svg>
      <div class="db-xaxis">${labels}</div>
    </div></div>`;
}

function donut(cash, card) {
  const sum = cash + card, r = 52, c = 2 * Math.PI * r, cardLen = sum ? (card / sum) * c : 0;
  return `<svg class="db-donut" viewBox="0 0 140 140" aria-hidden="true">
    <circle cx="70" cy="70" r="${r}" class="db-ring"/>
    ${sum ? `<circle cx="70" cy="70" r="${r}" class="db-ring cash" stroke-dasharray="${c - cardLen} ${c}" transform="rotate(-90 70 70)"/>
    <circle cx="70" cy="70" r="${r}" class="db-ring card" stroke-dasharray="${cardLen} ${c}" stroke-dashoffset="${-(c - cardLen)}" transform="rotate(-90 70 70)"/>` : ""}
  </svg>`;
}

/** 1 250 000 → «1,3 млн», 48 200 → «48 тыс.» */
function formatShort(v) {
  if (v >= 1e6) return `${(v / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн`;
  if (v >= 1e4) return `${Math.round(v / 1e3).toLocaleString("ru-RU")} тыс.`;
  return Math.round(v).toLocaleString("ru-RU");
}

/* ---------- Экран ---------- */
function greeting() {
  const h = new Date().getHours();
  const hello = h < 5 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
  const name = (state.role?.name || "").trim().split(/\s+/);
  const first = name.length > 1 ? name[1] : name[0]; // «Абуев Расул» → «Расул»
  return `${hello}${first ? `, ${escapeHtml(first)}` : ""}`;
}

function attentionHtml() {
  const fresh = orders.filter((o) => o.status === "new").length;
  const waiting = orders.filter((o) => o.status === "accepted");
  const today = new Date(); today.setHours(23, 59, 59, 999);
  const myTasks = (tasks || []).filter((t) => t.mine && !t.done_at && new Date(t.due) <= today).length;
  const item = (n, label, sub, target) => `<button class="db-alert${n ? " hot" : ""}" data-go="${target}">
    <b>${n}</b><span>${label}</span><small>${sub}</small></button>`;
  return `<div class="db-alerts">
    ${item(fresh, pluralize(fresh, "новая заявка", "новые заявки", "новых заявок"), fresh ? "ждут ответа" : "всё обработано", "adminOrdersButton")}
    ${item(waiting.length, "ждут оплаты", formatPrice(total(waiting.map((o) => o.total))), "adminOrdersButton")}
    ${tasks ? item(myTasks, pluralize(myTasks, "задача", "задачи", "задач"), "на сегодня и просрочено", "adminTasksButton") : ""}
  </div>`;
}

function render() {
  const head = `<div class="db-head">
      <div><h2 class="db-title">${greeting()}</h2>
        <p class="adm-sub">${new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}</p></div>
      <div class="db-tools">
        <div class="db-periods" role="radiogroup" aria-label="Период">${PERIODS.map(([id, title]) =>
          `<button role="radio" aria-checked="${id === period}" data-period="${id}">${title}</button>`).join("")}</div>
        <button class="ghost db-refresh" data-refresh aria-label="Обновить" title="Обновить">↻</button>
      </div></div>`;
  if (!orders) {
    sheetBody.innerHTML = `${head}${loadError ? `<p class="hint">${escapeHtml(loadError)}</p><button class="primary sm" data-refresh>Повторить</button>`
      : `<p class="adm-sub db-loading">Загружаем данные…</p>`}`;
    return;
  }
  const now = series(0), before = series(1), list = now.buckets;
  const sales = total(now.sales), salesBefore = total(before.sales);
  const count = total(now.orders), countBefore = total(before.orders);
  const cash = total(now.cash), card = total(now.card);
  const newClients = total(now.newClients);
  const periodWord = { week: "за 7 дней", month: "за 30 дней", half: "за 6 месяцев" }[period];

  sheetBody.innerHTML = `${head}
    ${loadError ? `<p class="hint">${escapeHtml(loadError)}</p>` : ""}
    ${attentionHtml()}
    <div class="db-grid">
      <section class="db-card db-kpi">
        <div><span class="db-label">Заявки</span><b>${count}</b>${delta(count, countBefore)}</div>${sparkline(now.orders, "var(--accent)")}
      </section>
      <section class="db-card db-kpi">
        <div><span class="db-label">Продаж</span><b>${formatPrice(sales)}</b>${delta(sales, salesBefore)}</div>${sparkline(now.sales, "var(--db-warm)")}
      </section>
      <section class="db-card db-sales">
        <div class="db-card-h"><div><span class="db-label">Продажи по ${period === "half" ? "месяцам" : "дням"}</span><b>${formatPrice(sales)}</b></div><small class="adm-sub">${periodWord}</small></div>
        ${bars(now.sales, list, "violet", formatPrice)}
      </section>
      <section class="db-card db-clients">
        <div class="db-card-h"><div><span class="db-label">Клиенты</span><b>${now.clients.size}</b></div><small class="adm-sub">новых: ${newClients}</small></div>
        ${bars(now.buyers.map((b) => b.size), list, "warm", (v) => `${v} ${pluralize(v, "клиент", "клиента", "клиентов")}`)}
      </section>
      <section class="db-card db-revenue">
        <div class="db-card-h"><div><span class="db-label">Выручка</span><b>${formatPrice(sales)}</b></div>
          <div class="db-legend"><span class="l1">Этот период</span><span class="l2">Прошлый период</span></div></div>
        ${lineChart(now.sales, before.sales, list)}
      </section>
      <section class="db-card db-pay">
        <div class="db-card-h"><div><span class="db-label">Способы оплаты</span><b>${formatPrice(sales)}</b></div></div>
        <div class="db-donut-wrap">${donut(cash, card)}<span>${sales ? `${Math.round((card / sales) * 100)}%<small>картой</small>` : "<small>нет оплат</small>"}</span></div>
        <div class="db-pay-split"><div><b>${formatPrice(cash)}</b><small class="cash">Наличными</small></div><div><b>${formatPrice(card)}</b><small class="card">Картой</small></div></div>
      </section>
    </div>`;
}

export function openDashboard() {
  render();
  sheetBody.onclick = (e) => {
    const p = e.target.closest("[data-period]")?.dataset.period;
    if (p && p !== period) { haptic(); period = p; render(); }
    if (e.target.closest("[data-refresh]")) { haptic(); orders ? load().then(() => toast("Данные обновлены")) : load(); }
    const go = e.target.closest("[data-go]")?.dataset.go;
    if (go) $(go)?.click();
  };
  sheetBody.oninput = null;
  sheetBody.onchange = null;
  openSheet("dashboard");
  load();
}

export function initDashboard() {
  $("adminHomeButton").onclick = () => { haptic(); openDashboard(); };
}
