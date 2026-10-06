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
  fitToPhone();
  fitHeader();
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

/** В Telegram на телефоне магазин масштабируется под ширину экрана: макет рассчитан на 390 px (обычный iPhone),
    на маленьком телефоне всё чуть мельче, на большом — чуть крупнее. Планшеты и компьютер — без масштаба. */
function fitToPhone() {
  if (!inTelegram) return;
  const apply = () => {
    const width = window.innerWidth, zoom = width >= 600 ? 1 : Math.min(1.15, Math.max(0.82, width / 390));
    document.documentElement.style.zoom = zoom === 1 ? "" : zoom.toFixed(3);
    document.documentElement.style.setProperty("--fit", zoom.toFixed(3)); // vw и vh в CSS делим на него, иначе масштаб удвоится
  };
  apply();
  addEventListener("resize", apply);
}

/** Логотип и адрес в шапке — в одну строку и в пределах экрана: если места не хватает, логотип немного уменьшается.
    Шрифты и размеры экранов у всех разные, поэтому проверяем по факту, а не заранее заданными цифрами. */
function fitHeader() {
  const row = document.querySelector(".hero-top"), brand = row?.querySelector(".brand");
  if (!brand) return;
  const fit = () => {
    brand.style.fontSize = "";
    let size = parseFloat(getComputedStyle(brand).fontSize);
    while (row.scrollWidth > row.clientWidth + 0.5 && size > 22) brand.style.fontSize = `${--size}px`;
  };
  fit();
  document.fonts?.ready.then(fit);
  // ширина экрана, шрифт адреса и т. п. поменялись — подгоняем заново
  if (window.ResizeObserver) new ResizeObserver(() => fit()).observe(row.querySelector(".shop") || row);
  addEventListener("resize", fit);
}
