/*
 * nalog-helper — ядро расчёта. Работает в браузере и в Node (для тестов).
 * Ничего никуда не отправляет: только разбор CSV и арифметика.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Nalog = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Параметры по годам. Источники — в README («Откуда цифры»).
  const PARAMS = {
    2026: {
      fixedContributions: 57390,   // фиксированные взносы ИП за себя
      onePercentBase: 300000,      // 1% с дохода сверх этой суммы
      onePercentMax: 321818,       // потолок 1%-го взноса
      usnLimit: 490500000,         // лимит доходов на УСН
      ndsThreshold: 20000000,      // порог освобождения от НДС на УСН
      npdLimit: 2400000,           // лимит дохода самозанятого
    },
  };

  function params(year) {
    const p = PARAMS[year];
    if (!p) throw new Error(`Нет параметров для ${year} года. Поддерживаются: ${Object.keys(PARAMS).join(", ")}`);
    return p;
  }

  const round2 = (x) => Math.round(x * 100) / 100;
  const roundRub = (x) => Math.round(x);  // налог и авансы платятся в полных рублях

  // ---------- разбор выписки ----------

  const HEADERS = {
    date: ["дата операции", "дата проводки", "дата", "date"],
    amount: ["сумма операции", "сумма в валюте счета", "сумма в валюте счёта", "сумма", "amount"],
    credit: ["приход", "зачисление", "поступление", "кредит", "credit"],
    debit: ["расход", "списание", "дебет", "debit"],
    description: ["назначение платежа", "назначение", "описание", "контрагент", "плательщик", "description"],
    payer: ["плательщик", "контрагент", "отправитель", "payer"],
  };

  function detectDelimiter(line) {
    const counts = [";", ",", "\t"].map((d) => [d, line.split(d).length]);
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][0];
  }

  function splitCsvLine(line, delim) {
    const out = [];
    let cur = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delim) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  function findColumns(header) {
    const lower = header.map((h) => h.toLowerCase());
    const cols = {};
    const used = new Set();
    for (const key of ["date", "credit", "debit", "amount", "description", "payer"]) {
      for (const kw of HEADERS[key]) {
        const idx = lower.findIndex((h, i) => !used.has(i) && h.includes(kw));
        if (idx !== -1) { cols[key] = idx; used.add(idx); break; }
      }
    }
    return cols;
  }

  function parseAmount(s) {
    if (s == null) return null;
    const clean = String(s).replace(/[\s ₽]|руб\.?|RUB/gi, "").replace(",", ".");
    if (clean === "" || clean === "-") return null;
    const n = Number(clean);
    return Number.isFinite(n) ? n : null;
  }

  function parseDate(s) {
    let m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(s);
    if (m) return { y: +m[3], m: +m[2], d: +m[1] };
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return { y: +m[1], m: +m[2], d: +m[3] };
    return null;
  }

  function parseStatement(text) {
    const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) throw new Error("В файле нет строк с операциями.");
    const delim = detectDelimiter(lines[0]);
    // Шапка может быть не в первой строке: ищем строку с колонкой даты.
    let headerIdx = 0, cols = {};
    for (let i = 0; i < Math.min(lines.length, 15); i++) {
      cols = findColumns(splitCsvLine(lines[i], delim));
      if (cols.date !== undefined && (cols.amount !== undefined || cols.credit !== undefined)) { headerIdx = i; break; }
    }
    if (cols.date === undefined) throw new Error("Не нашёл колонку с датой. Нужна шапка вида «Дата;Сумма;Описание».");
    if (cols.amount === undefined && cols.credit === undefined) throw new Error("Не нашёл колонку с суммой или поступлениями.");

    const ops = [];
    for (const line of lines.slice(headerIdx + 1)) {
      const row = splitCsvLine(line, delim);
      const date = parseDate(row[cols.date] || "");
      if (!date) continue;
      let amount = null;
      if (cols.credit !== undefined) {
        const credit = parseAmount(row[cols.credit]);
        const debit = cols.debit !== undefined ? parseAmount(row[cols.debit]) : null;
        if (credit) amount = Math.abs(credit);
        else if (debit) amount = -Math.abs(debit);
      }
      if (amount === null && cols.amount !== undefined) amount = parseAmount(row[cols.amount]);
      if (!amount) continue;
      const description = cols.description !== undefined ? row[cols.description] : "";
      const payer = cols.payer !== undefined ? row[cols.payer] : "";
      ops.push({ date, amount, description, payer });
    }
    return ops;
  }

  // ---------- что считать доходом ----------

  const NOT_INCOME = [
    /между (своими|собственными) счетами/i, /собственных средств/i, /со своего счета|со своей карты/i,
    /возврат/i, /кэшбэк|кешбэк|cashback/i, /выдача кредита|кредитн|займ|заём/i,
    /пополнение (счета )?наличными|взнос наличных/i, /ошибочно/i,
  ];
  const CHECK = [/процент/i, /перевод/i, /сбп/i];
  // \b в JavaScript не понимает кириллицу, поэтому граница слова задаётся явно.
  const LEGAL = /(?<!\p{L})(ооо|оао|зао|пао|ао|ип|гбу|муп|фгуп)(?!\p{L})|ozon|wildberries|вайлдберриз|озон|яндекс/iu;

  function classify(op) {
    const text = `${op.description} ${op.payer}`;
    if (NOT_INCOME.some((r) => r.test(text))) return { kind: "excluded", reason: "похоже не на доход" };
    const fromLegal = LEGAL.test(text.replace(/[«»"]/g, " "));
    if (!fromLegal && CHECK.some((r) => r.test(text))) return { kind: "check", fromLegal, reason: "перевод: уточните, доход ли это" };
    return { kind: "income", fromLegal };
  }

  // ---------- взносы и налоги ----------

  function contributions(income, year) {
    const p = params(year);
    const onePercent = Math.min(Math.max(0, income - p.onePercentBase) * 0.01, p.onePercentMax);
    return { fixed: p.fixedContributions, onePercent: round2(onePercent), total: round2(p.fixedContributions + onePercent) };
  }

  /*
   * УСН «Доходы» 6%, ИП без работников. Налог уменьшается на взносы за себя
   * до нуля; упрощение — взносы года учитываются целиком уже с первого квартала.
   */
  function usn6(quarterIncome, year, rate = 0.06) {
    const c = contributionsFor(quarterIncome, year);
    let cumIncome = 0, paid = 0;
    const periods = [];
    const names = ["I квартал", "полугодие", "9 месяцев", "год"];
    const due = [`28.04.${year}`, `28.07.${year}`, `28.10.${year}`, `28.04.${year + 1}`];
    for (let q = 0; q < 4; q++) {
      cumIncome += quarterIncome[q] || 0;
      const cumTax = Math.max(0, roundRub(cumIncome * rate - c.total));
      const payment = Math.max(0, cumTax - paid);
      paid += payment;
      periods.push({ name: names[q], income: round2(cumIncome), payment, due: due[q] });
    }
    const gross = roundRub(cumIncome * rate);
    return { regime: "usn6", rate, income: round2(cumIncome), grossTax: gross, contributions: c, tax: paid, periods,
      total: round2(paid + c.total) };
  }

  function contributionsFor(quarterIncome, year) {
    return contributions(quarterIncome.reduce((a, b) => a + (b || 0), 0), year);
  }

  /* НПД: 4% с физлиц, 6% с организаций и ИП, вычет 10 000 ₽ снижает ставки до 3% и 4%. */
  function npd(monthly, deductionLeft = 10000) {
    let left = deductionLeft;
    const months = monthly.map((m, i) => {
      const full = m.individuals * 0.04 + m.legal * 0.06;
      const bonus = Math.min(left, m.individuals * 0.01 + m.legal * 0.02);
      left -= bonus;
      return { month: i + 1, income: round2(m.individuals + m.legal), tax: round2(full - bonus) };
    });
    const income = months.reduce((a, m) => a + m.income, 0);
    const tax = months.reduce((a, m) => a + m.tax, 0);
    return { regime: "npd", income: round2(income), tax: round2(tax), months, deductionLeft: round2(left), total: round2(tax) };
  }

  // ---------- сводный анализ ----------

  function analyze(text, { year } = {}) {
    const ops = parseStatement(text);
    if (!year) {
      const counts = {};
      ops.forEach((o) => { counts[o.date.y] = (counts[o.date.y] || 0) + 1; });
      year = +Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    }
    const p = params(year);
    const quarter = [0, 0, 0, 0];
    const monthly = Array.from({ length: 12 }, () => ({ individuals: 0, legal: 0 }));
    const income = [], check = [], excluded = [];

    for (const op of ops) {
      if (op.amount <= 0 || op.date.y !== year) continue;
      const c = classify(op);
      const item = { ...op, ...c };
      if (c.kind === "excluded") { excluded.push(item); continue; }
      if (c.kind === "check") { check.push(item); continue; }
      income.push(item);
      quarter[Math.floor((op.date.m - 1) / 3)] += op.amount;
      monthly[op.date.m - 1][c.fromLegal ? "legal" : "individuals"] += op.amount;
    }

    const usn = usn6(quarter, year);
    const npdRes = npd(monthly);
    const totalIncome = usn.income;
    const warnings = [];
    if (totalIncome > p.npdLimit) warnings.push({ level: "danger", text: `Доход ${fmt(totalIncome)} ₽ выше лимита самозанятого (${fmt(p.npdLimit)} ₽): на НПД оставаться нельзя.` });
    else if (totalIncome > p.npdLimit * 0.8) warnings.push({ level: "warn", text: `Доход уже ${Math.round(totalIncome / p.npdLimit * 100)}% от лимита самозанятого (${fmt(p.npdLimit)} ₽).` });
    if (totalIncome > p.ndsThreshold) warnings.push({ level: "danger", text: `Доход выше ${fmt(p.ndsThreshold)} ₽: на УСН с этого года появляется обязанность платить НДС.` });
    else if (totalIncome > p.ndsThreshold * 0.8) warnings.push({ level: "warn", text: `Доход приближается к порогу НДС на УСН (${fmt(p.ndsThreshold)} ₽).` });
    if (totalIncome > p.usnLimit) warnings.push({ level: "danger", text: `Доход выше лимита УСН (${fmt(p.usnLimit)} ₽).` });
    if (check.length) warnings.push({ level: "warn", text: `${check.length} поступл. похожи на переводы — проверьте, доход это или нет. В расчёт они не вошли.` });

    const calendar = [
      ...usn.periods.filter((x) => x.payment > 0).map((x) => ({ date: x.due, what: `УСН: ${x.name === "год" ? "налог за год" : "аванс за " + x.name}`, sum: x.payment })),
      { date: `28.12.${year}`, what: "Фиксированные взносы ИП", sum: usn.contributions.fixed },
    ];
    if (usn.contributions.onePercent > 0) calendar.push({ date: `01.07.${year + 1}`, what: "Взнос 1% с дохода свыше 300 000 ₽", sum: usn.contributions.onePercent });
    calendar.sort((a, b) => toKey(a.date) - toKey(b.date));

    return { year, params: p, totalIncome, income, check, excluded, usn, npd: npdRes, warnings, calendar,
      cheaper: npdRes.income <= p.npdLimit && npdRes.total < usn.total ? "npd" : "usn6" };
  }

  function toKey(d) { const [dd, mm, yy] = d.split(".").map(Number); return yy * 10000 + mm * 100 + dd; }
  function fmt(n) { return Math.round(n).toLocaleString("ru-RU").replace(/ /g, " "); }

  return { PARAMS, params, parseStatement, classify, contributions, usn6, npd, analyze, fmt };
});
