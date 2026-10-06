// ТЕМП · Telegram-бот магазина (Supabase Edge Function «telegram-bot»).
// Принимает сообщения покупателей от Telegram и кладёт их в чат заказа на сайте; на /start — кнопки магазина.
// Ответы менеджера с сайта бот отправляет сам из базы (supabase-bot.sql), эта функция для них не нужна.
// Менеджер отправил реквизиты — база зовёт эту функцию ({ open_order: id }), и бот сам открывает покупателю этот заказ.
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

/** Кнопка «Открыть магазин» под сообщением — открывает мини-приложение внутри Telegram */
const shopButton = { inline_keyboard: [[{ text: "🛍 Открыть магазин", web_app: { url: SHOP_URL } }]] };

const reply = (chatId: number, text: string, withShop = false) =>
  tg("sendMessage", { chat_id: chatId, text, ...(withShop ? { reply_markup: shopButton } : {}) });

/* Постоянная кнопка под полем ввода. Нажатие присылает её текст боту — это команда, менеджеру не уходит.
   Магазин открывает кнопка меню «Магазин» слева от поля ввода: с кнопки под полем ввода Telegram
   не передаёт мини-приложению данные покупателя, и заказы бы не загрузились. */
const BTN_SHOP = "🛍 Магазин"; // была у первых покупателей — по-прежнему понимаем
const BTN_ORDERS = "📦 Мои заказы";
const mainKeyboard = {
  keyboard: [[{ text: BTN_ORDERS }]],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: "Напишите сообщение…",
};

/** Статус заказа — так, как его поймёт покупатель */
const STATUS: Record<string, string> = {
  new: "🕐 Проверяем наличие", awaiting_payment: "💳 Ждём оплату", paid: "✅ Оплачен, готовим заказ",
  delivered: "📦 Вручён", cancelled: "✖️ Отменён",
};
const rub = (n: number) => `${Math.round(Number(n) || 0).toLocaleString("ru-RU")} ₽`;
/** «3 октября» — дата оформления по времени магазина (Краснодар) */
const day = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" });
const itemsOf = (o: Json): Json[] => (Array.isArray(o.items) ? o.items : []);

const ACTIVE = ["new", "awaiting_payment", "paid"];
const OPEN = ["awaiting_payment", "paid"]; // по этим заказам можно писать менеджеру

/** Кнопка заказа в списке: дата, что заказано, статус. Без номера. */
function orderButton(o: Json) {
  const items = itemsOf(o);
  const first = String(items[0]?.name ?? "Заказ");
  const what = (first.length > 22 ? first.slice(0, 21) + "…" : first) + (items.length > 1 ? ` и ещё ${items.length - 1}` : "");
  return `${day(o.created_at)} · ${what} · ${STATUS[o.status] ?? ""}`;
}

/** Чат с менеджером закрыт: сообщения покупателя больше не уходят в чат заказа */
const closeChat = (userId: number) => db.from("bot_chat_state").delete().eq("telegram_id", userId);
const CLOSE_BUTTON = { inline_keyboard: [[{ text: "✖️ Закрыть чат", callback_data: "close" }]] };
const CHAT_CLOSED = "Чат с менеджером закрыт — ваши сообщения больше не уходят менеджеру.\n\n" +
  "Чтобы написать снова, откройте заказ в «📦 Мои заказы».";

/** «Мои заказы»: только активные заказы, кнопкой на каждый — нажал, и сообщения уходят менеджеру по этому заказу.
    Открытый до этого чат закрывается: пока покупатель не выберет заказ, сообщения никуда не уходят. */
async function sendOrders(chatId: number, userId: number) {
  await closeChat(userId);
  const { data: orders, error } = await db.from("orders").select("id,status,items,created_at")
    .eq("user_id", userId).in("status", ACTIVE).order("id", { ascending: false }).limit(10);
  if (error) {
    console.error("orders", error);
    return reply(chatId, "Не получилось загрузить заказы 😔 Попробуйте, пожалуйста, ещё раз через минуту.");
  }
  if (!orders?.length) {
    return reply(chatId, "Сейчас у вас нет активных заказов.\n\nЗагляните в каталог — новинки уже ждут 👇", true);
  }
  return tg("sendMessage", {
    chat_id: chatId,
    text: orders.length === 1 ? "Ваш заказ 👇 Нажмите, чтобы посмотреть детали и написать менеджеру."
      : "Ваши заказы 👇 Нажмите на нужный, чтобы посмотреть детали и написать менеджеру.",
    reply_markup: { inline_keyboard: orders.map((o: Json) => [{ text: orderButton(o), callback_data: `order:${o.id}` }]) },
  });
}

/* ---------- Фото заказанных товаров ----------
   Ссылку на фото сайт кладёт в заказ (items[].photo). У заказов, оформленных раньше или со старой
   версии сайта, её нет — тогда ищем фото в каталоге: встроенные товары в js/data.js на сайте,
   добавленные — в catalog_state. */
const absolute = (path: string) => { try { return new URL(path, SHOP_URL).href; } catch { return ""; } };
const PHOTO_EXPR = String.raw`(?:img\("([^"]+)"\)|"([^"]+)")`; // img("2") или "1-pants.jpg"
const photoPath = (m: RegExpMatchArray, i: number) => (m[i] ? `img/products/${m[i]}.jpg` : m[i + 1]);

let catalogPhotos: { at: number; map: Map<string, string> } | null = null;
/** "id|#ЦВЕТ" и "id" → полная ссылка на фото. Кэш на 10 минут. */
async function loadCatalogPhotos() {
  if (catalogPhotos && Date.now() - catalogPhotos.at < 600_000) return catalogPhotos.map;
  const map = new Map<string, string>();
  try {
    const source = await (await fetch(absolute("js/data.js"))).text();
    for (const block of source.split(/(?=\{\s*id:\s*\d+,)/).slice(1)) {
      const id = /^\{\s*id:\s*(\d+)/.exec(block)?.[1];
      const main = new RegExp(String.raw`\bphoto:\s*` + PHOTO_EXPR).exec(block);
      if (!id || !main) continue;
      map.set(id, absolute(photoPath(main, 1)));
      const colors = /colorPhotos:\s*\{([^}]*)\}/.exec(block)?.[1] ?? "";
      for (const c of colors.matchAll(new RegExp(String.raw`"(#[0-9A-Fa-f]{6})":\s*` + PHOTO_EXPR, "g")))
        map.set(`${id}|${c[1].toUpperCase()}`, absolute(photoPath(c, 2)));
    }
  } catch (e) { console.error("Фото встроенных товаров (js/data.js):", e); }
  try {
    const { data } = await db.from("catalog_state").select("data").eq("id", 1).maybeSingle();
    for (const p of (data?.data?.products ?? []) as Json[]) {
      const colors = (Array.isArray(p.colors) ? p.colors : []).filter((c: Json) => c?.hex && c?.image);
      if (!p.num || !colors.length) continue;
      map.set(String(p.num), absolute(colors[0].image));
      for (const c of colors) map.set(`${p.num}|${String(c.hex).toUpperCase()}`, absolute(c.image));
    }
  } catch (e) { console.error("Фото добавленных товаров (catalog_state):", e); }
  catalogPhotos = { at: Date.now(), map };
  return map;
}

async function photoUrls(items: Json[]) {
  const catalog = items.some((l) => !String(l.photo ?? "").startsWith("https://")) ? await loadCatalogPhotos() : null;
  const urls = items.map((l) => {
    if (typeof l.photo === "string" && l.photo.startsWith("https://")) return l.photo;
    return catalog?.get(`${l.id}|${String(l.color ?? "").toUpperCase()}`) ?? catalog?.get(String(l.id)) ?? "";
  });
  return [...new Set(urls.filter((u) => u.startsWith("https://")))].slice(0, 10);
}

/** Скачиваем фото сами и отправляем файлом: так Telegram не нужно самому открывать сайт.
    Не скачалось — отдаём Telegram ссылку. */
async function sendPhotoFiles(chatId: number, urls: string[]) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  const media: Json[] = [];
  for (const [i, url] of urls.entries()) {
    const response = await fetch(url).catch(() => null);
    const type = response?.headers.get("content-type") ?? "";
    if (response?.ok && type.startsWith("image/")) {
      form.append(`p${i}`, new Blob([await response.arrayBuffer()], { type }), `p${i}.${type.split("/")[1] || "jpg"}`);
      media.push({ type: "photo", media: `attach://p${i}` });
    } else {
      console.error("Фото не скачалось:", url, response?.status);
      media.push({ type: "photo", media: url });
    }
  }
  let method = "sendMediaGroup";
  if (media.length === 1) {
    method = "sendPhoto";
    const only = media[0].media as string;
    if (only.startsWith("attach://")) { form.set("photo", form.get(only.slice(9)) as Blob, "photo.jpg"); form.delete(only.slice(9)); }
    else form.set("photo", only);
  } else form.append("media", JSON.stringify(media));
  const response = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", body: form });
  const result = await response.json().catch(() => ({}));
  if (!result?.ok) console.error(`Telegram ${method}:`, result?.error_code, result?.description);
  return Boolean(result?.ok);
}

/** Фото того, что заказано: одно — фотографией, несколько — альбомом. Альбом не ушёл — по одной. */
async function sendPhotos(chatId: number, items: Json[]) {
  const urls = await photoUrls(items);
  if (!urls.length) return console.log("У заказа нет фото товаров");
  if (await sendPhotoFiles(chatId, urls)) return;
  if (urls.length > 1) for (const url of urls) await sendPhotoFiles(chatId, [url]);
}

/** Покупатель нажал на заказ: фото, дата, состав, статус. Запоминаем — следующие сообщения уйдут менеджеру по нему.
    accepted — менеджер только что принял заказ и отправил реквизиты: бот открывает заказ сам. */
async function chooseOrder(chatId: number, userId: number, orderId: number, accepted = false) {
  const { data: o } = await db.from("orders")
    .select("id,status,total,items,payment_details,manager_note,created_at")
    .eq("id", orderId).eq("user_id", userId).maybeSingle();
  if (!o || !ACTIVE.includes(o.status)) {
    return reply(chatId, "Этот заказ уже завершён. Нажмите «📦 Мои заказы», чтобы увидеть актуальные.");
  }
  const items = itemsOf(o);
  await sendPhotos(chatId, items);
  const lines = items.map((l) => `• ${l.name} — ${String(l.colorName ?? "").toLowerCase()}, размер ${l.size}${Number(l.qty) > 1 ? `, ${l.qty} шт.` : ""}`);
  let text = `${accepted ? "✅ Заказ принят! " : "🛍 "}Ваш заказ от ${day(o.created_at)}\n\n${lines.join("\n")}\n\nСумма: ${rub(o.total)}\nСтатус: ${STATUS[o.status] ?? o.status}`;
  if (o.status === "awaiting_payment" && o.payment_details) {
    text += `\n\n💳 Реквизиты для оплаты:\n${o.payment_details}`;
    if (o.manager_note) text += `\n\n${o.manager_note}`;
    text += "\n\nПосле оплаты пришлите сюда, пожалуйста, чек — фото или скриншот.";
  }
  if (OPEN.includes(o.status)) {
    await db.from("bot_chat_state").upsert({ telegram_id: userId, order_id: o.id, updated_at: new Date().toISOString() });
    text += "\n\n✍️ Есть вопрос? Просто напишите сюда — менеджер ответит в этом чате. Закончили — нажмите «Закрыть чат».";
  } else {
    text += "\n\nМенеджер проверяет, всё ли есть в наличии. Как только заказ будет подтверждён, реквизиты для оплаты появятся в «📦 Мои заказы».";
  }
  return tg("sendMessage", { chat_id: chatId, text: text.slice(0, 4000), ...(OPEN.includes(o.status) ? { reply_markup: CLOSE_BUTTON } : {}) });
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

const NO_CHAT = "Чтобы написать менеджеру, откройте заказ: нажмите «📦 Мои заказы» и выберите нужный заказ.";
const NO_ORDER = "Написать менеджеру можно, когда он подтвердит ваш заказ — обычно это быстро 🙂\n\n" +
  "Статус заказа всегда можно посмотреть в «📦 Мои заказы». Если заказа ещё нет — загляните в каталог:";

const ERRORS: Record<string, string> = {
  too_many: "Вы отправили много сообщений подряд — передохнём пару минут, и можно продолжить 🙂",
  too_many_files: "К этому заказу уже прикреплено много файлов. Опишите, пожалуйста, вопрос текстом.",
  closed: "Этот заказ уже завершён. Нажмите «📦 Мои заказы», чтобы выбрать актуальный.",
};
const SEND_FAILED = "Не получилось отправить сообщение 😔 Попробуйте, пожалуйста, ещё раз через минуту.";

async function handle(msg: Json) {
  const chatId: number = msg.chat.id;
  const text: string = (msg.text ?? msg.caption ?? "").trim();

  if (/^\/(start|help)\b/.test(text)) {
    // кнопка «Магазин» слева от поля ввода — открывает мини-приложение в одно нажатие
    await tg("setChatMenuButton", { chat_id: chatId, menu_button: { type: "web_app", text: "Магазин", web_app: { url: SHOP_URL } } });
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Привет! Это ТЕМП — мужская одежда для бега, зала и улицы 🏃\n\n" +
        "🛍 Каталог открывается кнопкой «Магазин» слева от поля ввода.\n" +
        "📦 «Мои заказы» внизу — статус заказа, реквизиты для оплаты и связь с менеджером.\n\n" +
        "Появился вопрос по заказу? Пишите прямо сюда — менеджер ответит.",
      reply_markup: mainKeyboard,
    });
    return;
  }
  if (text === BTN_SHOP || /^\/shop\b/.test(text)) return reply(chatId, "Каталог ТЕМП 👇", true);
  if (text === BTN_ORDERS || /^\/orders\b/.test(text)) return sendOrders(chatId, msg.from.id);

  // Файл: фото (берём самое крупное) или документ PDF / картинка
  let file: { name: string; type: string; data: string } | null = null;
  if (msg.photo?.length) {
    file = await download(msg.photo[msg.photo.length - 1].file_id, "image/jpeg", "фото.jpg");
    if (!file) return reply(chatId, "Фото получилось слишком большим. Отправьте, пожалуйста, скриншот.");
  } else if (msg.document) {
    const type = msg.document.mime_type ?? "";
    if (!FILE_TYPES.includes(type)) return reply(chatId, "Такой файл не получится передать. Пришлите, пожалуйста, фото, скриншот или PDF.");
    file = await download(msg.document.file_id, type, msg.document.file_name ?? "файл");
    if (!file) return reply(chatId, "Файл больше 3 МБ. Пришлите, пожалуйста, скриншот чека.");
  }
  if (!text && !file) return reply(chatId, "Можно отправить текст, фото или PDF — всё передадим менеджеру.");

  // По какому заказу: тот, что выбран в «Мои заказы» (или по которому последним писал менеджер),
  // для старых сообщений с номером — по номеру. Чат закрыт и заказ не выбран — менеджеру не отправляем.
  const quoted = msg.reply_to_message?.text ?? msg.reply_to_message?.caption ?? "";
  let orderId = Number(/Заказ №(\d+)/.exec(quoted)?.[1]) || null;
  if (!orderId) {
    const { data: chosen } = await db.from("bot_chat_state").select("order_id").eq("telegram_id", msg.from.id).maybeSingle();
    orderId = chosen?.order_id ?? null;
  }
  if (!orderId) return tg("sendMessage", { chat_id: chatId, text: NO_CHAT, reply_markup: mainKeyboard });

  const { data, error } = await db.rpc("bot_customer_message", {
    p_telegram_id: msg.from.id, p_order_id: orderId, p_body: text || null,
    p_file_name: file?.name ?? null, p_file_type: file?.type ?? null, p_file_data: file?.data ?? null,
  });
  if (error) {
    console.error("bot_customer_message", error);
    return reply(chatId, SEND_FAILED);
  }
  if (data?.error === "no_open_order") return reply(chatId, NO_ORDER, true);
  if (data?.error) return reply(chatId, ERRORS[data.error] ?? SEND_FAILED);
  // Сообщение передано менеджеру — бот ничего не отвечает
}

/** Вызов из базы (supabase-bot.sql): менеджер отправил реквизиты — открываем покупателю этот заказ в боте.
    Подпись — токен бота: он есть и у функции, и в Vault базы. */
async function openFromDatabase(request: Request) {
  const body = await request.json().catch(() => null);
  const orderId = Number(body?.open_order);
  if (!orderId) return new Response("bad request", { status: 400 });
  const { data: o } = await db.from("orders").select("user_id").eq("id", orderId).maybeSingle();
  if (!o?.user_id) return new Response("ok");
  // фото и сообщение отправляем уже после ответа базе — она не ждёт дольше нескольких секунд
  const work = chooseOrder(o.user_id, o.user_id, orderId, true).catch((e) => console.error(e));
  const runtime = (globalThis as Json).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(work); else await work;
  return new Response("ok");
}

Deno.serve(async (request) => {
  if (TOKEN && request.headers.get("x-bot-token") === TOKEN) return openFromDatabase(request);
  // Запросы принимаем только от Telegram: он присылает секрет, указанный в setWebhook
  if (!SECRET || request.headers.get("x-telegram-bot-api-secret-token") !== SECRET) {
    console.error("Запрос отклонён: секрет не совпадает. TELEGRAM_WEBHOOK_SECRET в Supabase должен быть таким же, как secret_token в setWebhook");
    return new Response("forbidden", { status: 403 });
  }
  const update = await request.json().catch(() => null);
  // Нажатие на заказ в списке «Мои заказы»
  const callback = update?.callback_query;
  if (callback?.from && callback.message?.chat?.type === "private") {
    await tg("answerCallbackQuery", { callback_query_id: callback.id }).catch(() => {});
    const orderId = Number(/^order:(\d+)$/.exec(callback.data ?? "")?.[1]);
    if (orderId) try { await chooseOrder(callback.message.chat.id, callback.from.id, orderId); } catch (e) { console.error(e); }
    if (callback.data === "close") try {
      await closeChat(callback.from.id);
      // кнопку под сообщением убираем, чтобы не нажимали повторно
      await tg("editMessageReplyMarkup", { chat_id: callback.message.chat.id, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] } });
      await reply(callback.message.chat.id, CHAT_CLOSED);
    } catch (e) { console.error(e); }
    return new Response("ok");
  }
  const msg = update?.message;
  if (msg?.chat?.type === "private" && msg.from && !msg.from.is_bot) {
    console.log("Сообщение от", msg.from.id, (msg.text ?? msg.caption ?? "[файл]").slice(0, 40));
    try { await handle(msg); } catch (e) { console.error(e); }
  }
  return new Response("ok"); // всегда 200, иначе Telegram будет повторять одно и то же сообщение
});
