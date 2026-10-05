// Роли: директор и менеджеры входят по логину и паролю (ссылка …/crm.html), все остальные — покупатели.
import { $, escapeHtml, haptic, on } from "./core.js?v=20261001b";
import { state } from "./state.js?v=20261001b";
import { staffLogout } from "./supabase.js?v=20261001b";

/** Роль по входу сотрудника (state.staffSession приходит из базы после проверки пароля) */
export function detectRole() {
  const s = state.staffSession;
  if (s?.role === "admin") return { role: "director", position: "Директор", name: s.name };
  if (s?.role === "manager") return { role: "manager", position: "Менеджер", name: s.name };
  return { role: "customer" };
}

export const isStaff = () => state.role.role !== "customer";
export const isDirector = () => state.role.role === "director";

/** Должность, ФИО и «Выйти» справа сверху; вместо адреса магазина — сотруднику он не нужен */
function renderStaffBadge() {
  const { position, name } = state.role;
  $("staffBadge").hidden = !isStaff();
  const address = $("shopAddress"); // есть только в магазине; в панели (crm.html) адреса нет
  if (address) address.hidden = isStaff();
  if (!isStaff()) return;
  $("staffBadge").innerHTML = `<span class="role">${escapeHtml(position)}</span><span class="person">${escapeHtml(name)}</span>
    <button class="staff-logout" id="staffLogout">Выйти</button>`;
  $("staffLogout").onclick = async (e) => {
    const button = e.currentTarget;
    if (!button.hasAttribute("data-armed")) { button.setAttribute("data-armed", ""); button.textContent = "Точно выйти?"; return haptic("medium"); }
    button.disabled = true;
    await staffLogout();
    location.replace(location.pathname); // начисто: магазин для покупателя
  };
}

/** Пересчитывает роль после входа сотрудника; onChange — показать или спрятать кнопки сотрудника */
export function initRoles(onChange) {
  const update = () => {
    const next = detectRole();
    const changed = JSON.stringify(next) !== JSON.stringify(state.role);
    state.role = next;
    renderStaffBadge();
    if (changed) onChange(next);
  };
  update();
  on("staffrole", update);
}
