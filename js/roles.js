// Роли: директор (задан в config.js), менеджеры (назначает директор), покупатели — все остальные.
// Роль определяется по Telegram ID того, кто открыл магазин.
import { $, telegramUser, escapeHtml, on } from "./core.js";
import { DIRECTOR } from "./config.js";
import { state } from "./state.js";

const sameId = (a, b) => Number(a) > 0 && Number(a) === Number(b);

export function detectRole() {
  const id = telegramUser?.id;
  if (sameId(DIRECTOR.telegramId, id)) return { role: "director", position: "Директор", name: DIRECTOR.name };
  const manager = state.staff.find((s) => sameId(s.telegramId, id));
  return manager ? { role: "manager", position: manager.position || "Менеджер", name: manager.name } : { role: "customer" };
}

export const isStaff = () => state.role.role !== "customer";
export const isDirector = () => state.role.role === "director";

/** Должность и ФИО справа сверху; вместо адреса магазина — сотруднику он не нужен */
function renderStaffBadge() {
  const { position, name } = state.role;
  $("staffBadge").hidden = !isStaff();
  $("shopAddress").hidden = isStaff();
  if (isStaff()) $("staffBadge").innerHTML = `<span class="role">${escapeHtml(position)}</span><span class="person">${escapeHtml(name)}</span>`;
}

/** Пересчитывает роль, когда загрузился список сотрудников; onChange — показать или спрятать кнопки */
export function initRoles(onChange) {
  const update = () => {
    const next = detectRole();
    const changed = JSON.stringify(next) !== JSON.stringify(state.role);
    state.role = next;
    renderStaffBadge();
    if (changed) onChange(next);
  };
  update();
  on("catalog", update);
}
