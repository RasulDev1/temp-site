// Каталог: встроенные и добавленные товары, убранные варианты, остатки на складе.
import { BASE_PRODUCTS, CATEGORIES, COLOR_NAMES } from "./data.js?v=20261001b";
import { emit, escapeHtml } from "./core.js?v=20261001b";
import { state, api, saveCart, imageUrl } from "./state.js?v=20261001b";

export const CATEGORY_NAMES = Object.fromEntries(CATEGORIES);
let priceOverrides = {}; // id → { price, old }: цены и скидки, которые поменял администратор
let productOrder = [];   // порядок карточек, который задали сотрудники перетаскиванием (id товаров)
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const colorName = (product, color) => product.colorNames?.[color] || COLOR_NAMES[color] || color;
export const swatchBackground = (product, color) => product.swatches?.[color] || color;
export const stockLeft = (product, color, size) =>
  product.stock ? Math.max(0, Number(product.stock[`${color}|${size}`]) || 0) : Infinity;

/** Размер нельзя купить в этом цвете: распродан, убран администратором или закончился на складе */
export const isUnavailable = (product, color, size) =>
  product.soldOutSizes?.includes(size) || product.offCombos?.has(`${color}|${size}`) || stockLeft(product, color, size) <= 0;

export const isSoldOut = (product) =>
  Boolean(product.stock) && product.colors.every((c) => product.sizes.every((s) => isUnavailable(product, c, s)));

/** Товар, добавленный администратором, в формате встроенного каталога */
function fromServer(raw) {
  const colors = (raw.colors || []).filter((c) => HEX_COLOR.test(c.hex) && c.image);
  if (!raw.num || !raw.name || !colors.length) return null;
  const hex = (c) => c.hex.toUpperCase();
  const sizes = (raw.sizes || []).map(escapeHtml).filter(Boolean);
  return {
    id: raw.num,
    isCustom: true,
    category: CATEGORY_NAMES[raw.cat] ? raw.cat : "street",
    name: escapeHtml(raw.name),
    description: escapeHtml(raw.desc || ""),
    price: Math.max(0, Math.round(raw.price) || 0),
    oldPrice: Math.round(raw.old) || 0,
    isNew: Boolean(raw.isNew),
    colors: colors.map(hex),
    colorNames: Object.fromEntries(colors.map((c) => [hex(c), escapeHtml(c.name || hex(c))])),
    colorPhotos: Object.fromEntries(colors.map((c) => [hex(c), imageUrl(c.image)])),
    photo: imageUrl(colors[0].image),
    // уменьшенные копии для каталога и корзины (есть у товаров, добавленных после 09.10.2026)
    thumbs: Object.fromEntries(colors.filter((c) => c.thumb).map((c) => [imageUrl(c.image), imageUrl(c.thumb)])),
    photoPosition: "50% 50%",
    sizes: sizes.length ? sizes : ["One size"],
    listed: raw.listed !== false, // false — товар есть на складе, но ещё не выставлен на продажу
  };
}

/** Цена со скидкой: old — цена до скидки (0 — скидки нет) */
function withPrice(product) {
  const o = priceOverrides[product.id];
  const price = Math.round(o?.price);
  if (!(price > 0)) return product;
  const old = Math.round(o.old) || 0;
  return { ...product, price, oldPrice: old > price ? old : 0 };
}

/** Исходная цена товара — без правок администратора */
export const originalPrice = (id) => {
  const p = BASE_PRODUCTS.find((x) => x.id === id) || state.customProducts.find((x) => x.id === id);
  return p ? { price: p.price, old: p.oldPrice || 0 } : null;
};

/** Применяет убранные варианты и остатки. null — у товара не осталось ни одного сочетания. */
function forCustomers(product) {
  const qty = state.stock[product.id]?.qty;
  const v = state.variants[product.id];
  if (!v && !qty) return product;
  const colors = product.colors.filter((c) => !v?.offColors?.includes(c));
  const sizes = product.sizes.filter((s) => !v?.offSizes?.includes(s));
  const offCombos = new Set(v?.offCombos || []);
  if (!colors.some((c) => sizes.some((s) => !offCombos.has(`${c}|${s}`)))) return null;
  const edited = Boolean(v?.offColors?.length || v?.offSizes?.length || offCombos.size);
  return { ...product, colors, sizes, offCombos, edited, stock: qty };
}

/** Убирает из корзины то, чего больше нет, и уменьшает количество до остатка */
function fitCartToCatalog() {
  let changed = false;
  state.cart = state.cart.filter((line) => {
    const product = state.products.find((p) => p.id === line.id);
    const available = product && product.colors.includes(line.color) && product.sizes.includes(line.size)
      && !isUnavailable(product, line.color, line.size);
    if (!available) return !(changed = true);
    const left = stockLeft(product, line.color, line.size);
    if (line.qty > left) { line.qty = left; changed = true; }
    return true;
  });
  if (changed) saveCart();
}

export function applyCatalog(data) {
  state.customProducts = (data.products || []).map(fromServer).filter(Boolean);
  state.hiddenProductIds = (data.hidden || []).map(Number);
  state.variants = data.variants || {};
  state.stock = data.stock || {};
  state.receipts = Array.isArray(data.receipts) ? data.receipts : [];
  state.staff = Array.isArray(data.staff) ? data.staff : [];
  priceOverrides = data.prices && typeof data.prices === "object" ? data.prices : {};
  productOrder = Array.isArray(data.order) ? data.order.map(Number) : [];
  state.catalogLoaded = true;
  rebuildCatalog();
}

/** Товары по порядку, заданному сотрудниками; новые и не упорядоченные — в конце, как были */
function sortByOrder(products) {
  const position = new Map(productOrder.map((id, i) => [id, i]));
  return products.map((p, i) => [p, position.get(p.id) ?? productOrder.length + i])
    .sort((a, b) => a[1] - b[1]).map(([p]) => p);
}

/** Сразу показывает новый порядок (сохраняется отдельно через api.setOrder) */
export function setProductOrder(order) {
  productOrder = order.map(Number);
  rebuildCatalog();
}

export function rebuildCatalog() {
  state.catalogProducts = sortByOrder(BASE_PRODUCTS.filter((p) => !state.hiddenProductIds.includes(p.id))
    .concat(state.customProducts.filter((p) => p.listed)).map(withPrice));
  // склад: все товары, в том числе не выставленные на продажу и убранные из каталога
  state.warehouseProducts = BASE_PRODUCTS.concat(state.customProducts).map(withPrice);
  state.products = state.catalogProducts.map(forCustomers).filter(Boolean);
  if (state.catalogLoaded) fitCartToCatalog();
  emit("catalog");
}

export async function refreshCatalog() {
  try { applyCatalog(await api.catalog()); } catch {}
}
