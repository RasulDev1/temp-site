// ТЕМП MEN — сервер для Telegram Mini App.
// Отдаёт приложение, хранит каталог и фото, пускает в управление товарами
// только тех, чей Telegram ID указан в ADMIN_IDS.
// Нужен только Node.js 18+, без сторонних пакетов.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const netproxy = require("./netproxy"); // запросы к Telegram через системный прокси

loadEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT) || 3000;
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)
);
const SESSION_MAX_AGE = 24 * 60 * 60; // подпись Telegram действует сутки
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, ""); // адрес магазина, для кнопки «Открыть заказ»
const TELEGRAM_API = (process.env.TELEGRAM_API || "https://api.telegram.org").replace(/\/+$/, "");

const DATA_DIR = path.join(__dirname, "data");
const IMG_DIR = path.join(DATA_DIR, "images");
const DB_FILE = path.join(DATA_DIR, "catalog.json");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const SITE_DIR = __dirname;                          // сайт лежит в корне проекта (как на GitHub Pages)
const SITE_ENTRIES = ["index.html", "css", "js", "img"]; // наружу отдаём только это: .env, data и код сервера закрыты

const CATEGORIES = new Set(["run", "gym", "street"]); // Бег, Зал, Повседневное
const HEX = /^#[0-9A-F]{6}$/;
const MAX_BODY = 15 * 1024 * 1024; // запрос с фото
const MAX_IMAGE = 5 * 1024 * 1024; // одно фото
const MAX_COLORS = 8;

if (!BOT_TOKEN) console.warn("⚠ BOT_TOKEN не задан — вход администратора работать не будет.");
if (!ADMIN_IDS.size) console.warn("⚠ ADMIN_IDS пуст — ни у кого нет прав администратора.");
fs.mkdirSync(IMG_DIR, { recursive: true });

/* ---------- Хранилище: один JSON-файл + папка с фото ---------- */
let catalog = readCatalog();
function readCatalog() {
  try {
    const c = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return {
      products: Array.isArray(c.products) ? c.products : [],
      hidden: Array.isArray(c.hidden) ? c.hidden : [],
      variants: c.variants && typeof c.variants === "object" ? c.variants : {},
      stock: c.stock && typeof c.stock === "object" ? c.stock : {},
      orderSeq: Number(c.orderSeq) || 10000,
    };
  } catch {
    return { products: [], hidden: [], variants: {}, stock: {}, orderSeq: 10000 };
  }
}
function readOrders() {
  try { const l = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8")); return Array.isArray(l) ? l : []; } catch { return []; }
}
function writeOrders(list) {
  const tmp = ORDERS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
  fs.renameSync(tmp, ORDERS_FILE);
}
function appendOrder(order) {
  const list = readOrders();
  list.push(order);
  writeOrders(list);
}
function saveCatalog() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(catalog, null, 1));
  fs.renameSync(tmp, DB_FILE); // атомарная замена: файл не повредится при сбое
}

/* ---------- Проверка пользователя Telegram ----------
   Мини-приложение присылает initData. Подпись считается токеном бота,
   поэтому подделать чужой Telegram ID нельзя.
   https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app */
function telegramUser(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const expected = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (expected.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash))) return null;
  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > SESSION_MAX_AGE) return null;
  try {
    const user = JSON.parse(params.get("user") || "null");
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}
const isAdmin = (req) => {
  const user = telegramUser(req.headers["x-telegram-init-data"]);
  return !!user && ADMIN_IDS.has(String(user.id));
};

/* Отправка сообщения от имени бота. Возвращает true, если Telegram его принял.
   Бот может написать только тому, кто разрешил ему писать (нажал «Старт» или дал доступ из приложения). */
async function tgCall(method, body, timeout = 20000) {
  const r = await netproxy.request(`${TELEGRAM_API}/bot${BOT_TOKEN}/${method}`, { method: "POST", body, timeout });
  return JSON.parse(r.body.toString("utf8"));
}
async function tgSend(chat_id, text, reply_markup) {
  if (!BOT_TOKEN) return false;
  try {
    const d = await tgCall("sendMessage", { chat_id, text, reply_markup, disable_web_page_preview: true });
    return !!d.ok;
  } catch {
    return false;
  }
}

/* Сообщение администраторам о новом заказе, с кнопкой, которая открывает этот заказ в приложении */
function notifyAdmins(order) {
  if (!BOT_TOKEN) return;
  const lines = order.items.map((l) => `• ${l.name}, ${l.colorName}, ${l.size} — ${l.qty} шт. × ${l.price} ₽`);
  const who = order.user.username ? "@" + order.user.username : order.user.first_name || "покупатель";
  const text = [
    `Новый заказ №${order.num}`,
    `${order.name}, ${order.phone} (${who})`,
    `${order.way}${order.addr ? ": " + order.addr : ""}`,
    "",
    ...lines,
    "",
    `Итого: ${order.total} ₽`,
  ].join("\n");
  const markup = PUBLIC_URL
    ? { inline_keyboard: [[{ text: "Открыть заказ", web_app: { url: `${PUBLIC_URL}/?order=${order.num}` } }]] }
    : undefined;
  for (const chat_id of ADMIN_IDS) tgSend(chat_id, text, markup);
}

/* ---------- Статические файлы: сжатие, кэш, проверка изменений (ETag) ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon",
};
const fileCache = new Map(); // путь → { mtime, type, etag, raw, gzip }

function serveFile(req, res, file, cacheControl) {
  const { mtimeMs } = fs.statSync(file);
  let entry = fileCache.get(file);
  if (!entry || entry.mtime !== mtimeMs) {
    const raw = fs.readFileSync(file);
    const type = MIME[path.extname(file)] || "application/octet-stream";
    entry = {
      mtime: mtimeMs, type, raw,
      gzip: /^text\/|javascript|json|svg/.test(type) ? zlib.gzipSync(raw, { level: 9 }) : null,
      etag: `"${crypto.createHash("sha1").update(raw).digest("base64url").slice(0, 16)}"`,
    };
    fileCache.set(file, entry);
  }
  // Фото кэшируются на неделю; страница и код проверяются при каждом открытии (без изменений — короткий ответ 304)
  const headers = {
    "Content-Type": entry.type, ETag: entry.etag, Vary: "Accept-Encoding", "X-Content-Type-Options": "nosniff",
    "Cache-Control": cacheControl || (entry.type.startsWith("image/") ? "public, max-age=604800" : "no-cache"),
  };
  if (req.headers["if-none-match"] === entry.etag) { res.writeHead(304, headers); return res.end(); }
  const gzip = entry.gzip && /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  const body = gzip ? entry.gzip : entry.raw;
  if (gzip) headers["Content-Encoding"] = "gzip";
  headers["Content-Length"] = body.length;
  res.writeHead(200, headers);
  res.end(body);
}

/* ---------- Помощники HTTP ---------- */
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "Content-Type": isJson ? "application/json; charset=utf-8" : headers["Content-Type"] || "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject({ status: 413, error: "Слишком большой запрос" });
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject({ status: 400, error: "Неверный JSON" });
      }
    });
    req.on("error", reject);
  });
}
const text = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

/* Фото приходят как data:image/...;base64. Проверяем по первым байтам файла, а не по заявленному типу. */
function decodeImage(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) throw { status: 415, error: "Фото должно быть JPG, PNG или WebP" };
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_IMAGE) throw { status: 413, error: "Фото больше 5 МБ" };
  const jpg = buf[0] === 0xff && buf[1] === 0xd8;
  const png = buf.slice(0, 4).toString("hex") === "89504e47";
  const webp = buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP";
  if (!(jpg || png || webp)) throw { status: 415, error: "Файл не похож на фото" };
  return { buf, ext: jpg ? "jpg" : png ? "png" : "webp" };
}

function validateProduct(b) {
  const name = text(b.name, 80);
  const price = Math.round(Number(b.price));
  const old = Math.round(Number(b.old)) || 0;
  const colors = Array.isArray(b.colors) ? b.colors.slice(0, MAX_COLORS) : [];
  if (!name) throw { status: 400, error: "Нужно название" };
  if (!(price > 0)) throw { status: 400, error: "Нужна цена больше нуля" };
  if (old && old <= price) throw { status: 400, error: "Старая цена должна быть больше новой" };
  if (!colors.length) throw { status: 400, error: "Нужен хотя бы один цвет с фото" };
  const hexes = colors.map((c) => String(c.hex || "").toUpperCase());
  if (hexes.some((h) => !HEX.test(h)) || new Set(hexes).size !== hexes.length)
    throw { status: 400, error: "Цвета заданы неверно или повторяются" };
  return {
    name,
    price,
    old,
    cat: CATEGORIES.has(b.cat) ? b.cat : "street",
    desc: text(b.desc, 400),
    sizes: (Array.isArray(b.sizes) ? b.sizes : []).map((s) => text(s, 12)).filter(Boolean).slice(0, 12),
    isNew: !!b.isNew,
    colors: colors.map((c, i) => ({ hex: hexes[i], name: text(c.name, 30) || hexes[i], image: c.image })),
  };
}

/* ---------- Маршруты ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  // Сайт может открываться с другого адреса (GitHub Pages), поэтому разрешаем запросы к API с любого сайта.
  // Права проверяются по подписи Telegram в заголовке, а не по cookie, так что это безопасно.
  if (p.startsWith("/api/") || p.startsWith("/images/")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Init-Data");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.setHeader("Access-Control-Allow-Private-Network", "true"); // если сервер в локальной сети (START.bat), а сайт — на GitHub Pages
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  }
  try {
    // Сайт: index.html, css, js, img
    if (req.method === "GET" && !p.startsWith("/api/") && !p.startsWith("/images/")) {
      const relative = path.normalize(decodeURIComponent(p === "/" ? "/index.html" : p)).replace(/^[\\/]+/, "");
      const file = path.join(SITE_DIR, relative);
      const allowed = SITE_ENTRIES.includes(relative.split(/[\\/]/)[0]) && file.startsWith(SITE_DIR + path.sep);
      if (!allowed || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, "Not found");
      return serveFile(req, res, file);
    }

    // Фото товаров
    if (req.method === "GET" && p.startsWith("/images/")) {
      const file = path.basename(p);
      if (!/^[0-9]+-[0-9]+\.(jpg|png|webp)$/.test(file)) return send(res, 404, "Not found");
      const full = path.join(IMG_DIR, file);
      if (!fs.existsSync(full)) return send(res, 404, "Not found");
      return serveFile(req, res, full, "public, max-age=31536000, immutable");
    }

    // Каталог — открыт всем
    if (req.method === "GET" && p === "/api/catalog") {
      return send(res, 200, catalog, { "Cache-Control": "no-store" });
    }

    // Кто я — приложение показывает кнопку управления только администратору
    if (req.method === "GET" && p === "/api/me") {
      const user = telegramUser(req.headers["x-telegram-init-data"]);
      return send(res, 200, { id: user ? user.id : null, isAdmin: !!user && ADMIN_IDS.has(String(user.id)) });
    }

    // Заказ: оформить может любой пользователь Telegram. Остатки проверяются и списываются здесь,
    // поэтому двое покупателей не смогут купить одну последнюю вещь.
    if (req.method === "POST" && p === "/api/orders") {
      const user = telegramUser(req.headers["x-telegram-init-data"]);
      if (!user) return send(res, 401, { error: "Откройте магазин в Telegram" });
      const b = await readJson(req);
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 50).map((l) => ({
        id: Math.floor(Number(l.id)),
        color: String(l.color || "").toUpperCase(),
        size: text(l.size, 12),
        qty: Math.floor(Number(l.qty)),
        name: text(l.name, 80),
        colorName: text(l.colorName, 30),
        price: Math.max(0, Math.round(Number(l.price)) || 0),
      }));
      if (!items.length || items.some((l) => !l.id || !HEX.test(l.color) || !l.size || !(l.qty >= 1 && l.qty <= 99)))
        return send(res, 400, { error: "Неверный состав заказа" });
      const name = text(b.name, 80), phone = text(b.phone, 30);
      if (!name || !phone) return send(res, 400, { error: "Нужны имя и телефон" });

      // Проверяем все позиции, и только потом списываем
      const need = {};
      for (const l of items) if (catalog.stock[l.id]) {
        const k = l.id + "\u0000" + l.color + "|" + l.size;
        need[k] = (need[k] || 0) + l.qty;
      }
      const shortages = [];
      for (const [k, n] of Object.entries(need)) {
        const [id, key] = k.split("\u0000");
        const left = Number(catalog.stock[id].qty[key]) || 0;
        if (left < n) shortages.push({ id: Number(id), key, left });
      }
      if (shortages.length) return send(res, 409, { error: "Не хватает товара", shortages });
      for (const [k, n] of Object.entries(need)) {
        const [id, key] = k.split("\u0000");
        catalog.stock[id].qty[key] = (Number(catalog.stock[id].qty[key]) || 0) - n;
      }
      catalog.orderSeq += 1;
      saveCatalog();

      const order = {
        num: catalog.orderSeq,
        date: new Date().toISOString(),
        user: { id: user.id, username: user.username || "", first_name: user.first_name || "" },
        name, phone,
        way: text(b.way, 40),
        addr: text(b.addr, 200),
        items,
        total: items.reduce((a, l) => a + l.qty * l.price, 0),
        status: "new", // new → accepted (ссылка на оплату) или rejected (нет в наличии)
      };
      appendOrder(order);
      notifyAdmins(order);
      return send(res, 201, { num: order.num });
    }

    // Мои заказы: покупатель видит только свои, со статусом и ссылкой на оплату
    if (req.method === "GET" && p === "/api/my-orders") {
      const user = telegramUser(req.headers["x-telegram-init-data"]);
      if (!user) return send(res, 401, { error: "Откройте магазин в Telegram" });
      const mine = readOrders().filter((o) => o.user && o.user.id === user.id).slice(-50).reverse()
        .map(({ num, date, items, total, way, addr, status, payDetails, payUrl, note, message }) => ({ num, date, items, total, way, addr, status, payDetails: payDetails || payUrl, note, message }));
      return send(res, 200, { orders: mine }, { "Cache-Control": "no-store" });
    }

    // Всё ниже — только для администраторов. Проверка здесь, на сервере, а не только в интерфейсе.
    if (p.startsWith("/api/") && !isAdmin(req)) return send(res, 403, { error: "Нет прав администратора" });

    if (req.method === "POST" && p === "/api/products") {
      const product = validateProduct(await readJson(req));
      const num = Date.now();
      const images = product.colors.map((c) => decodeImage(c.image)); // сначала проверяем все фото
      product.colors.forEach((c, i) => {
        const file = `${num}-${i}.${images[i].ext}`;
        fs.writeFileSync(path.join(IMG_DIR, file), images[i].buf);
        c.image = "/images/" + file;
      });
      const saved = { num, createdAt: num, ...product };
      catalog.products.push(saved);
      saveCatalog();
      return send(res, 201, saved);
    }

    const del = /^\/api\/products\/(\d+)$/.exec(p);
    if (req.method === "DELETE" && del) {
      const num = Number(del[1]);
      const product = catalog.products.find((x) => x.num === num);
      if (!product) return send(res, 404, { error: "Товар не найден" });
      catalog.products = catalog.products.filter((x) => x.num !== num);
      delete catalog.variants[num];
      delete catalog.stock[num];
      saveCatalog();
      product.colors.forEach((c) => fs.rm(path.join(IMG_DIR, path.basename(c.image)), { force: true }, () => {}));
      return send(res, 200, { ok: true });
    }

    // Убранные цвета, размеры и сочетания «цвет + размер» у одного товара
    const vr = /^\/api\/variants\/(\d+)$/.exec(p);
    if (req.method === "PUT" && vr) {
      const b = await readJson(req);
      const list = (v, re) => [...new Set((Array.isArray(v) ? v : []).map((x) => text(x, 40)).filter((x) => re.test(x)))].slice(0, 200);
      const v = {
        offColors: list(b.offColors, /^#[0-9A-Fa-f]{6}$/),
        offSizes: list(b.offSizes, /^.{1,12}$/),
        offCombos: list(b.offCombos, /^#[0-9A-Fa-f]{6}\|.{1,12}$/),
      };
      if (v.offColors.length || v.offSizes.length || v.offCombos.length) catalog.variants[vr[1]] = v;
      else delete catalog.variants[vr[1]];
      saveCatalog();
      return send(res, 200, v);
    }

    // Заказы для администратора: сначала новые
    if (req.method === "GET" && p === "/api/orders") {
      const list = readOrders().slice(-300).reverse();
      return send(res, 200, { orders: list }, { "Cache-Control": "no-store" });
    }

    // Принять заказ и отправить покупателю реквизиты для оплаты (карта, банк, получатель или ссылка)
    const acc = /^\/api\/orders\/(\d+)\/accept$/.exec(p);
    if (req.method === "POST" && acc) {
      const b = await readJson(req);
      const payDetails = String(b.payDetails || b.payUrl || "").trim().slice(0, 500), note = text(b.note, 500);
      if (payDetails.length < 6) return send(res, 400, { error: "Нужны реквизиты для оплаты" });
      const list = readOrders();
      const order = list.find((o) => o.num === Number(acc[1]));
      if (!order) return send(res, 404, { error: "Заказ не найден" });
      if (order.status && order.status !== "new") return send(res, 409, { error: "Заказ уже обработан" });
      const msg = [`Ваш заказ №${order.num} принят.`, `Сумма к оплате: ${order.total} ₽`, note, "", "Реквизиты для оплаты:", payDetails]
        .filter((x, i) => x || i === 3).join("\n");
      const isLink = /^https:\/\/\S+$/.test(payDetails); // если реквизиты — это одна ссылка, добавляем кнопку
      order.delivered = await tgSend(order.user.id, msg, isLink ? { inline_keyboard: [[{ text: "Оплатить", url: payDetails }]] } : undefined);
      Object.assign(order, { status: "accepted", payDetails, note, decidedAt: new Date().toISOString(), decidedBy: telegramUser(req.headers["x-telegram-init-data"]).id });
      writeOrders(list);
      return send(res, 200, { order });
    }

    // Отказать: товара нет. Остатки возвращаются на склад, покупатель получает сообщение.
    const rej = /^\/api\/orders\/(\d+)\/reject$/.exec(p);
    if (req.method === "POST" && rej) {
      const b = await readJson(req);
      const message = text(b.message, 1000);
      if (!message) return send(res, 400, { error: "Напишите сообщение покупателю" });
      const list = readOrders();
      const order = list.find((o) => o.num === Number(rej[1]));
      if (!order) return send(res, 404, { error: "Заказ не найден" });
      if (order.status && order.status !== "new") return send(res, 409, { error: "Заказ уже обработан" });
      for (const l of order.items) {
        const st = catalog.stock[l.id];
        if (st) { const k = l.color + "|" + l.size; st.qty[k] = (Number(st.qty[k]) || 0) + l.qty; }
      }
      saveCatalog();
      order.delivered = await tgSend(order.user.id, message);
      Object.assign(order, { status: "rejected", message, decidedAt: new Date().toISOString(), decidedBy: telegramUser(req.headers["x-telegram-init-data"]).id });
      writeOrders(list);
      return send(res, 200, { order });
    }

    // Остатки на складе: {qty: {"#HEX|размер": штук}} или {tracked: false}, чтобы выключить учёт
    const sr = /^\/api\/stock\/(\d+)$/.exec(p);
    if (req.method === "PUT" && sr) {
      const b = await readJson(req);
      if (b.tracked === false) delete catalog.stock[sr[1]];
      else {
        const qty = {};
        for (const [k, v] of Object.entries(b.qty && typeof b.qty === "object" ? b.qty : {}).slice(0, 500)) {
          if (/^#[0-9A-Fa-f]{6}\|.{1,12}$/.test(k)) qty[k.slice(0, 7).toUpperCase() + k.slice(7)] = Math.max(0, Math.min(99999, Math.floor(Number(v)) || 0));
        }
        catalog.stock[sr[1]] = { qty };
      }
      saveCatalog();
      return send(res, 200, catalog.stock[sr[1]] || { tracked: false });
    }

    // Скрытые встроенные товары
    if (req.method === "PUT" && p === "/api/hidden") {
      const b = await readJson(req);
      catalog.hidden = [...new Set((Array.isArray(b.hidden) ? b.hidden : []).map(Number).filter(Number.isInteger))].slice(0, 500);
      saveCatalog();
      return send(res, 200, { hidden: catalog.hidden });
    }

    return send(res, 404, { error: "Не найдено" });
  } catch (e) {
    if (e && e.status) return send(res, e.status, { error: e.error });
    console.error(e);
    return send(res, 500, { error: "Ошибка сервера" });
  }
});

netproxy.detectProxy(process.env.PROXY).then((p) => { if (p) console.log(`Запросы к Telegram идут через прокси ${p.url} (${p.source})`); });
server.listen(PORT, () => {
  console.log(`ТЕМП MEN работает на http://localhost:${PORT}`);
  console.log(`Администраторы (Telegram ID): ${[...ADMIN_IDS].join(", ") || "не заданы"}`);
  botLoop();
  setMenuButton();
});

/* Кнопка «Магазин» в чате с ботом ведёт на PUBLIC_URL — настраивается сама при каждом запуске */
async function setMenuButton() {
  if (!BOT_TOKEN || !PUBLIC_URL) return;
  try {
    const d = await tgCall("setChatMenuButton", { menu_button: { type: "web_app", text: "Магазин", web_app: { url: PUBLIC_URL } } });
    if (d.ok) console.log(`Кнопка «Магазин» в боте ведёт на ${PUBLIC_URL}`);
  } catch {}
}

/* ---------- Бот отвечает на сообщения ----------
   Чтобы бот не молчал: на /start и любое сообщение он присылает кнопку «Открыть магазин».
   Работает через getUpdates, поэтому вебхук и отдельный адрес для бота не нужны. */
async function botLoop() {
  if (!BOT_TOKEN) return;
  let offset = 0;
  for (;;) {
    try {
      const d = await tgCall("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, 35000);
      if (!d.ok) { await new Promise((z) => setTimeout(z, 5000)); continue; } // например, бот запущен ещё где-то
      for (const u of d.result) {
        offset = u.update_id + 1;
        const m = u.message;
        if (!m || !m.from || m.from.is_bot || m.chat.type !== "private") continue;
        const admin = ADMIN_IDS.has(String(m.from.id));
        const text = [
          "Здравствуйте! Это ТЕМП MEN — мужская одежда для бега, зала и улицы.",
          "Откройте магазин кнопкой ниже, выберите товары и оформите заказ.",
          "Реквизиты для оплаты пришлём сюда, когда подтвердим наличие.",
          admin ? "\nВы администратор: в магазине доступны «Управление товарами» и «Заказы»." : "",
        ].filter(Boolean).join("\n");
        tgSend(m.chat.id, text, PUBLIC_URL ? { inline_keyboard: [[{ text: "Открыть магазин", web_app: { url: PUBLIC_URL } }]] } : undefined);
      }
    } catch {
      await new Promise((z) => setTimeout(z, 3000));
    }
  }
}

/* Простая загрузка .env без сторонних пакетов */
function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}
