// Точка входа: показываем встроенный каталог сразу, остальное догружаем с сервера.
import { $, telegram, inTelegram, setupTelegram, emit } from "./core.js?v=20261001b";
import { state, api, hasServer, useSupabase } from "./state.js?v=20261001b";
import { staffRestore } from "./supabase.js?v=20261001b";
import { rebuildCatalog, refreshCatalog } from "./catalog.js?v=20261001b";
import { initNavigation, syncMainButton, setTab } from "./nav.js?v=20261001b";
import { initShop } from "./shop.js?v=20261001b";
import { initCart } from "./cart.js?v=20261001b";
import { initAdminProducts } from "./admin-products.js?v=20261001b";
import { initAdminOrders, openAdminOrders } from "./admin-orders.js?v=20261001b";
import { hasGitHubKey } from "./github.js?v=20261001b";
import { initRoles } from "./roles.js?v=20261001b";
import { openStaffAccess } from "./staff-access.js?v=20261001b";
import { initStaffManager } from "./admin-staff.js?v=20261001b";
import { openStaffLogin } from "./staff-login.js?v=20261001b";
import { initProductSorting } from "./sort.js?v=20261001b";

document.documentElement.classList.toggle("in-telegram", inTelegram);
setupTelegram();
initNavigation();
initShop();
initCart();
rebuildCatalog();   // мгновенно: встроенные товары
syncMainButton();
refreshCatalog();   // добавленные товары, остатки, скрытые позиции
document.addEventListener("visibilitychange", () => !document.hidden && refreshCatalog());

/** Режим сотрудника: вместо вкладок покупателя (корзина, мои заказы, товары) — кнопки сотрудника, без корзины */
function setStaffMode(on) {
  document.documentElement.classList.toggle("staff-mode", on);
  if (on && state.tab !== "shop") setTab("shop");
  syncMainButton();
}

// GitHub Pages: сотрудники входят по ссылке …/staff.html (или ?staff) логином и паролем,
// все остальные — покупатели. Изменения в товарах сохраняются в репозиторий ключом доступа на устройстве.
if (!hasServer) {
  // С Supabase товары хранятся в базе — ключ GitHub не нужен, хватает входа сотрудника
  const withKey = (open) => (useSupabase || hasGitHubKey() ? open() : openStaffAccess("Чтобы сохранять изменения в товарах, добавьте на этом устройстве ключ доступа."));
  let staffToolsReady = false, ordersReady = false;
  initRoles(({ role }) => {
    state.isAdmin = role !== "customer";
    $("adminBar").hidden = !state.isAdmin;
    // С Supabase заказы видны в «Заказах» (ключ GitHub не нужен); без него приходят в Telegram сообщениями
    $("adminOrdersButton").hidden = !useSupabase;
    $("adminStaffButton").hidden = role !== "director";
    setStaffMode(state.isAdmin);
    if (state.isAdmin && !staffToolsReady) {
      staffToolsReady = true;
      initAdminProducts(withKey);
      initStaffManager();
      if (useSupabase) initProductSorting(); // карточки товаров можно перетаскивать
    }
    if (state.isAdmin && useSupabase && !ordersReady) {
      ordersReady = true;
      initAdminOrders();
      const focusOrder = Number(new URLSearchParams(location.search).get("order") || telegram?.initDataUnsafe?.start_param?.replace(/^order_/, ""));
      if (focusOrder) openAdminOrders(focusOrder);
    }
  });
  // Сохранённый вход сотрудника на этом устройстве; по ссылке для сотрудников без входа — форма входа
  const wantsStaffLogin = new URLSearchParams(location.search).has("staff");
  if (useSupabase) staffRestore().then((session) => {
    if (session) { state.staffSession = session; emit("staffrole"); }
    else if (wantsStaffLogin) openStaffLogin();
  });
  else if (wantsStaffLogin) openStaffLogin();
}

// Кнопки администратора — только если сервер подтвердил права по подписи Telegram
if (hasServer && telegram?.initData) {
  api.me().then(({ isAdmin }) => {
    if (!isAdmin) return;
    state.isAdmin = true;
    $("adminBar").hidden = false;
    setStaffMode(true);
    initAdminProducts();
    initAdminOrders();
    // Кнопка «Открыть заказ» в уведомлении бота ведёт сюда с ?order=номер
    const focusOrder = Number(new URLSearchParams(location.search).get("order") || telegram.initDataUnsafe?.start_param?.replace(/^order_/, ""));
    if (focusOrder) openAdminOrders(focusOrder);
  }).catch(() => {});
}
