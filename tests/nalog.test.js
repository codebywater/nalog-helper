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
