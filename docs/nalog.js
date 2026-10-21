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

  // Списания: что из них может быть расходом для УСН 15%.
  const NOT_EXPENSE = [
    /между (своими|собственными) счетами|на свой счет|на свою карту|собственных средств/i,
    /снятие наличных|выдача наличных|банкомат|atm/i,
    // Налоги и взносы считаем сами, иначе они попадут в расходы дважды.
    /налог|енп|единый налоговый|страховые взносы|фнс|уфк/i,
    /погашение (кредита|займа)|возврат (кредита|займа)/i,
  ];

  function classifyExpense(op) {
    const text = `${op.description} ${op.payer}`;
    if (NOT_EXPENSE.some((r) => r.test(text))) return { kind: "not-expense", reason: "не расход для УСН" };
    return { kind: "expense", reason: "проверьте, что это расход на бизнес" };
  }

  // ---------- взносы и налоги ----------

  /*
   * Взносы ИП за себя. Для УСН «Доходы минус расходы» 1% считается с разницы
   * доходов и расходов; собственные взносы с 2026 года в эти расходы не входят.
   */
  function contributions(income, year, expenses = 0) {
    const p = params(year);
    const base = Math.max(0, income - expenses);
    const onePercent = Math.min(Math.max(0, base - p.onePercentBase) * 0.01, p.onePercentMax);
    return { fixed: p.fixedContributions, onePercent: round2(onePercent), total: round2(p.fixedContributions + onePercent) };
  }

  const PERIOD_NAMES = ["I квартал", "полугодие", "9 месяцев", "год"];
  const pad = (n) => String(n).padStart(2, "0");
  const sum = (xs) => xs.reduce((a, b) => a + (b || 0), 0);

  // Срок, выпавший на субботу или воскресенье, переносится на понедельник.
  // Праздники не учитываются.
  function workday(d, m, y) {
    const t = new Date(Date.UTC(y, m - 1, d));
    const dow = t.getUTCDay();
    if (dow === 6) t.setUTCDate(t.getUTCDate() + 2);
    if (dow === 0) t.setUTCDate(t.getUTCDate() + 1);
    return `${pad(t.getUTCDate())}.${pad(t.getUTCMonth() + 1)}.${t.getUTCFullYear()}`;
  }

  function usnDue(year) {
    return [workday(28, 4, year), workday(28, 7, year), workday(28, 10, year), workday(28, 4, year + 1)];
  }

  /*
   * УСН «Доходы» 6%. Без работников налог уменьшается на взносы за себя до нуля;
   * с работниками — на взносы за себя и за работников, но не больше чем наполовину.
   * Упрощение: взносы года учитываются целиком уже с первого квартала.
   */
  function usn6(quarterIncome, year, { rate = 0.06, employeeContributions = 0 } = {}) {
    const c = contributions(sum(quarterIncome), year);
    const hasEmployees = employeeContributions > 0;
    const deduction = c.total + employeeContributions;
    const due = usnDue(year);
    let cumIncome = 0, paid = 0, cumTax = 0;
    const periods = [];
    for (let q = 0; q < 4; q++) {
      cumIncome += quarterIncome[q] || 0;
      const gross = cumIncome * rate;
      const reduce = hasEmployees ? Math.min(deduction, gross / 2) : deduction;
      cumTax = Math.max(0, roundRub(gross - reduce));
      const payment = Math.max(0, cumTax - paid);
      paid += payment;
      periods.push({ name: PERIOD_NAMES[q], income: round2(cumIncome), payment, due: due[q] });
    }
    return { regime: "usn6", rate, income: round2(cumIncome), grossTax: roundRub(cumIncome * rate), contributions: c,
      employeeContributions, tax: cumTax, periods, total: round2(cumTax + c.total) };
  }

  /*
   * УСН «Доходы минус расходы» 15% (в регионах ставка бывает ниже).
   * Взносы ИП за себя входят в расходы. За год платится не меньше
   * минимального налога — 1% от доходов.
   */
  function usn15(quarterIncome, quarterExpenses, year, { rate = 0.15 } = {}) {
    const income = sum(quarterIncome), expenses = sum(quarterExpenses);
    const c = contributions(income, year, expenses);
    const due = usnDue(year);
    let cumIncome = 0, cumExpenses = 0, paid = 0, cumTax = 0;
    const periods = [];
    for (let q = 0; q < 4; q++) {
      cumIncome += quarterIncome[q] || 0;
      cumExpenses += quarterExpenses[q] || 0;
      cumTax = Math.max(0, roundRub((cumIncome - cumExpenses - c.total) * rate));
      if (q === 3) cumTax = Math.max(cumTax, roundRub(cumIncome * 0.01));
      const payment = Math.max(0, cumTax - paid);
      paid += payment;
      periods.push({ name: PERIOD_NAMES[q], income: round2(cumIncome), expenses: round2(cumExpenses), payment, due: due[q] });
    }
    const regular = Math.max(0, roundRub((income - expenses - c.total) * rate));
    return { regime: "usn15", rate, income: round2(income), expenses: round2(expenses), contributions: c,
      tax: cumTax, minimumTaxApplied: cumTax > regular, periods, total: round2(cumTax + c.total) };
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

  // ---------- календарь ----------

  function calendarFor(res, year) {
    const label = res.regime === "usn15" ? "УСН 15%" : "УСН 6%";
    const items = res.periods.filter((x) => x.payment > 0).map((x) => ({
      date: x.due, sum: x.payment,
      what: `${label}: ${x.name === "год" ? "налог за год" : "аванс за " + x.name}`,
    }));
    items.push({ date: workday(28, 12, year), what: "Фиксированные взносы ИП", sum: res.contributions.fixed });
    if (res.contributions.onePercent > 0) {
      items.push({ date: workday(1, 7, year + 1), what: "Взнос 1% с дохода свыше 300 000 ₽", sum: res.contributions.onePercent });
    }
    return items.sort((a, b) => toKey(a.date) - toKey(b.date));
  }

  // Календарь в формате iCalendar: событие на весь день и напоминание за 3 дня.
  function toIcs(calendar, stamp = new Date()) {
    const ymd = (d) => d.split(".").reverse().join("");
    const nextDay = (d) => {
      const [dd, mm, yy] = d.split(".").map(Number);
      return new Date(Date.UTC(yy, mm - 1, dd + 1)).toISOString().slice(0, 10).replace(/-/g, "");
    };
    const esc = (s) => s.replace(/[\\;,]/g, (ch) => "\\" + ch);
    const dtstamp = stamp.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//codebywater//nalog-helper//RU", "CALSCALE:GREGORIAN"];
    calendar.forEach((c, i) => {
      lines.push("BEGIN:VEVENT", `UID:nalog-helper-${ymd(c.date)}-${i}@codebywater.github.io`, `DTSTAMP:${dtstamp}`,
        `DTSTART;VALUE=DATE:${ymd(c.date)}`, `DTEND;VALUE=DATE:${nextDay(c.date)}`,
        `SUMMARY:${esc(`${c.what}: ${fmt(c.sum)} ₽`)}`,
        "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-P3D", `DESCRIPTION:${esc(c.what)}`, "END:VALARM", "END:VEVENT");
    });
    lines.push("END:VCALENDAR");
    return lines.join("\r\n") + "\r\n";
  }

  // ---------- сводный анализ ----------

  /*
   * opts.year — год расчёта (по умолчанию самый частый в выписке);
   * opts.expenses — расходы за год вручную вместо найденных в выписке;
   * opts.employeeContributions — взносы за работников за год (если есть работники);
   * opts.usn15Rate — ставка УСН «Доходы минус расходы» в вашем регионе.
   */
  function analyze(text, opts = {}) {
    const ops = parseStatement(text);
    let year = opts.year;
    if (!year) {
      const counts = {};
      ops.forEach((o) => { counts[o.date.y] = (counts[o.date.y] || 0) + 1; });
      year = +Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    }
    const p = params(year);
    const quarter = [0, 0, 0, 0], quarterExp = [0, 0, 0, 0];
    const monthly = Array.from({ length: 12 }, () => ({ individuals: 0, legal: 0 }));
    const income = [], check = [], excluded = [], expenses = [], notExpenses = [];

    for (const op of ops) {
      if (op.date.y !== year) continue;
      const q = Math.floor((op.date.m - 1) / 3);
      if (op.amount < 0) {
        const c = classifyExpense(op);
        const item = { ...op, amount: -op.amount, ...c };
        if (c.kind === "expense") { expenses.push(item); quarterExp[q] += item.amount; } else notExpenses.push(item);
        continue;
      }
      const c = classify(op);
      const item = { ...op, ...c };
      if (c.kind === "excluded") { excluded.push(item); continue; }
      if (c.kind === "check") { check.push(item); continue; }
      income.push(item);
      quarter[q] += op.amount;
      monthly[op.date.m - 1][c.fromLegal ? "legal" : "individuals"] += op.amount;
    }

    // Расходы, введённые вручную, распределяем по кварталам пропорционально доходу.
    const foundExpenses = sum(quarterExp);
    let expByQuarter = quarterExp;
    if (opts.expenses != null) {
      const inc = sum(quarter);
      expByQuarter = quarter.map((x) => (inc ? opts.expenses * x / inc : opts.expenses / 4));
    }

    const employeeContributions = opts.employeeContributions || 0;
    const u6 = usn6(quarter, year, { employeeContributions });
    const u15 = usn15(quarter, expByQuarter, year, { rate: opts.usn15Rate || 0.15 });
    const npdRes = npd(monthly);
    const totalIncome = u6.income;
    // Самозанятые не могут нанимать работников.
    const npdAllowed = totalIncome <= p.npdLimit && !employeeContributions;

    const warnings = [];
    if (totalIncome > p.npdLimit) warnings.push({ level: "danger", text: `Доход ${fmt(totalIncome)} ₽ выше лимита самозанятого (${fmt(p.npdLimit)} ₽): на НПД оставаться нельзя.` });
    else if (totalIncome > p.npdLimit * 0.8) warnings.push({ level: "warn", text: `Доход уже ${Math.round(totalIncome / p.npdLimit * 100)}% от лимита самозанятого (${fmt(p.npdLimit)} ₽).` });
    if (totalIncome > p.ndsThreshold) warnings.push({ level: "danger", text: `Доход выше ${fmt(p.ndsThreshold)} ₽: на УСН с этого года появляется обязанность платить НДС.` });
    else if (totalIncome > p.ndsThreshold * 0.8) warnings.push({ level: "warn", text: `Доход приближается к порогу НДС на УСН (${fmt(p.ndsThreshold)} ₽).` });
    if (totalIncome > p.usnLimit) warnings.push({ level: "danger", text: `Доход выше лимита УСН (${fmt(p.usnLimit)} ₽).` });
    if (check.length) warnings.push({ level: "warn", text: `${check.length} поступл. похожи на переводы — проверьте, доход это или нет. В расчёт они не вошли.` });
    if (u15.minimumTaxApplied) warnings.push({ level: "warn", text: "На УСН 15% получился минимальный налог — 1% от доходов: расходы почти равны доходам." });

    const options = [["usn6", u6.total], ["usn15", u15.total]];
    if (npdAllowed) options.push(["npd", npdRes.total]);
    const cheaper = options.sort((a, b) => a[1] - b[1])[0][0];

    return {
      year, params: p, totalIncome, income, check, excluded, expenses, notExpenses,
      foundExpenses: round2(foundExpenses), expensesManual: opts.expenses != null,
      usn: u6, usn15: u15, npd: npdRes, npdAllowed, warnings, cheaper,
      calendars: { usn6: calendarFor(u6, year), usn15: calendarFor(u15, year) },
      calendar: calendarFor(cheaper === "usn15" ? u15 : u6, year),
    };
  }

  function toKey(d) { const [dd, mm, yy] = d.split(".").map(Number); return yy * 10000 + mm * 100 + dd; }
  function fmt(n) { return Math.round(n).toLocaleString("ru-RU").replace(/ /g, " "); }

  return { PARAMS, params, parseStatement, classify, classifyExpense, contributions, usn6, usn15, npd,
    workday, calendarFor, toIcs, analyze, fmt };
});
