// Сетевые запросы с учётом прокси из настроек системы.
// Порядок поиска прокси:
//   1. PROXY в файле .env (например socks5://127.0.0.1:1080 или http://127.0.0.1:8080);
//   2. переменные окружения HTTPS_PROXY / HTTP_PROXY / ALL_PROXY;
//   3. системные настройки: Windows — «Параметры → Сеть и Интернет → Прокси»
//      (в том числе, если их выставляет VPN-клиент), macOS — настройки сети.
// Если через прокси не получилось, запрос повторяется напрямую, и наоборот.
// Сторонние пакеты не нужны: поддерживаются HTTP-прокси (CONNECT) и SOCKS5.

const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const { execSync } = require("child_process");

let detected; // кэш: { url, type, host, port, auth, source } | null

function parseProxy(str, source) {
  if (!str) return null;
  let s = String(str).trim();
  if (!s) return null;
  if (!/^[a-z0-9]+:\/\//i.test(s)) s = "http://" + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  const proto = u.protocol.replace(":", "").toLowerCase();
  const type = /^socks/.test(proto) ? "socks5" : "http";
  const port = Number(u.port) || (type === "socks5" ? 1080 : 8080);
  if (!u.hostname) return null;
  return {
    type,
    host: u.hostname.replace(/^\[|\]$/g, ""),
    port,
    auth: u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password || "") } : null,
    url: `${type}://${u.hostname}:${port}`,
    source,
  };
}

/* Windows: прокси из реестра (то же, что в «Параметрах Windows»). PAC-скрипт разбираем упрощённо. */
function windowsProxy() {
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const q = (name) => {
    try {
      const out = execSync(`reg query "${key}" /v ${name}`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
      const m = new RegExp(name + "\\s+REG_\\w+\\s+(.*)").exec(out);
      return m ? m[1].trim() : null;
    } catch { return null; }
  };
  const enabled = q("ProxyEnable");
  const server = q("ProxyServer");
  if (enabled && /0x0*1$/i.test(enabled) && server) {
    if (server.includes("=")) {
      const map = {};
      for (const part of server.split(";")) {
        const [k, v] = part.split("=");
        if (k && v) map[k.trim().toLowerCase()] = v.trim();
      }
      if (map.https) return parseProxy(map.https, "Windows");
      if (map.http) return parseProxy(map.http, "Windows");
      if (map.socks) return parseProxy("socks5://" + map.socks, "Windows");
    } else return parseProxy(server, "Windows");
  }
  const pac = q("AutoConfigURL");
  if (pac) return { pac, source: "Windows (PAC)" };
  return null;
}

/* macOS: scutil --proxy */
function macProxy() {
  try {
    const out = execSync("scutil --proxy", { stdio: ["ignore", "pipe", "ignore"] }).toString();
    const g = (k) => { const m = new RegExp("\\b" + k + "\\s*:\\s*(\\S+)").exec(out); return m ? m[1] : null; };
    if (g("HTTPSEnable") === "1" && g("HTTPSProxy")) return parseProxy(`http://${g("HTTPSProxy")}:${g("HTTPSPort") || 443}`, "macOS");
    if (g("SOCKSEnable") === "1" && g("SOCKSProxy")) return parseProxy(`socks5://${g("SOCKSProxy")}:${g("SOCKSPort") || 1080}`, "macOS");
    if (g("HTTPEnable") === "1" && g("HTTPProxy")) return parseProxy(`http://${g("HTTPProxy")}:${g("HTTPPort") || 80}`, "macOS");
    if (g("ProxyAutoConfigEnable") === "1" && g("ProxyAutoConfigURLString")) return { pac: g("ProxyAutoConfigURLString"), source: "macOS (PAC)" };
  } catch {}
  return null;
}

/* PAC: берём первый PROXY/SOCKS из скрипта. Точной логики PAC это не заменяет, но для VPN-клиентов обычно хватает. */
async function fromPac(pacUrl, source) {
  try {
    const r = await rawRequest(new URL(pacUrl), { timeout: 5000 }, null);
    const txt = r.body.toString("utf8");
    const m = /\b(SOCKS5|SOCKS|PROXY|HTTPS)\s+([\w.-]+:\d+)/i.exec(txt);
    if (m) return parseProxy((/^SOCKS/i.test(m[1]) ? "socks5://" : "http://") + m[2], source);
  } catch {}
  return null;
}

async function detectProxy(envProxy) {
  if (detected !== undefined) return detected;
  let p = parseProxy(envProxy, ".env");
  if (!p) {
    const e = process.env;
    p = parseProxy(e.HTTPS_PROXY || e.https_proxy || e.ALL_PROXY || e.all_proxy || e.HTTP_PROXY || e.http_proxy, "переменные окружения");
  }
  if (!p && process.platform === "win32") p = windowsProxy();
  if (!p && process.platform === "darwin") p = macProxy();
  if (p && p.pac) p = await fromPac(p.pac, p.source);
  detected = p || null;
  return detected;
}
function setProxy(p) { detected = p; }

const isLocal = (h) => /^(localhost|127\.|10\.|192\.168\.|::1$|\[::1\])/.test(h);

/* Туннель через прокси до host:port — обычный TCP-сокет */
function tunnel(proxy, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxy.port, proxy.host);
    let buf = Buffer.alloc(0), stage = 0, done = false;
    const fail = (msg) => { if (done) return; done = true; sock.destroy(); reject(Object.assign(new Error(msg), { code: "EPROXY" })); };
    sock.setTimeout(timeout, () => fail("прокси не отвечает"));
    sock.on("error", (e) => fail("прокси недоступен: " + (e.code || e.message)));
    sock.on("close", () => fail("прокси закрыл соединение"));
    const ok = () => { if (done) return; done = true; sock.setTimeout(0); sock.removeAllListeners("data"); resolve(sock); };

    if (proxy.type === "http") {
      sock.on("connect", () => {
        const auth = proxy.auth ? `Proxy-Authorization: Basic ${Buffer.from(proxy.auth.user + ":" + proxy.auth.pass).toString("base64")}\r\n` : "";
        sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
      });
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const status = /^HTTP\/1\.\d (\d{3})/.exec(buf.slice(0, end).toString());
        if (status && status[1] === "200") ok();
        else fail("прокси отказал: " + (status ? status[1] : "неверный ответ"));
      });
      return;
    }

    // SOCKS5
    sock.on("connect", () => sock.write(Buffer.from(proxy.auth ? [5, 2, 0, 2] : [5, 1, 0])));
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2) {
        const method = buf[1]; buf = buf.slice(2);
        if (method === 2 && proxy.auth) {
          const u = Buffer.from(proxy.auth.user), p = Buffer.from(proxy.auth.pass);
          sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
          stage = 1;
        } else if (method === 0) { sendConnect(); stage = 2; }
        else return fail("SOCKS5: способ входа не поддерживается");
      }
      if (stage === 1 && buf.length >= 2) {
        if (buf[1] !== 0) return fail("SOCKS5: неверный логин или пароль");
        buf = buf.slice(2); sendConnect(); stage = 2;
      }
      if (stage === 2 && buf.length >= 5) {
        if (buf[1] !== 0) return fail("SOCKS5: прокси не смог подключиться (код " + buf[1] + ")");
        const atyp = buf[3];
        const len = atyp === 1 ? 10 : atyp === 4 ? 22 : 7 + buf[4];
        if (buf.length >= len) ok();
      }
    });
    function sendConnect() {
      const h = Buffer.from(host);
      sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
    }
  });
}

/* Один запрос: через прокси (если задан) либо напрямую */
async function rawRequest(u, opts, proxy) {
  const { method = "GET", body, headers = {}, timeout = 15000 } = opts;
  const secure = u.protocol === "https:";
  const port = Number(u.port) || (secure ? 443 : 80);
  let agent;
  if (proxy) {
    const sock = await tunnel(proxy, u.hostname, port, timeout);
    const conn = secure ? tls.connect({ socket: sock, servername: u.hostname }) : sock;
    agent = new (secure ? https.Agent : http.Agent)({ keepAlive: false });
    agent.createConnection = () => conn; // запрос пойдёт по уже открытому туннелю
  }
  const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const h = { ...headers };
  if (data) { h["Content-Length"] = data.length; if (!h["Content-Type"]) h["Content-Type"] = "application/json"; }
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(u, { method, headers: h, timeout, agent }, (res) => {
      const chunks = [];
      const total = Number(res.headers["content-length"]) || 0;
      let got = 0;
      res.on("data", (c) => { chunks.push(c); got += c.length; if (opts.onProgress) opts.onProgress(got, total); });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/* Публичная функция: сначала предпочтительный путь, при сетевой ошибке — второй */
let preferDirect = false;
async function request(url, opts = {}) {
  const u = new URL(url);
  const proxy = isLocal(u.hostname) ? null : detected;
  if (!proxy) return rawRequest(u, opts, null);
  const order = preferDirect ? [null, proxy] : [proxy, null];
  const errors = [];
  for (const p of order) {
    try {
      const r = await rawRequest(u, opts, p);
      preferDirect = p === null;
      return r;
    } catch (e) { errors.push(e); }
  }
  throw errors.find((e) => e.code === "EPROXY") || errors[0]; // сообщаем про прокси, если он подвёл
}

module.exports = { detectProxy, setProxy, request, parseProxy };
