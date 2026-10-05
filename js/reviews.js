// Отзывы о товарах (supabase-reviews.sql): звёзды в каталоге, отзывы в карточке товара, форма отзыва.
// Оставить отзыв может только покупатель, которому этот товар уже вручили; один отзыв на товар, его можно изменить.
import { $, escapeHtml, pluralize, haptic, toast, emit } from "./core.js?v=20261001b";
import { state, api, useSupabase } from "./state.js?v=20261001b";

const SHOWN = 5; // сколько отзывов видно сразу, остальные — по «Показать все»
const ERRORS = {
  not_bought: "Отзыв можно оставить после того, как товар вручат",
  bad_rating: "Поставьте оценку от 1 до 5 звёзд",
  network: "Нет связи. Проверьте интернет и повторите.",
};

let current = null; // { id, data, error, form, all } — отзывы открытой карточки товара

export const starsText = (n) => "★".repeat(Math.round(n)) + "☆".repeat(5 - Math.round(n));
const reviewsWord = (n) => `${n} ${pluralize(n, "отзыв", "отзыва", "отзывов")}`;
const day = (iso) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });

/** Оценки всех товаров для каталога */
export async function loadRatings() {
  if (!useSupabase) return;
  try {
    state.ratings = (await api.reviewsSummary()) || {};
    emit("ratings");
  } catch {}
}

/** Оценки, которые поставил этот покупатель (для «Мои заказы») */
export async function loadMyReviews() {
  if (!useSupabase) return;
  try { state.myReviews = (await api.myReviews()) || {}; } catch {}
}

/** «★ 4.8 · 12» под названием товара в каталоге */
export function ratingHtml(id) {
  const r = state.ratings[id];
  return r?.count ? `<p class="rate"><b>★ ${Number(r.avg).toFixed(1)}</b> · ${r.count}</p>` : "";
}

/** «★★★★★ 4.8 · 12 отзывов» под ценой в карточке товара */
export function ratingLineHtml(id) {
  const r = state.ratings[id];
  return r?.count ? `<button class="rate-line" data-rv-scroll><span class="stars">${starsText(r.avg)}</span> ${Number(r.avg).toFixed(1)} · ${reviewsWord(r.count)}</button>` : "";
}

const reviewHtml = (r) => `<div class="rv-item">
  <div class="rv-head"><b>${escapeHtml(r.author)}</b><span class="stars" aria-label="${r.rating} из 5">${starsText(r.rating)}</span></div>
  ${r.body ? `<p class="rv-body">${escapeHtml(r.body)}</p>` : ""}
  <small>${day(r.at)}</small>
  ${r.reply ? `<div class="rv-reply"><b>Ответ магазина</b><p>${escapeHtml(r.reply)}</p></div>` : ""}
</div>`;

function formHtml() {
  const f = current.form;
  return `<div class="rv-form">
    <p class="label">${current.data?.mine ? "Изменить отзыв" : "Ваша оценка"}</p>
    <div class="rv-stars" role="radiogroup">${[1, 2, 3, 4, 5].map((n) =>
      `<button class="rv-star${n <= f.rating ? " on" : ""}" data-rv-star="${n}" role="radio" aria-checked="${n === f.rating}" aria-label="${n} из 5">★</button>`).join("")}</div>
    <textarea id="rvText" maxlength="1000" placeholder="Расскажите, как сидит, подошёл ли размер, как качество">${escapeHtml(f.body)}</textarea>
    <p class="hint" id="rvHint"></p>
    <div class="ord-actions"><button class="primary sm" data-rv-send>Отправить отзыв</button><button class="ghost" data-rv-cancel>Отмена</button></div>
  </div>`;
}

function mineHtml(mine) {
  return `<div class="rv-mine"><p class="label">Ваш отзыв${mine.hidden ? " · скрыт магазином" : ""}</p>${reviewHtml(mine)}
    <div class="rv-tools"><button class="link" data-rv-edit>Изменить</button><button class="link" data-rv-delete>Удалить</button></div></div>`;
}

function render() {
  const box = $("reviews");
  if (!box || !current) return;
  const { data, error, form, all } = current;
  if (error) { box.innerHTML = `<h3 class="rv-title">Отзывы</h3><p class="adm-sub">${error}</p>`; return; }
  if (!data) { box.innerHTML = `<h3 class="rv-title">Отзывы</h3><p class="adm-sub">Загружаем…</p>`; return; }
  const others = data.reviews.filter((r) => r.id !== data.mine?.id);
  const r = state.ratings[current.id];
  const own = form ? formHtml() : data.mine ? mineHtml(data.mine)
    : data.can_review ? `<button class="ghost rv-write" data-rv-write>Оставить отзыв</button>` : "";
  box.innerHTML = `<h3 class="rv-title">Отзывы${r?.count ? ` <span>★ ${Number(r.avg).toFixed(1)} · ${r.count}</span>` : ""}</h3>
    ${own}
    ${others.length ? (all ? others : others.slice(0, SHOWN)).map(reviewHtml).join("")
      : !data.mine ? `<p class="adm-sub">Отзывов пока нет.${data.can_review ? "" : " Оставить отзыв можно после покупки этого товара."}</p>` : ""}
    ${!all && others.length > SHOWN ? `<button class="link rv-more" data-rv-all>Показать все ${reviewsWord(others.length)}</button>` : ""}`;
}

/** Отзывы в открытой карточке товара. writeNow — сразу открыть форму (из «Мои заказы»). */
export async function showProductReviews(id, writeNow = false) {
  if (!useSupabase || !$("reviews")) return;
  current = { id, data: null, error: "", form: null, all: false, writeNow };
  render();
  try {
    const data = await api.productReviews(id);
    if (current?.id !== id) return;
    current.data = { reviews: data?.reviews || [], can_review: Boolean(data?.can_review), mine: data?.mine || null };
    if (writeNow && (current.data.can_review || current.data.mine)) openForm();
  } catch (error) {
    if (current?.id !== id) return;
    current.error = error?.code === "no_function" ? "" : "Не удалось загрузить отзывы.";
    if (!current.error) { $("reviews").innerHTML = ""; current = null; return; }
  }
  render();
  if (writeNow) $("reviews")?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function openForm() {
  const mine = current.data?.mine;
  current.form = { rating: mine?.rating || 0, body: mine?.body || "" };
}

async function send(button) {
  const f = current.form;
  f.body = $("rvText").value.trim();
  if (!f.rating) { $("rvHint").textContent = "Поставьте оценку: нажмите на звёзды"; return haptic("medium"); }
  button.disabled = true;
  button.textContent = "Отправляем…";
  try {
    await api.reviewSave(current.id, f.rating, f.body);
    haptic("success");
    toast(current.data?.mine ? "Отзыв изменён" : "Спасибо за отзыв!");
    state.myReviews[current.id] = f.rating;
    current.form = null;
    await Promise.all([loadRatings(), showProductReviews(current.id)]);
    emit("myreviews");
  } catch (error) {
    button.disabled = false;
    button.textContent = "Отправить отзыв";
    $("rvHint").textContent = ERRORS[error?.code] || "Не получилось отправить. Повторите через минуту.";
  }
}

async function remove(button) {
  if (!button.hasAttribute("data-armed")) { button.setAttribute("data-armed", ""); button.textContent = "Точно удалить?"; return haptic("medium"); }
  button.disabled = true;
  try {
    await api.reviewDelete(current.data.mine.id);
    haptic("success");
    toast("Отзыв удалён");
    delete state.myReviews[current.id];
    await Promise.all([loadRatings(), showProductReviews(current.id)]);
    emit("myreviews");
  } catch {
    button.disabled = false;
    toast("Не получилось удалить. Повторите через минуту.");
  }
}

/** Нажатия в блоке отзывов карточки товара; true — нажатие обработано */
export function handleReviewTap(e) {
  const t = e.target;
  if (t.closest("[data-rv-scroll]")) { haptic(); $("reviews")?.scrollIntoView({ block: "start", behavior: "smooth" }); return true; }
  if (!current || !t.closest("#reviews")) return false;
  const star = t.closest("[data-rv-star]");
  if (star) {
    haptic();
    current.form.body = $("rvText").value;
    current.form.rating = Number(star.dataset.rvStar);
    render();
    return true;
  }
  if (t.closest("[data-rv-write]") || t.closest("[data-rv-edit]")) { haptic(); openForm(); render(); $("rvText")?.focus(); return true; }
  if (t.closest("[data-rv-cancel]")) { haptic(); current.form = null; render(); return true; }
  if (t.closest("[data-rv-send]")) { send(t.closest("[data-rv-send]")); return true; }
  if (t.closest("[data-rv-delete]")) { remove(t.closest("[data-rv-delete]")); return true; }
  if (t.closest("[data-rv-all]")) { haptic(); current.all = true; render(); return true; }
  return false;
}
