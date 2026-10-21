const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const N = require("../docs/nalog.js");

const sample = fs.readFileSync(path.join(__dirname, "../examples/vypiska-primer.csv"), "utf8");

test("взносы: только фиксированная часть при доходе до 300 000", () => {
  assert.deepEqual(N.contributions(250000, 2026), { fixed: 57390, onePercent: 0, total: 57390 });
});

test("взносы: 1% сверх 300 000 и его потолок", () => {
  assert.equal(N.contributions(1300000, 2026).onePercent, 10000);
  assert.equal(N.contributions(1e9, 2026).onePercent, 321818);
});

test("УСН 6%: взносы уменьшают налог до нуля, авансы нарастающим итогом", () => {
  const r = N.usn6([500000, 500000, 500000, 500000], 2026);
  // доход 2 000 000: налог 120 000, взносы 57 390 + 17 000
  assert.equal(r.grossTax, 120000);
  assert.equal(r.contributions.total, 74390);
  assert.equal(r.tax, 45610);
  assert.deepEqual(r.periods.map((p) => p.payment), [0, 0, 15610, 30000]);
  assert.equal(r.periods[3].due, "28.04.2027");
});

test("УСН 6%: маленький доход — налога нет", () => {
  assert.equal(N.usn6([100000, 0, 0, 0], 2026).tax, 0);
});

test("НПД: 4%/6% и вычет 10 000 ₽", () => {
  const months = Array.from({ length: 12 }, () => ({ individuals: 0, legal: 0 }));
  months[0] = { individuals: 100000, legal: 100000 };
  const r = N.npd(months);
  // 4000 + 6000 − (1000 + 2000) = 7000
  assert.equal(r.tax, 7000);
  assert.equal(r.deductionLeft, 7000);
});

test("разбор выписки: суммы с пробелами и запятой, расходы отрицательные", () => {
  const ops = N.parseStatement(sample);
  assert.equal(ops.length, 11);
  assert.equal(ops[0].amount, 180000);
  assert.equal(ops[1].amount, -4500);
});

test("разбор выписки с колонками Приход/Расход и запятой-разделителем", () => {
  const csv = 'Дата,Приход,Расход,Описание\n2026-03-01,"1 000,50",,Оплата от ООО Тест\n2026-03-02,,500,Аренда\n';
  const ops = N.parseStatement(csv);
  assert.deepEqual(ops.map((o) => o.amount), [1000.5, -500]);
});

test("классификация: свои переводы и кэшбэк — не доход, СБП от физлица — проверить", () => {
  assert.equal(N.classify({ description: "Перевод между своими счетами", payer: "" }).kind, "excluded");
  assert.equal(N.classify({ description: "Кэшбэк", payer: "" }).kind, "excluded");
  assert.equal(N.classify({ description: "Перевод по СБП", payer: "Иванов И.И." }).kind, "check");
  const legal = N.classify({ description: "Оплата по счету", payer: "ООО «Ромашка»" });
  assert.equal(legal.kind, "income");
  assert.equal(legal.fromLegal, true);
  assert.equal(N.classify({ description: "Оплата", payer: "Сидоров" }).fromLegal, false);
});

test("анализ примера целиком", () => {
  const r = N.analyze(sample);
  assert.equal(r.year, 2026);
  assert.equal(r.totalIncome, 1060000);
  assert.equal(r.income.length, 6);
  assert.equal(r.check.length, 1);
  assert.equal(r.excluded.length, 2);
  // 6% от 1 060 000 = 63 600, минус взносы 57 390 + 7 600
  assert.equal(r.usn.tax, 0);
  assert.equal(r.calendar.at(-1).what, "Взнос 1% с дохода свыше 300 000 ₽");
  assert.ok(r.warnings.some((w) => w.text.includes("переводы")));
});

test("неизвестный год — понятная ошибка", () => {
  assert.throws(() => N.contributions(1, 2019), /Нет параметров для 2019/);
});

test("демо на странице совпадает с примером выписки", () => {
  const src = fs.readFileSync(path.join(__dirname, "../docs/demo.js"), "utf8");
  const window = {};
  new Function("window", src)(window);
  assert.equal(window.NALOG_DEMO, sample);
});

test("УСН 15%: налог с разницы, взносы в расходах, 1% с разницы", () => {
  const r = N.usn15([1000000, 0, 0, 0], [400000, 0, 0, 0], 2026);
  // база для 1%: 1 000 000 − 400 000 − 300 000 = 300 000 → 3 000
  assert.equal(r.contributions.onePercent, 3000);
  // (1 000 000 − 400 000 − 60 390) × 15% = 80 941,5
  assert.equal(r.tax, 80942);
  assert.equal(r.minimumTaxApplied, false);
  assert.equal(r.periods[0].payment, 80942);
});

test("УСН 15%: минимальный налог 1% от доходов", () => {
  const r = N.usn15([500000, 500000, 500000, 500000], [490000, 490000, 490000, 490000], 2026);
  assert.equal(r.tax, 20000);
  assert.equal(r.minimumTaxApplied, true);
  assert.equal(r.periods[3].payment, 20000);
});

test("УСН 6% с работниками: уменьшение не больше 50% налога", () => {
  const r = N.usn6([1000000, 1000000, 1000000, 1000000], 2026, { employeeContributions: 200000 });
  // налог 240 000, взносы 57 390 + 37 000 + 200 000 > 120 000 → платим половину
  assert.equal(r.tax, 120000);
  const solo = N.usn6([1000000, 1000000, 1000000, 1000000], 2026);
  assert.equal(solo.tax, 240000 - 57390 - 37000);
});

test("сроки: выходной переносится на понедельник", () => {
  assert.equal(N.workday(28, 12, 2026), "28.12.2026");   // понедельник
  assert.equal(N.workday(28, 4, 2029), "30.04.2029");    // суббота → понедельник
  assert.equal(N.workday(28, 10, 2029), "29.10.2029");   // воскресенье → понедельник
});

test("расходы: налоги и снятие наличных не считаются расходом", () => {
  assert.equal(N.classifyExpense({ description: "Оплата рекламы", payer: "" }).kind, "expense");
  assert.equal(N.classifyExpense({ description: "Единый налоговый платеж", payer: "" }).kind, "not-expense");
  assert.equal(N.classifyExpense({ description: "Снятие наличных", payer: "" }).kind, "not-expense");
});

test("анализ: расходы из выписки и вручную, самозанятость недоступна с работниками", () => {
  const r = N.analyze(sample);
  assert.equal(r.foundExpenses, 16500);
  assert.equal(r.usn15.expenses, 16500);
  assert.equal(r.cheaper, "npd");
  const manual = N.analyze(sample, { expenses: 900000 });
  assert.equal(manual.usn15.expenses, 900000);
  assert.ok(manual.usn15.total < r.usn15.total);
  const staff = N.analyze(sample, { employeeContributions: 100000 });
  assert.equal(staff.npdAllowed, false);
  assert.notEqual(staff.cheaper, "npd");
});

test("календарь .ics: события на весь день с напоминанием", () => {
  const ics = N.toIcs([{ date: "28.12.2026", what: "Фиксированные взносы ИП", sum: 57390 }], new Date(Date.UTC(2026, 9, 21)));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261228\r\n/);
  assert.match(ics, /DTEND;VALUE=DATE:20261229\r\n/);
  assert.match(ics, /SUMMARY:Фиксированные взносы ИП: 57 390 ₽/);
  assert.match(ics, /TRIGGER:-P3D/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
});

test("CLI скилла: отчёт в markdown, json и файл .ics", () => {
  const { execFileSync } = require("node:child_process");
  const os = require("node:os");
  const cli = path.join(__dirname, "../skills/nalog-helper/scripts/nalog-cli.js");
  const csv = path.join(__dirname, "../examples/vypiska-primer.csv");
  const md = execFileSync("node", [cli, csv], { encoding: "utf8" });
  assert.match(md, /Доход: \*\*1 060 000 ₽\*\*/);
  assert.match(md, /05\.03\.2026 — Иванов/);
  const icsPath = path.join(os.tmpdir(), `nalog-test-${process.pid}.ics`);
  const json = JSON.parse(execFileSync("node", [cli, csv, "--format", "json", "--expenses", "900000", "--ics", icsPath], { encoding: "utf8" }));
  assert.equal(json.usn15.expenses, 900000);
  assert.equal(json.counts.income, 6);
  assert.match(fs.readFileSync(icsPath, "utf8"), /BEGIN:VCALENDAR/);
  fs.unlinkSync(icsPath);
});

test("плагин: манифесты — корректный JSON, скилл на месте", () => {
  const root = path.join(__dirname, "..");
  for (const f of [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"]) {
    JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
  }
  const skill = fs.readFileSync(path.join(root, "skills/nalog-helper/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: nalog-helper\ndescription: .+\n---/);
});

// ---------- регрессии по ревью ----------

const os = require("node:os");
const { spawnSync } = require("node:child_process");
const CLI = path.join(__dirname, "../skills/nalog-helper/scripts/nalog-cli.js");
const H = "Дата операции;Сумма операции;Плательщик;Назначение платежа\n";
const runCli = (args) => spawnSync("node", [CLI, ...args], { encoding: "utf8" });
const cliJson = (args) => {
  const r = runCli([...args, "--format", "json"]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
function tmpFiles(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nalog-test-"));
  const paths = Object.entries(files).map(([name, text]) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text);
    return p;
  });
  return { paths, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// cli-multifile-merge-drops-rows, nalog-cli-multifile-reuses-first-header
test("CLI: выписки разных банков разбираются каждая со своей шапкой", () => {
  const { paths, cleanup } = tmpFiles({
    "a.csv": H + "15.01.2026;100 000,00;ООО «Ромашка»;Оплата по договору\n",
    "b.csv": "Выписка по счету 40802810...\nДата;Назначение платежа;Плательщик;Приход;Расход\n20.02.2026;Оплата по счету 7;ООО «Лютик»;500 000,00;\n21.02.2026;Оплата аренды;ООО «Арендодатель»;;50 000,00\n",
    "c.csv": "Дата;Номер документа;Сумма;Плательщик;Назначение платежа\n20.02.2026;512;250 000,00;ООО Вектор;Оплата по счету 15\n21.02.2026;513;-3 000,00;;Оплата хостинга\n",
  });
  try {
    const [a, b, c] = paths;
    const ab = cliJson([a, b]);
    assert.equal(ab.totalIncome, 600000);
    assert.equal(ab.foundExpenses, 50000);
    for (const order of [[a, c], [c, a]]) {
      const r = cliJson(order);
      assert.equal(r.totalIncome, 350000);
      assert.equal(r.foundExpenses, 3000);
    }
    // ядро: массив текстов — то же самое
    assert.equal(N.analyze([fs.readFileSync(a, "utf8"), fs.readFileSync(b, "utf8")]).totalIncome, 600000);
  } finally { cleanup(); }
});

// usn15-ignores-employee-contributions
test("УСН 15%: взносы за работников входят в расходы, «Без налога (НДС)» — обычный расход", () => {
  const rows = [];
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, "0");
    rows.push(`10.${mm}.2026;500 000,00;ООО «Ромашка»;Оплата по договору`, `11.${mm}.2026;-250 000,00;ООО «Поставщик»;Оплата товара`,
      `12.${mm}.2026;-100 000,00;;Заработная плата за месяц`, `13.${mm}.2026;-30 000,00;УФК по г. Москве (ИФНС);Единый налоговый платеж`);
  }
  const csv = H + rows.join("\n") + "\n";
  const solo = N.analyze(csv);
  const staff = N.analyze(csv, { employeeContributions: 360000 });
  assert.equal(staff.usn15.expenses, solo.usn15.expenses + 360000);
  assert.equal(staff.usn15.total, 274472);
  assert.equal(staff.cheaper, "usn15");
  assert.ok(staff.warnings.some((w) => /НДФЛ/.test(w.text)));
  assert.equal(N.classifyExpense({ description: "Аренда офиса за март. Без налога (НДС)", payer: "ООО Арендодатель" }).kind, "expense");
});

// customer-refunds-not-reducing-income
test("возврат предоплаты покупателю уменьшает доход для всех режимов и лимитов", () => {
  const r = N.analyze(H + "10.02.2026;3 000 000,00;ООО «Ромашка»;Предоплата по договору 5\n20.03.2026;-1 000 000,00;ООО «Ромашка»;Возврат предоплаты по договору 5 в связи с расторжением\n");
  assert.equal(r.totalIncome, 2000000);
  assert.equal(r.usn.tax, 45610);
  assert.equal(r.usn.contributions.onePercent, 17000);
  assert.equal(r.usn.total, 120000);
  assert.equal(r.usn15.expenses, 0);
  assert.equal(r.npd.income, 2000000);
  assert.equal(r.refunds.length, 1);
  assert.ok(!r.warnings.some((w) => /выше лимита самозанятого/.test(w.text)));
  assert.ok(r.warnings.some((w) => /возврат/.test(w.text)));
});

// staff-checkbox-empty-allows-npd, nh-staff-checkbox-noop
test("работники без суммы взносов: НПД недоступен, действует ограничение 50%", () => {
  const web = N.analyze(sample, N.formOptions({ staff: true, staffSum: "" }));
  assert.equal(web.npdAllowed, false);
  assert.notEqual(web.cheaper, "npd");
  assert.equal(web.usn.tax, 31800);
  assert.ok(web.warnings.some((w) => /не указаны взносы/.test(w.text)));
  assert.equal(N.formOptions({ staff: false, staffSum: "5000" }).employeeContributions, 0);
  const cli = cliJson([path.join(__dirname, "../examples/vypiska-primer.csv"), "--has-employees"]);
  assert.equal(cli.npdAllowed, false);
  assert.equal(cli.usn.tax, 31800);
});

// npd-deduction-assumed-unused
test("НПД: остаток разового вычета задаётся в опциях, UI и CLI", () => {
  const csv = H + Array.from({ length: 12 }, (_, i) => `10.${String(i + 1).padStart(2, "0")}.2026;150 000,00;ООО «Ромашка»;Оплата`).join("\n") + "\n";
  assert.equal(N.analyze(csv).npd.total, 98000);
  const used = N.analyze(csv, { npdDeductionLeft: 0 });
  assert.equal(used.npd.total, 108000);
  assert.equal(used.npd.deductionStart, 0);
  assert.equal(N.analyze(csv, { npdDeductionLeft: 4000 }).npd.total, 104000);
  assert.equal(N.analyze(csv, N.formOptions({ npdLeft: "" })).npd.deductionStart, 10000);
  assert.equal(N.formOptions({ npdLeft: "50000" }).npdDeductionLeft, 10000);
  const cli = cliJson([path.join(__dirname, "../examples/vypiska-primer.csv"), "--npd-deduction-left", "0"]);
  assert.equal(cli.npd.deductionStart, 0);
  assert.equal(cli.npd.tax, 63600);
  assert.match(runCli([path.join(__dirname, "../examples/vypiska-primer.csv")]).stdout, /вычет 10 000 ₽ даётся один раз/);
});

// cli-numeric-args-silently-coerced
test("CLI: суммы с пробелами и запятой, ошибки на мусор, минус и ставку вне 0–15%", () => {
  const ex = path.join(__dirname, "../examples/vypiska-primer.csv");
  assert.equal(cliJson([ex, "--expenses", "900 000"]).usn15.expenses, 900000);
  assert.equal(cliJson([ex, "--expenses", "900000,50"]).usn15.expenses, 900000.5);
  for (const bad of [["--expenses", "-100000"], ["--expenses", "много"], ["--rate", "20"], ["--rate", "0"], ["--year", "2026.5"],
    ["--employees", "abc"], ["--npd-deduction-left", "20000"], ["--format", "xml"], ["--unknown"]]) {
    const r = runCli([ex, ...bad]);
    assert.notEqual(r.status, 0, bad.join(" "));
    assert.match(r.stderr, /Ошибка/);
  }
  assert.throws(() => N.analyze(sample, { expenses: NaN }), /Расходы/);
  assert.throws(() => N.analyze(sample, { usn15Rate: 0.2 }), /Ставка/);
});

// calendar-missing-usn-notifications
test("календарь: уведомления об авансах до 25-го и декларация, в .ics без суммы", () => {
  const r = N.analyze(H + ["15.01.2026", "15.04.2026", "15.07.2026", "15.10.2026"].map((d) => `${d};3 000 000,00;ООО «Ромашка»;Оплата`).join("\n") + "\n");
  const filings = r.calendars.usn6.filter((c) => c.kind === "filing");
  assert.deepEqual(filings.map((c) => c.date), ["27.04.2026", "27.07.2026", "26.10.2026", "26.04.2027"]);
  assert.match(filings[0].what, /уведомление об авансе за I квартал на 5 610 ₽/);
  assert.equal(filings[0].sum, null);
  const ics = N.toIcs(r.calendars.usn6, new Date(Date.UTC(2026, 0, 1)));
  assert.match(ics, /DTSTART;VALUE=DATE:20260427\r\nDTEND;VALUE=DATE:20260428\r\nSUMMARY:УСН 6%: уведомление об авансе за I квартал на 5 610 ₽ \(подать\\, не платить\)\r\n/);
  // без авансов уведомления не нужны
  assert.equal(N.analyze(sample).calendars.usn6.filter((c) => /уведомление/.test(c.what)).length, 0);
});

// nds-warning-timing-wrong
test("НДС: обязанность с 1-го числа месяца после превышения 20 млн", () => {
  const dec = N.analyze(H + "15.12.2026;21 000 000,00;ООО «Ромашка»;Оплата\n");
  const w = dec.warnings.find((x) => /НДС/.test(x.text)).text;
  assert.match(w, /в декабре: с 01\.01\.2027/);
  assert.doesNotMatch(w, /с этого года/);
  const jun = N.analyze(H + "15.03.2026;15 000 000,00;ООО «Ромашка»;Оплата\n20.06.2026;6 000 000,00;ООО «Ромашка»;Оплата\n");
  assert.match(jun.warnings.find((x) => /НДС/.test(x.text)).text, /в июне: с 01\.07\.2026/);
});

// nalog-acquiring-excluded-by-vozvrat
test("эквайринг — доход до комиссии, «возврат» в тексте не исключает поступление", () => {
  const r = N.analyze(H + "15.01.2026;48 512,30;ПАО СБЕРБАНК;Зачисление средств по операциям эквайринга. Мерчант №781000123456. Дата реестра 14.01.2026. Комиссия 990,00. Возврат покупки 0,00. НДС не облагается\n");
  assert.equal(r.totalIncome, 49502.3);
  assert.equal(r.foundExpenses, 990);
  assert.equal(N.classify({ description: "Возмещение по операциям торгового эквайринга. Терминал 1. Комиссия 60,00. Возврат покупки 500,00", payer: "АО ТБАНК" }).kind, "income");
  assert.equal(N.classify({ description: "Оплата по договору 12. Без возврата", payer: "ООО Ромашка" }).kind, "income");
  assert.equal(N.classify({ description: "Возврат излишне уплаченного налога", payer: "УФК" }).kind, "excluded");
  assert.equal(N.classify({ description: "Возврат по договору 3", payer: "ООО Ромашка" }).kind, "check");
});

// nalog-own-ip-transfer-is-income
test("перевод со своего счёта ИП — не доход, перевод от ИП — проверить", () => {
  for (const d of ["Перевод денежных средств на собственный счет. НДС не облагается", "Перевод собственных денежных средств",
    "Перевод средств на свой счет в другом банке", "Пополнение счета ИП собственными средствами"]) {
    assert.equal(N.classify({ description: d, payer: "ИП Иванов Иван Иванович" }).kind, "excluded", d);
  }
  assert.equal(N.classify({ description: "Перевод средств по договору", payer: "ИП Иванов Иван Иванович" }).kind, "check");
  assert.equal(N.classify({ description: "Оплата по счету 7", payer: "ИП Петров А.А." }).kind, "income");
  // заказчик-бюджетник платит «за счет собственных средств» — это доход
  assert.equal(N.classify({ description: "Оплата по контракту 5 за счет собственных средств учреждения", payer: "ГБУ Школа 1" }).kind, "income");
});

// nalog-tbank-wrong-amount-column-currency
test("Т-Банк и ВТБ: берётся сумма в валюте счёта, валютные строки без рублей пропускаются", () => {
  const q = (a) => a.map((x) => `"${x}"`).join(";");
  const tb = [
    ["Дата операции", "Дата платежа", "Номер карты", "Статус", "Сумма операции", "Валюта операции", "Сумма платежа", "Валюта платежа", "Описание"],
    ["20.03.2026 09:00:00", "20.03.2026", "", "OK", "1000,00", "USD", "95000,00", "RUB", "Пополнение. UPWORK GLOBAL INC"],
    ["21.03.2026 19:45:31", "22.03.2026", "*1234", "OK", "-12,99", "USD", "-1250,30", "RUB", "ANTHROPIC"],
  ].map(q).join("\r\n");
  assert.deepEqual(N.parseStatement(tb).map((o) => o.amount), [95000, -1250.3]);
  const vtb = "Номер карты/счета/договора;Дата операции;Дата обработки;Сумма операции;Валюта операции;Сумма пересчитанная в валюту счета;Валюта счета;Основание;Статус\n'2200;2026-02-06 00:00:00;2026-02-08;-45,00;EUR;-4515,00;RUR;BOOKING.COM;Исполнено\n";
  assert.deepEqual(N.parseStatement(vtb).map((o) => [o.amount, o.description]), [[-4515, "BOOKING.COM"]]);
  const usdOnly = N.parseStatementInfo("Дата операции;Сумма операции;Валюта операции;Описание\n01.02.2026;100,00;USD;Upwork\n02.02.2026;5000,00;RUB;Оплата\n");
  assert.deepEqual(usdOnly.ops.map((o) => o.amount), [5000]);
  assert.equal(usdOnly.stats.foreign, 1);
});

// nalog-alfa-two-digit-year
test("Альфа-Банк: год из двух цифр", () => {
  const ops = N.parseStatement("Тип счёта;Номер счета;Валюта;Дата операции;Референс проводки;Описание операции;Приход;Расход;\nТекущий счёт;40802810000000000001;RUR;15.01.26;C011501260001;Оплата по счету 7 от ООО Ромашка;180000;0;\nТекущий счёт;40802810000000000001;RUR;20.01.26;CRD;YANDEX.TAXI;0;450;\n");
  assert.deepEqual(ops.map((o) => [o.date, o.amount]), [[{ y: 2026, m: 1, d: 15 }, 180000], [{ y: 2026, m: 1, d: 20 }, -450]]);
});

// nalog-no-status-filter
test("отклонённые операции (статус FAILED) не учитываются", () => {
  const info = N.parseStatementInfo('Дата операции;Статус;Сумма операции;Описание\n16.03.2026;FAILED;90000,00;Пополнение. ООО ВЕКТОР\n17.03.2026;OK;95000,00;Пополнение. ООО РОМАШКА\n22.03.2026;Отклонена;-35000,00;М.Видео\n');
  assert.deepEqual(info.ops.map((o) => o.amount), [95000]);
  assert.equal(info.stats.failed, 2);
  assert.ok(N.analyzeOps(info.ops, {}, info.stats).warnings.some((w) => /отклонённых/.test(w.text)));
});

// nalog-multiline-quoted-cells
test("ячейки с переносом строки в кавычках (Excel) не ломают запись", () => {
  const ops = N.parseStatement('Дата операции;Плательщик;Сумма операции;Назначение платежа\n15.01.2026;"ООО ""Ромашка""\nИНН 7701234567";150 000,00;Оплата по счету 7\n16.01.2026;ООО Вектор;90 000,00;Оплата\n');
  assert.deepEqual(ops.map((o) => o.amount), [150000, 90000]);
  assert.equal(ops[0].payer, 'ООО "Ромашка" ИНН 7701234567');
  const biz = 'ПАО СБЕРБАНК;;;;\nДата проводки;Счет;;Сумма по дебету;Сумма по кредиту;Назначение платежа\n;Дебет;Кредит;;;\n' +
    '20.01.2026;"40702810400000012345\n7701234567\nООО ""РОМАШКА""";"40802810938000000001\nИП ИВАНОВ";;"180 000,00";"Оплата по счету 7"\n' +
    '25.01.2026;"40802810938000000001\nИП ИВАНОВ";"40702810100000099999\nООО Хостинг";"4 500,00";;"Оплата хостинга"\n';
  assert.deepEqual(N.parseStatement(biz).map((o) => o.amount), [180000, -4500]);
  // незакрытая кавычка не съедает остаток файла
  assert.equal(N.parseStatement('Дата;Сумма;Описание\n01.02.2026;100;"ООО Ромашка\n02.02.2026;200;Оплата\n').length, 2);
});

// nalog-own-withdrawals-as-expenses
test("вывод денег себе — не расход для УСН 15%", () => {
  for (const d of ["Перевод на личную карту ИП", "Перевод собственных денежных средств ИП Иванову И.И.", "Перевод средств на собственный счет", "Вывод прибыли"]) {
    assert.equal(N.classifyExpense({ description: d, payer: "" }).kind, "not-expense", d);
  }
  const r = N.analyze(H + "10.02.2026;1 000 000,00;ООО Ромашка;Оплата\n11.02.2026;-400 000,00;;Перевод на личную карту ИП\n12.02.2026;-300 000,00;;Перевод собственных денежных средств ИП Иванову И.И.\n");
  assert.equal(r.foundExpenses, 0);
});

// nalog-substring-picks-account-number-column
test("шапка 1С «Счет Дебет; Счет Кредит; Сумма по дебету; Сумма по кредиту»", () => {
  const csv = "Дата проводки;Счет Дебет;Счет Кредит;Сумма по дебету;Сумма по кредиту;№ документа;Назначение платежа\n20.01.2026;40702810400000012345;40802810938000000001;;180000,00;77;Оплата по счету 7\n25.01.2026;40802810938000000001;40702810100000099999;4500,00;;5;Оплата хостинга\n";
  const r = N.analyze(csv);
  assert.equal(r.totalIncome, 180000);
  assert.equal(r.foundExpenses, 4500);
  assert.equal(N.parseAmount("40702810400000012345"), null);
});

// amount-parse-silent-drop
test("суммы: юникодный минус, «р.», RUR, минус в конце, скобки, 1,500.00; нечитаемые — в предупреждение", () => {
  const cases = { "−1 500,00": -1500, "–1 500,00": -1500, "1 500,00 р.": 1500, "1500,00 RUR": 1500, "1500,00-": -1500,
    "(1 500,00)": -1500, "1,500.00": 1500, "1.500,00": 1500, "+1 500,00": 1500, "1 500,00": 1500 };
  for (const [s, n] of Object.entries(cases)) assert.equal(N.parseAmount(s), n, s);
  const r = N.analyze(H + "10.01.2026;200 000,00;ООО Ромашка;Оплата\n15.01.2026;двести;ООО Ромашка;Оплата\n");
  assert.ok(r.warnings.some((w) => /1 строк\(и\) с датой пропущено/.test(w.text)));
});

// nalog-legal-full-form-missed
test("организации полным названием, иностранные компании и ИНН из 10 цифр — НПД 6%", () => {
  for (const payer of ['ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "РОМАШКА"', "Индивидуальный предприниматель Петров А.А.", "UPWORK GLOBAL INC", "ACME LLC", "Ромашка ИНН 7701234567"]) {
    assert.equal(N.classify({ description: "Оплата по договору", payer }).fromLegal, true, payer);
  }
  assert.equal(N.classify({ description: "Оплата", payer: "Иванов И.И. ИНН 771234567890" }).fromLegal, false);
  const r = N.analyze(H + '10.02.2026;100 000,00;ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "РОМАШКА";Оплата\n');
  assert.equal(r.npd.tax, 4000);
});

// nalog-not-expense-substring
test("расходы: «ATMOSPHERE», «Налоговый консультант», «Уфкомплект» — это расходы", () => {
  for (const d of ["Оплата аренды ATMOSPHERE COWORKING", "Оплата по счету 15 ООО «Налоговый консультант» за бухгалтерские услуги", "Оплата по счету ООО Уфкомплект"]) {
    assert.equal(N.classifyExpense({ description: d, payer: "" }).kind, "expense", d);
  }
  for (const d of ["Единый налоговый платеж", "Снятие наличных в банкомате", "ATM 12345 MOSCOW", "Налог по УСН за 2025 год", "Страховые взносы ИП за себя"]) {
    assert.equal(N.classifyExpense({ description: d, payer: "" }).kind, "not-expense", d);
  }
});

// nalog-date-column-and-validation
test("даты: колонка «Дата поступления» важнее «Даты документа», месяц/день/год, неверные даты", () => {
  const r = N.analyze("Дата документа;Дата поступления;Сумма;Плательщик;Назначение платежа\n29.12.2025;12.01.2026;150 000,00;ООО Ромашка;Оплата\n01.02.2026;02.02.2026;100 000,00;ООО Ромашка;Оплата\n01.03.2026;02.03.2026;100 000,00;ООО Ромашка;Оплата\n");
  assert.equal(r.totalIncome, 350000);
  const us = N.analyze("Дата операции;Сумма операции;Описание\n1/15/2026;150000,00;Оплата ООО Ромашка\n1/5/2026;10000,00;Оплата ООО Ромашка\n");
  assert.equal(us.totalIncome, 160000);
  assert.deepEqual(us.income.map((o) => o.date.m), [1, 1]);
  assert.ok(us.warnings.some((w) => /месяц\/день\/год/.test(w.text)));
  assert.equal(N.parseDate("31.02.2026"), null);
  assert.equal(N.parseDate("15.13.2026"), null);
});

// delimiter-and-header-window
test("заголовок с запятой и длинная преамбула перед шапкой", () => {
  assert.equal(N.parseStatement("Выписка по счету 40802810000000000001, ИП Иванов И.И.\nДата операции;Сумма операции;Назначение платежа\n15.01.2026;150 000,00;Оплата ООО Ромашка\n").length, 1);
  const pre = Array.from({ length: 30 }, (_, i) => `Строка шапки ${i}`).join("\n");
  assert.equal(N.parseStatement(pre + "\nДата операции;Сумма операции;Назначение платежа\n15.01.2026;150 000,00;Оплата\n").length, 1);
});

// nh-steps-hidden-overridden (CSS: в браузере проверено отдельно, здесь — что правило есть)
test("страница: атрибут hidden не перебивается display у блоков", () => {
  const html = fs.readFileSync(path.join(__dirname, "../docs/index.html"), "utf8");
  assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
});

// nh-encoding-fallback-one-bad-byte
test("кодировка: один битый байт в UTF-8 не переключает файл в Windows-1251", () => {
  const good = fs.readFileSync(path.join(__dirname, "../examples/vypiska-primer.csv"));
  const broken = Buffer.concat([good, Buffer.from("01.10.2026;1 000,00;ООО Тест;Оплата "), Buffer.from([0xd0]), Buffer.from("\n")]);
  assert.equal(N.analyze(N.decodeStatement(new Uint8Array(broken))).totalIncome, 1061000);
  // настоящий файл в Windows-1251 по-прежнему читается
  const enc = new Map([..."абвгдеёжзийклмнопрстуфхцчшщъыьэюя"].map((ch, i) => [ch, ch === "ё" ? 0xb8 : 0xe0 + i - (i > 6 ? 1 : 0)]));
  const cp = Uint8Array.from([...good.toString("utf8")].map((ch) => {
    const lo = ch.toLowerCase();
    if (enc.has(lo)) return ch === lo ? enc.get(lo) : (lo === "ё" ? 0xa8 : enc.get(lo) - 0x20);
    return ch.charCodeAt(0) < 128 ? ch.charCodeAt(0) : 0x3f;
  }));
  assert.equal(N.analyze(N.decodeStatement(cp)).totalIncome, 1060000);
  const { paths, cleanup } = tmpFiles({ "broken.csv": broken });
  try { assert.equal(cliJson(paths).totalIncome, 1061000); } finally { cleanup(); }
});

// nh-nan-year-error
test("ни одной операции — понятная ошибка вместо «NaN года»", () => {
  for (const t of ["Дата;Сумма;Описание\nfoo;bar;baz\n", "Дата;Сумма;Описание\n01.02.2026;0;x\n"]) {
    assert.throws(() => N.analyze(t), /ни одной операции с датой/);
  }
});

test("регрессия: возврат покупателю не меняет авансы уже закрытых кварталов", () => {
  const head = "Дата операции;Сумма операции;Плательщик;Назначение платежа\n";
  const income = "10.02.2026;3 000 000,00;ООО «Ромашка»;Оплата по договору 5\n";
  const refund = "20.04.2026;-1 000 000,00;ООО «Ромашка»;Возврат предоплаты по договору 5 в связи с расторжением\n";
  const r = N.analyze(head + income + refund);
  // 6% от 3 000 000 за I квартал минус взносы года (57 390 + 1% с 2 000 000 − 300 000 = 17 000).
  // До исправления возврат уменьшал доход I квартала, и аванс выходил 45 610.
  assert.equal(r.usn.periods[0].payment, 180000 - 57390 - 17000);
  assert.equal(r.totalIncome, 2000000);
});

test("регрессия: возврат займа и депозита — не расход и не возврат покупателю", () => {
  for (const d of ["Возврат денежных средств по договору займа №3", "Возврат депозита по договору 12", "Погашение кредита по договору 77"]) {
    assert.equal(N.classifyExpense({ description: d, payer: "" }).kind, "not-expense", d);
  }
  assert.equal(N.classifyExpense({ description: "Возврат предоплаты покупателю по счету 5", payer: "" }).kind, "refund");
});

test("регрессия: взносы за участие, налоговые консультации и «в т.ч. НДС» — обычные расходы", () => {
  for (const d of ["Оплата взноса за участие в выставке", "Оплата налоговой консультации", "Оплата по счету 15, в том числе налог на добавленную стоимость 20% — 2 000,00", "Аренда офиса. НДС не облагается"]) {
    assert.equal(N.classifyExpense({ description: d, payer: "" }).kind, "expense", d);
  }
  for (const d of ["Единый налоговый платеж", "Уплата налога по УСН за 1 квартал", "Страховые взносы ИП за себя"]) {
    assert.equal(N.classifyExpense({ description: d, payer: "" }).kind, "not-expense", d);
  }
});

test("регрессия: копейки «-,01», рубли в разных записях, остаток — не сумма", () => {
  const ops = N.parseStatement("Дата операции;Сумма операции;Назначение платежа\n01.03.2026;-,01;Комиссия\n02.03.2026;100;Оплата\n");
  assert.deepEqual(ops.map((o) => o.amount), [-0.01, 100]);
  const rub = N.parseStatement("Дата;Сумма;Валюта;Назначение\n01.03.2026;500;Российские рубли;Оплата\n");
  assert.equal(rub.length, 1);
  const bal = N.parseStatement("Дата операции;Остаток в валюте счета;Сумма в валюте счета;Назначение\n01.03.2026;90 000;5 000;Оплата\n");
  assert.deepEqual(bal.map((o) => o.amount), [5000]);
});
