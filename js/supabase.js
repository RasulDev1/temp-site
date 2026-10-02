// Supabase: заказы и роли на GitHub Pages — без своего сервера.
// Запросы анонимные (publishable key), а в каждом едет заголовок X-Telegram-Init-Data —
// подписанные Telegram данные с ID пользователя. База сама проверяет подпись токеном бота
// и по правилам RLS решает, кому что видно: покупателю — свои заказы, персоналу — все.
// Библиотеку supabase-js кладёт на сайт деплой (js/vendor/supabase.js, см. .github/workflows/deploy.yml);
// если её там нет, она подгружается с CDN.
import { telegram, storage } from "./core.js?v=20261001b";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js?v=20261001b";

export const supabaseEnabled = Boolean(SUPABASE_URL && SUPABASE_KEY);
const CDN_LIBRARY = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.js";
let libraryPromise = null;

/** Библиотека: своя копия с сайта (подключена в index.html), а если её нет — с CDN */
function loadLibrary() {
  if (window.supabase?.createClient) return Promise.resolve(true);
  libraryPromise ||= new Promise((resolve) => {
    const done = (ok) => { clearTimeout(timer); if (!ok) libraryPromise = null; resolve(ok); };
    const timer = setTimeout(() => done(false), 15000);
    const script = document.createElement("script");
    script.src = CDN_LIBRARY;
    script.onload = () => done(Boolean(window.supabase?.createClient));
    script.onerror = () => done(false);
    document.head.appendChild(script);
  });
  return libraryPromise;
}

let client = null;
let me = null;          // { telegram_id, username, role, topic, staff_topic }
let loginPromise = null;
let loginError = null;  // почему не удалось войти — показываем в подсказке вместо общей фразы
let archiveReady = false; // в базе настроены скрытые заказы (supabase-archive.sql)
export const supabaseLoginError = () => loginError;

/* Вход сотрудника по логину и паролю (supabase-staff.sql). База выдаёт токен сессии на 30 дней,
   он хранится на устройстве и уходит в заголовке X-Staff-Token — по нему база даёт права менеджера или директора. */
const STAFF_TOKEN_KEY = "temp_staff_token";
let staffToken = storage.get(STAFF_TOKEN_KEY, "");
let staffSession = null; // { name, login, role: "manager" | "admin", staff_topic }

function db() {
  if (client) return client;
  if (!window.supabase?.createClient) throw { code: "server" };
  const headers = {};
  if (telegram?.initData) headers["X-Telegram-Init-Data"] = telegram.initData;
  if (staffToken) headers["X-Staff-Token"] = staffToken;
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers }, // заголовок добавляется ко всем запросам сразу
  });
  return client;
}

const fail = (error) => { throw { code: error?.code === "42501" ? "not_staff" : "server", raw: error }; };

/** Вход при старте: база проверяет подпись Telegram, регистрирует пользователя и возвращает роль.
 *  Удачный вход запоминается; неудачный — нет, следующая попытка (например, «Подтвердить заказ») войдёт заново. */
export function supabaseLogin() {
  if (me) return Promise.resolve(me);
  loginPromise ||= (async () => {
    if (!(await loadLibrary())) return fail_("no_library");             // не загрузилась ни своя копия, ни CDN
    const { data, error, status } = await db().rpc("tg_login");
    if (!error && data?.telegram_id) { loginError = null; return (me = data); }
    console.warn("Supabase tg_login:", status, error);
    if (error?.code === "PGRST202" || status === 404) return fail_("no_function"); // в базе нет tg_login
    if (error?.code === "42501") {                                                 // база не приняла подпись
      const reason = /tg:([a-z_]+)/.exec(error.message || "")?.[1];                // причину называет сама база
      return fail_(reason ? `tg_${reason}` : "bad_signature");
    }
    return fail_(status === 0 ? "network" : "server");
  })().catch((e) => { console.warn("Supabase tg_login:", e); return fail_("network"); })
    .finally(() => { loginPromise = null; });
  return loginPromise;
}
function fail_(reason) { loginError = reason; return null; }

/** Вызов функции базы; ошибка — { code }: причина из базы (staff:…), no_function, network или server */
async function rpc(name, args) {
  if (!(await loadLibrary())) throw { code: "network" };
  const { data, error, status } = await db().rpc(name, args);
  if (!error) return data;
  const reason = /staff:([a-z_]+)/.exec(error.message || "")?.[1];
  throw { code: reason || (error.code === "PGRST202" || status === 404 ? "no_function" : status === 0 ? "network" : "server"), raw: error };
}

function forgetStaff() {
  staffToken = "";
  staffSession = null;
  storage.set(STAFF_TOKEN_KEY, "");
  client = null; // следующий запрос — уже без токена
}

/** Вход сотрудника. Ошибки: bad_credentials, locked, no_function, network. */
export async function staffLogin(login, password) {
  const data = await rpc("staff_login", { p_login: login, p_password: password });
  if (data?.error || !data?.token) throw { code: data?.error || "server" };
  staffToken = data.token;
  storage.set(STAFF_TOKEN_KEY, staffToken);
  client = null; // следующие запросы — уже с токеном
  return (staffSession = { name: data.name, login: data.login, role: data.role, staff_topic: data.staff_topic });
}

/** Сохранённый вход ещё действует? null — нет (истёк, удалён директором, пароль сменён). */
export async function staffRestore() {
  if (!staffToken) return null;
  try {
    const data = await rpc("staff_me");
    if (!data) { forgetStaff(); return null; }
    return (staffSession = data);
  } catch {
    return null; // нет связи — токен не трогаем, попробуем при следующем запуске
  }
}

export async function staffLogout() {
  try { await rpc("staff_logout"); } catch {}
  forgetStaff();
}

/* В базе статусы new · awaiting_payment · paid · delivered · cancelled; в интерфейсе — new · accepted · paid · delivered · rejected */
const STATUS = { awaiting_payment: "accepted", cancelled: "rejected" };
const toOrder = (r) => ({
  num: r.id, status: STATUS[r.status] || r.status, date: r.created_at,
  items: Array.isArray(r.items) ? r.items : [], total: Number(r.total) || 0,
  name: r.customer_name, phone: r.phone, way: r.delivery_way || "", addr: r.address || "",
  payDetails: r.payment_details || "", note: r.manager_note || "", message: r.manager_note || "",
  user: { id: r.user_id, username: r.username },
});

/** Сводка переписки по заказам (сколько сообщений, последнее от менеджера и от покупателя) */
async function withChat(orders) {
  if (!orders.length) return orders;
  const { data, error } = await db().from("order_chat_summary").select("order_id,total,last_staff,last_customer")
    .in("order_id", orders.map((o) => o.num));
  if (error) return orders; // чат ещё не настроен в базе — заказы показываем как раньше
  const byId = new Map(data.map((s) => [Number(s.order_id), s]));
  return orders.map((o) => {
    const s = byId.get(o.num);
    return s ? { ...o, chat: { total: Number(s.total), lastStaff: Number(s.last_staff), lastCustomer: Number(s.last_customer) } } : o;
  });
}

/** Менеджер меняет заказ, только если тот ещё в ожидаемом статусе — иначе его уже обработал другой */
async function setStatus(num, from, patch) {
  const { data, error } = await db().from("orders").update(patch).eq("id", num).eq("status", from).select();
  if (error) fail(error);
  if (!data?.length) throw { code: "conflict" };
  return { order: toOrder(data[0]) };
}

/** Те же действия, что у сервера (state.js), — модули заказов не замечают разницы */
export const supabaseApi = {
  async placeOrder(order) {
    if (!(await supabaseLogin())) throw { code: "unauthorized", reason: loginError };
    // user_id и статус 'new' ставит сама база, клиент их не передаёт
    const { data, error } = await db().from("orders").insert({
      items: order.items, total: order.total, customer_name: order.name, phone: order.phone,
      delivery_way: order.way, address: order.addr || null,
    }).select().single();
    if (error) fail(error);
    return { num: data.id };
  },
  async myOrders() {
    const user = await supabaseLogin();
    if (!user) return { orders: [] };
    const { data, error } = await db().from("orders").select("*").eq("user_id", user.telegram_id).order("id", { ascending: false }).limit(50);
    if (error) fail(error);
    return { orders: await withChat(data.map(toOrder)) };
  },
  /** archived — скрытые заказы. Без настроенной очистки (supabase-archive.sql) — все заказы, как раньше. */
  async adminOrders(archived = false) {
    const query = (table) => db().from(table).select("*").order("id", { ascending: false }).limit(200);
    let { data, error } = await query(archived ? "orders_archived" : "orders_active");
    archiveReady = !error;
    if (error && !archived) ({ data, error } = await query("orders"));
    if (error) fail(error);
    return { orders: await withChat(data.map(toOrder)), canArchive: archiveReady };
  },
  /** Скрыть заказы из списка персонала (покупатель их по-прежнему видит) */
  async archiveOrders(nums) {
    const { error } = await db().from("order_archive")
      .upsert(nums.map((order_id) => ({ order_id })), { onConflict: "order_id", ignoreDuplicates: true });
    if (error) fail(error);
  },
  async unarchiveOrder(num) {
    const { error } = await db().from("order_archive").delete().eq("order_id", num);
    if (error) fail(error);
  },
  async archivedCount() {
    if (!archiveReady) return 0;
    const { count, error } = await db().from("order_archive").select("order_id", { count: "exact", head: true });
    return error ? 0 : count || 0;
  },
  acceptOrder: (num, payDetails, note) => setStatus(num, "new", { status: "awaiting_payment", payment_details: payDetails, manager_note: note || null }),
  rejectOrder: (num, message) => setStatus(num, "new", { status: "cancelled", manager_note: message }),
  markPaid: (num) => setStatus(num, "awaiting_payment", { status: "paid" }),
  markDelivered: (num) => setStatus(num, "paid", { status: "delivered" }),

  /* ---------- Переписка по заказу ---------- */
  async chatMessages(num) {
    const { data, error } = await db().from("order_messages")
      .select("id,body,from_staff,file_name,file_type,file_size,created_at").eq("order_id", num).order("id").limit(300);
    if (error) fail(error);
    return data;
  },
  async chatFile(id) {
    const { data, error } = await db().from("order_messages").select("file_name,file_type,file_data").eq("id", id).single();
    if (error) fail(error);
    return data;
  },
  async sendChatMessage(num, text, file) {
    // сотрудник пишет по своему входу; покупатель — по подписи Telegram
    if (!staffSession && !(await supabaseLogin())) throw { code: "unauthorized", reason: loginError };
    // отправителя, время и «менеджер или покупатель» ставит сама база
    const { error } = await db().from("order_messages").insert({
      order_id: num, body: text || null,
      file_name: file?.name ?? null, file_type: file?.type ?? null, file_data: file?.data ?? null,
    });
    if (!error) return;
    const reason = /chat:([a-z_]+)/.exec(error.message || "")?.[1];
    throw { code: { closed: "chat_closed", too_many: "rate_limited", too_many_files: "too_many_files" }[reason]
      || (error.code === "23514" || error.code === "54000" ? "too_large" : "server"), raw: error };
  },

  /* ---------- «Сотрудники»: аккаунты с логином и паролем (только директор) ---------- */
  staffList: () => rpc("staff_list"),
  staffSave: (id, name, login, password) => rpc("staff_save", { p_id: id || null, p_name: name, p_login: login, p_password: password || null }),
  staffDelete: (id) => rpc("staff_delete", { p_id: id }),
};

/** Живые обновления заказов. База шлёт в канал только номер заказа и действие (insert/update);
 *  сами данные перечитываются обычным запросом, где их защищает RLS.
 *  kind: "user" — свои заказы, "staff" — все заказы (только персоналу). onReady — после (пере)подключения. */
export async function watchOrders(kind, onChange, onReady) {
  const topic = kind === "staff" ? staffSession?.staff_topic : (await supabaseLogin())?.topic;
  if (!topic) return;
  db().channel(topic)
    .on("broadcast", { event: "changed" }, ({ payload }) => onChange(payload || {}))
    .subscribe((status) => status === "SUBSCRIBED" && onReady?.());
}
