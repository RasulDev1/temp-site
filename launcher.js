// ТЕМП MEN — запуск в одно нажатие.
// Сам спрашивает токен бота, определяет ваш Telegram ID, скачивает туннель,
// запускает сервер и привязывает магазин к кнопке меню бота. BotFather трогать не нужно.

const fs = require("fs");
const path = require("path");
const net = require("net");
const readline = require("readline");
const { spawn, execSync } = require("child_process");

const DIR = __dirname;
const ENV_FILE = path.join(DIR, ".env");
const RUNTIME = path.join(DIR, "runtime");
const IS_WIN = process.platform === "win32";
const TELEGRAM_API = (process.env.TELEGRAM_API || "https://api.telegram.org").replace(/\/+$/, "");

const say = (...a) => console.log(...a);
const line = () => say("─".repeat(56));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- .env: читаем и аккуратно обновляем ---------- */
function readEnv() {
  const env = {};
  try {
    for (const l of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return env;
}
function writeEnv(patch) {
  let lines = [];
  try { lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/); } catch {}
  const seen = new Set();
  lines = lines.map((l) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(l);
    if (m && m[1] in patch) { seen.add(m[1]); return `${m[1]}=${patch[m[1]]}`; }
    return l;
  });
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  for (const [k, v] of Object.entries(patch)) if (!seen.has(k)) lines.push(`${k}=${v}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n");
}

/* ---------- Вопросы в консоли ---------- */
// Один общий reader: строки, введённые заранее или вставленные разом, не теряются
let rl = null;
const pending = [], waiting = [];
function ask(q) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (l) => (waiting.length ? waiting.shift()(l.trim()) : pending.push(l.trim())));
    rl.on("close", () => { while (waiting.length) waiting.shift()(""); });
  }
  process.stdout.write(q);
  return new Promise((r) => (pending.length ? r(pending.shift()) : waiting.push(r)));
}
function closeInput() { try { rl && rl.close(); } catch {} rl = null; }

/* ---------- Сеть ---------- */
const netproxy = require("./netproxy");
const request = (url, opts) => netproxy.request(url, opts); // учитывает системный прокси
let netproxy_detected = null;
const proxyInfo = () => netproxy_detected ? `${netproxy_detected.url} (${netproxy_detected.source})` : "нет";

/* Понятное объяснение, почему не удалось связаться с Telegram */
let lastNetError = null;
function explainNetError(e) {
  const code = (e && (e.code || e.message)) || "неизвестно";
  let why;
  if (/ENOTFOUND|EAI_AGAIN/.test(code))
    why = "Компьютер не может найти сервер Telegram. Либо нет интернета, либо провайдер блокирует api.telegram.org.\n" +
          "Включите VPN или подключитесь к другому интернету (например, раздаче с телефона) и запустите снова.";
  else if (/CERT|UNABLE_TO|SELF_SIGNED|DEPTH_ZERO/.test(code))
    why = "Соединение перехватывает антивирус (например, «Проверка защищённых соединений» в Касперском).\n" +
          "Добавьте папку магазина в исключения антивируса или временно отключите проверку HTTPS и запустите снова.";
  else if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up/i.test(code))
    why = "Связь с Telegram обрывается. Скорее всего, провайдер ограничивает доступ к api.telegram.org\n" +
          "(приложение Telegram при этом может работать через свои обходные пути).\n" +
          "Включите VPN или подключитесь к другому интернету и запустите снова.";
  else if (/^HTTP /.test(code))
    why = "Ответ пришёл не от Telegram: доступ к api.telegram.org блокирует провайдер или сеть (например, рабочая).\n" +
          "Включите VPN или подключитесь к другому интернету и запустите снова.";
  else if (/EPROXY/.test(code) || /прокси/i.test(String(e && e.message)))
    why = `Не получилось подключиться через прокси ${proxyInfo()}: ${e.message}.\n` +
          "Проверьте, что VPN-клиент или прокси запущены, либо укажите другой прокси в .env: PROXY=socks5://адрес:порт";
  else why = "Проверьте интернет, VPN и антивирус и запустите снова.";
  const hint = netproxy_detected ? "" : "\nЕсли у вас есть прокси (например, SOCKS5 из настроек Telegram), впишите его в .env строкой PROXY=socks5://адрес:порт";
  return `Нет связи с Telegram (код: ${code}).\n${why}${hint}`;
}
async function tg(token, method, body) {
  let r;
  try { r = await request(`${TELEGRAM_API}/bot${token}/${method}`, { method: "POST", body: body || {}, timeout: 40000 }); }
  catch (e) { lastNetError = e; throw e; }
  let d = null;
  try { d = JSON.parse(r.body.toString("utf8")); } catch {}
  if (!d || typeof d.ok !== "boolean") { // ответил не Telegram: сеть блокирует или подменяет доступ
    lastNetError = { code: "HTTP " + r.status };
    throw lastNetError;
  }
  return d;
}
async function download(url, file, redirects = 6) {
  let last = 0;
  const onProgress = (got, total) => { // показываем, что загрузка идёт
    const now = Date.now(); if (now - last < 700) return; last = now;
    const mb = (got / 1048576).toFixed(1);
    process.stdout.write(`\r  загружено ${mb} МБ${total ? ` из ${(total / 1048576).toFixed(0)} МБ (${Math.floor((got / total) * 100)}%)` : ""}   `);
  };
  const r = await request(url, { timeout: 60000, onProgress });
  if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location && redirects > 0)
    return download(new URL(r.headers.location, url).toString(), file, redirects - 1);
  if (r.status !== 200) throw new Error("HTTP " + r.status);
  process.stdout.write("\n");
  const tmp = file + ".part";
  fs.writeFileSync(tmp, r.body);
  fs.renameSync(tmp, file); // недокачанный файл не будет принят за готовый
}
function freePort(start) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(freePort(start + 1)));
    s.once("listening", () => s.close(() => resolve(start)));
    s.listen(start, "127.0.0.1");
  });
}
function openInBrowser(url) {
  try {
    if (IS_WIN) spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    else if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {}
}

/* ---------- Шаг 1: токен бота ---------- */
async function setupToken(env) {
  if (env.BOT_TOKEN) {
    const me = await tg(env.BOT_TOKEN, "getMe").catch(() => null);
    if (me && me.ok) return me.result;
    if (me && !me.ok) say("⚠ Токен из .env не подходит, введите его заново.");
    else throw new Error(explainNetError(lastNetError));
  }
  line();
  say("Шаг 1 из 2. Токен бота");
  say("Откройте в Telegram @BotFather, отправьте /newbot и следуйте подсказкам.");
  say("В конце BotFather пришлёт токен вида 1234567890:AAH...  Скопируйте его.");
  say("Вставить в это окно: правый клик мышью, затем Enter.");
  say("Если окно «замерло» после клика мышью, нажмите Esc.");
  line();
  for (;;) {
    const token = (await ask("Вставьте токен и нажмите Enter: ")).replace(/\s+/g, "");
    if (!/^\d+:[\w-]{30,}$/.test(token)) { say("Это не похоже на токен. Он выглядит как 1234567890:AAH..."); continue; }
    say("Проверяю токен…");
    const me = await tg(token, "getMe").catch(() => null);
    if (!me) { say(explainNetError(lastNetError)); await ask("Нажмите Enter, чтобы попробовать ещё раз: "); say("Проверяю токен…");
      const again = await tg(token, "getMe").catch(() => null);
      if (!again) { say(explainNetError(lastNetError)); continue; }
      if (!again.ok) { say("Telegram не принял этот токен. Скопируйте его из BotFather ещё раз."); continue; }
      writeEnv({ BOT_TOKEN: token }); env.BOT_TOKEN = token; say(`✔ Бот найден: @${again.result.username}`); return again.result; }
    if (!me.ok) { say("Telegram не принял этот токен. Скопируйте его из BotFather ещё раз."); continue; }
    writeEnv({ BOT_TOKEN: token });
    env.BOT_TOKEN = token;
    say(`✔ Бот найден: @${me.result.username}`);
    return me.result;
  }
}

/* ---------- Шаг 2: администратор — определяем ID по сообщению боту ----------
   Enter нажимать не нужно: программа сама ждёт сообщение, а бот отвечает, что всё получилось. */
async function setupAdmin(env, bot) {
  if (env.ADMIN_IDS) return;
  line();
  say("Шаг 2 из 2. Администратор");
  say(`Откройте своего бота @${bot.username} в Telegram и отправьте ему любое сообщение, например «привет».`);
  say("Можно с телефона. Администратором станет тот, кто напишет первым.");
  line();
  await tg(env.BOT_TOKEN, "deleteWebhook").catch(() => {}); // иначе сообщения не придут сюда
  openInBrowser(`https://t.me/${bot.username}`);
  process.stdout.write("Жду сообщение боту");
  let offset = 0;
  for (;;) {
    const up = await tg(env.BOT_TOKEN, "getUpdates", { offset, timeout: 20, limit: 100 }).catch(() => null);
    if (!up) { await sleep(3000); process.stdout.write("."); continue; }
    const list = up.result || [];
    if (list.length) offset = list[list.length - 1].update_id + 1;
    const msg = list.map((u) => u.message).filter((m) => m && m.from && !m.from.is_bot).pop();
    if (!msg) { process.stdout.write("."); continue; }
    const from = msg.from;
    const who = [from.first_name, from.last_name].filter(Boolean).join(" ") + (from.username ? ` (@${from.username})` : "");
    writeEnv({ ADMIN_IDS: String(from.id) });
    env.ADMIN_IDS = String(from.id);
    await tg(env.BOT_TOKEN, "getUpdates", { offset, timeout: 0 }).catch(() => {}); // помечаем сообщения прочитанными
    await tg(env.BOT_TOKEN, "sendMessage", {
      chat_id: from.id,
      text: "✔ Вы администратор магазина.\nВернитесь к окну на компьютере: магазин запускается. Когда он заработает, здесь появится кнопка «Магазин».",
    }).catch(() => {});
    say(`\n✔ Администратор: ${who}, ID ${from.id}.`);
    say("  Если это не вы: закройте окно, удалите строку ADMIN_IDS в файле .env и запустите снова.");
    return;
  }
}

/* ---------- Туннель: бесплатный HTTPS-адрес от Cloudflare ---------- */
function which(cmd) {
  try {
    const out = execSync(IS_WIN ? `where ${cmd}` : `command -v ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split(/\r?\n/)[0];
    return out || null;
  } catch { return null; }
}
async function ensureCloudflared() {
  if (process.env.CLOUDFLARED) return process.env.CLOUDFLARED;
  const local = path.join(RUNTIME, IS_WIN ? "cloudflared.exe" : "cloudflared");
  if (fs.existsSync(local)) return local;
  const inPath = which("cloudflared");
  if (inPath) return inPath;
  if (IS_WIN) for (const d of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) { // установлен через winget/MSI
    const f = d && path.join(d, "cloudflared", "cloudflared.exe");
    if (f && fs.existsSync(f)) return f;
  }
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const base = "https://github.com/cloudflare/cloudflared/releases/latest/download/";
  fs.mkdirSync(RUNTIME, { recursive: true });
  say("Скачиваю туннель cloudflared, около 60 МБ, это нужно один раз…");
  const manual = IS_WIN
    ? `Скачайте файл вручную в браузере:\n  ${base}cloudflared-windows-amd64.exe\n` +
      `переименуйте его в cloudflared.exe и положите в папку:\n  ${RUNTIME}\nЗатем запустите START.bat снова.`
    : `Установите cloudflared вручную (Mac: brew install cloudflared) и запустите снова.`;
  for (let i = 1; ; i++) {
    try { await fetchCloudflared(base, arch, local); break; }
    catch (e) {
      process.stdout.write("\n");
      if (i >= 3) throw new Error(`Не удалось скачать туннель (${e.code || e.message}).\n` + manual);
      say(`Загрузка прервалась (${e.code || e.message}), пробую ещё раз…`);
      await sleep(3000);
    }
  }
  if (!IS_WIN) fs.chmodSync(local, 0o755);
  say("✔ Туннель скачан.");
  return local;
}
async function fetchCloudflared(base, arch, local) {
  if (IS_WIN) await download(base + "cloudflared-windows-amd64.exe", local);
  else if (process.platform === "darwin") {
    const tgz = path.join(RUNTIME, "cloudflared.tgz");
    await download(base + `cloudflared-darwin-${arch}.tgz`, tgz);
    execSync(`tar -xzf "${tgz}" -C "${RUNTIME}"`);
    fs.rmSync(tgz, { force: true });
  } else await download(base + `cloudflared-linux-${arch}`, local);
}
/* Запуск программы-туннеля и ожидание её публичного адреса */
function spawnTunnel(cmd, args, env, urlRe, label, waitMs = 45000) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: env || process.env }); }
    catch (e) { return reject(Object.assign(new Error("tunnel"), { detail: e.message })); }
    let done = false, log = "";
    const onData = (d) => {
      const t = d.toString(); log = (log + t).slice(-4000);
      const m = urlRe.exec(t);
      if (m && !done) { done = true; resolve({ proc: p, url: m[0].replace(/\/+$/, ""), label }); }
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    const why = () => {
      const lines = log.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const errLine = lines.filter((l) => /ERR|error|failed|denied|refused|timed? ?out|closed/i.test(l)).pop() || lines.pop() || "";
      return Object.assign(new Error("tunnel"), { detail: errLine.replace(/^\S+\s+ERR\s*/, "") });
    };
    p.on("error", (e) => { if (!done) { done = true; reject(Object.assign(new Error("tunnel"), { detail: e.message })); } });
    p.on("exit", () => { if (!done) { done = true; reject(why()); } });
    setTimeout(() => { if (!done) { done = true; try { p.kill(); } catch {} reject(why()); } }, waitMs);
  });
}

/* Способы получить адрес, по порядку. Если провайдер мешает одному, пробуем следующий. */
function tunnelProviders(cf, port) {
  const list = [];
  const cfArgs = ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`];
  // Адрес Cloudflare — случайные слова через дефис; api.trycloudflare.com — служебный адрес из ошибок
  const cfRe = /https:\/\/(?!api\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/;
  if (netproxy_detected) {
    const envP = { ...process.env, HTTPS_PROXY: netproxy_detected.url, HTTP_PROXY: netproxy_detected.url };
    list.push({ name: "Cloudflare через прокси", start: () => spawnTunnel(cf, ["tunnel", "--protocol", "http2", ...cfArgs.slice(1)], envP, cfRe, "Cloudflare") });
  }
  list.push({ name: "Cloudflare", start: () => spawnTunnel(cf, cfArgs, { ...process.env, HTTPS_PROXY: "", HTTP_PROXY: "" }, cfRe, "Cloudflare") });
  const ssh = which("ssh") || (IS_WIN && fs.existsSync("C:\\Windows\\System32\\OpenSSH\\ssh.exe") ? "C:\\Windows\\System32\\OpenSSH\\ssh.exe" : null);
  if (ssh) {
    const common = ["-T", "-o", "StrictHostKeyChecking=no", "-o", `UserKnownHostsFile=${IS_WIN ? "NUL" : "/dev/null"}`,
      "-o", "ServerAliveInterval=30", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=20", "-o", "BatchMode=yes"];
    list.push({ name: "localhost.run", start: () => spawnTunnel(ssh, [...common, "-R", `80:localhost:${port}`, "nokey@localhost.run"], null,
      /https:\/\/[a-z0-9-]+\.lhr\.life/, "localhost.run") });
    list.push({ name: "Pinggy", start: () => spawnTunnel(ssh, [...common, "-p", "443", "-R", `0:localhost:${port}`, "a.pinggy.io"], null,
      /https:\/\/[a-z0-9-]+\.a\.free\.pinggy\.link/, "Pinggy (бесплатно на 60 минут, потом адрес обновится сам)") });
  }
  return list;
}
async function waitReachable(url, seconds) {
  for (let i = 0; i < seconds / 2; i++) {
    try { const r = await request(url + "/api/catalog", { timeout: 5000 }); if (r.status === 200) return true; } catch {}
    await sleep(2000);
  }
  return false;
}

/* ---------- Запуск ---------- */
let server = null, tunnel = null, stopping = false, browserOpened = false;
function stopAll() {
  stopping = true;
  try { server && server.kill(); } catch {}
  try { tunnel && tunnel.kill(); } catch {}
}
process.on("SIGINT", () => { say("\nОстанавливаю магазин…"); stopAll(); process.exit(0); });
process.on("SIGTERM", () => { stopAll(); process.exit(0); });
process.on("exit", stopAll);

async function run() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) throw new Error(`Нужен Node.js 18 или новее, у вас ${process.versions.node}. Установите новую версию с https://nodejs.org`);

  say("\nТЕМП MEN — запуск магазина\n");
  const env = readEnv();
  netproxy_detected = await netproxy.detectProxy(env.PROXY);
  say(netproxy_detected ? `Прокси: ${proxyInfo()}` : "Прокси в настройках системы не найден, подключаюсь напрямую.");
  const bot = await setupToken(env);
  await setupAdmin(env, bot);

  closeInput(); // вопросы закончились
  if (process.argv.includes("--setup")) { say("✔ Настройка сохранена в .env"); return; } // режим для установки на сервер
  const port = await freePort(Number(env.PORT) || 3000);
  if (String(port) !== String(env.PORT)) writeEnv({ PORT: port });

  if (process.env.CODESPACES === "true" && process.env.CODESPACE_NAME) return runCodespaces(env, bot, port);

  const cf = await ensureCloudflared();

  for (let attempt = 1; !stopping; attempt++) {
    let t = null;
    const providers = tunnelProviders(cf, port);
    for (const pr of providers) {
      say(`Получаю адрес: ${pr.name}…`);
      try { t = await pr.start(); break; }
      catch (e) { say(`  не получилось${e.detail ? ": " + e.detail.slice(0, 180) : ""}`); }
    }
    if (!t) {
      if (attempt < 2) { say("Пробую все способы ещё раз…"); await sleep(3000); continue; }
      throw new Error(
        "Не удалось получить адрес магазина: провайдер или сеть не пускают к сервисам туннелей.\n" +
        "Включите VPN в режиме для всего компьютера (в Hiddify: «Режим» → VPN, в других программах: TUN / «весь трафик»)\n" +
        "и запустите START.bat снова. Режима «системный прокси» для туннеля обычно не хватает.");
    }
    say(`✔ Адрес получен через ${t.label}.`);
    tunnel = t.proc;
    const url = t.url;
    writeEnv({ PUBLIC_URL: url });

    server = spawn(process.execPath, [path.join(DIR, "server.js")], {
      cwd: DIR, env: { ...process.env, PORT: String(port), PUBLIC_URL: url, PROXY: netproxy_detected ? netproxy_detected.url : "" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let serverLog = "";
    server.stdout.on("data", (d) => (serverLog += d));
    server.stderr.on("data", (d) => (serverLog += d));
    const serverExited = new Promise((r) => server.on("exit", (code) => r(code)));

    say("Жду, пока адрес заработает (до минуты)…");
    const reachable = await Promise.race([waitReachable(url, 90), serverExited.then(() => "exit")]);
    if (reachable === "exit") throw new Error("Сервер остановился с ошибкой:\n" + serverLog.trim());

    const mb = await tg(env.BOT_TOKEN, "setChatMenuButton", {
      menu_button: { type: "web_app", text: "Магазин", web_app: { url } },
    }).catch(() => null);

    line();
    say(reachable ? "✔ Магазин работает!" : "⚠ Магазин запущен, но адрес пока не отвечает.");
    say(`  Бот:   https://t.me/${bot.username}`);
    say(`  Адрес: ${url}`);
    say(mb && mb.ok
      ? "  Кнопка «Магазин» в боте настроена автоматически."
      : "  ⚠ Не удалось настроить кнопку меню. Укажите адрес в @BotFather → Menu Button.");
    if (!reachable) say("  Подождите пару минут и откройте бота. Если магазин не открывается и тогда,\n  включите VPN в режиме для всего компьютера и перезапустите START.bat.");
    say("");
    say("  Откройте бота и нажмите «Магазин» слева от поля ввода.");
    say("  Не закрывайте это окно: пока оно открыто, магазин работает.");
    say("  Остановить: закройте окно или нажмите Ctrl+C.");
    line();
    if (!browserOpened) { browserOpened = true; openInBrowser(`https://t.me/${bot.username}`); }

    // Если туннель или сервер упадут — поднимаем заново, кнопка обновится сама.
    const why = await Promise.race([
      new Promise((r) => tunnel.on("exit", () => r("tunnel"))),
      serverExited.then(() => "server"),
    ]);
    if (stopping) return;
    if (why === "server") throw new Error("Сервер остановился с ошибкой:\n" + serverLog.trim());
    say("\nСвязь с туннелем потеряна, переподключаюсь…");
    try { server.kill(); } catch {}
    await sleep(2000);
    attempt = 0;
  }
}

/* ---------- GitHub Codespaces: бесплатный сервер от GitHub ----------
   Туннель не нужен: GitHub сам даёт постоянный HTTPS-адрес для порта, и у сервера есть прямой доступ к Telegram. */
async function runCodespaces(env, bot, port) {
  const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || "app.github.dev";
  const url = `https://${process.env.CODESPACE_NAME}-${port}.${domain}`;
  writeEnv({ PUBLIC_URL: url });
  say("Запускаю магазин в GitHub Codespaces…");
  server = spawn(process.execPath, [path.join(DIR, "server.js")], {
    cwd: DIR, env: { ...process.env, PORT: String(port), PUBLIC_URL: url, PROXY: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  const serverExited = new Promise((r) => server.on("exit", (code) => r(code)));
  await sleep(2500);
  // Делаем порт публичным, иначе Telegram увидит страницу входа GitHub вместо магазина
  let madePublic = false;
  for (let i = 0; i < 5 && !madePublic; i++) {
    try {
      execSync(`gh codespace ports visibility ${port}:public -c "${process.env.CODESPACE_NAME}"`, { stdio: "ignore" });
      madePublic = true;
    } catch { await sleep(3000); }
  }
  const reachable = await Promise.race([waitReachable(url, 40), serverExited.then(() => "exit")]);
  if (reachable === "exit") throw new Error("Сервер остановился с ошибкой:\n" + serverLog.trim());
  const mb = await tg(env.BOT_TOKEN, "setChatMenuButton", {
    menu_button: { type: "web_app", text: "Магазин", web_app: { url } },
  }).catch(() => null);
  line();
  say(reachable ? "✔ Магазин работает!" : "⚠ Магазин запущен, но адрес пока не отвечает.");
  say(`  Бот:   https://t.me/${bot.username}`);
  say(`  Адрес: ${url}`);
  say(mb && mb.ok ? "  Кнопка «Магазин» в боте настроена автоматически." : "  ⚠ Не удалось настроить кнопку меню бота.");
  if (!madePublic) say("  ⚠ Сделайте порт публичным вручную: вкладка «Порты» → правый клик по порту " + port + " → «Видимость порта» → «Public».");
  say("");
  say("  Адрес постоянный, пока существует этот Codespace.");
  say("  Codespace засыпает, если с ним не работать (по умолчанию через 30 минут).");
  say("  Чтобы снова запустить магазин, откройте Codespace и выполните npm start.");
  line();
  await serverExited;
  if (!stopping) throw new Error("Сервер остановился с ошибкой:\n" + serverLog.trim());
}

run().catch((e) => {
  closeInput();
  stopAll();
  line();
  say("✖ " + (e && e.message ? e.message : e));
  line();
  process.exitCode = 1;
});
