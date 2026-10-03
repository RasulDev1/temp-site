// ТЕМП · Telegram-бот магазина (Supabase Edge Function «telegram-bot»).
// Принимает сообщения покупателей от Telegram и кладёт их в чат заказа на сайте; на /start — кнопки магазина.
// Ответы менеджера с сайта бот отправляет сам из базы (supabase-bot.sql), эта функция для них не нужна.
//
// Секреты функции (Edge Functions → Secrets):
//   TELEGRAM_BOT_TOKEN      — токен бота от @BotFather
//   TELEGRAM_WEBHOOK_SECRET — любая длинная строка из латинских букв и цифр; её же указываете в setWebhook
//   SHOP_URL                — адрес магазина (необязательно)
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const SHOP_URL = Deno.env.get("SHOP_URL") ?? "https://rasuldev1.github.io/temp-site/";
const MAX_FILE = 3 * 1024 * 1024; // как в чате на сайте
const FILE_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

// Подсказка в логах, если забыли добавить секреты
if (!TOKEN) console.error("Нет секрета TELEGRAM_BOT_TOKEN: Edge Functions → Secrets");
if (!SECRET) console.error("Нет секрета TELEGRAM_WEBHOOK_SECRET: Edge Functions → Secrets");

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

// deno-lint-ignore no-explicit-any
type Json = any;

async function tg(method: string, body: Json): Promise<Json> {
  const response = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  // Ошибки Telegram — в логи функции: неверный токен даёт 401 Unauthorized, заблокированный бот — 403
  if (!result?.ok) console.error(`Telegram ${method}:`, result?.error_code, result?.description);
  return result;
}

/** Кнопки «Открыть магазин» и «Мои заказы» — открывают мини-приложение внутри Telegram */
const shopButtons = () => ({
  inline_keyboard: [
    [{ text: "🛍 Открыть магазин", web_app: { url: SHOP_URL } }],
    [{ text: "📦 Мои заказы", web_app: { url: `${SHOP_URL}?tab=orders` } }],
  ],
});

const reply = (chatId: number, text: string, buttons = false) =>
  tg("sendMessage", { chat_id: chatId, text, ...(buttons ? { reply_markup: shopButtons() } : {}) });

/* Постоянные кнопки под полем ввода. Нажатие присылает их текст боту — это команды, менеджеру они не уходят.
   (Мини-приложение с такой кнопки не открываем: Telegram не передаёт тогда данные входа, и заказы бы не загрузились.) */
const BTN_SHOP = "🛍 Магазин";
const BTN_ORDERS = "📦 Мои заказы";
const mainKeyboard = {
  keyboard: [[{ text: BTN_SHOP }, { text: BTN_ORDERS }]],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: "Сообщение менеджеру…",
};

const STATUS: Record<string, string> = {
  new: "⏳ ждёт подтверждения", awaiting_payment: "💳 принят, ждёт оплаты", paid: "✅ оплачен, готовим",
  delivered: "📦 вручён", cancelled: "✖️ отменён",
};
const rub = (n: number) => `${Math.round(Number(n) || 0).toLocaleString("ru-RU")} ₽`;

/** «Мои заказы» прямо в чате: последние заказы со статусом, составом и реквизитами для оплаты */
async function sendOrders(chatId: number, userId: number) {
  const { data: orders, error } = await db.from("orders")
    .select("id,status,total,items,payment_details,manager_note")
    .eq("user_id", userId).order("id", { ascending: false }).limit(5);
  if (error) {
    console.error("orders", error);
    return reply(chatId, "Не удалось загрузить заказы. Попробуйте ещё раз через минуту.");
  }
  if (!orders?.length) return reply(chatId, "У вас пока нет заказов. Выберите что-нибудь в магазине:", true);
  const lines = orders.map((o: Json) => {
    const items = (Array.isArray(o.items) ? o.items : [])
      .map((l: Json) => `   • ${l.name}, ${l.colorName}, ${l.size} — ${l.qty} шт.`).join("\n");
    let text = `№${o.id} · ${STATUS[o.status] ?? o.status} · ${rub(o.total)}\n${items}`;
    if (o.status === "awaiting_payment" && o.payment_details) {
      text += `\n   Реквизиты для оплаты: ${o.payment_details}`;
      if (o.manager_note) text += `\n   ${o.manager_note}`;
    }
    if (o.status === "cancelled" && o.manager_note) text += `\n   ${o.manager_note}`;
    return text;
  });
  const open = orders.some((o: Json) => o.status === "awaiting_payment" || o.status === "paid");
  const footer = open
    ? "\n\nЧтобы написать менеджеру, просто отправьте сообщение в этот чат — можно приложить фото или PDF чека."
    : "";
  return tg("sendMessage", {
    chat_id: chatId,
    text: `Ваши заказы:\n\n${lines.join("\n\n")}${footer}`.slice(0, 4000),
    reply_markup: { inline_keyboard: [[{ text: "📦 Открыть заказы в магазине", web_app: { url: `${SHOP_URL}?tab=orders` } }]] },
  });
}

/** Файл из Telegram → base64 для чата заказа. null — файл слишком большой. */
async function download(fileId: string, type: string, name: string) {
  const info = await tg("getFile", { file_id: fileId });
  const path = info?.result?.file_path;
  if (!path || (info.result.file_size ?? 0) > MAX_FILE) return null;
  const response = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${path}`);
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_FILE) return null;
  return { name: name.slice(-150), type, data: encodeBase64(bytes) };
}

const NO_ORDER = "Переписка с менеджером откроется, когда он примет ваш заказ и пришлёт реквизиты. " +
  "Оформить заказ и посмотреть статус можно в магазине:";

const ERRORS: Record<string, string> = {
  too_many: "Слишком много сообщений подряд. Подождите несколько минут.",
  too_many_files: "К этому заказу уже прикреплено много файлов. Напишите менеджеру текстом.",
  closed: "Этот заказ уже закрыт, писать по нему нельзя.",
};

async function handle(msg: Json) {
  const chatId: number = msg.chat.id;
  const text: string = (msg.text ?? msg.caption ?? "").trim();

  if (/^\/(start|help)\b/.test(text)) {
    // кнопка «Магазин» слева от поля ввода — открывает мини-приложение в одно нажатие
    await tg("setChatMenuButton", { chat_id: chatId, menu_button: { type: "web_app", text: "Магазин", web_app: { url: SHOP_URL } } });
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Здравствуйте! Это магазин ТЕМП — мужская одежда для бега, зала и улицы.\n\n" +
        "Кнопки внизу: «Магазин» — открыть каталог, «Мои заказы» — статусы и реквизиты прямо здесь.\n" +
        "Когда менеджер примет заказ, переписывайтесь с ним прямо в этом чате и присылайте чек об оплате.",
      reply_markup: mainKeyboard,
    });
    return reply(chatId, "Открыть магазин:", true);
  }
  if (text === BTN_SHOP || /^\/shop\b/.test(text)) return reply(chatId, "Открыть магазин:", true);
  if (text === BTN_ORDERS || /^\/orders\b/.test(text)) return sendOrders(chatId, msg.from.id);

  // Файл: фото (берём самое крупное) или документ PDF / картинка
  let file: { name: string; type: string; data: string } | null = null;
  if (msg.photo?.length) {
    file = await download(msg.photo[msg.photo.length - 1].file_id, "image/jpeg", "фото.jpg");
    if (!file) return reply(chatId, "Фото слишком большое. Отправьте его ещё раз в сжатом виде или скриншотом.");
  } else if (msg.document) {
    const type = msg.document.mime_type ?? "";
    if (!FILE_TYPES.includes(type)) return reply(chatId, "Можно отправить фото, скриншот или PDF.");
    file = await download(msg.document.file_id, type, msg.document.file_name ?? "файл");
    if (!file) return reply(chatId, "Файл больше 3 МБ. Отправьте скриншот чека.");
  }
  if (!text && !file) return reply(chatId, "Отправьте текст, фото или PDF — сообщение попадёт менеджеру.");

  // Ответ на сообщение бота «Заказ №…» — пишем именно по этому заказу
  const quoted = msg.reply_to_message?.text ?? msg.reply_to_message?.caption ?? "";
  const orderId = Number(/Заказ №(\d+)/.exec(quoted)?.[1]) || null;

  const { data, error } = await db.rpc("bot_customer_message", {
    p_telegram_id: msg.from.id, p_order_id: orderId, p_body: text || null,
    p_file_name: file?.name ?? null, p_file_type: file?.type ?? null, p_file_data: file?.data ?? null,
  });
  if (error) {
    console.error("bot_customer_message", error);
    return reply(chatId, "Не удалось передать сообщение. Попробуйте ещё раз через минуту.");
  }
  if (data?.error === "no_open_order") return reply(chatId, NO_ORDER, true);
  if (data?.error) return reply(chatId, ERRORS[data.error] ?? "Не удалось передать сообщение. Попробуйте ещё раз через минуту.");
  // Сообщение передано менеджеру — бот ничего не отвечает
}

Deno.serve(async (request) => {
  // Запросы принимаем только от Telegram: он присылает секрет, указанный в setWebhook
  if (!SECRET || request.headers.get("x-telegram-bot-api-secret-token") !== SECRET) {
    console.error("Запрос отклонён: секрет не совпадает. TELEGRAM_WEBHOOK_SECRET в Supabase должен быть таким же, как secret_token в setWebhook");
    return new Response("forbidden", { status: 403 });
  }
  const update = await request.json().catch(() => null);
  const msg = update?.message;
  if (msg?.chat?.type === "private" && msg.from && !msg.from.is_bot) {
    console.log("Сообщение от", msg.from.id, (msg.text ?? msg.caption ?? "[файл]").slice(0, 40));
    try { await handle(msg); } catch (e) { console.error(e); }
  }
  return new Response("ok"); // всегда 200, иначе Telegram будет повторять одно и то же сообщение
});
