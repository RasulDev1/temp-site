// Навигация: всплывающая шторка, вкладки «Корзина · Мои заказы · Товары», главная кнопка Telegram.
import { $, telegram, inTelegram, formatPrice, haptic, replayAnimation, emit } from "./core.js?v=20261001b";
import { state, cartCount, cartTotal } from "./state.js?v=20261001b";
import { addSelectedToCart } from "./shop.js?v=20261001b";
import { renderCartPage, openCheckout, placeOrder, renderMyOrders } from "./cart.js?v=20261001b";

export const sheetBody = $("sheetBody");
let onBack = null;

/** Открывает шторку. back — куда вести по кнопке «Назад» Telegram (по умолчанию закрыть). */
export function openSheet(view, back = null) {
  const changed = state.view !== view;
  state.view = view;
  onBack = back;
  $("scrim").classList.add("open");
  $("sheet").classList.add("open");
  $("sheet").classList.toggle("has-back", Boolean(back));
  document.documentElement.classList.add("sheet-open");
  $("sheet").scrollTop = 0;
  // у сотрудника раздел открывается прямо на странице — новый раздел показываем с начала
  if (changed && staffPage()) scrollTo({ top: 0 });
  telegram?.BackButton?.show();
  syncMainButton();
  emit("sheet");
}

export function closeSheet() {
  state.view = null;
  $("scrim").classList.remove("open");
  $("sheet").classList.remove("open");
  document.documentElement.classList.remove("sheet-open");
  if (staffPage()) scrollTo({ top: 0 });
  telegram?.BackButton?.hide();
  syncMainButton();
  emit("sheet");
}

/** Режим сотрудника: разделы (заказы, клиенты, задачи…) показываются на странице вместо всплывающего окна */
const staffPage = () => document.documentElement.classList.contains("staff-mode");

/** Шаг назад: из вложенной шторки (например, чат заказа) — туда, откуда пришли, иначе закрыть */
export const goBack = () => (onBack ? onBack() : closeSheet());

export function setTab(tab) {
  const changed = state.tab !== tab;
  state.tab = tab;
  document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.tab === tab));
  const pages = { shop: $("shopPage"), cart: $("cartPage"), orders: $("ordersPage") };
  for (const [name, page] of Object.entries(pages)) page.hidden = name !== tab;
  if (tab === "cart") renderCartPage();
  if (tab === "orders") renderMyOrders(true);
  if (changed) {
    replayAnimation(tab === "shop" ? $("grid") : pages[tab], "swap");
    scrollTo({ top: 0 });
  }
  syncMainButton();
}

export function openCart() {
  if (state.view) closeSheet();
  setTab("cart");
}

/* ---------- Главная кнопка: MainButton в Telegram, своя панель в браузере ---------- */
let mainButtonHandler = null;
function setMainButton(text, handler) {
  const button = telegram?.MainButton;
  if (!inTelegram || !button) return;
  if (mainButtonHandler) button.offClick(mainButtonHandler);
  mainButtonHandler = text ? handler : null;
  if (!text) return button.hide();
  button.setText(text);
  button.onClick(handler);
  button.show();
}

export function syncMainButton() {
  const count = cartCount(), total = formatPrice(cartTotal());
  const byView = { product: ["Добавить в корзину", addSelectedToCart], checkout: ["Подтвердить заказ", placeOrder] };
  if (state.isAdmin) setMainButton(null); // сотруднику корзина не нужна
  else if (state.view) setMainButton(...(byView[state.view] || [null]));
  else if (state.tab === "cart") setMainButton(count ? `Оформить заказ · ${total}` : null, openCheckout);
  else if (state.tab === "shop") setMainButton(count ? `Корзина · ${count} шт · ${total}` : null, openCart);
  else setMainButton(null);

  $("cartTabCount").textContent = count ? ` · ${count}` : "";
  $("cartBar").classList.toggle("show", !inTelegram && !state.isAdmin && !state.view && state.tab === "shop" && count > 0);
  $("cartBarText").textContent = `Корзина · ${count} шт`;
  $("cartBarTotal").textContent = total;
}

export function initNavigation() {
  // крестик, тап мимо шторки и Esc ведут на шаг назад: из чата заказа менеджер возвращается к списку заказов
  $("scrim").onclick = goBack;
  $("closeSheet").onclick = goBack;
  $("cartBarButton").onclick = openCart;
  $("tabs").onclick = (e) => {
    const tab = e.target.closest("[data-tab]")?.dataset.tab;
    if (tab && tab !== state.tab) { haptic(); setTab(tab); }
  };
  telegram?.BackButton?.onClick(goBack);
  document.addEventListener("keydown", (e) => e.key === "Escape" && state.view && goBack());
}
