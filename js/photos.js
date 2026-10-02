// Фото товаров: разметка, уменьшенные копии для каталога, плавная смена при выборе цвета.
import { reducedMotion } from "./core.js?v=20261001b";
import { colorName } from "./catalog.js?v=20261001b";

/** Уменьшенная копия *-thumb.jpg есть только у встроенных фото: в img/products/ и в корне сайта */
const hasThumbnail = (url) => /\.jpg$/.test(url) && (url.startsWith("img/products/") || !url.includes("/"));
const thumbnailOf = (url) => (hasThumbnail(url) ? url.replace(/\.jpg$/, "-thumb.jpg") : url);
const photoUrl = (product, color) => product.colorPhotos?.[color] || product.photo;

/** <img> товара. thumb — для каталога и корзины. */
export function productImage(product, color, { thumb = false, lazy = false } = {}) {
  const url = thumb ? thumbnailOf(photoUrl(product, color)) : photoUrl(product, color);
  return `<img class="ph" src="${url}" alt="${product.name}${color ? ", " + colorName(product, color) : ""}"
    style="object-position:${product.photoPosition}" decoding="async"${lazy ? ' loading="lazy"' : ""}>`;
}

/** Новое фото проявляется поверх старого */
export function swapImage(img, src) {
  if (!img || img.src.endsWith(src)) return;
  if (reducedMotion) { img.src = src; return; }
  const incoming = Object.assign(img.cloneNode(), { src });
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
  return photoUrl(product, color);
}
