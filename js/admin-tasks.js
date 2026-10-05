// «Задачи» (директор и менеджеры): «перезвонить клиенту в пятницу» с напоминанием в срок.
// Напоминает сайт (счётчик на кнопке и всплывающее сообщение) и бот в Telegram, если сотрудник его подключил.
import { $, formatDate, escapeHtml, pluralize, haptic, toast, inTelegram } from "./core.js?v=20261001b";
import { state, api } from "./state.js?v=20261001b";
import { sheetBody, openSheet } from "./nav.js?v=20261001b";
import { isDirector } from "./roles.js?v=20261001b";
import { openCustomer } from "./admin-customers.js?v=20261001b";

const ERRORS = {
  no_function: "Задачи не настроены: в Supabase нужно запустить supabase-tasks.sql",
  forbidden: "Нет прав на это действие",
  no_telegram: "Откройте магазин через бота в Telegram и нажмите ещё раз",
  network: "Нет связи с базой. Проверьте интернет и повторите.",
};
const errorText = (error) => ERRORS[error?.code] || "Не получилось. Повторите через минуту.";

let tasks = null, loadError = "";
let info = null;          // { me, telegram, staff: [{ id, name }] }
let scope = "mine";       // mine · all (только директор)
let form = null;          // открытая форма задачи
let back = null;          // куда вернуться из формы (карточка клиента)
const reminded = new Set(); // о каких наступивших задачах уже напомнили на этом устройстве

/* ---------- Даты ---------- */
const pad = (n) => String(n).padStart(2, "0");
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return localDay(d); };
const isDue = (t) => !t.done_at && new Date(t.due) <= new Date();
const dueToday = (t) => !t.done_at && localDay(new Date(t.due)) <= localDay(new Date());

function groupOf(t) {
  if (t.done_at) return "done";
  if (isDue(t)) return "overdue";
  const day = localDay(new Date(t.due));
  return day === addDays(0) ? "today" : day === addDays(1) ? "tomorrow" : "later";
}
const GROUPS = [["overdue", "Просрочено"], ["today", "Сегодня"], ["tomorrow", "Завтра"], ["later", "Позже"], ["done", "Выполнено"]];

/* ---------- Кнопка «Задачи» и напоминания на сайте ---------- */
const myOpen = () => (tasks || []).filter((t) => t.mine && !t.done_at);

function updateButton() {
  const button = $("adminTasksButton");
  if (!button) return;
  const n = myOpen().filter(dueToday).length;
  button.textContent = `Задачи${n ? ` · ${n}` : ""}`;
  button.title = n ? `${n} ${pluralize(n, "задача", "задачи", "задач")} на сегодня или просрочено` : "";
  button.classList.toggle("has-new", myOpen().some(isDue));
}

function remind() {
  const due = myOpen().filter((t) => isDue(t) && !reminded.has(t.id));
  due.forEach((t) => reminded.add(t.id));
  if (!due.length) return;
  haptic("heavy");
  toast(due.length === 1 ? `⏰ Задача: ${due[0].title}` : `⏰ ${due.length} ${pluralize(due.length, "задача ждёт", "задачи ждут", "задач ждут")} выполнения`);
}

async function load() {
  try {
    tasks = (await api.tasksList(scope === "all", null)) || [];
    loadError = "";
  } catch (error) {
    loadError = errorText(error);
  }
  updateButton();
  remind();
  render();
}

/* ---------- Список ---------- */
// Нажатие на задачу раскрывает действия: «Подтвердить выполнение» или «Убрать статус «Выполнено»» (с вопросом «точно?»)
const taskHtml = (t) => `<div class="tk${t.done_at ? " tk-done" : ""}${isDue(t) ? " due" : ""}" data-task-open="${t.id}">
  <span class="tk-check" aria-hidden="true">✓</span>
  <div class="tk-body">
    <p class="tk-title">${escapeHtml(t.title)}</p>
    <small>${formatDate(t.due)}${t.customer ? ` · <button class="link" data-task-customer="${Number(t.customer_id)}">${escapeHtml(t.customer)}</button>` : ""}${t.order_id ? ` · заказ №${Number(t.order_id)}` : ""}</small>
    <small>${t.mine ? "Вам" : escapeHtml(t.assignee || "")}${t.created_by && t.created_by !== t.assignee ? ` · от ${escapeHtml(t.created_by)}` : ""}${t.done_at ? ` · выполнено ${formatDate(t.done_at)}${t.done_by ? `, ${escapeHtml(t.done_by)}` : ""}` : ""}</small>
    <div class="tk-actions">${t.done_at
      ? `<button class="ghost" data-task-undo>Убрать статус «Выполнено»</button>
        <div class="tk-confirm" hidden><p>Точно убрать статус «Выполнено»? Задача снова станет активной.</p>
          <div class="ord-actions"><button class="ghost danger" data-task-done="${t.id}" data-done="0">Да, убрать</button><button class="ghost" data-task-undo-cancel>Отмена</button></div></div>`
      : `<button class="primary sm" data-task-done="${t.id}" data-done="1">Подтвердить выполнение</button>
        <span class="tk-tools"><button class="link" data-task-edit="${t.id}">Изменить</button>${t.can_delete ? `<button class="link" data-task-delete="${t.id}">Удалить</button>` : ""}</span>`}</div>
  </div></div>`;

export const tasksListHtml = (list) => list.map(taskHtml).join("");

/** Нажатия по задаче (раскрыть, подтвердить, убрать статус). true — нажатие обработано. after — что обновить. */
export function handleTaskTap(e, after = load) {
  const t = e.target;
  const done = t.closest("[data-task-done]");
  if (done) { toggleTaskDone(done, after); return true; }
  const row = t.closest("[data-task-open]");
  if (!row) return false;
  if (t.closest("[data-task-undo]")) {
    haptic("medium");
    row.querySelector("[data-task-undo]").hidden = true;
    row.querySelector(".tk-confirm").hidden = false;
    return true;
  }
  if (t.closest("[data-task-undo-cancel]")) {
    haptic();
    row.querySelector("[data-task-undo]").hidden = false;
    row.querySelector(".tk-confirm").hidden = true;
    return true;
  }
  if (t.closest("button, a")) return false; // «Изменить», «Удалить», клиент — у каждого свой обработчик
  haptic();
  const opening = !row.classList.contains("open");
  row.parentElement.querySelectorAll(".tk.open").forEach((x) => x.classList.remove("open"));
  row.classList.toggle("open", opening);
  return true;
}

function telegramHtml() {
  if (!info) return "";
  if (info.telegram) return `<p class="adm-sub tk-tg">🔔 Напоминания приходят вам в Telegram. <button class="link" data-tg-off>Отключить</button></p>`;
  return `<div class="req tk-tg"><p class="req-t">Чтобы напоминания приходили в Telegram, откройте магазин через бота и нажмите кнопку ниже.</p>
    <button class="ghost" data-tg-on ${inTelegram ? "" : "disabled"}>${inTelegram ? "Получать напоминания в Telegram" : "Доступно, если открыть магазин в Telegram"}</button></div>`;
}

function formHtml() {
  const staff = info?.staff || [];
  const quick = [["Сегодня", 0], ["Завтра", 1], ["Через 3 дня", 3], ["Через неделю", 7]];
  return `<div class="grab"></div><h2 class="p-name">${form.id ? "Изменить задачу" : "Новая задача"}</h2>
    ${form.customer ? `<p class="adm-sub">Клиент: <b>${escapeHtml(form.customer)}</b>${form.orderId ? ` · заказ №${Number(form.orderId)}` : ""}</p>` : ""}
    <label class="field"><span>Что сделать</span><textarea id="tkTitle" maxlength="500" placeholder="Например: перезвонить и уточнить размер">${escapeHtml(form.title)}</textarea></label>
    <div class="field"><span>Когда напомнить</span>
      <div class="cl-tagbar">${quick.map(([title, days]) => `<button class="cl-tag" data-quick-day="${days}" aria-pressed="${form.date === addDays(days)}">${title}</button>`).join("")}</div>
      <div class="an-range" style="margin-top:8px"><input id="tkDate" type="date" value="${form.date}"><input id="tkTime" type="time" value="${form.time}"></div></div>
    <label class="field"><span>Кому</span><select id="tkWho">${staff.map((s) =>
      `<option value="${s.id}" ${Number(s.id) === Number(form.assigneeId) ? "selected" : ""}>${escapeHtml(s.name)}${Number(s.id) === Number(info.me) ? " (вы)" : ""}</option>`).join("")}</select></label>
    <p class="hint" id="tkHint"></p>
    <div class="ord-actions"><button class="primary sm" data-task-save>${form.id ? "Сохранить" : "Поставить задачу"}</button><button class="ghost" data-task-cancel>Отмена</button></div>`;
}

function render() {
  if (state.view !== "tasks") return;
  if (form) { sheetBody.innerHTML = formHtml(); return; }
  const list = tasks || [];
  const groups = GROUPS.map(([id, title]) => [title, list.filter((t) => groupOf(t) === id)]).filter(([, items]) => items.length);
  sheetBody.innerHTML = `<div class="grab"></div><h2 class="p-name">Задачи</h2>
    <p class="adm-sub">Звонки, обещания клиентам и другие дела с напоминанием в срок. Нажмите на задачу, чтобы подтвердить выполнение.</p>
    ${isDirector() ? `<div class="order-groups" role="tablist">${[["mine", "Мои"], ["all", "Все сотрудники"]].map(([id, title]) =>
      `<button class="chip" role="tab" data-scope="${id}" aria-pressed="${id === scope}">${title}</button>`).join("")}</div>` : ""}
    <button class="primary" data-task-new>Новая задача</button>
    ${loadError ? `<p class="hint">${loadError}</p>` : !tasks ? `<p class="adm-sub">Загружаем…</p>`
      : groups.length ? groups.map(([title, items]) => `<h3 class="an-h">${title} · ${items.length}</h3>${tasksListHtml(items)}`).join("")
      : `<p class="adm-sub" style="margin-top:12px">Задач нет.</p>`}
    ${telegramHtml()}`;
}

/* ---------- Действия ---------- */
async function loadInfo() {
  try { info = await api.tasksStaff(); } catch { info = null; }
}

/** Открыть форму задачи. prefill — { customerId, customer, orderId }; onBack — куда вернуться после сохранения. */
export async function openTaskForm(prefill = {}, onBack = null, task = null) {
  back = onBack;
  if (!info) await loadInfo();
  form = task
    ? { id: task.id, title: task.title, date: localDay(new Date(task.due)), time: `${pad(new Date(task.due).getHours())}:${pad(new Date(task.due).getMinutes())}`,
        assigneeId: task.assignee_id, customerId: task.customer_id, customer: task.customer, orderId: task.order_id }
    : { title: "", date: addDays(1), time: "10:00", assigneeId: info?.me, ...prefill };
  sheetBody.onclick = onClick;
  openSheet("tasks", closeForm);
  render();
  $("tkTitle")?.focus();
}

function closeForm() {
  form = null;
  const to = back;
  back = null;
  if (to) return to();
  openSheet("tasks");
  render();
}

function readForm() {
  form.title = $("tkTitle").value;
  form.date = $("tkDate").value;
  form.time = $("tkTime").value || "10:00";
  form.assigneeId = Number($("tkWho").value) || info?.me;
}

async function saveTask(button) {
  readForm();
  const due = new Date(`${form.date}T${form.time}`);
  const problem = !form.title.trim() ? "Напишите, что нужно сделать" : !form.date || isNaN(due) ? "Выберите дату напоминания" : "";
  if (problem) { $("tkHint").textContent = problem; return haptic("medium"); }
  button.disabled = true;
  try {
    await api.taskSave({ ...form, title: form.title.trim(), due: due.toISOString() });
    haptic("success");
    toast(form.id ? "Задача сохранена" : `Задача поставлена на ${formatDate(due.toISOString())}`);
    await load();
    closeForm();
  } catch (error) {
    button.disabled = false;
    $("tkHint").textContent = errorText(error);
  }
}

/** Отметить выполненной или вернуть в работу; after — что перерисовать (список задач или карточку клиента) */
export async function toggleTaskDone(button, after = load) {
  const done = button.dataset.done === "1";
  button.disabled = true;
  try {
    await api.taskDone(Number(button.dataset.taskDone), done);
    haptic(done ? "success" : "light");
    if (done) toast("Задача выполнена");
  } catch (error) {
    toast(errorText(error));
  }
  if (after !== load) load(); // счётчик на кнопке
  await after();
}

export async function deleteTask(button, after = load) {
  if (!button.hasAttribute("data-armed")) { button.setAttribute("data-armed", ""); button.textContent = "Точно удалить?"; return haptic("medium"); }
  button.disabled = true;
  try {
    await api.taskDelete(Number(button.dataset.taskDelete));
    haptic("success");
  } catch (error) {
    toast(errorText(error));
  }
  if (after !== load) load();
  await after();
}

async function linkTelegram(on, button) {
  button.disabled = true;
  try {
    if (on) await api.staffLinkTelegram(); else await api.staffUnlinkTelegram();
    haptic("success");
    toast(on ? "Готово: напоминания будут приходить в Telegram" : "Напоминания в Telegram отключены");
  } catch (error) {
    button.disabled = false;
    return toast(errorText(error));
  }
  await loadInfo();
  render();
}

function onClick(e) {
  const t = e.target;
  if (t.closest("[data-task-new]")) { haptic(); return openTaskForm(); }
  if (t.closest("[data-task-cancel]")) { haptic(); return closeForm(); }
  if (t.closest("[data-task-save]")) return saveTask(t.closest("[data-task-save]"));
  const quick = t.closest("[data-quick-day]");
  if (quick) { haptic(); readForm(); form.date = addDays(Number(quick.dataset.quickDay)); return render(); }
  if (handleTaskTap(e)) return;
  if (t.dataset.taskEdit) { haptic(); return openTaskForm({}, null, tasks.find((x) => x.id === Number(t.dataset.taskEdit))); }
  if (t.dataset.taskDelete) return deleteTask(t);
  if (t.dataset.taskCustomer) { haptic(); return openCustomer(t.dataset.taskCustomer, openTasks); }
  const scopeId = t.closest("[data-scope]")?.dataset.scope;
  if (scopeId && scopeId !== scope) { haptic(); scope = scopeId; tasks = null; render(); return load(); }
  if (t.closest("[data-tg-on]")) return linkTelegram(true, t.closest("[data-tg-on]"));
  if (t.closest("[data-tg-off]")) return linkTelegram(false, t);
}

export function openTasks() {
  form = null;
  back = null;
  sheetBody.onclick = onClick;
  openSheet("tasks");
  render();
  load();
  loadInfo().then(render);
}

export function initTasks() {
  $("adminTasksButton").onclick = () => { haptic(); openTasks(); };
  load();
  setInterval(() => { if (!document.hidden && !form) load(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !form) load(); });
}
