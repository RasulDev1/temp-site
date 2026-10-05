// Точка входа страницы сотрудников (crm.html): директор и менеджеры. Покупатели открывают index.html (js/main.js),
// поэтому код заказов, клиентов, задач и аналитики у них не загружается.
import { $, telegram, inTelegram, setupTelegram, emit, on } from "./core.js?v=20261001b";
import { state, api, hasServer, useSupabase } from "./state.js?v=20261001b";
import { staffRestore } from "./supabase.js?v=20261001b";
import { rebuildCatalog, refreshCatalog } from "./catalog.js?v=20261001b";
import { initNavigation, syncMainButton } from "./nav.js?v=20261001b";
import { initShop } from "./shop.js?v=20261001b";
import { initCart } from "./cart.js?v=20261001b";
import { initAdminProducts } from "./admin-products.js?v=20261001b";
import { initAdminOrders, openAdminOrders } from "./admin-orders.js?v=20261001b";
import { hasGitHubKey } from "./github.js?v=20261001b";
import { initRoles } from "./roles.js?v=20261001b";
import { openStaffAccess } from "./staff-access.js?v=20261001b";
import { initStaffManager } from "./admin-staff.js?v=20261001b";
import { initAnalytics } from "./admin-analytics.js?v=20261001b";
import { initCustomers } from "./admin-customers.js?v=20261001b";
import { initTasks, openTasks } from "./admin-tasks.js?v=20261001b";
import { initDashboard, openDashboard } from "./admin-dashboard.js?v=20261001b";
import { initAdminBarSorting } from "./admin-bar-sort.js?v=20261001b";
import { openStaffLogin } from "./staff-login.js?v=20261001b";
import { initProductSorting } from "./sort.js?v=20261001b";

document.documentElement.classList.toggle("in-telegram", inTelegram);
setupTelegram();
initNavigation();
initShop();
initCart();
rebuildCatalog();   // мгновенно: встроенные товары
refreshCatalog();   // добавленные товары, остатки, скрытые позиции
document.addEventListener("visibilitychange", () => !document.hidden && refreshCatalog());

// Разделы сотрудника открываются на странице, в колонке рядом с меню — переносим «шторку» внутрь страницы
const sheet = $("sheet");
$("cartPage").parentElement.append(sheet);
sheet.setAttribute("aria-modal", "false");
syncMainButton();

/** Подсвечиваем в меню сотрудника раздел, который сейчас открыт */
const SECTION_BUTTONS = { dashboard: "adminHomeButton", adminOrders: "adminOrdersButton", chat: "adminOrdersButton", customers: "adminCustomersButton",
  tasks: "adminTasksButton", analytics: "adminAnalyticsButton", staff: "adminStaffButton" };
function syncActiveSection() {
  const active = SECTION_BUTTONS[state.view] || "adminProductsButton";
  document.querySelectorAll("#adminBar .admin-btn").forEach((b) => b.toggleAttribute("aria-current", b.id === active));
}
on("sheet", syncActiveSection);

const params = new URLSearchParams(location.search);
const focusOrder = Number(params.get("order") || telegram?.initDataUnsafe?.start_param?.replace(/^order_/, ""));

// GitHub Pages: сотрудники входят логином и паролем. Изменения в товарах без Supabase сохраняются в репозиторий ключом доступа.
if (!hasServer) {
  // С Supabase товары хранятся в базе — ключ GitHub не нужен, хватает входа сотрудника
  const withKey = (open) => (useSupabase || hasGitHubKey() ? open() : openStaffAccess("Чтобы сохранять изменения в товарах, добавьте на этом устройстве ключ доступа."));
  let staffToolsReady = false, ordersReady = false;
  initRoles(({ role }) => {
    state.isAdmin = role !== "customer";
    $("adminBar").hidden = !state.isAdmin;
    if (!state.isAdmin) return;
    // С Supabase заказы видны в «Заказах» (ключ GitHub не нужен); без него приходят в Telegram сообщениями
    $("adminOrdersButton").hidden = !useSupabase;
    $("adminCustomersButton").hidden = !useSupabase; // клиенты собираются из заказов в базе
    $("adminTasksButton").hidden = !useSupabase;
    $("adminHomeButton").hidden = !useSupabase; // дашборд считается по заказам в базе
    $("adminStaffButton").hidden = role !== "director";
    $("adminAnalyticsButton").hidden = role !== "director" || !useSupabase; // оплаты считает база
    syncActiveSection();
    syncMainButton();
    if (!staffToolsReady) {
      staffToolsReady = true;
      initAdminBarSorting(); // кнопки сотрудника можно переставлять
      initAdminProducts(withKey);
      initStaffManager();
      initAnalytics();
      if (useSupabase) initProductSorting(); // карточки товаров можно перетаскивать
    }
    if (useSupabase && !ordersReady) {
      ordersReady = true;
      initAdminOrders();
      initCustomers();
      initTasks();
      initDashboard();
      if (params.has("tasks")) openTasks(); // «Открыть задачи» из напоминания бота
      else if (focusOrder) openAdminOrders(focusOrder);
      else if (!state.view || state.view === "staffLogin") openDashboard(); // сотрудник начинает с «Главной»
    }
  });
  // Сохранённый вход сотрудника на этом устройстве; без него — форма входа
  if (useSupabase) staffRestore().then((session) => {
    if (session) { state.staffSession = session; emit("staffrole"); }
    else openStaffLogin();
  });
  else openStaffLogin();
}

// Свой сервер (server.js): кнопки администратора — только если сервер подтвердил права по подписи Telegram
if (hasServer && telegram?.initData) {
  api.me().then(({ isAdmin }) => {
    if (!isAdmin) return;
    state.isAdmin = true;
    $("adminBar").hidden = false;
    syncMainButton();
    initAdminProducts();
    initAdminOrders();
    // Кнопка «Открыть заказ» в уведомлении бота ведёт сюда с ?order=номер
    if (focusOrder) openAdminOrders(focusOrder);
  }).catch(() => {});
}
