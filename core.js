// Общие помощники: DOM, форматирование, хранилище, Telegram, анимации, уведомления.

export const telegram = window.Telegram?.WebApp?.initData !== undefined ? window.Telegram.WebApp : null;
export const inTelegram = Boolean(telegram?.platform && telegram.platform !== "unknown");
export const telegramUser = telegram?.initDataUnsafe?.user || null;

export const $ = (id) => document.getElementById(id);
export const formatPrice = (rubles) => rubles.toLocaleString("ru-RU") + "\u00A0₽";
export const formatDate = (iso) => new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
export const escapeHtml = (text) => String(text ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
export const pluralize = (n, one, few, many) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;

export const storage = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

// Простая шина событий между модулями: emit("catalog") → on("catalog", ...)
export const emit = (name) => document.dispatchEvent(new Event(name));
export const on = (name, handler) => document.addEventListener(name, handler);

export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Перезапускает CSS-анимацию на элементе */
export function replayAnimation(element, className) {
  if (!element || reducedMotion) return;
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
}

export function haptic(kind = "light") {
  const feedback = telegram?.HapticFeedback;
  if (!feedback) return;
  try { kind === "success" ? feedback.notificationOccurred("success") : feedback.impactOccurred(kind); } catch {}
}

let toastTimer;
export function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), Math.max(1600, text.length * 55)); // длинное сообщение — дольше
}

export function copyToClipboard(text, button) {
  const done = () => {
    haptic("success");
    const label = button.textContent;
    button.textContent = "Скопировано";
    setTimeout(() => (button.textContent = label), 1500);
  };
  navigator.clipboard?.writeText(text).then(done, () => toast("Выделите и скопируйте текст вручную"))
    ?? toast("Выделите и скопируйте текст вручную");
}

/** Ссылки t.me внутри Telegram открываем средствами Telegram */
export function openLink(url) {
  if (inTelegram && url.startsWith("https://t.me/")) telegram.openTelegramLink(url);
  else if (inTelegram) telegram.openLink(url);
  else window.open(url, "_blank", "noopener");
}

export function setupTelegram() {
  if (!telegram) return;
  try {
    telegram.ready();
    telegram.expand();
    const applyTheme = () => (document.documentElement.dataset.theme = telegram.colorScheme);
    applyTheme();
    telegram.onEvent("themeChanged", applyTheme);
    telegram.setHeaderColor?.("bg_color");
    if (telegramUser?.first_name) $("greeting").textContent = `${telegramUser.first_name}, подберём форму к тренировке`;
  } catch {}
}
