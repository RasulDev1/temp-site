// Администратор: список товаров, цвета/размеры/остатки, добавление и удаление товаров.
import { $, formatPrice, escapeHtml, pluralize, haptic, toast, on } from "./core.js?v=20261001b";
import { BASE_PRODUCTS, CATEGORIES } from "./data.js?v=20261001b";
import { state, api, errorMessage, hasServer, useSupabase } from "./state.js?v=20261001b";
import { CATEGORY_NAMES, colorName, swatchBackground, refreshCatalog, originalPrice } from "./catalog.js?v=20261001b";
import { productImage } from "./photos.js?v=20261001b";
import { sheetBody, openSheet, closeSheet } from "./nav.js?v=20261001b";

/** Кнопка удаления срабатывает со второго нажатия */
function confirmTwice(button, question) {
  if (button.hasAttribute("data-armed")) return true;
  sheetBody.querySelectorAll("[data-armed]").forEach((b) => { b.removeAttribute("data-armed"); b.textContent = b.dataset.label; });
  button.dataset.label = button.textContent;
  button.setAttribute("data-armed", "");
  button.textContent = question;
  haptic("medium");
  return false;
}

async function runAction(action, successText) {
  try {
    await action();
    await refreshCatalog();
    haptic("success");
    toast(hasServer || useSupabase ? successText : `${successText}. У покупателей — через 1–2 минуты`);
    return true;
  } catch (error) {
    toast(errorMessage(error));
    return false;
  }
}

const discountPercent = (price, old) => Math.round((1 - price / old) * 100);

/* ---------- Список товаров ---------- */
function productSummary(p) {
  const e = state.products.find((x) => x.id === p.id) || p;
  const inStock = e.stock && Object.entries(e.stock)
    .filter(([key]) => { const [c, s] = key.split("|"); return e.colors.includes(c) && e.sizes.includes(s); })
    .reduce((sum, [, n]) => sum + Math.max(0, Number(n) || 0), 0);
  const price = p.oldPrice ? `${formatPrice(p.price)} (−${discountPercent(p.price, p.oldPrice)}%, было ${formatPrice(p.oldPrice)})` : formatPrice(p.price);
  return [CATEGORY_NAMES[p.category], price,
    `${e.colors.length} ${pluralize(e.colors.length, "цвет", "цвета", "цветов")}, ${e.sizes.length} ${pluralize(e.sizes.length, "размер", "размера", "размеров")}`,
    e.edited && "изменён", e.stock && `на складе ${inStock} шт.`].filter(Boolean).join(" · ");
}

const productRow = (p, buttons) => `<div class="adm-row"><div class="thumb">${productImage(p, null, { thumb: true })}</div>
  <div><p class="t">${p.name}</p><p class="s">${productSummary(p)}</p></div>${buttons}</div>`;

export function openAdminProducts() {
  const hidden = BASE_PRODUCTS.filter((p) => state.hiddenProductIds.includes(p.id));
  sheetBody.innerHTML = `<div class="grab"></div>
    <h2 class="p-name">Товары в каталоге</h2>
    <p class="adm-sub">${state.catalogProducts.length} шт. «Изменить» — цена и скидка, цвета, размеры и количество на складе. «Удалить» — весь товар.</p>
    <button class="primary" id="addProduct">Добавить товар</button>
    ${hasServer || useSupabase ? "" : `<p class="adm-sub" style="margin-top:10px">Изменения сохраняются в репозиторий GitHub, покупатели увидят их через 1–2 минуты.</p>`}
    ${state.catalogProducts.map((p) => productRow(p, `<span class="adm-btns">
      <button class="adm-del" data-edit="${p.id}">Изменить</button><button class="adm-del" data-delete="${p.id}">Удалить</button></span>`)).join("")}
    ${hidden.length ? `<p class="label">Удалённые из каталога</p><p class="adm-sub">Встроенные товары можно вернуть.</p>
      ${hidden.map((p) => productRow(p, `<button class="adm-del" data-restore="${p.id}">Вернуть</button>`)).join("")}` : ""}`;
  sheetBody.onclick = async (e) => {
    const edit = e.target.closest("[data-edit]"), remove = e.target.closest("[data-delete]"), restore = e.target.closest("[data-restore]");
    if (e.target.id === "addProduct") openNewProductForm();
    if (edit) openVariantEditor(Number(edit.dataset.edit));
    if (remove && confirmTwice(remove, "Точно удалить?")) {
      remove.disabled = true;
      await deleteProduct(Number(remove.dataset.delete));
    }
    if (restore) {
      restore.disabled = true;
      const id = Number(restore.dataset.restore);
      await runAction(() => api.setHiddenProducts(state.hiddenProductIds.filter((x) => x !== id)), "Товар снова в каталоге");
    }
  };
  openSheet("admin");
}

/** Встроенный товар скрывается (его можно вернуть), добавленный — удаляется вместе с фото */
function deleteProduct(id) {
  const product = state.catalogProducts.find((p) => p.id === id);
  return product.isCustom
    ? runAction(() => api.deleteProduct(id), "Товар удалён")
    : runAction(() => api.setHiddenProducts([...state.hiddenProductIds, id]), "Товар удалён из каталога");
}

/* ---------- Режим сотрудника: «Товары» — это сам каталог; правка по нажатию на карточку, «Добавить» справа от категорий ---------- */
const staffPage = () => document.documentElement.classList.contains("staff-mode");
/** Куда вернуться из правки товара: у сотрудника — в каталог, иначе — к списку товаров */
const backTarget = () => (staffPage() ? null : openAdminProducts);
const backToProducts = () => (staffPage() ? closeSheet() : openAdminProducts());

/** Удалённые встроенные товары: их можно вернуть в каталог */
function openHiddenProducts() {
  const hidden = BASE_PRODUCTS.filter((p) => state.hiddenProductIds.includes(p.id));
  if (!hidden.length) return state.view === "adminHidden" && closeSheet();
  sheetBody.innerHTML = `<div class="grab"></div>
    <button class="adm-back" id="backToProducts">← Товары</button>
    <h2 class="p-name">Удалённые товары</h2>
    <p class="adm-sub">Встроенные товары, убранные из каталога. Их можно вернуть.</p>
    ${hidden.map((p) => productRow(p, `<button class="adm-del" data-restore="${p.id}">Вернуть</button>`)).join("")}`;
  sheetBody.onclick = async (e) => {
    const restore = e.target.closest("[data-restore]");
    if (e.target.id === "backToProducts") closeSheet();
    if (restore) {
      restore.disabled = true;
      const id = Number(restore.dataset.restore);
      await runAction(() => api.setHiddenProducts(state.hiddenProductIds.filter((x) => x !== id)), "Товар снова в каталоге");
    }
  };
  openSheet("adminHidden");
}

function syncCatalogTools() {
  const count = state.hiddenProductIds.filter((id) => BASE_PRODUCTS.some((p) => p.id === id)).length;
  $("hiddenProductsButton").hidden = !count;
  $("hiddenProductsButton").textContent = `Удалённые · ${count}`;
}

/* ---------- Цвета, размеры и остатки: таблица «цвет × размер» ---------- */
// С Supabase количество ведётся в «Складе»: здесь его не вводят, а только по желанию ограничивают продажу цветов и размеров
const warehouseMode = () => useSupabase;
let draft = null;
const toggle = (set, value) => (set.has(value) ? set.delete(value) : set.add(value));
const key = (color, size) => `${color}|${size}`;

function openVariantEditor(id) {
  const product = state.catalogProducts.find((p) => p.id === id);
  if (!product) return;
  const v = state.variants[id] || {}, qty = state.stock[id]?.qty;
  draft = {
    product,
    offColors: new Set(v.offColors), offSizes: new Set(v.offSizes), offCombos: new Set(v.offCombos),
    trackStock: Boolean(qty), qty: { ...qty },
    // цена до скидки и цена со скидкой (пусто — скидки нет)
    price: String(product.oldPrice || product.price), sale: product.oldPrice ? String(product.price) : "",
    cost: state.costs?.[id] ? String(state.costs[id]) : "", // закупочная цена (видят только сотрудники)
  };
  renderVariantEditor();
  sheetBody.onclick = async (e) => {
    const t = e.target, { product: p } = draft;
    if (t.id === "backToProducts") return backToProducts();
    if (t.closest("[data-off-color]")) toggle(draft.offColors, t.closest("[data-off-color]").dataset.offColor);
    else if (t.closest("[data-off-size]")) toggle(draft.offSizes, t.closest("[data-off-size]").dataset.offSize);
    else if (t.closest("[data-off-combo]:not(:disabled)")) toggle(draft.offCombos, t.closest("[data-off-combo]").dataset.offCombo);
    else if (t.id === "trackStock") {
      draft.trackStock = t.checked;
      p.colors.forEach((c) => p.sizes.forEach((s) => (draft.qty[key(c, s)] ??= 0)));
    } else if (t.dataset.discount) {
      const base = Math.round(Number(draft.price)) || 0, d = Number(t.dataset.discount);
      if (d && !(base > 0)) { $("priceHint").textContent = "Сначала укажите цену"; return haptic("medium"); }
      // цену со скидкой округляем до десятков: 2990 −20% → 2390
      draft.sale = d ? String(Math.max(1, Math.min(base - 1, Math.round(base * (1 - d / 100) / 10) * 10))) : "";
    } else if (t.id === "saveVariants") return saveVariants(t);
    else if (t.id === "unlistProduct") {
      if (!confirmTwice(t, "Точно снять с продажи?")) return;
      t.disabled = true;
      const action = p.isCustom ? () => api.setListed(p.id, false) : () => api.setHiddenProducts([...state.hiddenProductIds, p.id]);
      if (await runAction(action, "Товар снят с продажи, он остался на складе")) backToProducts();
      return;
    } else if (t.id === "deleteProduct") {
      if (confirmTwice(t, "Точно удалить весь товар?") && await deleteProduct(p.id)) backToProducts();
      return;
    } else return;
    haptic();
    renderVariantEditor();
  };
  sheetBody.oninput = (e) => {
    if (e.target.id === "priceBase" || e.target.id === "priceSale" || e.target.id === "priceCost") {
      draft[{ priceBase: "price", priceSale: "sale", priceCost: "cost" }[e.target.id]] = e.target.value;
      $("pricePreview").innerHTML = pricePreview();
      if ($("costPreview")) $("costPreview").innerHTML = costPreview();
      $("priceHint").textContent = "";
      return;
    }
    const cell = e.target.dataset.qty;
    if (!cell) return;
    const n = Math.max(0, Math.min(99999, Math.floor(Number(e.target.value) || 0)));
    draft.qty[cell] = n;
    e.target.classList.toggle("zero", n === 0);
    $("stockTotal").textContent = stockTotal();
  };
  openSheet("adminVariants", backTarget());
}

const activeColors = () => draft.product.colors.filter((c) => !draft.offColors.has(c));
const activeSizes = () => draft.product.sizes.filter((s) => !draft.offSizes.has(s));
/** Сколько штук доступно покупателям с учётом ограничений */
const saleTotal = () => activeColors().reduce((sum, c) => sum + activeSizes().reduce((n, s) =>
  n + (draft.offCombos.has(key(c, s)) ? 0 : Math.max(0, Number(draft.qty[key(c, s)]) || 0)), 0), 0);
const stockTotal = () => activeColors().reduce((sum, c) => sum + activeSizes().reduce((n, s) => n + (Number(draft.qty[key(c, s)]) || 0), 0), 0);

function variantCell(color, size) {
  const d = draft, label = `${colorName(d.product, color)}, ${size}`;
  const wholeOff = d.offColors.has(color) || d.offSizes.has(size);
  if (warehouseMode()) {
    const off = wholeOff || d.offCombos.has(key(color, size));
    const n = d.qty && Object.keys(d.qty).length ? Math.max(0, Number(d.qty[key(color, size)]) || 0) : null;
    return `<button class="vcell wh-cell${off ? " off" : ""}${n === 0 ? " empty" : ""}" data-off-combo="${key(color, size)}" ${wholeOff ? "disabled" : ""}
      aria-pressed="${!off}" aria-label="${label}" title="${n == null ? "" : `На складе: ${n} шт.`}">${off ? "—" : n == null ? "✓" : n}</button>`;
  }
  if (d.trackStock) {
    if (wholeOff) return `<span class="vcell off"></span>`;
    const n = Number(d.qty[key(color, size)]) || 0;
    return `<input class="vqty${n ? "" : " zero"}" type="number" inputmode="numeric" min="0" value="${n}" data-qty="${key(color, size)}" aria-label="${label}: количество">`;
  }
  const off = wholeOff || d.offCombos.has(key(color, size));
  return `<button class="vcell${off ? " off" : ""}" data-off-combo="${key(color, size)}" ${wholeOff ? "disabled" : ""} aria-pressed="${!off}" aria-label="${label}">${off ? "" : "✓"}</button>`;
}

/** Что увидит покупатель с введёнными ценами */
function pricePreview() {
  const base = Math.round(Number(draft.price)) || 0, sale = Math.round(Number(draft.sale)) || 0;
  if (!(base > 0)) return "Укажите цену.";
  if (!sale) return `Без скидки. Покупатель увидит: <b>${formatPrice(base)}</b>`;
  if (sale >= base) return "Цена со скидкой должна быть меньше обычной цены.";
  return `Покупатель увидит: <b>${formatPrice(sale)}</b> <s>${formatPrice(base)}</s> и отметку «−${discountPercent(sale, base)}%»`;
}

/** Наценка с закупочной цены: сколько магазин зарабатывает с одной вещи */
function costPreview() {
  const cost = Number(String(draft.cost).replace(",", ".")) || 0, price = Math.round(Number(draft.sale)) || Math.round(Number(draft.price)) || 0;
  if (!cost) return "Укажите, за сколько закупаете вещь: тогда в «Аналитике» и на «Главной» будет видна выручка (продажа минус закупка).";
  if (!price) return "";
  const margin = price - cost;
  return `С одной вещи: <b>${formatPrice(Math.round(margin))}</b> (${margin >= 0 ? "наценка" : "убыток"} ${Math.round(Math.abs(margin) / cost * 100)}%)`;
}

const costEditorHtml = () => !state.costs ? "" : `<label class="field"><span>Закупочная цена, ₽ <small>видят только сотрудники</small></span>
      <input id="priceCost" type="number" inputmode="decimal" min="0" step="0.01" value="${escapeHtml(draft.cost)}" placeholder="Не указана"></label>
    <p class="adm-sub" id="costPreview">${costPreview()}</p>`;

const priceEditorHtml = () => !api.setPrice ? "" : `<p class="label">Цена и скидка</p>
    <div class="two">
      <label class="field"><span>Цена, ₽</span><input id="priceBase" type="number" inputmode="numeric" min="1" value="${escapeHtml(draft.price)}"></label>
      <label class="field"><span>Цена со скидкой, ₽</span><input id="priceSale" type="number" inputmode="numeric" min="0" value="${escapeHtml(draft.sale)}" placeholder="Без скидки"></label>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">
      ${[10, 15, 20, 30, 50].map((d) => `<button class="adm-del" data-discount="${d}">−${d}%</button>`).join("")}
      <button class="adm-del" data-discount="0">Без скидки</button>
    </div>
    <p class="adm-sub" id="pricePreview" style="margin-top:8px">${pricePreview()}</p>
    <p class="hint" id="priceHint"></p>
    ${costEditorHtml()}
    <p class="label">Цвета, размеры и остатки</p>`;

/** Цена, которую нужно сохранить: undefined — не менялась, null — вернуть исходную, иначе { price, old } */
function priceToSave() {
  const { product: p } = draft;
  const base = Math.round(Number(draft.price)) || 0, sale = Math.round(Number(draft.sale)) || 0;
  if (!(base > 0) || base > 10000000) return { error: "Укажите цену больше нуля" };
  if (sale && sale >= base) return { error: "Цена со скидкой должна быть меньше обычной цены" };
  const value = sale ? { price: sale, old: base } : { price: base, old: 0 };
  if (value.price === p.price && value.old === (p.oldPrice || 0)) return { value: undefined };
  const original = originalPrice(p.id);
  return { value: original && original.price === value.price && original.old === value.old ? null : value };
}

function renderVariantEditor() {
  const { product: p, trackStock } = draft, scroll = $("sheet").scrollTop;
  sheetBody.innerHTML = `<div class="grab"></div>
    <button class="adm-back" id="backToProducts">← ${staffPage() ? "Товары" : "Все товары"}</button>
    <h2 class="p-name">${p.name}</h2>
    ${priceEditorHtml()}
    ${warehouseMode() ? `<p class="adm-sub">В клетках — сколько штук на складе. Количество меняется в «Складе». Нажмите на клетку, чтобы не продавать это сочетание
      (оно останется на складе). Нажмите на цвет или размер, чтобы убрать его целиком.</p>` : `<label class="check-line"><input type="checkbox" id="trackStock" ${trackStock ? "checked" : ""}> Вести учёт количества</label>
    <p class="adm-sub">${trackStock ? `Впишите, сколько штук каждого сочетания на складе. 0 — нет в наличии. ${hasServer || state.costs ? "Остатки уменьшаются сами при каждом заказе и возвращаются при отказе или возврате." : "После продажи уменьшайте остаток здесь вручную."}`
      : "Нажмите на клетку, чтобы убрать сочетание. Без учёта количества товар продаётся без ограничений."} Нажмите на цвет или размер, чтобы убрать его целиком.</p>`}
    <div class="vwrap"><table class="vtab">
      <thead><tr><th></th>${p.sizes.map((s) => `<th><button class="vhead${draft.offSizes.has(s) ? " off" : ""}" data-off-size="${s}">${s}</button></th>`).join("")}</tr></thead>
      <tbody>${p.colors.map((c) => `<tr><th><button class="vcolor${draft.offColors.has(c) ? " off" : ""}" data-off-color="${c}">
        <i style="background:${swatchBackground(p, c)}"></i><span>${colorName(p, c)}</span></button></th>
        ${p.sizes.map((s) => `<td>${variantCell(c, s)}</td>`).join("")}</tr>`).join("")}</tbody>
    </table></div>
    ${trackStock ? `<p class="vtotal">${warehouseMode() ? "В продаже" : "Всего на складе"}: <b id="stockTotal">${warehouseMode() ? saleTotal() : stockTotal()}</b> шт.</p>` : ""}
    <p class="hint" id="hint"></p>
    <button class="primary" id="saveVariants">Сохранить</button>
    ${warehouseMode() ? `<button class="ghost" id="unlistProduct">Снять с продажи</button>
    <p class="adm-sub">Товар пропадёт из каталога, но останется на складе.</p>`
      : `<button class="ghost danger" id="deleteProduct">Удалить весь товар</button>`}`;
  $("sheet").scrollTop = scroll;
}

async function saveVariants(button) {
  const { product: p, trackStock } = draft, colors = activeColors(), sizes = activeSizes();
  // При учёте количества роль «убрать сочетание» играет остаток 0
  const offCombos = trackStock && !warehouseMode() ? [] : [...draft.offCombos].filter((k) => { const [c, s] = k.split("|"); return colors.includes(c) && sizes.includes(s); });
  if (!colors.some((c) => sizes.some((s) => !offCombos.includes(key(c, s))))) {
    $("hint").textContent = "Должно остаться хотя бы одно сочетание цвета и размера. Чтобы убрать всё, удалите товар целиком.";
    return haptic("medium");
  }
  const price = api.setPrice ? priceToSave() : { value: undefined };
  if (price.error) {
    $("priceHint").textContent = price.error;
    $("priceBase").scrollIntoView({ block: "center" });
    return haptic("medium");
  }
  const cost = Math.round((Number(String(draft.cost).replace(",", ".")) || 0) * 100) / 100;
  if (cost < 0 || cost > 10000000) { $("priceHint").textContent = "Проверьте закупочную цену"; return haptic("medium"); }
  const costChanged = state.costs && cost !== (Number(state.costs[p.id]) || 0);
  const qty = trackStock ? Object.fromEntries(p.colors.flatMap((c) => p.sizes.map((s) => [key(c, s), Number(draft.qty[key(c, s)]) || 0]))) : null;
  button.disabled = true;
  button.textContent = "Сохраняем…";
  const saved = await runAction(async () => {
    if (price.value !== undefined) await api.setPrice(p.id, price.value);
    if (costChanged) {
      await api.productCostSet(p.id, cost);
      if (cost) state.costs[p.id] = cost; else delete state.costs[p.id];
    }
    await api.setVariants(p.id, { offColors: [...draft.offColors], offSizes: [...draft.offSizes], offCombos });
    if (!warehouseMode()) await api.setStock(p.id, qty);
  }, "Изменения сохранены");
  if (saved) backToProducts();
  else { button.disabled = false; button.textContent = "Сохранить"; }
}

/* ---------- «+ Добавить» со склада: в каталог попадает только то, что принято на склад ---------- */
const warehouseTotal = (p) => { const q = state.stock[p.id]?.qty; return q ? Object.values(q).reduce((n, v) => n + Math.max(0, Number(v) || 0), 0) : null; };
const notOnSale = () => state.warehouseProducts.filter((p) => (p.isCustom ? !p.listed : state.hiddenProductIds.includes(p.id)));

function openFromWarehouse() {
  const list = notOnSale();
  sheetBody.innerHTML = `<div class="grab"></div>
    <button class="adm-back" id="backToProducts">← Товары</button>
    <h2 class="p-name">Добавить товар в каталог</h2>
    <p class="adm-sub">Выставить на продажу можно только то, что есть на складе. Новый товар сначала примите в «Склад».</p>
    ${list.length ? list.map((p) => { const n = warehouseTotal(p); return productRow(p, `<button class="adm-del" data-list="${p.id}" ${n === 0 ? "title=\"На складе 0 шт.\"" : ""}>Выставить</button>`)
      .replace(`<p class="s">${productSummary(p)}</p>`, `<p class="s">${formatPrice(p.price)} · ${n == null ? "количество не заведено" : `на складе ${n} шт.`}</p>`); }).join("")
      : `<p class="adm-sub" style="margin-top:12px">На складе нет товаров, которые ещё не продаются.</p>`}
    <button class="ghost" id="toWarehouse">Открыть «Склад»</button>`;
  sheetBody.onclick = async (e) => {
    const t = e.target, listBtn = t.closest("[data-list]");
    if (t.id === "backToProducts") return backToProducts();
    if (t.id === "toWarehouse") return state.openWarehouse?.();
    if (!listBtn) return;
    listBtn.disabled = true;
    const id = Number(listBtn.dataset.list), p = state.warehouseProducts.find((x) => x.id === id);
    const action = p.isCustom ? () => api.setListed(id, true) : () => api.setHiddenProducts(state.hiddenProductIds.filter((x) => x !== id));
    // сразу открываем товар: можно ограничить продажу отдельных цветов и размеров
    if (await runAction(action, "Товар выставлен на продажу")) openVariantEditor(id);
    else listBtn.disabled = false;
  };
  openSheet("adminFromWarehouse", backTarget());
}

/* ---------- Новый товар ---------- */
let colorRows = [];

function openNewProductForm() {
  colorRows = [{ hex: "#1B1B1F", name: "Чёрный", photo: "" }];
  sheetBody.innerHTML = `<div class="grab"></div>
    <button class="adm-back" id="backToProducts">← ${staffPage() ? "Товары" : "Все товары"}</button>
    <h2 class="p-name">Новый товар</h2>
    <label class="field"><span>Название</span><input id="newName" maxlength="80" placeholder="Например, Футболка Base"></label>
    <div class="two">
      <label class="field"><span>Цена, ₽</span><input id="newPrice" type="number" inputmode="numeric" min="1" placeholder="2990"></label>
      <label class="field"><span>Старая цена, ₽</span><input id="newOldPrice" type="number" inputmode="numeric" min="0" placeholder="Если есть скидка"></label>
    </div>
    <label class="field"><span>Категория</span><select id="newCategory">${CATEGORIES.map(([id, title]) => `<option value="${id}">${title}</option>`).join("")}</select></label>
    <label class="field"><span>Описание</span><textarea id="newDescription" maxlength="400" placeholder="Ткань, крой, для чего подходит"></textarea></label>
    <label class="field"><span>Размеры через запятую</span><input id="newSizes" value="S, M, L, XL, XXL"></label>
    <label class="check-line"><input type="checkbox" id="newIsNew" checked> Отметить как новинку</label>
    <p class="label">Цвета и фото</p>
    <p class="adm-sub">Для каждого цвета нужно своё фото. Первый цвет будет основным.</p>
    <div id="colorRows"></div>
    <button class="ghost" id="addColor">Добавить цвет</button>
    <p class="hint" id="hint"></p>
    <button class="primary" id="publishProduct">Опубликовать товар</button>`;
  renderColorRows();
  sheetBody.onclick = (e) => {
    const t = e.target;
    if (t.id === "backToProducts") backToProducts();
    if (t.id === "addColor") { colorRows.push({ hex: "#8A97A5", name: "", photo: "" }); renderColorRows(); }
    if (t.dataset.removeColor) { colorRows.splice(Number(t.dataset.removeColor), 1); renderColorRows(); }
    if (t.id === "publishProduct") publishProduct(t);
  };
  sheetBody.oninput = (e) => {
    const row = colorRows[e.target.dataset.row];
    if (row) row[e.target.type === "color" ? "hex" : "name"] = e.target.value;
  };
  sheetBody.onchange = async (e) => {
    const file = e.target.dataset.photoRow && e.target.files[0];
    if (!file) return;
    colorRows[e.target.dataset.photoRow].photo = await compressPhoto(file).catch(() => "");
    if (!colorRows[e.target.dataset.photoRow].photo) toast(errorMessage({ code: "unsupported_type" }));
    renderColorRows();
  };
  openSheet("adminNewProduct", backTarget());
}

function renderColorRows() {
  $("colorRows").innerHTML = colorRows.map((row, i) => `<div class="crow">
    <input type="color" value="${row.hex}" data-row="${i}" aria-label="Цвет ${i + 1}">
    <input type="text" value="${escapeHtml(row.name)}" data-row="${i}" placeholder="Название цвета" maxlength="30">
    <label class="cphoto">${row.photo ? `<img src="${row.photo}" alt="">` : "Фото"}
      <input type="file" accept="image/jpeg,image/png,image/webp" data-photo-row="${i}" aria-label="Фото для цвета ${i + 1}"></label>
    ${colorRows.length > 1 ? `<button class="x" data-remove-color="${i}" aria-label="Убрать цвет">✕</button>` : "<span></span>"}
  </div>`).join("");
}

/** Уменьшает фото до 1400 px и переводит в JPEG — каталог грузится быстрее */
export function compressPhoto(file, maxSide = 1400) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = Object.assign(document.createElement("canvas"), {
        width: Math.round(image.naturalWidth * scale), height: Math.round(image.naturalHeight * scale),
      });
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(image.src);
      resolve(canvas.toDataURL("image/jpeg", 0.86));
    };
    image.onerror = reject;
    image.src = URL.createObjectURL(file);
  });
}

async function publishProduct(button) {
  const name = $("newName").value.trim(), price = Math.round($("newPrice").value), oldPrice = Math.round($("newOldPrice").value) || 0;
  const hexes = colorRows.map((r) => r.hex.toUpperCase());
  const problem = !name ? "Введите название товара"
    : !(price > 0) ? "Укажите цену больше нуля"
    : oldPrice && oldPrice <= price ? "Старая цена должна быть больше новой"
    : colorRows.some((r) => !r.name.trim()) ? "Дайте название каждому цвету"
    : new Set(hexes).size !== hexes.length ? "Цвета не должны повторяться"
    : colorRows.some((r) => !r.photo) ? "Добавьте фото для каждого цвета" : "";
  if (problem) { $("hint").textContent = problem; return haptic("medium"); }

  button.disabled = true;
  button.textContent = "Публикуем…";
  const published = await runAction(() => api.createProduct({
    name, price, old: oldPrice, cat: $("newCategory").value, desc: $("newDescription").value.trim(), isNew: $("newIsNew").checked,
    sizes: $("newSizes").value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12),
    colors: colorRows.map((r, i) => ({ hex: hexes[i], name: r.name.trim(), image: r.photo })),
  }), "Товар опубликован");
  if (published) backToProducts();
  else { button.disabled = false; button.textContent = "Опубликовать товар"; }
}

/** guard — проверка перед открытием (на GitHub Pages: есть ли на устройстве ключ доступа) */
export function initAdminProducts(guard = (open) => open()) {
  // у сотрудника «Товары» показывают каталог на странице; список товаров во всплывающем окне — для старого входа администратора
  $("adminProductsButton").onclick = () => { haptic(); staffPage() ? closeSheet() : guard(openAdminProducts); };
  $("addProductButton").hidden = false;
  $("addProductButton").onclick = () => { haptic(); guard(warehouseMode() ? openFromWarehouse : openNewProductForm); };
  $("hiddenProductsButton").onclick = () => { haptic(); guard(openHiddenProducts); };
  state.editProduct = (id) => guard(() => openVariantEditor(id)); // нажатие на карточку в каталоге
  // закупочные цены (supabase-crm.sql); без настройки поле не показываем
  if (api.productCosts) api.productCosts().then((costs) => { state.costs = costs || {}; }).catch(() => { state.costs = null; });
  syncCatalogTools();
  on("catalog", () => {
    syncCatalogTools();
    if (state.view === "admin") openAdminProducts();
    if (state.view === "adminHidden") openHiddenProducts();
    if (state.view === "adminFromWarehouse") openFromWarehouse();
  });
}
