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
