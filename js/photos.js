// Фото товаров: разметка, уменьшенные копии для каталога, перекраска ткани по маске, плавная смена.
import { reducedMotion } from "./core.js";
import { colorName } from "./catalog.js";

/** Уменьшенная копия есть только у встроенных фото */
const thumbnailOf = (url) => (url.startsWith("img/products/") ? url.replace(/\.jpg$/, "-thumb.jpg") : url);
const needsRecolor = (product, color) => Boolean(color && product.recolorMask && color !== product.colors[0] && !product.colorPhotos?.[color]);
const photoUrl = (product, color) => product.colorPhotos?.[color] || product.photo;

/** <img> товара. thumb — для каталога и корзины. Перекрашенные цвета подставляет applyRecolors(). */
export function productImage(product, color, { thumb = false, lazy = false } = {}) {
  const recolorKey = needsRecolor(product, color) ? `${product.id}|${color}` : "";
  const url = recolorCache.get(recolorKey) || (thumb ? thumbnailOf(photoUrl(product, color)) : photoUrl(product, color));
  return `<img class="ph" src="${url}" alt="${product.name}${color ? ", " + colorName(product, color) : ""}"
    style="object-position:${product.photoPosition}" decoding="async"${lazy ? ' loading="lazy"' : ""}${recolorKey ? ` data-recolor="${recolorKey}"` : ""}>`;
}

/* ---------- Перекраска ткани ---------- */
const recolorCache = new Map();   // "id|цвет" → data URL
const recolorJobs = new Map();    // "id|цвет" → Promise
const loadImage = (src) => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = reject;
  image.src = src;
});

/** Перекрашивает ткань на фото, сохраняя складки и тени: сдвиг яркости пикселя переносится на новый цвет */
export function recolor(product, color) {
  const key = `${product.id}|${color}`;
  if (recolorCache.has(key)) return Promise.resolve(recolorCache.get(key));
  if (recolorJobs.has(key)) return recolorJobs.get(key);
  const job = Promise.all([loadImage(product.photo), loadImage(product.recolorMask)]).then(([photo, mask]) => {
    const { naturalWidth: w, naturalHeight: h } = photo;
    const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(mask, 0, 0, w, h);
    const alpha = ctx.getImageData(0, 0, w, h).data;
    ctx.drawImage(photo, 0, 0, w, h);
    const frame = ctx.getImageData(0, 0, w, h);
    const px = frame.data;
    const target = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    const brightness = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

    let sum = 0, count = 0;
    for (let i = 0; i < px.length; i += 4) if (alpha[i] > 127) { sum += brightness(px[i], px[i + 1], px[i + 2]); count++; }
    const mean = count ? sum / count : 128;
    const contrast = 1 + Math.max(0, (brightness(...target) - mean) / 255) * 1.6; // светлый цвет на тёмной ткани — усиливаем складки

    for (let i = 0; i < px.length; i += 4) {
      const a = alpha[i] / 255;
      if (!a) continue;
      const shade = (brightness(px[i], px[i + 1], px[i + 2]) - mean) * contrast;
      for (let ch = 0; ch < 3; ch++) px[i + ch] = px[i + ch] * (1 - a) + Math.min(255, Math.max(0, target[ch] + shade)) * a;
    }
    ctx.putImageData(frame, 0, 0);
    const url = canvas.toDataURL("image/jpeg", 0.88);
    recolorCache.set(key, url);
    return url;
  }).catch(() => product.photo).finally(() => recolorJobs.delete(key));
  recolorJobs.set(key, job);
  return job;
}

/** Подставляет перекрашенные фото во все <img data-recolor> внутри root */
export function applyRecolors(root, findProduct) {
  root.querySelectorAll("img[data-recolor]").forEach((img) => {
    const key = img.dataset.recolor;
    const [id, color] = key.split("|");
    const product = findProduct(Number(id));
    if (product) recolor(product, color).then((url) => { if (img.dataset.recolor === key) img.src = url; });
  });
}

/** Новое фото проявляется поверх старого */
export function swapImage(img, src) {
  if (!img || img.src.endsWith(src)) return;
  if (reducedMotion) { img.src = src; return; }
  const incoming = Object.assign(img.cloneNode(), { src });
  incoming.removeAttribute("data-recolor");
  incoming.classList.add("incoming");
  img.after(incoming);
  const reveal = () => {
    requestAnimationFrame(() => incoming.classList.add("in"));
    setTimeout(() => { img.src = src; incoming.remove(); }, 300);
  };
  incoming.decode().then(reveal, reveal);
}

/** Фото товара в выбранном цвете (для смены цвета в карточке) */
export async function photoForColor(product, color) {
  return needsRecolor(product, color) ? recolor(product, color) : photoUrl(product, color);
}
