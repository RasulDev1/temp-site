// Режим GitHub Pages: каталог хранится в репозитории (catalog/catalog.json и catalog/photos/),
// а администратор сохраняет изменения через GitHub API своим ключом доступа.
// Ключ хранится только на устройстве сотрудника. Роль (директор, менеджер) определяется по Telegram ID,
// а ключ нужен, чтобы сохранять изменения: без него посторонний ничего не изменит, даже подделав роль.
import { storage } from "./core.js";
import { GITHUB_REPO } from "./config.js";

const CATALOG_PATH = "catalog/catalog.json";
const PHOTOS_DIR = "catalog/photos";
const TOKEN_KEY = "temp_github_token";
const EMPTY_CATALOG = { products: [], hidden: [], variants: {}, stock: {}, staff: [] };

/** owner/repo: из настроек или из адреса сайта (логин.github.io/репозиторий) */
export const repository = GITHUB_REPO || (() => {
  const owner = location.hostname.split(".")[0];
  const firstSegment = location.pathname.split("/").filter(Boolean)[0];
  return `${owner}/${firstSegment || `${owner}.github.io`}`;
})();

let token = storage.get(TOKEN_KEY, "");
let branch = null; // основная ветка репозитория — узнаём у GitHub перед первой записью
export const hasGitHubKey = () => Boolean(token);

/** Только что загруженные фото: пока GitHub Pages их не опубликовал, показываем локальную копию */
const freshPhotos = new Map();
export const githubPhotoUrl = (path) => freshPhotos.get(path) || path;

/** Запрос к GitHub API. Ошибки — с понятным кодом: bad_key, forbidden, repo_not_found, github_offline, conflict, github_error. */
async function github(method, path, body) {
  let response;
  try {
    response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      method,
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      body: body && JSON.stringify(body),
    });
  } catch {
    throw { code: "github_offline" }; // запрос не дошёл до api.github.com
  }
  if (response.status === 404 && method === "GET" && path) return null; // файла ещё нет
  if (response.ok) return response.status === 204 ? {} : response.json();
  const detail = (await response.json().catch(() => ({}))).message || "";
  // GitHub отвечает 404, когда у ключа нет доступа к репозиторию
  const code = { 401: "bad_key", 403: /rate limit/i.test(detail) ? "rate_limited" : "forbidden", 404: "repo_not_found", 409: "conflict", 422: "conflict" }[response.status];
  throw { code: code || "github_error", status: response.status, detail };
}

/** Узнаёт основную ветку (main, master…) — без неё GitHub не примет запись */
async function ensureBranch() {
  if (branch) return;
  const repo = await github("GET", "");
  branch = repo.default_branch;
}

const toBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const fromBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

/** Проверяет ключ: он должен давать право записи в этот репозиторий */
export async function signIn(newToken) {
  token = newToken.trim();
  try {
    const repo = await github("GET", "");
    if (!repo.permissions?.push) throw { code: "forbidden" };
    branch = repo.default_branch;
    storage.set(TOKEN_KEY, token);
  } catch (error) {
    token = storage.get(TOKEN_KEY, "");
    throw error.code ? error : { code: "server" };
  }
}

export function signOut() {
  token = "";
  storage.set(TOKEN_KEY, "");
}

/** Каталог: администратору — свежий из репозитория, покупателю — опубликованный на Pages */
export async function loadCatalog() {
  if (token) {
    const file = await ensureBranch().then(() => github("GET", `/contents/${CATALOG_PATH}?ref=${branch}`)).catch(() => null);
    if (file) return JSON.parse(fromBase64(file.content));
  }
  const response = await fetch(`${CATALOG_PATH}?v=${Date.now()}`, { cache: "no-store" });
  return response.ok ? response.json() : { ...EMPTY_CATALOG };
}

/** Читает каталог из репозитория, применяет изменение и сохраняет. При одновременной правке — повтор. */
async function updateCatalog(change, message) {
  await ensureBranch();
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = await github("GET", `/contents/${CATALOG_PATH}?ref=${branch}`);
    const catalog = { ...EMPTY_CATALOG, ...(file ? JSON.parse(fromBase64(file.content)) : {}) };
    change(catalog);
    try {
      await github("PUT", `/contents/${CATALOG_PATH}`, {
        message, branch, sha: file?.sha, content: toBase64(JSON.stringify(catalog, null, 1)),
      });
      return catalog;
    } catch (error) {
      if (error.code !== "conflict" || attempt === 2) throw error;
    }
  }
}

async function uploadPhoto(path, dataUrl) {
  await ensureBranch();
  await github("PUT", `/contents/${path}`, { message: `Фото ${path}`, branch, content: dataUrl.split(",")[1] });
  freshPhotos.set(path, dataUrl);
}

async function deleteFile(path) {
  const file = await github("GET", `/contents/${path}?ref=${branch}`).catch(() => null);
  if (file) await github("DELETE", `/contents/${path}`, { message: `Удалено ${path}`, branch, sha: file.sha });
}

/** Те же действия, что у сервера, — модули администратора не замечают разницы */
export const githubApi = {
  catalog: loadCatalog,
  setHiddenProducts: (hidden) => updateCatalog((c) => { c.hidden = hidden; }, "Скрытые товары"),
  setVariants: (id, variants) => updateCatalog((c) => {
    const empty = !variants.offColors.length && !variants.offSizes.length && !variants.offCombos.length;
    if (empty) delete c.variants[id]; else c.variants[id] = variants;
  }, "Цвета и размеры"),
  setStaff: (staff) => updateCatalog((c) => { c.staff = staff; }, "Сотрудники"),
  setStock: (id, qty) => updateCatalog((c) => { if (qty) c.stock[id] = { qty }; else delete c.stock[id]; }, "Остатки"),
  async createProduct(product) {
    const num = Date.now();
    const colors = [];
    for (const [i, color] of product.colors.entries()) {
      const path = `${PHOTOS_DIR}/${num}-${i}.jpg`;
      await uploadPhoto(path, color.image);
      colors.push({ ...color, image: path });
    }
    return updateCatalog((c) => { c.products.push({ num, createdAt: num, ...product, colors }); }, `Новый товар: ${product.name}`);
  },
  async deleteProduct(id) {
    let removed;
    await updateCatalog((c) => {
      removed = c.products.find((p) => p.num === id);
      c.products = c.products.filter((p) => p.num !== id);
      delete c.variants[id];
      delete c.stock[id];
    }, "Удалён товар");
    for (const color of removed?.colors || []) await deleteFile(color.image).catch(() => {});
  },
};
