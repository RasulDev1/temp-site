// Точка входа: показываем встроенный каталог сразу, остальное догружаем с сервера.
import { $, telegram, inTelegram, setupTelegram, emit } from "./core.js";
import { state, api, hasServer, useSupabase } from "./state.js";
import { supabaseLogin } from "./supabase.js";
import { rebuildCatalog, refreshCatalog } from "./catalog.js";
import { initNavigation, syncMainButton } from "./nav.js";
import { initShop } from "./shop.js";
import { initCart } from "./cart.js";
import { initAdminProducts } from "./admin-products.js";
import { initAdminOrders, openAdminOrders } from "./admin-orders.js";
import { hasGitHubKey } from "./github.js";
import { initRoles } from "./roles.js";
import { openStaffAccess } from "./staff-access.js";
import { initStaffManager } from "./admin-staff.js";

document.documentElement.classList.toggle("in-telegram", inTelegram);
setupTelegram();
initNavigation();
initShop();
initCart();
rebuildCatalog();   // мгновенно: встроенные товары
syncMainButton();
refreshCatalog();   // добавленные товары, остатки, скрытые позиции
document.addEventListener("visibilitychange", () => !document.hidden && refreshCatalog());

// GitHub Pages: роли по Telegram ID — директор (config.js), менеджеры (назначает директор), покупатели.
// Сохранять изменения можно только с ключом доступа на устройстве.
if (!hasServer) {
  $("staffLink").hidden = false;
  $("staffLink").onclick = () => openStaffAccess();
  const withKey = (open) => (hasGitHubKey() ? open() : openStaffAccess("Чтобы сохранять изменения, добавьте на этом устройстве ключ доступа."));
  let staffToolsReady = false, ordersReady = false;
  initRoles(({ role }) => {
    state.isAdmin = role !== "customer";
    $("adminBar").hidden = !state.isAdmin;
    // С Supabase заказы видны в «Заказах» (ключ GitHub не нужен); без него приходят в Telegram сообщениями
    $("adminOrdersButton").hidden = !useSupabase;
    $("adminStaffButton").hidden = role !== "director";
    if (state.isAdmin && !staffToolsReady) {
      staffToolsReady = true;
      initAdminProducts(withKey);
      initStaffManager(withKey);
    }
    if (state.isAdmin && useSupabase && !ordersReady) {
      ordersReady = true;
      initAdminOrders();
      const focusOrder = Number(new URLSearchParams(location.search).get("order") || telegram?.initDataUnsafe?.start_param?.replace(/^order_/, ""));
      if (focusOrder) openAdminOrders(focusOrder);
    }
  });
  // Supabase: база проверяет подпись Telegram и сообщает роль (менеджер, админ) — она добавляется к роли из config.js
  if (useSupabase) supabaseLogin().then((me) => {
    if (!me) return;
    state.dbRole = me.role;
    emit("dbrole");
  });
}

// Кнопки администратора — только если сервер подтвердил права по подписи Telegram
if (hasServer && telegram?.initData) {
  api.me().then(({ isAdmin }) => {
    if (!isAdmin) return;
    state.isAdmin = true;
    $("adminBar").hidden = false;
    initAdminProducts();
    initAdminOrders();
    // Кнопка «Открыть заказ» в уведомлении бота ведёт сюда с ?order=номер
    const focusOrder = Number(new URLSearchParams(location.search).get("order") || telegram.initDataUnsafe?.start_param?.replace(/^order_/, ""));
    if (focusOrder) openAdminOrders(focusOrder);
  }).catch(() => {});
}
