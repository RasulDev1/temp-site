// Выгрузка в Excel (директор, «Аналитика»): заказы за период, позиции заказов и клиенты — три листа одного файла.
// Библиотека SheetJS подгружается только по нажатию; если она не загрузилась — скачивается CSV, его тоже открывает Excel.
import { api } from "./state.js?v=20261001b";

const LIBRARY = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
const STATUS = { new: "Новый", awaiting_payment: "Ждёт оплаты", paid: "Оплачен", delivered: "Вручён", cancelled: "Отказ",
  return_requested: "Просят возврат", return_approved: "Возврат одобрен", returned: "Возврат вручён" };
const METHOD = { cash: "Наличные", card: "Карта" };
const SOLD = ["paid", "delivered", "return_requested", "return_approved", "returned"];

function loadLibrary() {
  if (window.XLSX) return Promise.resolve(true);
  return new Promise((resolve) => {
    const script = Object.assign(document.createElement("script"), { src: LIBRARY });
    const timer = setTimeout(() => resolve(false), 15000);
    script.onload = () => { clearTimeout(timer); resolve(Boolean(window.XLSX)); };
    script.onerror = () => { clearTimeout(timer); resolve(false); };
    document.head.appendChild(script);
  });
}

/** Дата и время по Москве — так же считает «Аналитика» */
const moscow = (iso) => (iso ? new Date(iso).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const num = (v) => (v == null || v === "" ? "" : Number(v));

function ordersSheet(orders) {
  return orders.map((o) => {
    const sold = SOLD.includes(o.status) && o.paid != null;
    const revenue = sold ? Number(o.paid) - (Number(o.refund) || 0) : "";
    // вещь, вернувшаяся на склад, не в расходах — как в «Аналитике»
    const cost = o.cost == null ? "" : o.status === "returned" && o.restocked ? 0 : Number(o.cost);
    return {
      "№": o.id, "Дата заказа": moscow(o.created_at), "Статус": STATUS[o.status] || o.status,
      "Покупатель": o.customer || "", "Телефон": o.phone || "", "Откуда узнал": o.source || "",
      "Доставка": o.way || "", "Адрес": o.addr || "", "Сумма заказа": num(o.total),
      "Оплачено": num(o.paid), "Способ оплаты": METHOD[o.method] || "", "Дата оплаты": moscow(o.paid_at),
      "Менеджер": o.manager || "", "Вручён": moscow(o.delivered_at),
      "Возвращено": num(o.refund), "Причина возврата": o.return_reason || "",
      "Выручка": revenue, "Себестоимость": sold ? cost : "", "Прибыль": sold && cost !== "" ? revenue - cost : "",
    };
  });
}

function itemsSheet(orders) {
  return orders.flatMap((o) => (Array.isArray(o.items) ? o.items : []).map((l) => ({
    "№ заказа": o.id, "Дата": moscow(o.created_at), "Статус": STATUS[o.status] || o.status,
    "Товар": l.name || "", "Цвет": l.colorName || l.color || "", "Размер": l.size || "",
    "Количество": num(l.qty), "Цена": num(l.price), "Сумма": num((Number(l.qty) || 0) * (Number(l.price) || 0)),
  })));
}

function customersSheet(customers) {
  return customers.map((c) => ({
    "Покупатель": c.name || "", "Телефон": c.phone || "", "Telegram": c.username ? "@" + c.username : String(c.id || ""),
    "Откуда узнал": c.source || "", "Заказов": num(c.orders), "Оплачено заказов": num(c.bought), "Возвратов": num(c.returns),
    "Купил на": num(c.spent), "Метки": (c.tags || []).join(", "),
    "Первый заказ": moscow(c.first_at), "Последний заказ": moscow(c.last_at),
  }));
}

const fileName = (from, to, ext) => `temp-${from || "start"}_${to || new Date().toISOString().slice(0, 10)}.${ext}`;

function download(blob, name) {
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

/** CSV с разделителем «;» и BOM — Excel с русской локалью открывает его без настроек */
function toCsv(rows) {
  const head = Object.keys(rows[0] || {});
  const cell = (v) => { const s = String(v ?? ""); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return "﻿" + [head.join(";"), ...rows.map((r) => head.map((k) => cell(r[k])).join(";"))].join("\r\n");
}

/** from / to — "ГГГГ-ММ-ДД" или null (всё время). Возвращает { csv: true }, если пришлось скачать CSV. */
export async function exportToExcel(from, to) {
  const [orders, customers] = await Promise.all([api.exportOrders(from, to), api.customersList().catch(() => [])]);
  if (!orders?.length) throw { code: "empty" };
  const sheets = [["Заказы", ordersSheet(orders)], ["Позиции", itemsSheet(orders)], ["Клиенты", customersSheet(customers || [])]];
  if (!(await loadLibrary())) {
    download(new Blob([toCsv(sheets[0][1])], { type: "text/csv;charset=utf-8" }), fileName(from, to, "csv"));
    return { csv: true };
  }
  const { utils, write } = window.XLSX, book = utils.book_new();
  for (const [title, rows] of sheets) {
    const sheet = utils.json_to_sheet(rows.length ? rows : [{ "": "Нет данных" }]);
    sheet["!cols"] = Object.keys(rows[0] || { "": "" }).map((k) => ({ wch: Math.min(40, Math.max(k.length + 2,
      ...rows.slice(0, 200).map((r) => String(r[k] ?? "").length + 1))) }));
    utils.book_append_sheet(book, sheet, title);
  }
  const data = write(book, { bookType: "xlsx", type: "array" });
  download(new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), fileName(from, to, "xlsx"));
  return { csv: false };
}
