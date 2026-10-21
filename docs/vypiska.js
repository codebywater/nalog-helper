/*
 * vypiska — разбор CSV-выписок российских банков в единый список операций.
 * Без зависимостей; работает в браузере (window.Vypiska) и в Node (require).
 * Ничего никуда не отправляет.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Vypiska = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Ключевые слова колонок по приоритету: первое совпадение побеждает.
  const HEADERS = {
    // Дата поступления/списания денег, а не дата документа.
    date: ["дата операции", "дата совершения операции", "дата проводки", "дата поступления", "дата зачисления",
      "дата списания", "дата платежа", "дата транзакции", "дата", "date"],
    credit: ["по кредиту", "приход", "зачисление", "поступление", "кредит", "credit"],
    debit: ["по дебету", "расход", "списание", "дебет", "debit"],
    // Сначала сумма в валюте счёта: у Т-Банка это «Сумма платежа», у ВТБ — «Сумма пересчитанная в валюту счета».
    amount: ["сумма платежа", "сумма в валюте сч", "сумма пересчитанная в валют", "сумма операции", "сумма", "amount"],
    currency: ["валюта платежа", "валюта счета", "валюта счёта", "валюта операции", "валюта", "currency"],
    status: ["статус", "status"],
    category: ["категория", "category"],
    mcc: ["mcc"],
    description: ["назначение платежа", "назначение", "описание операции", "детали операции", "описание", "основание", "description", "merchant"],
    counterparty: ["плательщик", "получатель", "контрагент", "отправитель", "наименование контрагента", "payer", "payee"],
  };
  const ORDER = ["date", "credit", "debit", "amount", "currency", "status", "category", "mcc", "description", "counterparty"];
  const MONEY_KEYS = new Set(["credit", "debit", "amount"]);
  // «Счет Кредит», «ИНН», «Банк» — это не суммы, даже если в названии есть «кредит».
  const NOT_MONEY_HEADER = /сч[её]т|инн|бик|банк|наименован|кэшб[эе]к|бонус|cashback/;
  // Остаток и баланс — не сумма операции, даже если «в валюте счёта».
  const BALANCE_HEADER = /остат|баланс|сальдо|лимит|balance/;
  const MONEY_HEADER = /сумм|оборот/;
  const FAILED = /отклон|failed|declined|отмен|cancel|ошибк/i;
  // «RUB», «Рубли», «Российский рубль (RUB)», код 643 или старый 810 — всё это рубли.
  const RUB = /^$|^(rub|rur|₽|руб|рубл|российск|643|810)/i;
  const DELIMITERS = [";", ",", "\t"];

  // Строки таблицы и номер строки файла, с которой каждая начинается (для поля line).
  function parseRows(text, delim, byLine = false) {
    if (byLine) {
      const rows = [], lines = [];
      text.split(/\r?\n/).forEach((l, k) => {
        for (const r of parseRows(l, delim).rows) { rows.push(r); lines.push(k + 1); }
      });
      return { rows, lines };
    }
    const raw = [];
    let row = [], cur = "", quoted = false, line = 1, start = 1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else {
          cur += ch;
          if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
        }
      } else if (ch === '"' && cur.trim() === "") { quoted = true; cur = ""; }
      else if (ch === delim) { row.push(cur); cur = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cur); raw.push([row, start]); row = []; cur = "";
        start = ++line;
      } else cur += ch;
    }
    // Незакрытая кавычка съела бы остаток файла: тогда разбираем по строкам.
    if (quoted && text.includes("\n")) return parseRows(text, delim, true);
    row.push(cur); raw.push([row, start]);
    const rows = [], lines = [];
    for (const [r, l] of raw) {
      const cells = r.map((c) => c.replace(/\s*[\r\n]+\s*/g, " ").trim());
      if (cells.some(Boolean)) { rows.push(cells); lines.push(l); }
    }
    return { rows, lines };
  }

  /*
   * CSV целиком, а не построчно: Excel сохраняет ячейки с переносом строки
   * («счёт / ИНН / название») в кавычках, и такая запись занимает несколько строк.
   * Кавычка открывает поле только в его начале; внутри поля она обычный символ.
   */
  function parseCsv(text, delim) { return parseRows(text, delim).rows; }

  function findColumns(header) {
    const lower = header.map((h) => h.toLowerCase().replace(/\s+/g, " ").replace(/^['"]|['"]$/g, ""));
    const cols = {};
    const used = new Set();
    const fits = (key, h) => !MONEY_KEYS.has(key) ||
      !BALANCE_HEADER.test(h) && (!NOT_MONEY_HEADER.test(h) || MONEY_HEADER.test(h) && !/кэшб[эе]к|бонус/.test(h));
    for (const key of ORDER) {
      for (const kw of HEADERS[key]) {
        const idx = lower.findIndex((h, i) => !used.has(i) && (key === "mcc" ? h === kw : h.includes(kw)) && fits(key, h));
        if (idx !== -1) { cols[key] = idx; used.add(idx); break; }
      }
    }
    // Сумма уже в валюте счёта — значит «Валюта операции» к ней не относится.
    if (cols.currency !== undefined && cols.amount !== undefined &&
        /платеж|в валют[еу] сч/.test(lower[cols.amount]) && /операци/.test(lower[cols.currency])) delete cols.currency;
    if (cols.currency !== undefined && BALANCE_HEADER.test(lower[cols.currency])) delete cols.currency;
    return cols;
  }

  const isHeader = (cols) => cols.date !== undefined && (cols.amount !== undefined || cols.credit !== undefined || cols.debit !== undefined);

  // Разделитель и шапку ищем вместе: заголовок «Выписка по счету …, ИП …» с запятой не должен решать за весь файл.
  function findHeader(text) {
    let best = null;
    for (const delim of DELIMITERS) {
      const { rows, lines } = parseRows(text, delim);
      for (let i = 0; i < Math.min(rows.length, 50); i++) {
        const cols = findColumns(rows[i]);
        if (!isHeader(cols)) continue;
        if (!best || i < best.idx || (i === best.idx && rows[i].length > best.rows[best.idx].length)) best = { rows, lines, idx: i, cols, delim };
        break;
      }
    }
    return best;
  }

  /*
   * «1 500,00», «−1 500,00», «(1 500,00)», «1500,00-», «1,500.00», «1.500,00 р.» → число.
   * Пустая строка и не-число → null. 15 и больше цифр — это номер счёта, а не сумма.
   */
  function parseAmount(s) {
    if (s == null) return null;
    let t = String(s).replace(/[−–—]/g, "-").replace(/руб\.?|р\.|rur|rub|₽|[\s  ']/gi, "").replace(/р$/i, "");
    let neg = false;
    const paren = /^\((.*)\)$/.exec(t);
    if (paren) { neg = true; t = paren[1]; }
    if (/^[^-+].*-$/.test(t)) { neg = true; t = t.slice(0, -1); }
    if (t.includes(",") && t.includes(".")) {
      t = t.indexOf(",") < t.indexOf(".") ? t.replace(/,/g, "") : t.replace(/\./g, "").replace(",", ".");
    } else if ((t.match(/,/g) || []).length > 1) t = t.replace(/,/g, "");
    else if ((t.match(/\./g) || []).length > 1) t = t.replace(/\./g, "");
    else t = t.replace(",", ".");
    if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(t)) return null;   // Сбер пишет копейки как «-,01»
    if (t.replace(/^[+-]/, "").split(".")[0].length >= 15) return null;
    const n = Number(t);
    return neg ? -Math.abs(n) : n;
  }

  const DMY = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)/;
  const YMD = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?!\d)/;
  const TIME = /(?:^|[ T])(\d{1,2}):(\d{2})(?::(\d{2}))?/;

  function validDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
    return { y, m, d };
  }

  // order: "dmy" (как в российских банках) или "mdy" (Excel с американскими настройками).
  function parseDate(s, order = "dmy") {
    s = String(s || "").trim().replace(/^'/, "");
    let m = DMY.exec(s), date = null;
    if (m) {
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      date = order === "mdy" ? validDate(y, +m[1], +m[2]) : validDate(y, +m[2], +m[1]);
    } else if ((m = YMD.exec(s))) date = validDate(+m[1], +m[2], +m[3]);
    if (!date) return null;
    const t = TIME.exec(s.slice(m[0].length));
    return { ...date, h: t ? +t[1] : null, min: t ? +t[2] : null };
  }

  // Если «месяц» где-то больше 12, а «день» нигде не больше 12, файл записан как месяц/день/год.
  function detectDateOrder(cells) {
    const parts = cells.map((c) => DMY.exec(String(c).trim())).filter(Boolean);
    const firstOver = parts.some((m) => +m[1] > 12), secondOver = parts.some((m) => +m[2] > 12);
    return secondOver && !firstOver ? "mdy" : "dmy";
  }

  const pad = (n) => String(n).padStart(2, "0");

  function emptyStats() {
    return { rows: 0, ops: 0, badDate: 0, badAmount: 0, failed: 0, zero: 0, foreign: 0, dateOrder: "dmy" };
  }

  /*
   * Разбор одной выписки.
   * Возвращает { ops, stats, columns, delimiter }:
   *   ops — операции: { date: "ГГГГ-ММ-ДД", time: "ЧЧ:ММ" | null, amount, currency, description,
   *          counterparty, category, mcc, status, line };
   *          amount в валюте счёта: плюс — поступление, минус — списание;
   *   stats — сколько строк пропущено и почему, чтобы ничего не терялось молча;
   *   columns — какие колонки файла чем стали (по названиям из шапки).
   * Опции: includeFailed — не отбрасывать отклонённые операции (по умолчанию отбрасываются);
   *        includeForeign — оставлять операции не в рублях (по умолчанию пропускаются и считаются в stats.foreign).
   */
  function parse(text, { includeFailed = false, includeForeign = false } = {}) {
    text = String(text).replace(/^﻿/, "");
    if (text.split(/\r?\n/).filter((l) => l.trim()).length < 2) throw new Error("В файле нет строк с операциями.");
    const found = findHeader(text);
    if (!found) {
      const anyDate = DELIMITERS.some((d) => parseCsv(text, d).slice(0, 50).some((r) => findColumns(r).date !== undefined));
      throw new Error(anyDate ? "Не нашёл колонку с суммой." : "Не нашёл колонку с датой. Нужна шапка вида «Дата операции;Сумма;Описание».");
    }
    const { rows, lines, idx, cols, delim } = found;
    const header = rows[idx];
    const data = rows.slice(idx + 1);
    const order = detectDateOrder(data.map((r) => r[cols.date] || ""));
    const stats = emptyStats();
    stats.dateOrder = order;
    const moneyCols = [cols.credit, cols.debit, cols.amount].filter((c) => c !== undefined);
    const get = (row, key) => (cols[key] !== undefined ? (row[cols[key]] || "").trim() : "");

    const ops = [];
    data.forEach((row, i) => {
      const cell = row[cols.date] || "";
      const date = parseDate(cell, order);
      if (!date) { if (DMY.test(cell.trim()) || YMD.test(cell.trim())) { stats.rows++; stats.badDate++; } return; }
      stats.rows++;
      const status = get(row, "status");
      if (!includeFailed && FAILED.test(status)) { stats.failed++; return; }
      let amount = null;
      if (cols.credit !== undefined || cols.debit !== undefined) {
        const credit = cols.credit !== undefined ? parseAmount(row[cols.credit]) : null;
        const debit = cols.debit !== undefined ? parseAmount(row[cols.debit]) : null;
        if (credit) amount = Math.abs(credit);
        else if (debit) amount = -Math.abs(debit);
      }
      if (amount === null && cols.amount !== undefined) amount = parseAmount(row[cols.amount]);
      if (amount === null) {
        if (moneyCols.some((c) => (row[c] || "").trim() && parseAmount(row[c]) === null)) stats.badAmount++;
        else stats.zero++;
        return;
      }
      if (!amount) { stats.zero++; return; }
      const cur = get(row, "currency");
      const currency = RUB.test(cur) ? "RUB" : cur.toUpperCase();
      if (currency !== "RUB") { stats.foreign++; if (!includeForeign) return; }
      ops.push({
        date: `${date.y}-${pad(date.m)}-${pad(date.d)}`,
        time: date.h === null ? null : `${pad(date.h)}:${pad(date.min)}`,
        amount: Math.round(amount * 100) / 100,
        currency,
        description: get(row, "description"),
        counterparty: cols.counterparty !== cols.description ? get(row, "counterparty") : "",
        category: get(row, "category"),
        // Альфа-Банк пишет MCC прямо в описание: «… RUR MCC4121».
        mcc: get(row, "mcc") || ((/(?<![A-Za-z])MCC\s?(\d{4})(?!\d)/i.exec(get(row, "description")) || [])[1] || ""),
        status,
        line: lines[idx + 1 + i],
      });
    });
    // Время 00:00 у всех операций — это заглушка банка (так делает ВТБ), а не покупки в полночь.
    if (ops.length > 1 && ops.every((o) => o.time === null || o.time === "00:00")) ops.forEach((o) => { o.time = null; });
    stats.ops = ops.length;
    const columns = Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, header[v]]));
    return { ops, stats, columns, delimiter: delim };
  }

  /*
   * Байты файла → текст. Банки отдают CSV в UTF-8 или Windows-1251. Один битый
   * байт в UTF-8 не повод перекодировать весь файл: берём ту кодировку,
   * в которой выписка разбирается лучше.
   */
  function decode(bytes) {
    const utf8 = new TextDecoder("utf-8").decode(bytes);
    if (!utf8.includes("�")) return utf8;
    const cp1251 = new TextDecoder("windows-1251").decode(bytes);
    const score = (t) => { try { return parse(t).ops.length; } catch (e) { return -1; } };
    return score(cp1251) > score(utf8) ? cp1251 : utf8;
  }

  // Несколько выписок (разные счета и банки): каждая разбирается со своей шапкой.
  function parseMany(texts, opts) {
    const results = texts.map((t) => parse(t, opts));
    const stats = emptyStats();
    for (const r of results) for (const k of Object.keys(stats)) if (typeof stats[k] === "number") stats[k] += r.stats[k];
    stats.dateOrder = results.some((r) => r.stats.dateOrder === "mdy") ? "mixed" : "dmy";
    const ops = results.flatMap((r, file) => r.ops.map((o) => ({ ...o, file })));
    ops.sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
    return { ops, stats, files: results.map(({ columns, delimiter, stats: s }) => ({ columns, delimiter, stats: s })) };
  }

  return { parse, parseMany, decode, parseAmount, parseDate, parseCsv, findColumns, HEADERS };
});
