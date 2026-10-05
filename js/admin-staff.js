// «Сотрудники» (только директор): ФИО, логин и пароль. Сотрудник входит по ссылке …/crm.html.
// Пароли хранятся в базе только в виде хеша — посмотреть их нельзя, можно задать новый.
import { $, escapeHtml, haptic, toast, copyToClipboard } from "./core.js?v=20261001b";
import { state, api } from "./state.js?v=20261001b";
import { sheetBody, openSheet } from "./nav.js?v=20261001b";

let accounts = [];
let editing = null;   // null — список, 0 — новый сотрудник, иначе id редактируемого
let loadError = "";

const STAFF_ERRORS = {
  bad_name: "Впишите ФИО",
  bad_login: "Логин: 3–32 символа — латинские буквы, цифры, точка, дефис или _",
  short_password: "Пароль — не короче 8 символов",
  login_taken: "Такой логин уже занят",
  forbidden: "Управлять сотрудниками может только директор",
  self: "Свой аккаунт удалить нельзя",
  no_function: "Вход по паролю не настроен: в Supabase нужно запустить supabase-staff.sql",
  network: "Нет связи с базой. Проверьте интернет и повторите.",
};
const staffError = (error) => STAFF_ERRORS[error?.code] || "Не удалось сохранить. Повторите через минуту.";

/** Ссылка для входа сотрудников — рядом с сайтом магазина */
const staffLink = () => new URL("crm.html", location.href.split(/[?#]/)[0]).href;

function accountForm(a = {}) {
  const isNew = !a.id;
  return `<div class="ord" id="staffForm">
    <label class="field"><span>ФИО</span><input id="staffName" maxlength="80" value="${escapeHtml(a.name || "")}" placeholder="Петров Пётр Петрович"></label>
    <label class="field"><span>Логин</span><input id="staffLogin" maxlength="32" autocapitalize="none" autocorrect="off" spellcheck="false"
      value="${escapeHtml(a.login || "")}" placeholder="Например, petrov"></label>
    <label class="field"><span>Пароль</span><input id="staffPass" autocomplete="new-password" autocapitalize="none" spellcheck="false"
      placeholder="${isNew ? "Не короче 8 символов" : "Оставьте пустым, чтобы не менять"}"></label>
    <p class="hint" id="hint"></p>
    <div class="ord-actions"><button class="primary sm" id="saveStaff">${isNew ? "Добавить" : "Сохранить"}</button><button class="ghost" id="cancelStaff">Отмена</button></div>
  </div>`;
}

const accountCard = (a) => editing === a.id ? accountForm(a) : `<div class="adm-row staff-row">
  <div><p class="t">${escapeHtml(a.name)}${a.me ? " (вы)" : ""}</p><p class="s">${a.role === "admin" ? "Директор" : "Менеджер"} · логин ${escapeHtml(a.login)}</p></div>
  <span class="adm-btns"><button class="adm-del" data-edit-staff="${a.id}">Изменить</button>
    ${a.me ? "" : `<button class="adm-del" data-delete-staff="${a.id}">Удалить</button>`}</span></div>`;

function render() {
  if (state.view !== "staff") return;
  sheetBody.innerHTML = `<div class="grab"></div>
    <h2 class="p-name">Сотрудники</h2>
    <p class="adm-sub">Сотрудник входит по этой ссылке своим логином и паролем. Менеджер видит заказы, переписку и товары, сотрудников — только директор.</p>
    <div class="req"><p class="req-t staff-link">${escapeHtml(staffLink())}</p><button class="ghost copy" id="copyStaffLink">Скопировать ссылку</button></div>
    ${loadError ? `<p class="hint">${loadError}</p>` : accounts.map(accountCard).join("")}
    ${editing === 0 ? accountForm() : loadError ? "" : `<button class="primary" id="addStaff">Добавить сотрудника</button>`}
    <p class="adm-sub" style="margin-top:12px">Пароль хранится в зашифрованном виде — посмотреть его нельзя, только задать новый. После смены пароля или удаления сотрудник сразу теряет доступ.</p>`;
}

async function load() {
  try {
    accounts = await api.staffList();
    loadError = "";
  } catch (error) {
    loadError = staffError(error);
  }
  render();
}

export function openStaffManager() {
  editing = null;
  loadError = "";
  sheetBody.innerHTML = `<div class="grab"></div><h2 class="p-name">Сотрудники</h2><p class="adm-sub">Загружаем…</p>`;
  sheetBody.onclick = onClick;
  openSheet("staff");
  load();
}

async function onClick(e) {
  const t = e.target;
  if (t.id === "copyStaffLink") return copyToClipboard(staffLink(), t);
  if (t.id === "saveStaff") return save(t);
  if (t.dataset.deleteStaff) return remove(t);
  if (t.id === "addStaff") editing = 0;
  else if (t.id === "cancelStaff") editing = null;
  else if (t.dataset.editStaff) editing = Number(t.dataset.editStaff);
  else return;
  haptic();
  render();
  $("staffName")?.focus();
}

async function save(button) {
  const name = $("staffName").value.trim(), login = $("staffLogin").value.trim().toLowerCase(), password = $("staffPass").value;
  const problem = name.length < 2 ? STAFF_ERRORS.bad_name
    : !/^[a-z0-9._-]{3,32}$/.test(login) ? STAFF_ERRORS.bad_login
    : (editing === 0 || password) && password.length < 8 ? STAFF_ERRORS.short_password : "";
  if (problem) { $("hint").textContent = problem; return haptic("medium"); }
  button.disabled = true;
  try {
    await api.staffSave(editing || null, name, login, password);
    haptic("success");
    toast(editing === 0 ? "Сотрудник добавлен. Передайте ему ссылку, логин и пароль" : "Изменения сохранены");
    editing = null;
    await load();
  } catch (error) {
    button.disabled = false;
    $("hint").textContent = staffError(error);
    haptic("medium");
  }
}

async function remove(button) {
  if (!button.hasAttribute("data-armed")) { button.setAttribute("data-armed", ""); button.textContent = "Точно удалить?"; return haptic("medium"); }
  button.disabled = true;
  try {
    await api.staffDelete(Number(button.dataset.deleteStaff));
    haptic("success");
    toast("Сотрудник удалён, доступ закрыт");
  } catch (error) {
    toast(staffError(error));
  }
  await load();
}

export function initStaffManager() {
  $("adminStaffButton").onclick = () => { haptic(); openStaffManager(); };
}
