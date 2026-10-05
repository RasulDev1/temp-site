// «Отзывы» (директор и менеджеры): все отзывы покупателей о товарах, новые сверху.
// Можно ответить от имени магазина (ответ виден под отзывом в карточке товара), скрыть отзыв или вернуть его; директор может удалить.
import { $, escapeHtml, pluralize, haptic, toast } from "./core.js?v=20261001b";
import { state, api } from "./state.js?v=20261001b";
import { sheetBody, openSheet } from "./nav.js?v=20261001b";
import { isDirector } from "./roles.js?v=20261001b";
import { starsText, loadRatings } from "./reviews.js?v=20261001b";
import { productImage } from "./photos.js?v=20261001b";

const FILTERS = [["all", "Все"], ["noreply", "Без ответа"], ["low", "1–3 ★"], ["hidden", "Скрытые"]];
const ERRORS = {
  no_function: "Отзывы не настроены: в Supabase нужно запустить supabase-reviews.sql",
  forbidden: "Нет прав на это действие",
  network: "Нет связи с базой. Проверьте интернет и повторите.",
};
const errorText = (error) => ERRORS[error?.code] || "Не получилось. Повторите через минуту.";

let reviews = null, loadError = "", filter = "all";
let replyOpen = null; // id отзыва, на который пишут ответ
let replyDraft = "";

const day = (iso) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
const productOf = (id) => state.catalogProducts.find((p) => p.id === Number(id));
const MATCH = { all: () => true, noreply: (r) => !r.reply && !r.hidden, low: (r) => r.rating <= 3, hidden: (r) => r.hidden };

function reviewHtml(r) {
  const p = productOf(r.product);
  const replying = replyOpen === r.id;
  return `<article class="ord adm-rv${r.hidden ? " rv-hidden" : ""}" data-review-id="${r.id}">
    <div class="adm-rv-prod">${p ? `<span class="thumb">${productImage(p, null, { thumb: true })}</span>` : ""}<b>${p ? p.name : `Товар №${Number(r.product)}`}</b></div>
    <div class="rv-head"><b>${escapeHtml(r.author)}</b><span class="stars">${starsText(r.rating)}</span></div>
    ${r.body ? `<p class="rv-body">${escapeHtml(r.body)}</p>` : `<p class="adm-sub">Без текста, только оценка</p>`}
    <small class="adm-sub">${day(r.at)}${r.edited ? " · изменён" : ""}${r.hidden ? ` · скрыт${r.hidden_by ? ` (${escapeHtml(r.hidden_by)})` : ""}` : ""}</small>
    ${r.reply && !replying ? `<div class="rv-reply"><b>Ответ магазина${r.reply_by ? ` · ${escapeHtml(r.reply_by)}` : ""}</b><p>${escapeHtml(r.reply)}</p></div>` : ""}
    ${replying ? `<label class="field"><span>Ответ магазина (увидят все покупатели)</span>
        <textarea id="rvReply" maxlength="1000" placeholder="Спасибо за отзыв!">${escapeHtml(replyDraft)}</textarea></label>
      <div class="ord-actions"><button class="primary sm" data-rv-reply-save>Сохранить ответ</button><button class="ghost" data-rv-reply-cancel>Отмена</button></div>`
    : `<div class="rv-tools"><button class="link" data-rv-reply>${r.reply ? "Изменить ответ" : "Ответить"}</button>
        <button class="link" data-rv-hide="${r.hidden ? 0 : 1}">${r.hidden ? "Показать снова" : "Скрыть"}</button>
        ${isDirector() ? `<button class="link danger" data-rv-del>Удалить</button>` : ""}</div>`}
  </article>`;
}

function render() {
  if (state.view !== "reviews") return;
  const list = (reviews || []).filter(MATCH[filter]);
  const counts = Object.fromEntries(FILTERS.map(([id]) => [id, (reviews || []).filter(MATCH[id]).length]));
  const shown = (reviews || []).filter((r) => !r.hidden);
  const avg = shown.length ? shown.reduce((s, r) => s + r.rating, 0) / shown.length : 0;
  sheetBody.innerHTML = `<div class="grab"></div><h2 class="p-name">Отзывы${reviews?.length ? ` · ${reviews.length}` : ""}</h2>
    <p class="adm-sub">Отзывы оставляют покупатели, которым товар уже вручили. Они видны в карточке товара.${shown.length ? ` Средняя оценка: <b>★ ${avg.toFixed(1)}</b>.` : ""}</p>
    ${reviews?.length ? `<div class="order-groups" role="tablist">${FILTERS.map(([id, title]) =>
      `<button class="chip" role="tab" data-rv-filter="${id}" aria-pressed="${id === filter}">${title}${counts[id] ? ` · ${counts[id]}` : ""}</button>`).join("")}</div>` : ""}
    ${loadError ? `<p class="hint">${loadError}</p>` : !reviews ? `<p class="adm-sub">Загружаем…</p>`
      : !reviews.length ? `<p class="adm-sub" style="margin-top:12px">Отзывов пока нет. Покупатель может оставить отзыв в «Мои заказы», когда заказ вручён.</p>`
      : list.length ? list.map(reviewHtml).join("") : `<p class="adm-sub" style="margin-top:12px">Здесь пусто.</p>`}`;
}

async function load() {
  try {
    reviews = (await api.reviewsList()) || [];
    loadError = "";
  } catch (error) {
    loadError = errorText(error);
  }
  updateButton();
  render();
}

/** Счётчик на кнопке: отзывы без ответа */
function updateButton() {
  const button = $("adminReviewsButton");
  if (!button) return;
  const n = (reviews || []).filter(MATCH.noreply).length;
  button.textContent = `Отзывы${n ? ` · ${n}` : ""}`;
  button.title = n ? `${n} ${pluralize(n, "отзыв", "отзыва", "отзывов")} без ответа` : "";
}

async function act(button, action, done) {
  button.disabled = true;
  try {
    await action();
    haptic("success");
    if (done) toast(done);
  } catch (error) {
    button.disabled = false;
    return toast(errorText(error));
  }
  await load();
  loadRatings(); // звёзды в каталоге
}

function onClick(e) {
  const t = e.target;
  const f = t.closest("[data-rv-filter]")?.dataset.rvFilter;
  if (f) { haptic(); filter = f; return render(); }
  const card = t.closest("[data-review-id]");
  if (!card) return;
  const id = Number(card.dataset.reviewId);
  const r = reviews.find((x) => x.id === id);
  if (t.closest("[data-rv-reply]")) { haptic(); replyOpen = id; replyDraft = r.reply || ""; render(); return $("rvReply")?.focus(); }
  if (t.closest("[data-rv-reply-cancel]")) { haptic(); replyOpen = null; return render(); }
  if (t.closest("[data-rv-reply-save]")) {
    const text = $("rvReply").value.trim();
    return act(t.closest("[data-rv-reply-save]"), () => api.reviewReply(id, text), text ? "Ответ сохранён" : "Ответ убран")
      .then(() => { replyOpen = null; render(); });
  }
  const hide = t.closest("[data-rv-hide]");
  if (hide) return act(hide, () => api.reviewHide(id, hide.dataset.rvHide === "1"), hide.dataset.rvHide === "1" ? "Отзыв скрыт" : "Отзыв снова виден");
  const del = t.closest("[data-rv-del]");
  if (del) {
    if (!del.hasAttribute("data-armed")) { del.setAttribute("data-armed", ""); del.textContent = "Точно удалить?"; return haptic("medium"); }
    return act(del, () => api.reviewDelete(id), "Отзыв удалён");
  }
}

export function openReviews() {
  replyOpen = null;
  sheetBody.onclick = onClick;
  sheetBody.oninput = (e) => { if (e.target.id === "rvReply") replyDraft = e.target.value; };
  openSheet("reviews");
  render();
  load();
}

export function initReviews() {
  $("adminReviewsButton").onclick = () => { haptic(); openReviews(); };
  load();
}
