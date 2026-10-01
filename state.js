// Общее состояние приложения и запросы к серверу.
import { storage, telegram } from "./core.js";
import { API_URL } from "./config.js";
import { githubApi, githubPhotoUrl, repository } from "./github.js";

/** Есть ли сервер магазина. На GitHub Pages без API_URL его нет: только витрина и заказ сообщением менеджеру. */
const isGitHubPages = location.hostname.endsWith(".github.io");
export const hasServer = Boolean(API_URL) || !isGitHubPages;
export const serverUrl = (path) => (API_URL ? API_URL.replace(/\/+$/, "") : "") + path;
/** Адрес фото добавленного товара: с сервера или из репозитория (GitHub Pages) */
export const imageUrl = (path) => (hasServer ? serverUrl(path) : githubPhotoUrl(path));

export const state = {
  catalogProducts: [],  // встроенные (кроме скрытых) и добавленные товары — как их видит администратор
  products: [],         // то, что видит покупатель: без убранных цветов и размеров, с остатками
  customProducts: [],   // добавленные администратором
  hiddenProductIds: [], // скрытые встроенные товары
  variants: {},         // id → { offColors, offSizes, offCombos }
  stock: {},            // id → { qty: { "цвет|размер": штук } }
  catalogLoaded: false,

  cart: storage.get("temp_cart", []),
  myOrders: storage.get("temp_my_orders", []),
  category: "run",
  tab: "shop",          // "cart" | "orders" | "shop"
  view: null,           // открытая шторка: "product" | "checkout" | "done" | "admin" | ...
  isAdmin: false,
  staff: [],            // менеджеры: { telegramId, name, position } — назначает директор
  role: { role: "customer" }, // { role: "director" | "manager" | "customer", position, name }
  adminOrders: [],
};

export const saveCart = () => storage.set("temp_cart", state.cart);
export const findProduct = (id) => state.products.find((p) => p.id === id);
export const cartCount = () => state.cart.reduce((sum, line) => sum + line.qty, 0);
export const cartTotal = () => state.cart.reduce((sum, line) => sum + line.qty * (findProduct(line.id)?.price || 0), 0);

/* ---------- Сервер ---------- */
const HTTP_ERRORS = { 401: "unauthorized", 403: "forbidden", 409: "conflict", 413: "too_large", 415: "unsupported_type", 429: "rate_limited" };

async function request(method, path, body) {
  const response = await fetch(serverUrl(path), {
    method,
    cache: "no-store",
    headers: { "Content-Type": "application/json", "X-Telegram-Init-Data": telegram?.initData || "" },
    body: body && JSON.stringify(body),
  });
  if (!response.ok) throw { code: HTTP_ERRORS[response.status] || "server" };
  return response.json().catch(() => ({}));
}

const serverApi = {
  catalog: () => request("GET", "/api/catalog"),
  me: () => request("GET", "/api/me"),
  placeOrder: (order) => request("POST", "/api/orders", order),
  myOrders: () => request("GET", "/api/my-orders"),
  adminOrders: () => request("GET", "/api/orders"),
  acceptOrder: (num, payDetails, note) => request("POST", `/api/orders/${num}/accept`, { payDetails, note }),
  rejectOrder: (num, message) => request("POST", `/api/orders/${num}/reject`, { message }),
  createProduct: (product) => request("POST", "/api/products", product),
  deleteProduct: (id) => request("DELETE", `/api/products/${id}`),
  setHiddenProducts: (hidden) => request("PUT", "/api/hidden", { hidden }),
  setVariants: (id, variants) => request("PUT", `/api/variants/${id}`, variants),
  setStock: (id, qty) => request("PUT", `/api/stock/${id}`, qty ? { qty } : { tracked: false }),
};

/** На GitHub Pages каталог и управление товарами работают через репозиторий */
export const api = hasServer ? serverApi : { ...serverApi, ...githubApi };

export function errorMessage(error) {
  return {
    bad_key: "GitHub не принял ключ: он удалён, истёк или перевыпущен. Введите новый ключ в «Для сотрудников».",
    repo_not_found: `Ключ не видит репозиторий ${repository}. Проверьте в настройках ключа: Repository access — этот репозиторий, Contents — Read and write, и нажмите Update.`,
    github_offline: "Не удалось связаться с GitHub (api.github.com). Попробуйте другую сеть или VPN.",
    github_error: `GitHub ответил ошибкой ${error?.status || ""}${error?.detail ? ": " + error.detail : ""}. Повторите через минуту.`,
    unauthorized: "Откройте магазин в Telegram.",
    forbidden: hasServer ? "Нет прав на это действие. Войдите как администратор." : "Ключ GitHub не подходит или истёк. Войдите заново.",
    conflict: "Этот заказ уже обработан другим администратором.",
    too_large: "Фото слишком большое. Выберите файл поменьше.",
    unsupported_type: "Этот формат фото не подходит. Выберите JPG или PNG.",
    rate_limited: "Слишком много действий подряд. Подождите минуту и повторите.",
  }[error?.code] || "Не удалось выполнить действие. Проверьте соединение и повторите.";
}
