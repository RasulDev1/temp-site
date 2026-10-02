// Переписка по заказу (Supabase): покупатель и менеджер пишут друг другу и отправляют файлы,
// например чек об оплате. Писать можно, когда менеджер принял заказ (отправил реквизиты) и после оплаты.
// Файлы хранятся в базе: фото сжимаются до ~2000 px, PDF — до 3 МБ.
import { $, escapeHtml, formatDate, haptic, toast, storage, emit } from "./core.js?v=20261001b";
import { state } from "./state.js?v=20261001b";
import { supabaseApi } from "./supabase.js?v=20261001b";
import { sheetBody, openSheet } from "./nav.js?v=20261001b";

const OPEN_STATUSES = ["accepted", "paid"];
const MAX_PDF = 3 * 1024 * 1024;
const MAX_IMAGE_SIDE = 2000;
const SEEN_KEY = "temp_chat_seen";

let chat = null;          // { num, order, side: "customer" | "staff", messages, file, sending }
let pollTimer = null;
const files = new Map();  // id сообщения → { file_name, file_type, file_data }

const canWrite = (order) => OPEN_STATUSES.includes(order.status);
const chatAvailable = (order) => canWrite(order) || (order.chat?.total || 0) > 0;
const seen = () => storage.get(SEEN_KEY, {});

/** Есть ли сообщения от другой стороны, которые на этом устройстве ещё не открывали */
export function hasUnread(order, side) {
  const last = side === "staff" ? order.chat?.lastCustomer : order.chat?.lastStaff;
  return Boolean(last) && last > (seen()[order.num] || 0);
}

/** Кнопка «Чат» в карточке заказа */
export function chatButtonHtml(order, side) {
  if (!chatAvailable(order)) return "";
  const total = order.chat?.total || 0, unread = hasUnread(order, side);
  const label = side === "staff" ? "Чат с покупателем" : "Чат с менеджером";
  return `<button class="ghost chat-btn${unread ? " unread" : ""}" data-chat="${order.num}">${label}${total ? ` · ${total}` : ""}${unread ? `<span class="chat-new">новое</span>` : ""}</button>`;
}

/** Открывает переписку. back — куда вести по кнопке «Назад» Telegram. */
export function openChat(order, side, back = null) {
  chat = { num: order.num, order, side, messages: [], file: null, sending: false };
  renderShell();
  sheetBody.onclick = onClick;
  openSheet("chat", back);
  load();
  pollTimer ||= setInterval(() => state.view === "chat" && !document.hidden && load(), 20000);
}

/** Событие Realtime о новом сообщении. Возвращает true, если событие про чат. */
export function onChatEvent(payload = {}, side) {
  if (payload.op !== "message") return false;
  const num = Number(payload.id), fromOther = Boolean(payload.staff) !== (side === "staff");
  if (state.view === "chat" && chat?.num === num) load();
  else if (fromOther) { haptic("success"); toast(`Новое сообщение по заказу №${num}`); }
  return true;
}

function renderShell() {
  const { order, side } = chat;
  sheetBody.innerHTML = `<div class="grab"></div><h2 class="p-name">Заказ №${order.num}</h2>
    <p class="adm-sub">${side === "staff" ? "Переписка с покупателем. Сюда он пришлёт чек об оплате."
      : "Переписка с менеджером. После оплаты отправьте сюда чек: фото, скриншот или PDF."}</p>
    <div class="chat" id="chatList"><p class="adm-sub">Загружаем переписку…</p></div>
    ${canWrite(order) ? `<div class="chat-compose">
      <div class="chat-file" id="chatPicked" hidden></div>
      <textarea id="chatText" rows="2" maxlength="2000" placeholder="Сообщение"></textarea>
      <div class="chat-row">
        <label class="ghost chat-attach">Прикрепить файл<input type="file" id="chatFile" accept="image/*,application/pdf" hidden></label>
        <button class="primary sm" id="chatSend">Отправить</button>
      </div>
      <p class="hint" id="chatHint"></p></div>`
    : `<p class="adm-sub" style="margin-top:10px">Заказ ${order.status === "rejected" ? "отменён" : "ещё не принят"}, писать в чат нельзя.</p>`}`;
  $("chatFile")?.addEventListener("change", pickFile);
}

const isOpen = (num) => state.view === "chat" && chat?.num === num;

async function load() {
  const num = chat?.num;
  if (!num) return;
  try {
    const messages = await supabaseApi.chatMessages(num);
    if (!isOpen(num)) return;
    chat.messages = messages || [];
    markSeen(num);
    renderList();
  } catch {
    const list = $("chatList");
    if (list && isOpen(num) && !chat.messages.length) list.innerHTML = `<p class="hint">Не удалось загрузить переписку. Проверьте интернет.</p>`;
  }
}

function markSeen(num) {
  const last = chat.messages.reduce((max, m) => Math.max(max, Number(m.id)), 0);
  const all = seen();
  if (last && last !== all[num]) {
    all[num] = last;
    storage.set(SEEN_KEY, all);
    emit("chatseen");
  }
}

const fileSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round((bytes || 0) / 1024))} КБ`);

function messageHtml(m) {
  const mine = (m.from_staff ? "staff" : "customer") === chat.side;
  const who = mine ? "Вы" : m.from_staff ? "Менеджер" : "Покупатель";
  const file = !m.file_name ? ""
    : m.file_type?.startsWith("image/") ? `<img class="msg-img" data-file="${m.id}" alt="${escapeHtml(m.file_name)}">`
    : `<button class="msg-doc" data-file="${m.id}">📄 ${escapeHtml(m.file_name)}<small>${fileSize(m.file_size)} · открыть</small></button>`;
  return `<div class="msg${mine ? " mine" : ""}"><p class="msg-who">${who} · ${formatDate(m.created_at)}</p>
    ${m.body ? `<p class="msg-text">${escapeHtml(m.body)}</p>` : ""}${file}</div>`;
}

function renderList() {
  const list = $("chatList");
  if (!list) return;
  list.innerHTML = chat.messages.length ? chat.messages.map(messageHtml).join("")
    : `<p class="adm-sub">Сообщений пока нет.</p>`;
  list.querySelectorAll("img[data-file]").forEach(loadImage);
  list.scrollTop = list.scrollHeight;
}

async function getFile(id) {
  if (!files.has(id)) files.set(id, await supabaseApi.chatFile(id));
  return files.get(id);
}

async function loadImage(img) {
  try {
    const f = await getFile(Number(img.dataset.file));
    img.onload = () => { const list = $("chatList"); if (list) list.scrollTop = list.scrollHeight; };
    img.src = `data:${f.file_type};base64,${f.file_data}`;
  } catch { img.alt = "Не удалось загрузить фото"; }
}

async function openDoc(id, button) {
  try {
    button.disabled = true;
    const f = await getFile(id);
    const bytes = Uint8Array.from(atob(f.file_data), (ch) => ch.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: f.file_type }));
    const a = Object.assign(document.createElement("a"), { href: url, download: f.file_name, target: "_blank", rel: "noopener" });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch {
    toast("Не удалось открыть файл");
  } finally {
    button.disabled = false;
  }
}

/* ---------- Отправка ---------- */
const hint = (text) => { const el = $("chatHint"); if (el) el.textContent = text; };

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
  reader.onerror = () => reject(new Error("Не удалось прочитать файл."));
  reader.readAsDataURL(blob);
});

/** Фото уменьшаем и пересохраняем в JPEG: чек остаётся читаемым, а весит в разы меньше */
async function shrinkImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Не удалось открыть изображение. Сделайте скриншот чека и отправьте его."));
      i.src = url;
    });
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Не удалось подготовить изображение."))), "image/jpeg", 0.85));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function prepareFile(file) {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    if (file.size > MAX_PDF) throw new Error("PDF больше 3 МБ. Отправьте скриншот чека.");
    return { name: file.name.slice(-150), type: "application/pdf", data: await toBase64(file) };
  }
  if (!file.type.startsWith("image/")) throw new Error("Можно отправить фото, скриншот или PDF.");
  const base = (file.name || "").replace(/\.[^.]+$/, "").slice(0, 100) || "фото";
  return { name: `${base}.jpg`, type: "image/jpeg", data: await toBase64(await shrinkImage(file)) };
}

function showPicked() {
  const box = $("chatPicked");
  if (!box) return;
  box.hidden = !chat.file;
  box.innerHTML = chat.file ? `<span>📎 ${escapeHtml(chat.file.name)} · ${fileSize(chat.file.data.length * 0.75)}</span><button data-unpick>Убрать</button>` : "";
}

async function pickFile(e) {
  const input = e.target, file = input.files?.[0];
  input.value = "";
  if (!file) return;
  hint("");
  try {
    chat.file = await prepareFile(file);
    showPicked();
  } catch (error) {
    hint(error.message || "Не удалось подготовить файл.");
    haptic("medium");
  }
}

const SEND_ERRORS = {
  chat_closed: "Заказ закрыт, писать в чат нельзя.",
  rate_limited: "Слишком много сообщений подряд. Подождите несколько минут.",
  too_many_files: "К этому заказу уже прикреплено много файлов. Напишите менеджеру текстом.",
  too_large: "Файл слишком большой.",
  unauthorized: "Не удалось войти в базу заказов. Перезапустите магазин и повторите.",
};

async function send() {
  if (chat.sending) return;
  const num = chat.num, textarea = $("chatText"), button = $("chatSend");
  const text = textarea.value.trim();
  if (!text && !chat.file) { hint("Напишите сообщение или прикрепите файл"); return haptic("medium"); }
  chat.sending = button.disabled = true;
  button.textContent = "Отправляем…";
  try {
    await supabaseApi.sendChatMessage(num, text, chat.file);
    if (!isOpen(num)) return;
    textarea.value = "";
    chat.file = null;
    showPicked();
    hint("");
    haptic("success");
    await load();
  } catch (error) {
    hint(SEND_ERRORS[error.code] || "Не удалось отправить. Проверьте интернет и повторите.");
    haptic("medium");
  } finally {
    chat.sending = button.disabled = false;
    button.textContent = "Отправить";
  }
}

function onClick(e) {
  const t = e.target;
  if (t.id === "chatSend") return send();
  if (t.closest("[data-unpick]")) { chat.file = null; return showPicked(); }
  const doc = t.closest("button[data-file]");
  if (doc) return openDoc(Number(doc.dataset.file), doc);
  if (t.matches("img.msg-img")) t.classList.toggle("full");
}
