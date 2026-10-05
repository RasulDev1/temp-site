// Точка входа магазина для покупателей: показываем встроенный каталог сразу, остальное догружаем с сервера.
// Страница сотрудников — отдельная (crm.html, js/crm.js): её код покупателям не загружается.
import { $, telegram, inTelegram, setupTelegram, storage } from "./core.js?v=20261001b";
import { rebuildCatalog, refreshCatalog } from "./catalog.js?v=20261001b";
import { initNavigation, syncMainButton, setTab } from "./nav.js?v=20261001b";
import { initShop } from "./shop.js?v=20261001b";
import { initCart } from "./cart.js?v=20261001b";

// Старые ссылки для сотрудников (…/?staff, …/?tasks из напоминаний бота, …/?order=номер) ведут на страницу сотрудников
const params = new URLSearchParams(location.search);
if (["staff", "tasks", "order"].some((p) => params.has(p)) || /^order_/.test(telegram?.initDataUnsafe?.start_param || "")) {
  location.replace("crm.html" + location.search);
} else {
  document.documentElement.classList.toggle("in-telegram", inTelegram);
  setupTelegram();
  initNavigation();
  initShop();
  initCart();
  rebuildCatalog();   // мгновенно: встроенные товары
  syncMainButton();
  refreshCatalog();   // добавленные товары, остатки, скрытые позиции
  document.addEventListener("visibilitychange", () => !document.hidden && refreshCatalog());
  // Кнопка «Мои заказы» в боте открывает магазин сразу на вкладке заказов (…/?tab=orders)
  if (params.get("tab") === "orders" || telegram?.initDataUnsafe?.start_param === "orders") setTab("orders");
  // На устройстве, где сотрудник входил, — ссылка на страницу сотрудников (например, в мини-приложении Telegram)
  if (storage.get("temp_staff_token", "")) $("staffEntry").hidden = false;
}
