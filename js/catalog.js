// Каталог: встроенные и добавленные товары, убранные варианты, остатки на складе.
import { BASE_PRODUCTS, CATEGORIES, COLOR_NAMES } from "./data.js?v=20261001b";
import { emit, escapeHtml } from "./core.js?v=20261001b";
import { state, api, saveCart, imageUrl } from "./state.js?v=20261001b";

export const CATEGORY_NAMES = Object.fromEntries(CATEGORIES);
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
    photoPosition: "50% 50%",
    sizes: sizes.length ? sizes : ["One size"],
  };
}

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
  state.staff = Array.isArray(data.staff) ? data.staff : [];
  state.catalogLoaded = true;
  rebuildCatalog();
}

export function rebuildCatalog() {
  state.catalogProducts = BASE_PRODUCTS.filter((p) => !state.hiddenProductIds.includes(p.id)).concat(state.customProducts);
  state.products = state.catalogProducts.map(forCustomers).filter(Boolean);
  if (state.catalogLoaded) fitCartToCatalog();
  emit("catalog");
}

export async function refreshCatalog() {
  try { applyCatalog(await api.catalog()); } catch {}
}
