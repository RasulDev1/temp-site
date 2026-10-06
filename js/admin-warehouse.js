// «Склад» (директор и менеджеры): сколько каждого товара есть по цветам и размерам, приёмка и журнал.
// Товар появляется на складе через «Принять на склад» (те же данные, что у товара, плюс количество).
// В «Товары» (каталог для покупателей) можно выставить только то, что есть на складе; количество там не вводится.
// Остатки уменьшаются сами при заказе и возвращаются при отказе или возврате (supabase-crm.sql).
import { $, formatPrice, escapeHtml, pluralize, haptic, toast, on } from "./core.js?v=20261001b";
import { CATEGORIES } from "./data.js?v=20261001b";
import { state, api, errorMessage } from "./state.js?v=20261001b";
import { CATEGORY_NAMES, colorName, swatchBackground, refreshCatalog } from "./catalog.js?v=20261001b";
import { productImage } from "./photos.js?v=20261001b";
import { sheetBody, openSheet } from "./nav.js?v=20261001b";
import { compressPhoto } from "./admin-products.js?v=20261001b";

const key = (color, size) => `${color}|${size}`;
const pcs = (n) => `${n} шт.`;
const day = (ms) => new Date(ms).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const findItem = (id) => state.warehouseProducts.find((p) => p.id === Number(id));
const qtyOf = (id) => state.stock[id]?.qty || null;
const combos = (p) => p.colors.flatMap((c) => p.sizes.map((s) => key(c, s)));
const totalOf = (p) => { const q = qtyOf(p.id); return q ? combos(p).reduce((n, k) => n + Math.max(0, Number(q[k]) || 0), 0) : null; };
/** В продаже: встроенный товар не убран из каталога, добавленный — выставлен */
export const isOnSale = (p) => (p.isCustom ? p.listed : !state.hiddenProductIds.includes(p.id));

let view = "list";  // list · item · receive · new · fix
let current = null; // открытый товар
let draft = null;   // форма: { qty } или новая карточка

async function save(action, successText) {
  try {
    await action();
    await refreshCatalog();
    haptic("success");
    toast(successText);
    return true;
  } catch (error) {
    toast(errorMessage(error));
    return false;
  }
}

/* ---------- Список ---------- */
function itemRow(p) {
  const total = totalOf(p);
  return `<button class="wh-row" data-wh-item="${p.id}"><span class="thumb">${productImage(p, null, { thumb: true })}</span>
    <span class="wh-main"><b>${p.name}</b><small>${CATEGORY_NAMES[p.category] || ""} · ${formatPrice(p.price)}</small></span>
    <span class="wh-side"><b class="${total === 0 ? "wh-zero" : ""}">${total == null ? "—" : pcs(total)}</b>
      <i class="wh-st${isOnSale(p) ? " on" : ""}">${isOnSale(p) ? "В продаже" : "Не в продаже"}</i></span></button>`;
}

function journalHtml(list) {
  if (!list.length) return "";
  const KIND = { new: "Принят новый товар", in: "Приёмка", fix: "Исправлено количество" };
  return `<h3 class="an-h">Журнал склада</h3>${list.slice(0, 40).map((r) => {
    const n = Object.values(r.qty || {}).reduce((a, b) => a + (Number(b) || 0), 0);
    return `<div class="wh-log"><span><b>${escapeHtml(r.name || "")}</b><small>${KIND[r.kind] || ""}${r.by ? ` · ${escapeHtml(r.by)}` : ""} · ${day(r.at)}</small></span>
      <b class="${n < 0 ? "wh-minus" : "wh-plus"}">${n > 0 ? "+" : ""}${n} шт.</b></div>`;
  }).join("")}`;
}

function listHtml() {
  const items = [...state.warehouseProducts].sort((a, b) => (totalOf(b) ?? -1) - (totalOf(a) ?? -1));
  const stocked = items.filter((p) => totalOf(p) != null);
  const total = stocked.reduce((n, p) => n + totalOf(p), 0);
  return `<div class="grab"></div><h2 class="p-name">Склад</h2>
    <p class="adm-sub">Всё, что есть в магазине, по цветам и размерам. Новый товар сначала принимают на склад, потом выставляют в «Товары».
      ${stocked.length ? `На складе <b>${pcs(total)}</b>.` : ""}</p>
    <button class="primary" data-wh-receive>Принять на склад</button>
    ${items.map(itemRow).join("")}
    ${journalHtml(state.receipts)}`;
}

/* ---------- Карточка товара на складе ---------- */
function gridHtml(p, cell) {
  return `<div class="vwrap"><table class="vtab">
    <thead><tr><th></th>${p.sizes.map((s) => `<th><span class="vhead">${s}</span></th>`).join("")}</tr></thead>
    <tbody>${p.colors.map((c) => `<tr><th><span class="vcolor"><i style="background:${swatchBackground(p, c)}"></i><span>${colorName(p, c)}</span></span></th>
      ${p.sizes.map((s) => `<td>${cell(c, s)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function itemHtml(p) {
  const q = qtyOf(p.id), total = totalOf(p), sale = isOnSale(p);
  const log = state.receipts.filter((r) => r.id === p.id);
  return `<div class="grab"></div><button class="adm-back" data-wh-back>← Склад</button>
    <div class="wh-head"><span class="thumb">${productImage(p, null, { thumb: true })}</span>
      <span><h2 class="p-name">${p.name}</h2><p class="adm-sub">${CATEGORY_NAMES[p.category] || ""} · ${formatPrice(p.price)}${state.costs?.[p.id] ? ` · закупка ${formatPrice(state.costs[p.id])}` : ""}</p>
      <i class="wh-st${sale ? " on" : ""}">${sale ? "В продаже" : "Не в продаже"}</i></span></div>
    ${q ? gridHtml(p, (c, s) => { const n = Math.max(0, Number(q[key(c, s)]) || 0); return `<span class="vcell wh-n${n ? "" : " off"}">${n}</span>`; })
      + `<p class="vtotal">Всего: <b>${pcs(total)}</b></p>`
      : `<p class="adm-sub">Количество ещё не заведено: товар продаётся без ограничений. Примите его на склад, чтобы вести учёт.</p>`}
    <button class="primary" data-wh-more>Принять ещё</button>
    ${q ? `<button class="ghost" data-wh-fix>Исправить количество</button>` : ""}
    <button class="ghost" data-wh-sale="${sale ? 0 : 1}">${sale ? "Снять с продажи" : "Выставить на продажу"}</button>
    ${p.isCustom ? `<button class="ghost danger" data-wh-delete>Удалить со склада</button>` : ""}
    <p class="adm-sub" style="margin-top:8px">${sale ? "Покупатели видят товар в каталоге. Ограничить продажу отдельных цветов и размеров можно в «Товарах»."
      : "Покупатели этот товар не видят. «Выставить на продажу» добавит его в каталог."}</p>
    ${journalHtml(log)}`;
}

/* ---------- Приёмка существующего товара и исправление количества ---------- */
function qtyFormHtml(p, fix) {
  const q = qtyOf(p.id) || {};
  return `<div class="grab"></div><button class="adm-back" data-wh-back>← ${p.name}</button>
    <h2 class="p-name">${fix ? "Исправить количество" : "Принять на склад"}</h2>
    <p class="adm-sub">${fix ? "Впишите, сколько штук сейчас на складе на самом деле (после пересчёта, брака, потери). Разница попадёт в журнал."
      : `${p.name}: впишите, сколько штук пришло каждого цвета и размера. Сейчас на складе ${pcs(totalOf(p) || 0)}. Новый цвет или размер — это отдельный товар.`}</p>
    ${gridHtml(p, (c, s) => {
      const k = key(c, s), n = fix ? Number(draft.qty[k] ?? q[k]) || 0 : draft.qty[k] || "";
      return `<input class="vqty${n ? "" : " zero"}" type="number" inputmode="numeric" min="0" value="${n}" placeholder="0" data-qty="${k}" aria-label="${colorName(p, c)}, ${s}">`;
    })}
    <p class="vtotal">${fix ? "Будет на складе" : "Принимаем"}: <b id="whTotal">${pcs(draftTotal())}</b></p>
    ${!fix && state.costs ? `<label class="field"><span>Закупочная цена за штуку, ₽ <small>видят только сотрудники</small></span>
      <input id="whCost" type="number" inputmode="decimal" min="0" step="0.01" value="${escapeHtml(draft.cost)}" placeholder="Не указана"></label>` : ""}
    <p class="hint" id="whHint"></p>
    <button class="primary" data-wh-save>${fix ? "Сохранить количество" : "Принять"}</button>`;
}

const draftTotal = () => Object.values(draft.qty).reduce((n, v) => n + (Number(v) || 0), 0);

async function saveQty(button) {
  const p = current, fix = view === "fix";
  const qty = Object.fromEntries(Object.entries(draft.qty).map(([k, v]) => [k, Math.max(0, Math.floor(Number(v) || 0))]));
  if (!fix && !draftTotal()) { $("whHint").textContent = "Впишите количество хотя бы для одного цвета и размера"; return haptic("medium"); }
  const cost = Math.round((Number(String(draft.cost || "").replace(",", ".")) || 0) * 100) / 100;
  button.disabled = true;
  button.textContent = "Сохраняем…";
  const ok = await save(async () => {
    if (fix) await api.stockSet(p.id, p.name, Object.fromEntries(combos(p).map((k) => [k, qty[k] ?? (Number(qtyOf(p.id)?.[k]) || 0)])));
    else await api.stockReceive(p.id, p.name, Object.fromEntries(Object.entries(qty).filter(([, n]) => n > 0)), combos(p));
    if (!fix && cost && state.costs && cost !== Number(state.costs[p.id])) { await api.productCostSet(p.id, cost); state.costs[p.id] = cost; }
  }, fix ? "Количество исправлено" : `Принято ${pcs(draftTotal())}`);
  if (ok) openItem(p.id);
  else { button.disabled = false; button.textContent = fix ? "Сохранить количество" : "Принять"; }
}

/* ---------- Принять на склад: выбор товара или новый ---------- */
function receiveHtml() {
  return `<div class="grab"></div><button class="adm-back" data-wh-back>← Склад</button>
    <h2 class="p-name">Принять на склад</h2>
    <button class="primary" data-wh-new>Новый товар</button>
    <p class="label">Или товар, который уже есть</p>
    <p class="adm-sub">Нажмите на товар, чтобы принять ещё штук тех же цветов и размеров.</p>
    ${state.warehouseProducts.map((p) => itemRow(p).replace("data-wh-item", "data-wh-pick")).join("")}`;
}

/* ---------- Новый товар: данные карточки, цвета с фото, размеры и количество ---------- */
const sizesOf = () => draft.sizes.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12);

function newHtml() {
  const d = draft, sizes = sizesOf();
  return `<div class="grab"></div><button class="adm-back" data-wh-back>← Склад</button>
    <h2 class="p-name">Новый товар на склад</h2>
    <p class="adm-sub">Покупатели его пока не увидят: после приёмки выставьте товар в «Товары».</p>
    <label class="field"><span>Название</span><input id="whName" maxlength="80" value="${escapeHtml(d.name)}" placeholder="Например, Футболка Base"></label>
    <div class="two">
      <label class="field"><span>Цена, ₽</span><input id="whPrice" type="number" inputmode="numeric" min="1" value="${escapeHtml(d.price)}" placeholder="2990"></label>
      <label class="field"><span>Старая цена, ₽</span><input id="whOld" type="number" inputmode="numeric" min="0" value="${escapeHtml(d.old)}" placeholder="Если есть скидка"></label>
    </div>
    ${state.costs ? `<label class="field"><span>Закупочная цена за штуку, ₽ <small>видят только сотрудники</small></span>
      <input id="whCost" type="number" inputmode="decimal" min="0" step="0.01" value="${escapeHtml(d.cost)}" placeholder="Не указана"></label>` : ""}
    <label class="field"><span>Категория</span><select id="whCat">${CATEGORIES.map(([id, title]) => `<option value="${id}" ${id === d.cat ? "selected" : ""}>${title}</option>`).join("")}</select></label>
    <label class="field"><span>Описание</span><textarea id="whDesc" maxlength="400" placeholder="Ткань, крой, для чего подходит">${escapeHtml(d.desc)}</textarea></label>
    <label class="field"><span>Размеры через запятую</span><input id="whSizes" value="${escapeHtml(d.sizes)}"></label>
    <label class="check-line"><input type="checkbox" id="whIsNew" ${d.isNew ? "checked" : ""}> Отметить как новинку</label>
    <p class="label">Цвета и фото</p>
    <p class="adm-sub">Для каждого цвета нужно своё фото. Первый цвет будет основным.</p>
    ${d.colors.map((row, i) => `<div class="crow">
      <input type="color" value="${row.hex}" data-row="${i}" aria-label="Цвет ${i + 1}">
      <input type="text" value="${escapeHtml(row.name)}" data-row="${i}" placeholder="Название цвета" maxlength="30">
      <label class="cphoto">${row.photo ? `<img src="${row.photo}" alt="">` : "Фото"}
        <input type="file" accept="image/jpeg,image/png,image/webp" data-photo-row="${i}" aria-label="Фото для цвета ${i + 1}"></label>
      ${d.colors.length > 1 ? `<button class="x" data-remove-color="${i}" aria-label="Убрать цвет">✕</button>` : "<span></span>"}</div>`).join("")}
    <button class="ghost" data-add-color>Добавить цвет</button>
    <p class="label">Количество</p>
    <p class="adm-sub">Сколько штук каждого цвета и размера принимаете.</p>
    ${sizes.length ? `<div class="vwrap"><table class="vtab">
      <thead><tr><th></th>${sizes.map((s) => `<th><span class="vhead">${escapeHtml(s)}</span></th>`).join("")}</tr></thead>
      <tbody>${d.colors.map((row, i) => `<tr><th><span class="vcolor"><i style="background:${row.hex}"></i><span>${escapeHtml(row.name || `Цвет ${i + 1}`)}</span></span></th>
        ${sizes.map((s) => { const n = d.qty[`${i}|${s}`] || ""; return `<td><input class="vqty${n ? "" : " zero"}" type="number" inputmode="numeric" min="0" value="${n}" placeholder="0" data-nqty="${i}|${escapeHtml(s)}"></td>`; }).join("")}</tr>`).join("")}</tbody>
    </table></div><p class="vtotal">Принимаем: <b id="whTotal">${pcs(draftTotal())}</b></p>` : `<p class="hint">Укажите размеры</p>`}
    <p class="hint" id="whHint"></p>
    <button class="primary" data-wh-create>Принять на склад</button>`;
}

function readNew() {
  const d = draft;
  d.name = $("whName").value; d.price = $("whPrice").value; d.old = $("whOld").value; d.cat = $("whCat").value;
  d.desc = $("whDesc").value; d.sizes = $("whSizes").value; d.isNew = $("whIsNew").checked;
  if ($("whCost")) d.cost = $("whCost").value;
}

async function createItem(button) {
  readNew();
  const d = draft, name = d.name.trim(), price = Math.round(d.price), old = Math.round(d.old) || 0, sizes = sizesOf();
  const hexes = d.colors.map((r) => r.hex.toUpperCase());
  const qty = {};
  d.colors.forEach((row, i) => sizes.forEach((s) => { qty[key(hexes[i], s)] = Math.max(0, Math.floor(Number(d.qty[`${i}|${s}`]) || 0)); }));
  const total = Object.values(qty).reduce((a, b) => a + b, 0);
  const problem = !name ? "Введите название товара"
    : !(price > 0) ? "Укажите цену больше нуля"
    : old && old <= price ? "Старая цена должна быть больше новой"
    : !sizes.length ? "Укажите размеры"
    : d.colors.some((r) => !r.name.trim()) ? "Дайте название каждому цвету"
    : new Set(hexes).size !== hexes.length ? "Цвета не должны повторяться"
    : d.colors.some((r) => !r.photo) ? "Добавьте фото для каждого цвета"
    : !total ? "Впишите количество хотя бы для одного цвета и размера" : "";
  if (problem) { $("whHint").textContent = problem; return haptic("medium"); }
  const cost = Math.round((Number(String(d.cost || "").replace(",", ".")) || 0) * 100) / 100;
  button.disabled = true;
  button.textContent = "Принимаем…";
  let id = null;
  const ok = await save(async () => {
    id = await api.warehouseCreate({
      name, price, old, cat: d.cat, desc: d.desc.trim(), isNew: d.isNew, sizes,
      colors: d.colors.map((r, i) => ({ hex: hexes[i], name: r.name.trim(), image: r.photo })),
    }, qty);
    if (cost && state.costs) { await api.productCostSet(id, cost); state.costs[id] = cost; }
  }, `Принято на склад: ${pcs(total)}`);
  if (ok) openItem(id);
  else { button.disabled = false; button.textContent = "Принять на склад"; }
}

/* ---------- Отрисовка и нажатия ---------- */
function render() {
  if (!state.view?.startsWith("warehouse")) return;
  if ((view === "item" || view === "more" || view === "fix") && !findItem(current?.id)) view = "list";
  if (view === "item") current = findItem(current.id);
  const scroll = $("sheet").scrollTop;
  sheetBody.innerHTML = view === "item" ? itemHtml(current) : view === "more" ? qtyFormHtml(current, false)
    : view === "fix" ? qtyFormHtml(current, true) : view === "receive" ? receiveHtml() : view === "new" ? newHtml() : listHtml();
  $("sheet").scrollTop = scroll;
}

function go(next, product = current) {
  view = next;
  current = product;
  if (next === "more" || next === "fix") draft = { qty: {}, cost: state.costs?.[product.id] ? String(state.costs[product.id]) : "" };
  if (next === "new") draft = { name: "", price: "", old: "", cost: "", cat: CATEGORIES[0][0], desc: "", sizes: "S, M, L, XL, XXL", isNew: true,
    colors: [{ hex: "#1B1B1F", name: "Чёрный", photo: "" }], qty: {} };
  openSheet(`warehouse-${next}`);
  render();
}

function openItem(id) { go("item", findItem(id)); }

async function onClick(e) {
  const t = e.target;
  if (t.closest("[data-wh-back]")) {
    haptic();
    return view === "more" || view === "fix" ? go("item") : go("list", null);
  }
  const item = t.closest("[data-wh-item]");
  if (item) { haptic(); return openItem(item.dataset.whItem); }
  const pick = t.closest("[data-wh-pick]");
  if (pick) { haptic(); return go("more", findItem(pick.dataset.whPick)); }
  if (t.closest("[data-wh-receive]")) { haptic(); return go("receive", null); }
  if (t.closest("[data-wh-new]")) { haptic(); return go("new", null); }
  if (t.closest("[data-wh-more]")) { haptic(); return go("more"); }
  if (t.closest("[data-wh-fix]")) { haptic(); return go("fix"); }
  if (t.closest("[data-wh-save]")) return saveQty(t.closest("[data-wh-save]"));
  if (t.closest("[data-wh-create]")) return createItem(t.closest("[data-wh-create]"));
  if (t.closest("[data-add-color]")) { readNew(); draft.colors.push({ hex: "#8A97A5", name: "", photo: "" }); return render(); }
  const remove = t.closest("[data-remove-color]");
  if (remove) { readNew(); draft.colors.splice(Number(remove.dataset.removeColor), 1); draft.qty = {}; return render(); }
  const sale = t.closest("[data-wh-sale]");
  if (sale) {
    sale.disabled = true;
    const on = sale.dataset.whSale === "1", p = current;
    const action = p.isCustom ? () => api.setListed(p.id, on)
      : () => api.setHiddenProducts(on ? state.hiddenProductIds.filter((x) => x !== p.id) : [...state.hiddenProductIds, p.id]);
    return save(action, on ? "Товар выставлен на продажу" : "Товар снят с продажи, он остался на складе");
  }
  const del = t.closest("[data-wh-delete]");
  if (del) {
    if (!del.hasAttribute("data-armed")) { del.setAttribute("data-armed", ""); del.textContent = "Точно удалить товар целиком?"; return haptic("medium"); }
    del.disabled = true;
    if (await save(() => api.deleteProduct(current.id), "Товар удалён")) go("list", null);
  }
}

function onInput(e) {
  const t = e.target;
  if (t.dataset.qty || t.dataset.nqty) {
    draft.qty[t.dataset.qty || t.dataset.nqty] = t.value;
    t.classList.toggle("zero", !(Number(t.value) > 0));
    if ($("whTotal")) $("whTotal").textContent = pcs(draftTotal());
    return;
  }
  if (t.id === "whCost" && view !== "new") draft.cost = t.value;
  if (view === "new") {
    const row = draft.colors[t.dataset.row];
    if (row) row[t.type === "color" ? "hex" : "name"] = t.value;
  }
}

async function onChange(e) {
  const t = e.target;
  if (view === "new" && t.id === "whSizes") { readNew(); return render(); } // таблица количества — по новым размерам
  if (view === "new" && t.dataset.row !== undefined) { readNew(); return render(); }
  const file = t.dataset.photoRow && t.files[0];
  if (!file) return;
  readNew();
  draft.colors[t.dataset.photoRow].photo = await compressPhoto(file).catch(() => "");
  if (!draft.colors[t.dataset.photoRow].photo) toast(errorMessage({ code: "unsupported_type" }));
  render();
}

export function openWarehouse(id = null) {
  sheetBody.onclick = onClick;
  sheetBody.oninput = onInput;
  sheetBody.onchange = onChange;
  if (id) openItem(id); else go("list", null);
}

export function initWarehouse() {
  $("adminWarehouseButton").onclick = () => { haptic(); openWarehouse(); };
  on("catalog", () => { if (state.view?.startsWith("warehouse") && view !== "new" && view !== "more" && view !== "fix") render(); });
}
