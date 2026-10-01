// Настройки сайта. Меняйте здесь, остальной код трогать не нужно.

// Директор магазина — задаётся здесь один раз. Telegram ID — число, его присылает бот @userinfobot.
// Менеджеров директор назначает сам в приложении: «Сотрудники».
export const DIRECTOR = { telegramId: 7920676508, name: "Абуев Расул" };

// Адрес сервера магазина (VPS или Codespaces), например "https://1-2-3-4.sslip.io".
// Пусто, если сайт открыт с того же сервера (START.bat, install.sh) — тогда запросы идут на тот же адрес.
// На GitHub Pages сервера нет: оставьте пусто, и заказы будут уходить сообщением менеджеру (ниже).
export const API_URL = "";

// Имя менеджера в Telegram без @. Нужно, только если сервера нет (GitHub Pages без API_URL):
// кнопка «Подтвердить заказ» откроет чат с менеджером, а текст заказа будет уже вписан.
export const MANAGER_USERNAME = "light_temshik";

// Только для GitHub Pages со своим доменом: репозиторий магазина в виде "логин/репозиторий".
// На адресе логин.github.io/репозиторий он определяется сам — оставьте пусто.
export const GITHUB_REPO = "";

// Supabase — база заказов и ролей для GitHub Pages (Project Settings → API).
// С ними заказы не уходят сообщением менеджеру, а сохраняются в базе: менеджер видит их в «Заказах»
// в реальном времени, а покупатель получает реквизиты прямо во вкладке «Мои заказы».
// Ключ — publishable, он публичный. Secret / service_role сюда вставлять нельзя!
export const SUPABASE_URL = "https://ztcltngfpnhhuzyyqnfw.supabase.co";
export const SUPABASE_KEY = "sb_publishable_8xnrRsc0jbvrdWLQfVl9RA_ChDkxp-a";
