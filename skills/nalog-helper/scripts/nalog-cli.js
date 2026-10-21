#!/usr/bin/env node
/*
 * nalog-helper из командной строки. Использует то же ядро, что и веб-версия
 * (docs/nalog.js), поэтому результаты совпадают. Работает без интернета.
 *
 *   node nalog-cli.js выписка.csv [--year 2026] [--expenses 900000]
 *                     [--employees 100000] [--rate 15] [--format md|json] [--ics файл.ics]
 */
"use strict";
const fs = require("fs");
const path = require("path");
const Nalog = require(path.join(__dirname, "../../../docs/nalog.js"));

function parseArgs(argv) {
  const args = { files: [], format: "md" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`После ${a} нужно значение`);
      return argv[++i];
    };
    if (a === "--year") args.year = Number(val());
    else if (a === "--expenses") args.expenses = Number(val());
    else if (a === "--employees") args.employeeContributions = Number(val());
    else if (a === "--rate") args.usn15Rate = Number(val()) / 100;
    else if (a === "--format") args.format = val();
    else if (a === "--ics") args.ics = val();
    else if (a === "-h" || a === "--help") args.help = true;
    else args.files.push(a);
  }
  return args;
}

function readStatement(file) {
  const buf = fs.readFileSync(file);
  const utf8 = buf.toString("utf8");
  // Банки часто отдают CSV в Windows-1251.
  return utf8.includes("�") ? new TextDecoder("windows-1251").decode(buf) : utf8;
}

const rub = (n) => `${Nalog.fmt(n)} ₽`;

function markdown(r) {
  const name = { usn6: "УСН 6%", usn15: `УСН ${Math.round(r.usn15.rate * 100)}%`, npd: "НПД (самозанятый)" };
  const lines = [
    `## Налоги за ${r.year} год`,
    "",
    `Доход: **${rub(r.totalIncome)}** (поступлений: ${r.income.length}, нужно проверить: ${r.check.length})`,
    `Расходы для УСН 15%: ${rub(r.usn15.expenses)}${r.expensesManual ? " (введены вручную)" : " (из выписки)"}`,
    "",
    "| Режим | Налог | Взносы за себя | Всего |",
    "|---|---:|---:|---:|",
    `| ${name.usn6} | ${rub(r.usn.tax)} | ${rub(r.usn.contributions.total)} | **${rub(r.usn.total)}** |`,
    `| ${name.usn15} | ${rub(r.usn15.tax)}${r.usn15.minimumTaxApplied ? " (мин. 1%)" : ""} | ${rub(r.usn15.contributions.total)} | **${rub(r.usn15.total)}** |`,
    `| ${name.npd} | ${r.npdAllowed ? rub(r.npd.tax) : "недоступно"} | — | **${r.npdAllowed ? rub(r.npd.total) : "—"}** |`,
    "",
    `Выгоднее: **${name[r.cheaper]}**`,
    "",
    `### Календарь платежей (${r.cheaper === "usn15" ? name.usn15 : name.usn6})`,
    "",
    ...r.calendar.map((c) => `- ${c.date} — ${c.what}: ${rub(c.sum)}`),
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
    console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(2, 7).map((l) => l.replace(/^ \*\s?/, "")).join("\n"));
    process.exit(args.help ? 0 : 1);
  }
  // Несколько выписок (разные счета) склеиваем: шапка берётся из первой.
  const texts = args.files.map(readStatement);
  const text = texts.map((t, i) => (i ? t.replace(/^﻿?[^\n]*\n/, "") : t)).join("\n");
  const r = Nalog.analyze(text, args);
  if (args.ics) fs.writeFileSync(args.ics, Nalog.toIcs(r.calendar));
  if (args.format === "json") {
    const { income, check, excluded, expenses, notExpenses, ...summary } = r;
    console.log(JSON.stringify({ ...summary, counts: { income: income.length, check: check.length,
      excluded: excluded.length, expenses: expenses.length, notExpenses: notExpenses.length }, check }, null, 2));
  } else {
    console.log(markdown(r));
  }
}

try { main(); } catch (e) {
  console.error(`Ошибка: ${e.message}`);
  process.exit(1);
}
