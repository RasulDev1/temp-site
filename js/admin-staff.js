// Директор назначает менеджеров: Telegram ID, ФИО и должность.
import { $, escapeHtml, haptic, toast, on } from "./core.js";
import { state, api, errorMessage } from "./state.js";
import { refreshCatalog } from "./catalog.js";
import { keyInstructions } from "./staff-access.js";
import { sheetBody, openSheet } from "./nav.js";

let editingId = null; // Telegram ID редактируемого менеджера; 0 — новый

/** Supabase: доступ к заказам — по роли в базе. Назначили менеджера — роль manager, сняли — user. */
async function syncDatabaseRoles(before, after) {
  if (!api.setRole) return true;
  const was = new Set(before.map((m) => m.telegramId)), now = new Set(after.map((m) => m.telegramId));
  try {
    for (const id of now) if (!was.has(id)) await api.setRole(id, "manager");
    for (const id of was) if (!now.has(id)) await api.setRole(id, "user");
    return true;
  } catch {
    return false;
  }
}

async function saveStaff(staff, successText) {
  try {
    const before = state.staff;
    await api.setStaff(staff);
    await refreshCatalog();
    const synced = await syncDatabaseRoles(before, staff);
    haptic("success");
    toast(synced ? `${successText}. У сотрудника — через 1–2 минуты`
      : `${successText}, но доступ к заказам не изменён: в базе Supabase у вас нет роли администратора`);
    return true;
  } catch (error) {
    toast(errorMessage(error));
    return false;
  }
}

function managerForm(m = {}) {
  return `<div class="ord" id="managerForm">
    <label class="field"><span>Telegram ID</span><input id="managerId" inputmode="numeric" value="${m.telegramId || ""}" placeholder="Например, 123456789"></label>
    <label class="field"><span>ФИО</span><input id="managerName" maxlength="80" value="${escapeHtml(m.name || "")}" placeholder="Петров Пётр Петрович"></label>
    <label class="field"><span>Должность</span><input id="managerPosition" maxlength="40" value="${escapeHtml(m.position || "Менеджер")}"></label>
    <p class="hint" id="hint"></p>
    <div class="ord-actions"><button class="primary sm" id="saveManager">${m.telegramId ? "Сохранить" : "Назначить"}</button><button class="ghost" id="cancelManager">Отмена</button></div>
  </div>`;
}

const managerCard = (m) => editingId === m.telegramId ? managerForm(m) : `<div class="adm-row staff-row">
  <div><p class="t">${escapeHtml(m.name)}</p><p class="s">${escapeHtml(m.position)} · ID ${m.telegramId}</p></div>
  <span class="adm-btns"><button class="adm-del" data-edit-manager="${m.telegramId}">Изменить</button>
    <button class="adm-del" data-remove-manager="${m.telegramId}">Снять</button></span></div>`;

export function openStaffManager() {
  const list = state.staff;
  sheetBody.innerHTML = `<div class="grab"></div>
    <h2 class="p-name">Сотрудники</h2>
    <p class="adm-sub">Менеджер видит свою должность и ФИО, управляет товарами и складом. Назначать сотрудников может только директор.</p>
    ${list.length ? list.map(managerCard).join("") : `<p class="adm-sub">Менеджеров пока нет.</p>`}
    ${editingId === 0 ? managerForm() : `<button class="primary" id="addManager">Назначить менеджера</button>`}
    <p class="label">Как назначить</p>
    <ol class="steps">
      <li>Менеджер открывает магазин в Telegram и внизу нажимает «Для сотрудников» — там его Telegram ID.</li>
      <li>Вы вписываете этот ID, ФИО и должность и нажимаете «Назначить».</li>
      <li>Чтобы менеджер мог сохранять изменения, создайте для него отдельный ключ и передайте лично:</li>
    </ol>
    ${keyInstructions()}
    <p class="adm-sub">Когда снимаете менеджера, удалите и его ключ: github.com/settings/personal-access-tokens.</p>`;
  sheetBody.onclick = onStaffClick;
  openSheet("staff");
}

async function onStaffClick(e) {
  const t = e.target;
  const edit = t.dataset.editManager, remove = t.dataset.removeManager;
  if (t.id === "addManager") editingId = 0;
  else if (t.id === "cancelManager") editingId = null;
  else if (edit) editingId = Number(edit);
  else if (remove) {
    if (!t.hasAttribute("data-armed")) { t.setAttribute("data-armed", ""); t.textContent = "Точно снять?"; return haptic("medium"); }
    t.disabled = true;
    await saveStaff(state.staff.filter((m) => m.telegramId !== Number(remove)), "Менеджер снят");
  } else if (t.id === "saveManager") return saveManager(t);
  else return;
  openStaffManager();
  $("managerId")?.focus();
}

async function saveManager(button) {
  const telegramId = Number($("managerId").value.trim());
  const name = $("managerName").value.trim(), position = $("managerPosition").value.trim() || "Менеджер";
  const taken = state.staff.some((m) => m.telegramId === telegramId && m.telegramId !== editingId);
  const problem = !(telegramId > 0) ? "Telegram ID — это число, например 123456789"
    : !name ? "Впишите ФИО" : taken ? "Сотрудник с таким ID уже есть" : "";
  if (problem) { $("hint").textContent = problem; return haptic("medium"); }
  button.disabled = true;
  const staff = state.staff.filter((m) => m.telegramId !== editingId).concat({ telegramId, name, position });
  if (await saveStaff(staff, editingId ? "Изменения сохранены" : "Менеджер назначен")) editingId = null;
  openStaffManager();
}

export function initStaffManager(onlyWithKey) {
  $("adminStaffButton").onclick = () => onlyWithKey(openStaffManager);
  on("catalog", () => state.view === "staff" && editingId === null && openStaffManager());
}
