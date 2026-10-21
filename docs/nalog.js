/*
 * nalog-helper — ядро расчёта. Работает в браузере и в Node (для тестов).
 * Ничего никуда не отправляет: только разбор CSV и арифметика.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./vypiska.js"));
  else root.Nalog = factory(root.Vypiska);
})(typeof self !== "undefined" ? self : this, function (Vypiska) {
  "use strict";

  // Параметры по годам. Те же значения сведены в таблицу в README («Откуда цифры»).
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

  // Колонки, кодировки, суммы в валюте счёта, отклонённые и валютные операции разбирает
  // библиотека vypiska (https://github.com/codebywater/vypiska), копия лежит рядом.
  const parseAmount = Vypiska.parseAmount;

  function parseDate(s, order) {
    const d = Vypiska.parseDate(s, order);
    return d && { y: d.y, m: d.m, d: d.d };
  }

  function emptyStats() { return { badDate: 0, badAmount: 0, failed: 0, foreign: 0, mdyFiles: 0 }; }

  /*
   * Разбор одной выписки: операции и счётчики пропущенных строк,
   * чтобы ничего не терялось молча.
   */
  function parseStatementInfo(text) {
    const r = Vypiska.parse(text);
    const ops = r.ops.map((o) => {
      const [y, m, d] = o.date.split("-").map(Number);
      return { date: { y, m, d }, amount: o.amount, description: o.description, payer: o.counterparty };
    });
    const { badDate, badAmount, failed, foreign } = r.stats;
    return { ops, stats: { badDate, badAmount, failed, foreign, mdyFiles: r.stats.dateOrder === "mdy" ? 1 : 0 } };
  }

  function parseStatement(text) { return parseStatementInfo(text).ops; }

  function mergeStats(list) {
    const out = emptyStats();
    for (const s of list) for (const k of Object.keys(out)) out[k] += (s && s[k]) || 0;
    return out;
  }

  const decodeStatement = (bytes) => Vypiska.decode(bytes);

  // ---------- что считать доходом ----------

  // Поступления от эквайринга: банк перечисляет выручку по картам за вычетом комиссии.
  const ACQUIRING = /эквайринг|мерчант|дата реестра|возмещение по (операциям|торгов)/i;
  // Перевод своих денег: между своими счетами, с личной карты, «собственные средства», вывод прибыли.
  const SELF = /между (своими|собственными) счетами|собственн\S*\s+(денежн\S*\s+)?средств|(на|в) (свой|свою|собственный|собственную|личн\S*) (сч[её]т|карту)|со? (своего|собственного|личного) сч[её]та|со? (своей|собственной|личной) карты|вывод прибыли|на личные (нужды|цели)/i;
  // «Оплата за счет собственных средств учреждения» — так пишут заказчики-бюджетники, это доход.
  const OWN_FUNDS_OF_PAYER = /за сч[её]т\s+(собственн|своих)\S*\s+(денежн\S*\s+)?средств\S*/gi;
  // Слова про возврат, которые возвратом не являются.
  const NOT_REFUND = /без возврата|возврату не подлежит|не подлежит возврату|подлежит возврату|невозвратн\S*/gi;
  const NOT_INCOME = [
    /(^|[^\p{L}])возврат\S*\s+(ошибочно|излишне|займа|кредита|аванса|предоплат|депозита|(денежных\s+)?средств|платеж|оплат|комисси|налог|госпошлин|покупк|товар|по операции|переплат|неиспольз|остатк)/iu,
    /кэшбэк|кешбэк|cashback/i, /выдача кредита|кредитн|займ|заём/i,
    /пополнение (счета )?наличными|взнос наличных/i, /ошибочно/i,
  ];
  const CHECK = [/процент/i, /перевод/i, /сбп/i];
  // \b в JavaScript не понимает кириллицу, поэтому граница слова задаётся явно.
  const LEGAL = /(?<!\p{L})(ооо|оао|зао|пао|нао|ао|ип|гбу|гку|гау|муп|фгуп|ано|ooo|llc|ltd|inc|gmbh|corp|limited|plc)(?!\p{L})|общество с ограниченной ответственностью|акционерное общество|индивидуальн\S* предпринимател|(государственное|муниципальное) (бюджетное|казенное|казённое|автономное|унитарное)|ozon|wildberries|вайлдберриз|озон|яндекс/iu;
  // ИНН из 10 цифр бывает только у организаций.
  const LEGAL_INN = /инн\s*:?\s*\d{10}(?!\d)/i;
  const PAYER_IP = /(?<!\p{L})ип(?!\p{L})|индивидуальн\S* предпринимател/iu;

  const isLegal = (text) => LEGAL.test(text.replace(/[«»"]/g, " ")) || LEGAL_INN.test(text);

  function acquiringCommission(text) {
    const m = /комисси[яи](?:\s+банка)?\s*:?\s*(\d[\d\s ]*(?:[.,]\d{1,2})?)/i.exec(text);
    const n = m ? parseAmount(m[1]) : null;
    return n && n > 0 ? n : 0;
  }

  function classify(op) {
    const text = `${op.description} ${op.payer}`;
    // Эквайринг — выручка по картам (в шаблоне банка есть «Возврат покупки 0,00», это не возврат).
    // Доход на УСН — до вычета комиссии банка. Платят по картам в основном физлица.
    if (ACQUIRING.test(text)) return { kind: "income", fromLegal: false, reason: "эквайринг", commission: acquiringCommission(op.description) };
    if (SELF.test(text.replace(OWN_FUNDS_OF_PAYER, ""))) return { kind: "excluded", reason: "перевод своих денег" };
    const clean = text.replace(NOT_REFUND, "");
    if (NOT_INCOME.some((r) => r.test(clean))) return { kind: "excluded", reason: "похоже не на доход" };
    const fromLegal = isLegal(text);
    // Перевод от ИП может быть переводом со своего же счёта ИП — уточняем.
    const fromIp = PAYER_IP.test(op.payer || "") && /перевод/i.test(clean);
    if (/возврат/i.test(clean) || ((!fromLegal || fromIp) && CHECK.some((r) => r.test(clean)))) return { kind: "check", fromLegal, reason: "перевод или возврат: уточните, доход ли это" };
    return { kind: "income", fromLegal };
  }

  // Списания: что из них может быть расходом для УСН 15%.
  // Свои налоги и взносы ИП считаем сами, иначе они попадут в расходы дважды.
  // Взносы за работников передаются отдельно (opts.employeeContributions).
  const TAX = /(уплата|оплата|перечисление)\s+налог(а|ов)?(?!\p{L})|(?<!\p{L})налог(а|ов|и)?\s+(по|на|за|при|усн)(?!\p{L})|единый налоговый (платеж|платёж)|(?<!\p{L})енп(?!\p{L})|(?<!\p{L})уфк(?!\p{L})|казначейств|страховые взносы|фиксированн\S* взнос|(?<!\p{L})и?фнс(?!\p{L})/iu;
  const NOT_EXPENSE = [
    SELF,
    /снятие наличных|выдача наличных|банкомат|(?<!\p{L})atm(?!\p{L})/iu,
    TAX,
    /(погашение|возврат)[^;]*?(кредит|займ|заём|депозит|обеспечительн|подотч[её]т)|ошибочно/i,
  ];
  // Возврат денег покупателю уменьшает доход периода возврата (абз. 3 п. 1 ст. 346.17 НК РФ).
  const REFUND_TO_CUSTOMER = /возврат[^;]*?(предоплат|аванс|покупател|заказчик|клиент|оплаты по договору|(денежных )?средств по договору|за (товар|услуг))/i;

  // «в т.ч. НДС 20%», «НДС не облагается» — это про сумму платежа, а не уплата налога.
  const VAT_NOTE = /в\s*т(ом)?\.?\s*ч(исле)?\.?\s*(налог на добавленную стоимость|ндс)[^;,.]*|(налог на добавленную стоимость|ндс)\s+не облагается|без (налога|ндс)( \(ндс\))?/gi;

  function classifyExpense(op) {
    const text = `${op.description} ${op.payer}`.replace(VAT_NOTE, " ");
    if (NOT_EXPENSE.some((r) => r.test(text))) return { kind: "not-expense", reason: "не расход для УСН" };
    if (REFUND_TO_CUSTOMER.test(text)) return { kind: "refund", reason: "возврат покупателю: уменьшает доход", fromLegal: isLegal(text) };
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
  const MONTHS_IN = ["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре", "октябре", "ноябре", "декабре"];
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

  // Уведомления об исчисленных авансах — до 25-го числа месяца уплаты (п. 9 ст. 58 НК РФ).
  function usnNoticeDue(year) {
    return [workday(25, 4, year), workday(25, 7, year), workday(25, 10, year)];
  }

  /*
   * УСН «Доходы» 6%. Без работников налог уменьшается на взносы за себя до нуля;
   * с работниками — на взносы за себя и за работников, но не больше чем наполовину
   * (п. 3.1 ст. 346.21 НК РФ: важен сам факт работников, а не сумма взносов).
   * Упрощение: взносы года учитываются целиком уже с первого квартала.
   */
  function usn6(quarterIncome, year, { rate = 0.06, employeeContributions = 0, hasEmployees = employeeContributions > 0 } = {}) {
    const c = contributions(sum(quarterIncome), year);
    const deduction = c.total + employeeContributions;
    const due = usnDue(year);
    let cumIncome = 0, paid = 0, cumTax = 0;
    const periods = [];
    for (let q = 0; q < 4; q++) {
      cumIncome = Math.max(0, cumIncome + (quarterIncome[q] || 0));
      const gross = cumIncome * rate;
      const reduce = hasEmployees ? Math.min(deduction, gross / 2) : deduction;
      cumTax = Math.max(0, roundRub(gross - reduce));
      const payment = Math.max(0, cumTax - paid);
      paid += payment;
      periods.push({ name: PERIOD_NAMES[q], income: round2(cumIncome), payment, due: due[q] });
    }
    return { regime: "usn6", rate, income: round2(cumIncome), grossTax: roundRub(cumIncome * rate), contributions: c,
      employeeContributions, hasEmployees, tax: cumTax, periods, total: round2(cumTax + c.total) };
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
      cumIncome = Math.max(0, cumIncome + (quarterIncome[q] || 0));
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

  /*
   * НПД: 4% с физлиц, 6% с организаций и ИП. Вычет 10 000 ₽ снижает ставки до 3% и 4%,
   * но даётся один раз за всё время (ст. 12 422-ФЗ): если человек уже был самозанятым,
   * передайте остаток из «Мой налог».
   */
  const NPD_DEDUCTION = 10000;
  function npd(monthly, deductionLeft = NPD_DEDUCTION) {
    const start = Math.min(Math.max(0, deductionLeft), NPD_DEDUCTION);
    let left = start;
    const months = monthly.map((m, i) => {
      const full = m.individuals * 0.04 + m.legal * 0.06;
      const bonus = Math.min(left, m.individuals * 0.01 + m.legal * 0.02);
      left -= bonus;
      return { month: i + 1, income: round2(m.individuals + m.legal), tax: round2(full - bonus) };
    });
    const income = months.reduce((a, m) => a + m.income, 0);
    const tax = months.reduce((a, m) => a + m.tax, 0);
    return { regime: "npd", income: round2(income), tax: round2(tax), months, deductionStart: round2(start), deductionLeft: round2(left), total: round2(tax) };
  }

  // ---------- календарь ----------

  /*
   * Платежи (kind "payment") и то, что нужно подать без оплаты (kind "filing"):
   * уведомления об авансах по УСН и декларацию за год.
   */
  function calendarFor(res, year) {
    const label = res.regime === "usn15" ? "УСН 15%" : "УСН 6%";
    const items = res.periods.filter((x) => x.payment > 0).map((x) => ({
      date: x.due, sum: x.payment, kind: "payment",
      what: `${label}: ${x.name === "год" ? "налог за год" : "аванс за " + x.name}`,
    }));
    const notice = usnNoticeDue(year);
    res.periods.slice(0, 3).forEach((x, q) => {
      if (x.payment > 0) items.push({ date: notice[q], sum: null, kind: "filing",
        what: `${label}: уведомление об авансе за ${x.name} на ${fmt(x.payment)} ₽ (подать, не платить)` });
    });
    items.push({ date: workday(25, 4, year + 1), sum: null, kind: "filing", what: `${label}: декларация за ${year} год (подать)` });
    items.push({ date: workday(28, 12, year), what: "Фиксированные взносы ИП", sum: res.contributions.fixed, kind: "payment" });
    if (res.contributions.onePercent > 0) {
      items.push({ date: workday(1, 7, year + 1), what: "Взнос 1% с дохода свыше 300 000 ₽", sum: res.contributions.onePercent, kind: "payment" });
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
      const summary = c.sum == null ? c.what : `${c.what}: ${fmt(c.sum)} ₽`;
      lines.push("BEGIN:VEVENT", `UID:nalog-helper-${ymd(c.date)}-${i}@codebywater.github.io`, `DTSTAMP:${dtstamp}`,
        `DTSTART;VALUE=DATE:${ymd(c.date)}`, `DTEND;VALUE=DATE:${nextDay(c.date)}`,
        `SUMMARY:${esc(summary)}`,
        "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-P3D", `DESCRIPTION:${esc(c.what)}`, "END:VALARM", "END:VEVENT");
    });
    lines.push("END:VCALENDAR");
    return lines.join("\r\n") + "\r\n";
  }

  // ---------- сводный анализ ----------

  function optNumber(v, name, { min = 0, max = Infinity } = {}) {
    if (v == null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name}: нужно число от ${fmt(min)} до ${max === Infinity ? "∞" : fmt(max)}, получено «${v}».`);
    return n;
  }

  // Вычитает сумму из ячеек по порядку (от периода возврата к началу года): доход не бывает отрицательным.
  function subtractBack(cells, amount) {
    for (const [obj, key] of cells) {
      const d = Math.min(obj[key], amount);
      obj[key] -= d;
      amount -= d;
      if (amount <= 0) break;
    }
    return Math.max(0, amount);
  }

  // Первый месяц, в котором доход с начала года превысил порог.
  function monthOver(monthly, threshold) {
    let cum = 0;
    for (let i = 0; i < monthly.length; i++) {
      cum += monthly[i].individuals + monthly[i].legal;
      if (cum > threshold) return i + 1;
    }
    return 0;
  }

  /*
   * analyze(text | [text, …], opts): каждая выписка разбирается отдельно
   * (у разных банков разные колонки), операции объединяются.
   *
   * opts.year — год расчёта (по умолчанию самый частый в выписке);
   * opts.expenses — расходы за год вручную вместо найденных в выписке
   *   (без взносов за работников: они добавляются отдельно);
   * opts.hasEmployees — есть работники (даже если сумма взносов не указана);
   * opts.employeeContributions — взносы за работников за год;
   * opts.usn15Rate — ставка УСН «Доходы минус расходы» в вашем регионе (до 0,15);
   * opts.npdDeductionLeft — остаток разового вычета НПД (по умолчанию 10 000 ₽).
   */
  function analyze(input, opts = {}) {
    const parsed = (Array.isArray(input) ? input : [input]).map(parseStatementInfo);
    return analyzeOps(parsed.flatMap((x) => x.ops), opts, mergeStats(parsed.map((x) => x.stats)));
  }

  function analyzeOps(ops, opts = {}, stats = emptyStats()) {
    if (!ops.length) throw new Error("Не нашёл ни одной операции с датой и ненулевой суммой. Проверьте формат дат (ДД.ММ.ГГГГ или ГГГГ-ММ-ДД) и колонку суммы.");
    let year = opts.year == null ? null : Number(opts.year);
    if (!year) {
      const counts = {};
      ops.forEach((o) => { counts[o.date.y] = (counts[o.date.y] || 0) + 1; });
      year = +Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    }
    const p = params(year);
    const manualExpenses = optNumber(opts.expenses, "Расходы");
    const employeeContributions = optNumber(opts.employeeContributions, "Взносы за работников") || 0;
    const hasEmployees = !!opts.hasEmployees || employeeContributions > 0;
    const usn15Rate = opts.usn15Rate == null ? 0.15 : optNumber(opts.usn15Rate, "Ставка УСН 15%", { min: 0.0001, max: 0.15 });
    const npdLeft = opts.npdDeductionLeft == null ? NPD_DEDUCTION : Math.min(optNumber(opts.npdDeductionLeft, "Остаток вычета НПД"), NPD_DEDUCTION);

    const quarter = [0, 0, 0, 0], quarterExp = [0, 0, 0, 0];
    const monthly = Array.from({ length: 12 }, () => ({ individuals: 0, legal: 0 }));
    const income = [], check = [], excluded = [], expenses = [], notExpenses = [], refunds = [];
    let commissions = 0;

    for (const op of ops) {
      if (op.date.y !== year) continue;
      const q = Math.floor((op.date.m - 1) / 3);
      if (op.amount < 0) {
        const c = classifyExpense(op);
        const item = { ...op, amount: -op.amount, ...c };
        if (c.kind === "expense") { expenses.push(item); quarterExp[q] += item.amount; }
        else if (c.kind === "refund") refunds.push(item);
        else notExpenses.push(item);
        continue;
      }
      const c = classify(op);
      if (c.kind === "excluded") { excluded.push({ ...op, ...c }); continue; }
      if (c.kind === "check") { check.push({ ...op, ...c }); continue; }
      // Эквайринг: доход — вся выручка, комиссия банка — расход для УСН 15%.
      const fee = c.commission || 0;
      const item = { ...op, ...c, amount: round2(op.amount + fee), credited: op.amount };
      income.push(item);
      quarter[q] += item.amount;
      monthly[op.date.m - 1][c.fromLegal ? "legal" : "individuals"] += item.amount;
      if (fee) {
        commissions += fee;
        expenses.push({ date: op.date, amount: fee, description: "Комиссия банка за эквайринг", payer: op.payer, kind: "expense", reason: "комиссия эквайринга" });
        quarterExp[q] += fee;
      }
    }

    // Возвраты покупателям уменьшают доход в периоде возврата; для НПД — доход месяца
    // (по-настоящему чек аннулируют, и налог пересчитывается за месяц продажи).
    for (const r of refunds) {
      const q = Math.floor((r.date.m - 1) / 3);
      // Только квартал возврата (абз. 3 п. 1 ст. 346.17 НК РФ): авансы прошлых кварталов уже уплачены.
      quarter[q] -= r.amount;
      const key = r.fromLegal ? "legal" : "individuals", other = r.fromLegal ? "individuals" : "legal";
      const back = Array.from({ length: r.date.m }, (_, i) => monthly[r.date.m - 1 - i]);
      subtractBack([...back.map((m) => [m, key]), ...back.map((m) => [m, other])], r.amount);
    }

    // Расходы, введённые вручную, распределяем по кварталам пропорционально доходу.
    const foundExpenses = sum(quarterExp);
    let expByQuarter = quarterExp;
    if (manualExpenses != null) {
      const inc = sum(quarter);
      expByQuarter = quarter.map((x) => (inc ? manualExpenses * x / inc : manualExpenses / 4));
    }
    // Взносы за работников — расход на УСН 15% (пп. 7 п. 1 ст. 346.16 НК РФ), платятся каждый месяц.
    if (employeeContributions) expByQuarter = expByQuarter.map((x) => x + employeeContributions / 4);

    const u6 = usn6(quarter, year, { employeeContributions, hasEmployees });
    const u15 = usn15(quarter, expByQuarter, year, { rate: usn15Rate });
    const npdRes = npd(monthly, npdLeft);
    const totalIncome = u6.income;
    // Самозанятые не могут нанимать работников (пп. 4 п. 2 ст. 4 422-ФЗ).
    const npdAllowed = totalIncome <= p.npdLimit && !hasEmployees;

    const warnings = [];
    if (stats.badDate) warnings.push({ level: "warn", text: `${stats.badDate} строк(и) пропущено: дата не читается. Проверьте формат дат (ДД.ММ.ГГГГ).` });
    if (stats.badAmount) warnings.push({ level: "warn", text: `${stats.badAmount} строк(и) с датой пропущено: не удалось прочитать сумму.` });
    if (stats.foreign) warnings.push({ level: "warn", text: `${stats.foreign} операц. в иностранной валюте без суммы в рублях не вошли в расчёт.` });
    if (stats.failed) warnings.push({ level: "warn", text: `${stats.failed} отклонённых или отменённых операций не учтено.` });
    if (stats.mdyFiles) warnings.push({ level: "warn", text: "Даты прочитаны как месяц/день/год (так сохраняет Excel с американскими настройками)." });
    if (totalIncome > p.npdLimit) warnings.push({ level: "danger", text: `Доход ${fmt(totalIncome)} ₽ выше лимита самозанятого (${fmt(p.npdLimit)} ₽): на НПД оставаться нельзя.` });
    else if (totalIncome > p.npdLimit * 0.8) warnings.push({ level: "warn", text: `Доход уже ${Math.round(totalIncome / p.npdLimit * 100)}% от лимита самозанятого (${fmt(p.npdLimit)} ₽).` });
    if (totalIncome > p.ndsThreshold) {
      // Порог превышен в течение года — НДС с 1-го числа следующего месяца (п. 5 ст. 145 НК РФ).
      const m = monthOver(monthly, p.ndsThreshold) || 12;
      const from = m === 12 ? `01.01.${year + 1}` : `01.${pad(m + 1)}.${year}`;
      warnings.push({ level: "danger", text: `Доход превысил ${fmt(p.ndsThreshold)} ₽ в ${MONTHS_IN[m - 1]}: с ${from} на УСН нужно исчислять и платить НДС (5%, 7% или 22%). Если доход за прошлый год был больше ${fmt(p.ndsThreshold)} ₽, НДС платится с 1 января.` });
    } else if (totalIncome > p.ndsThreshold * 0.8) warnings.push({ level: "warn", text: `Доход приближается к порогу НДС на УСН (${fmt(p.ndsThreshold)} ₽).` });
    if (totalIncome > p.usnLimit) warnings.push({ level: "danger", text: `Доход выше лимита УСН (${fmt(p.usnLimit)} ₽).` });
    if (check.length) warnings.push({ level: "warn", text: `${check.length} ${plural(check.length, "поступление похоже", "поступления похожи", "поступлений похожи")} на переводы или возвраты — проверьте, доход это или нет. В расчёт такие поступления не вошли.` });
    if (refunds.length) warnings.push({ level: "warn", text: `${refunds.length} возврат(а) покупателям на ${fmt(sum(refunds.map((r) => r.amount)))} ₽ уменьшили доход. Проверьте, что это действительно возвраты.` });
    if (commissions) warnings.push({ level: "warn", text: `Эквайринг: доход посчитан до вычета комиссии банка (${fmt(commissions)} ₽), комиссия учтена в расходах УСН 15%.` });
    if (hasEmployees && !employeeContributions) warnings.push({ level: "warn", text: "Отмечено, что есть работники, но не указаны взносы за них: УСН 6% уменьшен только на ваши взносы и не больше чем наполовину, в расходах УСН 15% этих взносов нет." });
    if (hasEmployees) warnings.push({ level: "warn", text: "НДФЛ, удержанный из зарплаты работников и уплаченный через ЕНП, — тоже расход на оплату труда для УСН 15%. В выписке ЕНП не делится на части, добавьте этот НДФЛ к расходам вручную." });
    if (u15.minimumTaxApplied) warnings.push({ level: "warn", text: "На УСН 15% получился минимальный налог — 1% от доходов: расходы почти равны доходам." });

    const options = [["usn6", u6.total], ["usn15", u15.total]];
    if (npdAllowed) options.push(["npd", npdRes.total]);
    const cheaper = options.sort((a, b) => a[1] - b[1])[0][0];

    return {
      year, params: p, totalIncome, income, check, excluded, expenses, notExpenses, refunds,
      foundExpenses: round2(foundExpenses), expensesManual: manualExpenses != null,
      hasEmployees, employeeContributions,
      usn: u6, usn15: u15, npd: npdRes, npdAllowed, warnings, cheaper, parseStats: stats,
      calendars: { usn6: calendarFor(u6, year), usn15: calendarFor(u15, year) },
      calendar: calendarFor(cheaper === "usn15" ? u15 : u6, year),
    };
  }

  /*
   * Значения полей формы на странице → opts для analyze. Отметка «Есть работники»
   * работает и без суммы: НПД становится недоступен, действует ограничение 50%.
   */
  function formOptions(f = {}) {
    const num = (s) => {
      if (s == null || String(s).trim() === "") return null;
      const n = parseAmount(s);
      return n == null ? null : Math.max(0, n);
    };
    const rate = num(f.rate);
    const npdLeft = num(f.npdLeft);
    return {
      expenses: num(f.expenses),
      hasEmployees: !!f.staff,
      employeeContributions: f.staff ? num(f.staffSum) || 0 : 0,
      usn15Rate: rate ? Math.min(rate, 15) / 100 : 0.15,
      npdDeductionLeft: npdLeft == null ? NPD_DEDUCTION : Math.min(npdLeft, NPD_DEDUCTION),
    };
  }

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function toKey(d) { const [dd, mm, yy] = d.split(".").map(Number); return yy * 10000 + mm * 100 + dd; }
  function fmt(n) { return Math.round(n).toLocaleString("ru-RU").replace(/ /g, " "); }

  return { PARAMS, params, parseStatement, parseStatementInfo, parseAmount, parseDate, mergeStats, decodeStatement,
    classify, classifyExpense, contributions, usn6, usn15, npd, workday, calendarFor, toIcs,
    analyze, analyzeOps, formOptions, fmt };
});
