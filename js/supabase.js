// Supabase: заказы и роли на GitHub Pages — без своего сервера.
// Запросы анонимные (publishable key), а в каждом едет заголовок X-Telegram-Init-Data —
// подписанные Telegram данные с ID пользователя. База сама проверяет подпись токеном бота
// и по правилам RLS решает, кому что видно: покупателю — свои заказы, персоналу — все.
// Библиотеку supabase-js кладёт на сайт деплой (js/vendor/supabase.js, см. .github/workflows/deploy.yml);
// если её там нет, она подгружается с CDN.
import { telegram } from "./core.js?v=20261001b";
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
export const supabaseLoginError = () => loginError;

function db() {
  if (client) return client;
  if (!window.supabase?.createClient) throw { code: "server" };
  const headers = telegram?.initData ? { "X-Telegram-Init-Data": telegram.initData } : {};
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

/* В базе статусы new · awaiting_payment · paid · cancelled; в интерфейсе — new · accepted · paid · rejected */
const STATUS = { awaiting_payment: "accepted", cancelled: "rejected" };
const toOrder = (r) => ({
  num: r.id, status: STATUS[r.status] || r.status, date: r.created_at,
  items: Array.isArray(r.items) ? r.items : [], total: Number(r.total) || 0,
  name: r.customer_name, phone: r.phone, way: r.delivery_way || "", addr: r.address || "",
  payDetails: r.payment_details || "", note: r.manager_note || "", message: r.manager_note || "",
  user: { id: r.user_id, username: r.username },
});

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
    return { orders: data.map(toOrder) };
  },
  async adminOrders() {
    await supabaseLogin();
    const { data, error } = await db().from("orders").select("*").order("id", { ascending: false }).limit(200);
    if (error) fail(error);
    return { orders: data.map(toOrder) };
  },
  acceptOrder: (num, payDetails, note) => setStatus(num, "new", { status: "awaiting_payment", payment_details: payDetails, manager_note: note || null }),
  rejectOrder: (num, message) => setStatus(num, "new", { status: "cancelled", manager_note: message }),
  markPaid: (num) => setStatus(num, "awaiting_payment", { status: "paid" }),

  /** Роль в базе: директор назначает менеджеров в «Сотрудниках» — доступ к заказам меняется здесь */
  async setRole(telegramId, role) {
    const user = await supabaseLogin();
    if (!user) throw { code: "unauthorized" };
    if (Number(telegramId) === Number(user.telegram_id)) return; // свою роль не меняем
    const { data, error } = await db().from("users").update({ role }).eq("telegram_id", telegramId).select("telegram_id");
    if (error) fail(error);
    if (data.length || role === "user") return;
    const insert = await db().from("users").insert({ telegram_id: telegramId, role }); // ещё не открывал магазин — заводим заранее
    if (insert.error) fail(insert.error);
  },
};

/** Живые обновления заказов. База шлёт в канал только номер заказа и действие (insert/update);
 *  сами данные перечитываются обычным запросом, где их защищает RLS.
 *  kind: "user" — свои заказы, "staff" — все заказы (только персоналу). onReady — после (пере)подключения. */
export async function watchOrders(kind, onChange, onReady) {
  const user = await supabaseLogin();
  const topic = kind === "staff" ? user?.staff_topic : user?.topic;
  if (!topic) return;
  db().channel(topic)
    .on("broadcast", { event: "changed" }, ({ payload }) => onChange(payload || {}))
    .subscribe((status) => status === "SUBSCRIBED" && onReady?.());
}
