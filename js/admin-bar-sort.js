// Кнопки сотрудника (Заказы, Клиенты, Задачи…) можно переставить перетаскиванием.
// Мышью — сразу, на телефоне — удержать кнопку ~0,3 секунды и вести пальцем. Порядок запоминается на этом устройстве.
import { $, haptic, storage } from "./core.js?v=20261001b";

const ORDER_KEY = "temp_admin_bar_order";
const HOLD_MS = 300;
const MOVE_TOLERANCE = 6;
let drag = null;            // { button, pointerId, touch, startX, startY, timer, active, ghost, before }
let suppressClick = false;  // после перетаскивания кнопка не должна срабатывать

const bar = () => $("adminBar");
const buttonIds = () => [...bar().querySelectorAll(".admin-btn")].map((b) => b.id);

/** Сохранённый порядок; новые кнопки, которых не было при сохранении, остаются на своих местах в конце */
function applySavedOrder() {
  const saved = storage.get(ORDER_KEY, []);
  if (!Array.isArray(saved) || !saved.length) return;
  for (const id of saved) {
    const button = $(id);
    if (button?.parentElement === bar()) bar().append(button);
  }
  for (const id of buttonIds()) if (!saved.includes(id)) bar().append($(id));
}

function onDown(e) {
  if (drag || e.button > 0) return;
  const button = e.target.closest(".admin-btn");
  if (!button) return;
  drag = { button, pointerId: e.pointerId, touch: e.pointerType !== "mouse", startX: e.clientX, startY: e.clientY, active: false };
  if (drag.touch) drag.timer = setTimeout(() => start(e.clientX, e.clientY), HOLD_MS);
}

function start(x, y) {
  if (!drag || drag.active) return;
  const { button } = drag, rect = button.getBoundingClientRect();
  drag.active = true;
  drag.before = buttonIds().join(",");
  drag.ghost = Object.assign(button.cloneNode(true), { id: "", className: `${button.className} drag-ghost` });
  drag.ghost.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
  document.body.append(drag.ghost);
  button.classList.add("drag-placeholder");
  haptic("medium");
  follow(x, y);
}

function follow(x, y) {
  drag.ghost.style.transform = `translate(${x - drag.startX}px, ${y - drag.startY}px) scale(1.05)`;
  const target = document.elementFromPoint(x, y)?.closest(".admin-btn");
  if (target && target !== drag.button && target.parentElement === bar()) {
    const buttons = [...bar().children];
    if (buttons.indexOf(drag.button) < buttons.indexOf(target)) target.after(drag.button); else target.before(drag.button);
  }
}

function onMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= MOVE_TOLERANCE) return;
    if (drag.touch) return reset(); // палец поехал раньше времени — это прокрутка
    start(e.clientX, e.clientY);    // мышью — берём сразу
  }
  e.preventDefault();
  follow(e.clientX, e.clientY);
}

function reset() {
  clearTimeout(drag?.timer);
  drag?.ghost?.remove();
  drag?.button.classList.remove("drag-placeholder");
  drag = null;
}

function onUp(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (!drag.active) return reset();
  const changed = buttonIds().join(",") !== drag.before;
  reset();
  suppressClick = true;
  setTimeout(() => (suppressClick = false), 80);
  if (changed) { storage.set(ORDER_KEY, buttonIds()); haptic("success"); }
}

export function initAdminBarSorting() {
  const el = bar();
  if (!el || el.dataset.sortable) return;
  el.dataset.sortable = "1";
  applySavedOrder();
  el.addEventListener("pointerdown", onDown);
  document.addEventListener("pointermove", onMove, { passive: false });
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", (e) => drag && e.pointerId === drag.pointerId && reset());
  document.addEventListener("touchmove", (e) => { if (drag?.active) e.preventDefault(); }, { passive: false });
  el.addEventListener("click", (e) => { if (suppressClick) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  el.addEventListener("contextmenu", (e) => e.preventDefault()); // долгое нажатие — не меню
}
