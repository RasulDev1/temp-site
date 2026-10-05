// «Клиенты» (директор и менеджеры): покупатели из заказов, карточка с историей покупок, заметками и метками.
// Покупатель — это Telegram-аккаунт, с которого оформлены заказы; отдельно заводить клиентов не нужно.
import { $, formatPrice, formatDate, orderDate, escapeHtml, pluralize, haptic, toast } from "./core.js?v=20261001b";
import { state, api } from "./state.js?v=20261001b";
import { sheetBody, openSheet } from "./nav.js?v=20261001b";
import { orderItemsHtml } from "./cart.js?v=20261001b";
import { openAdminOrders } from "./admin-orders.js?v=20261001b";
import { openTaskForm, tasksListHtml, handleTaskTap, deleteTask } from "./admin-tasks.js?v=20261001b";

const TAGS = ["Постоянный", "VIP", "Опт", "Проблемный"];
const SORTS = [["recent", "Недавние"], ["spent", "Больше купили"], ["sleeping", "Давно не покупали"]];
const STATUS = { new: "Новый", awaiting_payment: "Ждёт оплаты", paid: "Оплачен", delivered: "Вручён", cancelled: "Отменён" };
const PAY_METHOD = { cash: "наличными", card: "картой" };
const ERRORS = {
  no_function: "Клиенты не настроены: в Supabase нужно запустить supabase-customers.sql",
  forbidden: "Нет прав: войдите как сотрудник по ссылке …/crm.html",
  network: "Нет связи с базой. Проверьте интернет и повторите.",
};
const errorText = (error) => ERRORS[error?.code] || "Не удалось загрузить. Повторите через минуту.";

let customers = null, listError = "";
let query = "", sort = "recent";
let open = null;     // { id, card, tasks, error, back } — открытая карточка
let noteDraft = "";

const ordersWord = (n) => `${n} ${pluralize(n, "заказ", "заказа", "заказов")}`;
const daysAgo = (iso) => Math.floor((Date.now() - new Date(iso)) / 864e5);
const lastSeen = (iso) => { const d = daysAgo(iso); return d < 1 ? "сегодня" : d < 2 ? "вчера" : `${d} ${pluralize(d, "день", "дня", "дней")} назад`; };
const findCustomer = (id) => customers?.find((c) => Number(c.id) === Number(id));

/* ---------- Список ---------- */
function sorted() {
  const q = query.trim().toLowerCase(), digits = q.replace(/\D/g, "");
  const list = (customers || []).filter((c) => !q || (c.name || "").toLowerCase().includes(q)
    || (c.username || "").toLowerCase().includes(q.replace(/^@/, "")) || (digits.length >= 3 && (c.phone || "").replace(/\D/g, "").includes(digits)));
  const by = { recent: (a, b) => new Date(b.last_at) - new Date(a.last_at), spent: (a, b) => b.spent - a.spent || b.orders - a.orders,
    sleeping: (a, b) => (b.bought > 0) - (a.bought > 0) || new Date(a.last_at) - new Date(b.last_at) };
  return list.sort(by[sort]);
}

const tagsHtml = (tags = []) => tags.length ? `<span class="cl-tags">${tags.map((t) => `<i>${escapeHtml(t)}</i>`).join("")}</span>` : "";

const customerRow = (c) => `<button class="an-day an-staff cl-row" data-customer="${Number(c.id)}">
  <span><b>${escapeHtml(c.name || "Без имени")}</b>${tagsHtml(c.tags)}
    <small>${escapeHtml(c.phone || (c.username ? "@" + c.username : ""))}</small>
    <small>${ordersWord(Number(c.orders))} · последний ${lastSeen(c.last_at)}${c.notes ? ` · 📝${c.notes}` : ""}</small></span>
  <span>${formatPrice(Number(c.spent) || 0)}<small>купил на ›</small></span></button>`;

function renderList() {
  if (state.view !== "customers" || open) return;
  const list = customers && sorted();
  const body = listError ? `<p class="hint">${listError}</p>` : !customers ? `<p class="adm-sub">Загружаем…</p>`
    : !customers.length ? `<p class="adm-sub" style="margin-top:12px">Клиентов пока нет. Они появятся с первыми заказами.</p>`
    : list.length ? list.map(customerRow).join("") : `<p class="adm-sub" style="margin-top:12px">Никого не нашли.</p>`;
  const searchFocused = document.activeElement?.id === "clSearch";
  sheetBody.innerHTML = `<div class="grab"></div><h2 class="p-name">Клиенты${customers?.length ? ` · ${customers.length}` : ""}</h2>
    <p class="adm-sub">Все, кто оформлял заказы. Нажмите на клиента, чтобы открыть карточку: его покупки, заметки и метки.</p>
    <label class="field"><input id="clSearch" type="search" placeholder="Поиск: ФИО, телефон или @логин" value="${escapeHtml(query)}"></label>
    <div class="order-groups" role="tablist">${SORTS.map(([id, title]) =>
      `<button class="chip" role="tab" data-sort="${id}" aria-pressed="${id === sort}">${title}</button>`).join("")}</div>
    <div id="clList">${body}</div>`;
  $("clSearch").oninput = (e) => { query = e.target.value; $("clList").innerHTML = (sorted().map(customerRow).join("")) || `<p class="adm-sub" style="margin-top:12px">Никого не нашли.</p>`; };
  if (searchFocused) { const input = $("clSearch"); input.focus(); input.setSelectionRange(query.length, query.length); }
}

async function loadList() {
  try {
    customers = (await api.customersList()) || [];
    listError = "";
  } catch (error) {
    listError = errorText(error);
  }
  renderList();
}

/* ---------- Карточка ---------- */
const contactLinks = (c) => [
  c.phone && `<a class="ghost cl-btn" href="tel:${escapeHtml(c.phone.replace(/[^\d+]/g, ""))}">Позвонить</a>`,
  `<a class="ghost cl-btn" href="${c.username ? `https://t.me/${encodeURIComponent(c.username)}` : `tg://user?id=${Number(c.id)}`}" target="_blank" rel="noopener">Написать в Telegram</a>`,
].filter(Boolean).join("");

const cardOrderHtml = (o) => `<article class="ord st-${o.status === "awaiting_payment" ? "accepted" : o.status === "cancelled" ? "rejected" : o.status}">
  <div class="ord-top"><b>№${o.id}</b><span class="ord-st">${STATUS[o.status] || ""}</span><time>${formatDate(o.at)}</time></div>
  ${orderItemsHtml(o)}
  <p class="ord-way">${escapeHtml(o.way || "")}${o.addr ? ": " + escapeHtml(o.addr) : ""}</p>
  <p class="ord-sum">Итого <b>${formatPrice(Number(o.total) || 0)}</b></p>
  ${o.paid != null ? `<p class="ord-pay">Оплачено ${PAY_METHOD[o.method] || ""} · <b>${formatPrice(Number(o.paid))}</b></p>` : ""}
  ${o.manager ? `<p class="adm-sub">Менеджер: ${escapeHtml(o.manager)}</p>` : ""}
  <button class="link" data-open-order="${o.id}">Открыть в «Заказах»</button></article>`;

function renderCard() {
  if (state.view !== "customers" || !open) return;
  const c = findCustomer(open.id) || { id: open.id, name: open.card?.orders?.[0]?.name, phone: open.card?.orders?.[0]?.phone, tags: [] };
  const card = open.card, orders = card?.orders || [];
  const bought = orders.filter((o) => o.status === "paid" || o.status === "delivered");
  const spent = bought.reduce((s, o) => s + (Number(o.paid ?? o.total) || 0), 0);
  const tags = card?.tags || c.tags || [];
  sheetBody.innerHTML = `<div class="grab"></div>
    <button class="link an-back" data-back>← ${open.back ? "К заказу" : "Все клиенты"}</button>
    <h2 class="p-name">${escapeHtml(c.name || "Клиент")}</h2>
    <dl class="ord-contacts">
      ${c.phone ? `<dt>Телефон</dt><dd>${escapeHtml(c.phone)}</dd>` : ""}
      <dt>Telegram</dt><dd>${c.username ? "@" + escapeHtml(c.username) : `ID ${Number(c.id)}`}</dd></dl>
    <div class="ord-actions">${contactLinks(c)}</div>
    ${open.error ? `<p class="hint">${open.error}</p>` : !card ? `<p class="adm-sub">Загружаем…</p>` : `
    <div class="an-grid an-top">
      <div class="an-total"><span>Купил на</span><b>${formatPrice(spent)}</b><small>${bought.length ? `средний чек ${formatPrice(Math.round(spent / bought.length))}` : "оплаченных заказов нет"}</small></div>
      <div class="an-total"><span>Заказов</span><b>${orders.length}</b><small>${orders.length ? `первый ${orderDate(orders[orders.length - 1].at)}` : ""}</small></div>
    </div>
    <h3 class="an-h">Метки</h3>
    <div class="cl-tagbar">${[...new Set([...TAGS, ...tags])].map((t) =>
      `<button class="cl-tag" data-tag="${escapeHtml(t)}" aria-pressed="${tags.includes(t)}">${escapeHtml(t)}</button>`).join("")}</div>
    ${open.tasks ? `<h3 class="an-h">Задачи</h3>
    ${tasksListHtml(open.tasks.filter((t) => !t.done_at || daysAgo(t.done_at) < 3))}
    <button class="ghost" data-customer-task>Поставить задачу</button>` : ""}
    <h3 class="an-h">Заметки</h3>
    <label class="field"><textarea id="clNote" maxlength="1000" placeholder="Например: носит размер L, просил звонить после 18:00">${escapeHtml(noteDraft)}</textarea></label>
    <p class="hint" id="clHint"></p>
    <button class="primary sm" data-note-add>Добавить заметку</button>
    ${card.notes.map((n) => `<div class="cl-note"><p>${escapeHtml(n.body)}</p>
      <small>${escapeHtml(n.author || "")}${n.author ? ", " : ""}${formatDate(n.at)} · <button class="link" data-note-del="${n.id}">Удалить</button></small></div>`).join("")}
    <h3 class="an-h">Заказы</h3>
    ${orders.map(cardOrderHtml).join("")}`}`;
}

async function loadCard() {
  const id = open.id;
  try {
    const [card, tasks] = await Promise.all([api.customerCard(id), api.tasksList(false, id).catch(() => null)]);
    if (open?.id === id) { open.card = card; open.tasks = tasks; open.error = ""; }
  } catch (error) {
    if (open?.id === id) open.error = errorText(error);
  }
  renderCard();
}

/** Открыть карточку клиента. back — вернуться к заказу (из «Заказов»), иначе к списку клиентов. */
export function openCustomer(id, back = null) {
  open = { id: Number(id), card: null, tasks: null, error: "", back };
  noteDraft = "";
  sheetBody.onclick = onClick;
  openSheet("customers", back || closeCard);
  renderCard();
  $("sheet").scrollTop = 0;
  loadCard();
  if (!customers) loadList();
}

function closeCard() {
  open = null;
  openSheet("customers");
  renderList();
  $("sheet").scrollTop = 0;
  loadList(); // заметки и метки могли поменяться
}

async function toggleTag(button) {
  const tag = button.dataset.tag, tags = new Set(open.card.tags || []);
  tags.has(tag) ? tags.delete(tag) : tags.add(tag);
  const next = [...tags];
  haptic();
  button.setAttribute("aria-pressed", tags.has(tag));
  try {
    await api.customerTagsSet(open.id, next);
    open.card.tags = next;
    const c = findCustomer(open.id);
    if (c) c.tags = next;
  } catch (error) {
    button.setAttribute("aria-pressed", !tags.has(tag));
    toast(errorText(error));
  }
}

async function addNote(button) {
  noteDraft = $("clNote").value;
  if (!noteDraft.trim()) { $("clHint").textContent = "Напишите заметку"; return haptic("medium"); }
  button.disabled = true;
  try {
    await api.customerNoteAdd(open.id, noteDraft.trim());
    noteDraft = "";
    haptic("success");
    toast("Заметка сохранена");
    await loadCard();
  } catch (error) {
    button.disabled = false;
    $("clHint").textContent = errorText(error);
  }
}

async function deleteNote(button) {
  if (!button.hasAttribute("data-armed")) { button.setAttribute("data-armed", ""); button.textContent = "Точно удалить?"; return haptic("medium"); }
  noteDraft = $("clNote")?.value || "";
  button.disabled = true;
  try {
    await api.customerNoteDelete(Number(button.dataset.noteDel));
    haptic("success");
    await loadCard();
  } catch (error) {
    button.disabled = false;
    toast(error?.code === "forbidden" ? "Удалить заметку может её автор или директор" : errorText(error));
  }
}

function onClick(e) {
  const t = e.target;
  const row = t.closest("[data-customer]");
  if (row) { haptic(); return openCustomer(row.dataset.customer); }
  const sortId = t.closest("[data-sort]")?.dataset.sort;
  if (sortId) { if (sortId !== sort) { haptic(); sort = sortId; renderList(); } return; }
  if (t.closest("[data-back]")) { haptic(); return open?.back ? open.back() : closeCard(); }
  const tag = t.closest("[data-tag]");
  if (tag) return toggleTag(tag);
  if (t.closest("[data-note-add]")) return addNote(t.closest("[data-note-add]"));
  if (t.dataset.noteDel) return deleteNote(t);
  if (t.dataset.openOrder) { haptic(); return openAdminOrders(Number(t.dataset.openOrder)); }
  // задачи по клиенту: после формы — обратно в его карточку
  const reopen = ((id, prev) => () => openCustomer(id, prev))(open?.id, open?.back);
  if (t.closest("[data-customer-task]")) {
    haptic();
    const c = findCustomer(open.id);
    return openTaskForm({ customerId: open.id, customer: c?.name || open.card?.orders?.[0]?.name || "" }, reopen);
  }
  if (handleTaskTap(e, loadCard)) return;
  if (t.dataset.taskEdit) { haptic(); return openTaskForm({}, reopen, open.tasks.find((x) => x.id === Number(t.dataset.taskEdit))); }
  if (t.dataset.taskDelete) return deleteTask(t, loadCard);
}

export function openCustomers() {
  open = null;
  sheetBody.onclick = onClick;
  openSheet("customers");
  renderList();
  loadList();
}

export function initCustomers() {
  $("adminCustomersButton").onclick = () => { haptic(); openCustomers(); };
}
