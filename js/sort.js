// Сотрудники меняют порядок карточек в каталоге перетаскиванием.
// Мышью — сразу, на телефоне — удержать карточку ~0,3 секунды и вести пальцем. Порядок сохраняется в базе.
import { $, haptic, toast, emit } from "./core.js?v=20261001b";
import { state, api, errorMessage } from "./state.js?v=20261001b";
import { setProductOrder, refreshCatalog } from "./catalog.js?v=20261001b";

const HOLD_MS = 300;        // сколько держать палец, чтобы карточка «взялась»
const MOVE_TOLERANCE = 8;   // столько пикселей можно сдвинуться, пока держишь (иначе это прокрутка)
let drag = null;            // { card, pointerId, touch, startX, startY, timer, active, ghost, dx, dy, before }
let suppressClick = false;  // после перетаскивания карточка не должна открываться

const staffMode = () => document.documentElement.classList.contains("staff-mode");
const gridIds = () => [...$("grid").querySelectorAll(".card[data-open]")].map((c) => Number(c.dataset.open));

function onDown(e) {
  if (!staffMode() || drag || e.button > 0) return;
  const card = e.target.closest(".card[data-open]");
  if (!card) return;
  drag = { card, pointerId: e.pointerId, touch: e.pointerType !== "mouse", startX: e.clientX, startY: e.clientY, active: false };
  if (drag.touch) drag.timer = setTimeout(() => start(e.clientX, e.clientY), HOLD_MS);
}

function start(x, y) {
  if (!drag || drag.active) return;
  const { card } = drag, rect = card.getBoundingClientRect();
  drag.active = true;
  drag.before = gridIds().join(",");
  drag.dx = drag.startX - rect.left;
  drag.dy = drag.startY - rect.top;
  drag.ghost = Object.assign(card.cloneNode(true), { className: `${card.className} drag-ghost` });
  drag.ghost.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px`;
  document.body.append(drag.ghost);
  card.classList.add("drag-placeholder");
  haptic("medium");
  follow(x, y);
}

function follow(x, y) {
  drag.ghost.style.transform = `translate(${x - drag.startX}px, ${y - drag.startY}px) scale(1.04)`;
  // карточка под пальцем — встаём перед ней или после неё
  const target = document.elementFromPoint(x, y)?.closest(".card[data-open]");
  if (target && target !== drag.card && target.parentElement === drag.card.parentElement) {
    const cards = [...drag.card.parentElement.children];
    if (cards.indexOf(drag.card) < cards.indexOf(target)) target.after(drag.card); else target.before(drag.card);
  }
  // у края экрана — прокручиваем
  if (y < 70) scrollBy(0, -14);
  else if (y > innerHeight - 70) scrollBy(0, 14);
}

function onMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (!drag.active) {
    const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > MOVE_TOLERANCE;
    if (!moved) return;
    if (drag.touch) return reset(); // палец поехал раньше времени — это прокрутка
    start(e.clientX, e.clientY);    // мышью — берём сразу
  }
  if (!$("grid").contains(drag.card)) return cancel(); // каталог перерисовался под пальцем
  e.preventDefault();
  follow(e.clientX, e.clientY);
}

function reset() {
  clearTimeout(drag?.timer);
  drag?.ghost?.remove();
  drag?.card.classList.remove("drag-placeholder");
  drag = null;
}

function cancel() {
  const wasActive = drag?.active;
  reset();
  if (wasActive) emit("catalog"); // вернуть карточки на место
}

function onUp(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (!drag.active) return reset();
  const changed = gridIds().join(",") !== drag.before;
  reset();
  suppressClick = true;
  setTimeout(() => (suppressClick = false), 80);
  if (changed) saveOrder();
}

/** Новый порядок внутри категории вписываем в общий порядок всех товаров */
async function saveOrder() {
  const ids = gridIds(), inCategory = new Set(ids);
  let k = 0;
  const order = state.catalogProducts.map((p) => (inCategory.has(p.id) ? ids[k++] : p.id));
  setProductOrder(order); // покупатель увидит то же самое — сразу показываем у себя
  haptic("success");
  try {
    await api.setOrder(order);
    toast("Порядок сохранён");
  } catch (error) {
    toast(error.code === "not_staff" ? "Нет прав: войдите как сотрудник" : errorMessage(error));
    refreshCatalog(); // вернуть порядок из базы
  }
}

function renderHint() {
  if ($("sortHint")) return;
  const hint = Object.assign(document.createElement("p"), { id: "sortHint", className: "sort-hint",
    textContent: "Нажмите на товар, чтобы изменить его. Чтобы поменять порядок, перетащите карточку (на телефоне — удерживайте её)." });
  $("grid").before(hint);
}

export function initProductSorting() {
  if (!api.setOrder) return;
  renderHint();
  const grid = $("grid");
  grid.addEventListener("pointerdown", onDown);
  document.addEventListener("pointermove", onMove, { passive: false });
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", (e) => drag && e.pointerId === drag.pointerId && cancel());
  // пока карточку тащат пальцем — страница не прокручивается сама
  document.addEventListener("touchmove", (e) => { if (drag?.active) e.preventDefault(); }, { passive: false });
  grid.addEventListener("click", (e) => { if (suppressClick) { e.preventDefault(); e.stopPropagation(); } }, true);
  grid.addEventListener("contextmenu", (e) => { if (staffMode()) e.preventDefault(); }); // долгое нажатие — не меню
  grid.addEventListener("dragstart", (e) => { if (staffMode()) e.preventDefault(); });   // не перетаскивать само фото
}
