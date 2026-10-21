#!/usr/bin/env node
/*
 * nalog-helper из командной строки. Использует то же ядро, что и веб-версия
 * (docs/nalog.js), поэтому результаты совпадают. Работает без интернета.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const Nalog = require(path.join(__dirname, "../../../docs/nalog.js"));

const HELP = `node nalog-cli.js выписка.csv [ещё.csv ...] [параметры]

  --year 2026                 год расчёта (по умолчанию — самый частый в выписке)
  --expenses 900000           расходы за год для УСН 15% вручную (без взносов за работников)
  --employees 100000          взносы за работников за год (значит, работники есть)
  --has-employees             работники есть, сумма взносов неизвестна
  --rate 15                   ставка УСН «Доходы минус расходы» в регионе, от 0 до 15%
  --npd-deduction-left 10000  остаток разового вычета НПД из «Мой налог» (0–10 000)
  --format md|json            формат отчёта
  --ics файл.ics              сохранить календарь платежей и уведомлений

Суммы можно писать с пробелами и запятой: «900 000» или «900000,50».
Несколько файлов (разные счета) разбираются по отдельности и складываются.`;

// Число из аргумента: «900 000», «900000,50», «900 000 ₽». Пустое, отрицательное или вне диапазона — ошибка.
function toNum(s, name, { min = 0, max = Infinity, integer = false } = {}) {
  const clean = String(s).replace(/[\s\u00a0\u202f₽]|руб\.?/gi, "").replace(",", ".");
  const n = /^[+-]?\d+(\.\d+)?$/.test(clean) ? Number(clean) : NaN;
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    const range = max === Infinity ? `не меньше ${min}` : `от ${min} до ${max}`;
    throw new Error(`Неверное значение ${name}: «${s}». Нужно ${integer ? "целое " : ""}число ${range}.`);
  }
  return n;
}

function parseArgs(argv) {
  const args = { files: [], format: "md" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`После ${a} нужно значение`);
      return argv[++i];
    };
    if (a === "--year") args.year = toNum(val(), a, { min: 2000, max: 2100, integer: true });
    else if (a === "--expenses") args.expenses = toNum(val(), a);
    else if (a === "--employees") {
      args.employeeContributions = toNum(val(), a);
      if (args.employeeContributions > 0) args.hasEmployees = true;
    } else if (a === "--has-employees") args.hasEmployees = true;
    else if (a === "--rate") {
      // п. 2 ст. 346.20 НК РФ: не больше 15%.
      const rate = toNum(val(), a, { max: 15 });
      if (rate <= 0) throw new Error(`Неверное значение ${a}: «${rate}». Ставка УСН 15% — больше 0 и не больше 15.`);
      args.usn15Rate = rate / 100;
    } else if (a === "--npd-deduction-left") args.npdDeductionLeft = toNum(val(), a, { max: 10000 });
    else if (a === "--format") {
      args.format = val();
      if (!["md", "json"].includes(args.format)) throw new Error(`Неверное значение --format: «${args.format}». Можно md или json.`);
    } else if (a === "--ics") args.ics = val();
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a.startsWith("--")) throw new Error(`Неизвестный параметр ${a}. Справка: --help`);
    else args.files.push(a);
  }
  return args;
}

function readStatement(file) {
  // UTF-8 или Windows-1251: ядро выбирает ту кодировку, в которой выписка читается.
  return Nalog.decodeStatement(new Uint8Array(fs.readFileSync(file)));
}

const rub = (n) => `${Nalog.fmt(n)} ₽`;

function markdown(r) {
  const name = { usn6: "УСН 6%", usn15: `УСН ${Math.round(r.usn15.rate * 100)}%`, npd: "НПД (самозанятый)" };
  const lines = [
    `## Налоги за ${r.year} год`,
    "",
    `Доход: **${rub(r.totalIncome)}** (поступлений: ${r.income.length}, нужно проверить: ${r.check.length})`,
    `Расходы для УСН 15%: ${rub(r.usn15.expenses)}${r.expensesManual ? " (введены вручную" : " (из выписки"}${r.employeeContributions ? ` + взносы за работников ${rub(r.employeeContributions)})` : ")"}`,
    "",
    "| Режим | Налог | Взносы за себя | Всего |",
    "|---|---:|---:|---:|",
    `| ${name.usn6} | ${rub(r.usn.tax)} | ${rub(r.usn.contributions.total)} | **${rub(r.usn.total)}** |`,
    `| ${name.usn15} | ${rub(r.usn15.tax)}${r.usn15.minimumTaxApplied ? " (мин. 1%)" : ""} | ${rub(r.usn15.contributions.total)} | **${rub(r.usn15.total)}** |`,
    `| ${name.npd} | ${r.npdAllowed ? rub(r.npd.tax) : "недоступно"} | — | **${r.npdAllowed ? rub(r.npd.total) : "—"}** |`,
    "",
    `НПД посчитан с остатком разового вычета ${rub(r.npd.deductionStart)}: вычет 10 000 ₽ даётся один раз за всё время, остаток виден в «Мой налог» (--npd-deduction-left).`,
    "",
    `Выгоднее: **${name[r.cheaper]}**`,
    "",
    `### Календарь платежей и уведомлений (${r.cheaper === "usn15" ? name.usn15 : name.usn6})`,
    "",
    ...r.calendar.map((c) => `- ${c.date} — ${c.what}${c.sum == null ? "" : `: ${rub(c.sum)}`}`),
  ];
  if (r.warnings.length) lines.push("", "### Предупреждения", "", ...r.warnings.map((w) => `- ${w.text}`));
  if (r.check.length) {
    lines.push("", "### Проверьте: доход или нет?", "",
      ...r.check.map((o) => `- ${String(o.date.d).padStart(2, "0")}.${String(o.date.m).padStart(2, "0")}.${o.date.y} — ${[o.payer, o.description].filter(Boolean).join(" — ")}: ${rub(o.amount)}`));
  }
  lines.push("", "_Расчёт ориентировочный и не заменяет бухгалтера._");
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.files.length) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }
  // Каждую выписку разбираем отдельно: у разных банков разные колонки и разделители.
  const parsed = args.files.map((f) => {
    let info;
    try { info = Nalog.parseStatementInfo(readStatement(f)); } catch (e) { throw new Error(`${f}: ${e.message}`); }
    if (!info.ops.length) throw new Error(`${f}: не нашёл ни одной операции с датой и суммой. Проверьте формат дат и колонку суммы.`);
    return info;
  });
  if (parsed.length > 1) parsed.forEach((p, i) => console.error(`${args.files[i]}: операций ${p.ops.length}`));
  const r = Nalog.analyzeOps(parsed.flatMap((p) => p.ops), args, Nalog.mergeStats(parsed.map((p) => p.stats)));
  if (args.ics) fs.writeFileSync(args.ics, Nalog.toIcs(r.calendar));
  if (args.format === "json") {
    const { income, check, excluded, expenses, notExpenses, refunds, ...summary } = r;
    console.log(JSON.stringify({ ...summary, counts: { income: income.length, check: check.length,
      excluded: excluded.length, expenses: expenses.length, notExpenses: notExpenses.length, refunds: refunds.length }, check, refunds }, null, 2));
  } else {
    console.log(markdown(r));
  }
}

try { main(); } catch (e) {
  console.error(`Ошибка: ${e.message}`);
  process.exit(1);
}
