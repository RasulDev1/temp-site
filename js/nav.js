// Навигация: всплывающая шторка, вкладки «Корзина · Мои заказы · Товары», главная кнопка Telegram.
import { $, telegram, inTelegram, formatPrice, haptic, replayAnimation } from "./core.js";
import { state, cartCount, cartTotal } from "./state.js";
import { addSelectedToCart } from "./shop.js";
import { renderCartPage, openCheckout, placeOrder, renderMyOrders } from "./cart.js";

export const sheetBody = $("sheetBody");
let onBack = null;

/** Открывает шторку. back — куда вести по кнопке «Назад» Telegram (по умолчанию закрыть). */
export function openSheet(view, back = null) {
  state.view = view;
  onBack = back;
  $("scrim").classList.add("open");
  $("sheet").classList.add("open");
  $("sheet").scrollTop = 0;
  telegram?.BackButton?.show();
  syncMainButton();
}

export function closeSheet() {
  state.view = null;
  $("scrim").classList.remove("open");
  $("sheet").classList.remove("open");
  telegram?.BackButton?.hide();
  syncMainButton();
}

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
  if (state.view) setMainButton(...(byView[state.view] || [null]));
  else if (state.tab === "cart") setMainButton(count ? `Оформить заказ · ${total}` : null, openCheckout);
  else if (state.tab === "shop") setMainButton(count ? `Корзина · ${count} шт · ${total}` : null, openCart);
  else setMainButton(null);

  $("cartTabCount").textContent = count ? ` · ${count}` : "";
  $("cartBar").classList.toggle("show", !inTelegram && !state.view && state.tab === "shop" && count > 0);
  $("cartBarText").textContent = `Корзина · ${count} шт`;
  $("cartBarTotal").textContent = total;
}

export function initNavigation() {
  $("scrim").onclick = closeSheet;
  $("closeSheet").onclick = closeSheet;
  $("cartBarButton").onclick = openCart;
  $("tabs").onclick = (e) => {
    const tab = e.target.closest("[data-tab]")?.dataset.tab;
    if (tab && tab !== state.tab) { haptic(); setTab(tab); }
  };
  telegram?.BackButton?.onClick(() => (onBack ? onBack() : closeSheet()));
  document.addEventListener("keydown", (e) => e.key === "Escape" && state.view && closeSheet());
}
