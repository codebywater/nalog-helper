(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Nalog.fmt(n) + " ₽";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const day = (d) => `${String(d.d).padStart(2, "0")}.${String(d.m).padStart(2, "0")}.${d.y}`;
  const short = (n) => n >= 1e6 ? (n / 1e6).toFixed(1).replace(".", ",") + " млн" : Math.round(n / 1000) + " тыс.";
  const num = (el) => (el.value.trim() === "" ? null : Math.max(0, Number(el.value)));

  let statement = null;   // текст выписки, чтобы пересчитывать без повторной загрузки
  let result = null;
  let calendarRegime = null;

  function card({ label, value, rows, mod = "", tag = "" }) {
    return `<article class="card ${mod}">
      <div class="card__label"><span>${label}</span>${tag}</div>
      <div class="card__value num">${value}</div>
      <ul class="card__rows">${rows.map(([k, v]) => `<li><span>${k}</span><b class="num">${v}</b></li>`).join("")}</ul>
    </article>`;
  }

  function options() {
    const staff = $("opt-staff").checked;
    const rate = num($("opt-rate"));
    return {
      expenses: num($("opt-expenses")),
      employeeContributions: staff ? num($("opt-staff-sum")) || 0 : 0,
      usn15Rate: rate ? Math.min(rate, 15) / 100 : 0.15,
    };
  }

  function load(text) {
    statement = text;
    $("opt-expenses").value = "";
    calendarRegime = null;
    render(true);
  }

  function render(scroll) {
    $("error").hidden = true;
    try { result = Nalog.analyze(statement, options()); } catch (e) {
      $("error").textContent = e.message;
      $("error").hidden = false;
      $("result").hidden = true;
      return;
    }
    const r = result;

    $("warnings").innerHTML = r.warnings.map((w) => `<div class="alert alert--${w.level}">${esc(w.text)}</div>`).join("");

    const u = r.usn, u15 = r.usn15, n = r.npd;
    const best = (k) => (r.cheaper === k ? { mod: "card--best", tag: '<span class="tag">выгоднее</span>' } : {});
    $("cards").innerHTML =
      card({ label: `Доход за ${r.year} год`, value: fmt(r.totalIncome), mod: "card--income",
        rows: [["Поступлений учтено", r.income.length], ["Нужно проверить", r.check.length], ["Расходы", fmt(u15.expenses)]] }) +
      card({ label: "ИП на УСН 6%", value: fmt(u.total), ...best("usn6"),
        rows: [["Налог 6% до вычета", fmt(u.grossTax)], ["Взносы за себя", fmt(u.contributions.total)],
          ["Налог после вычета", fmt(u.tax)]] }) +
      card({ label: `ИП на УСН ${Math.round(u15.rate * 100)}%`, value: fmt(u15.total), ...best("usn15"),
        rows: [["База: доходы − расходы", fmt(Math.max(0, u15.income - u15.expenses))], ["Взносы за себя", fmt(u15.contributions.total)],
          [u15.minimumTaxApplied ? "Минимальный налог 1%" : "Налог", fmt(u15.tax)]] }) +
      card({ label: "Самозанятый (НПД)", value: r.npdAllowed ? fmt(n.total) : "недоступно", ...best("npd"),
        rows: [["Ставка", "4% / 6%"], ["Остаток вычета", fmt(n.deductionLeft)], ["Пенсионный стаж", "не идёт"]] });

    $("opt-expenses").placeholder = Nalog.fmt(r.foundExpenses);
    $("opt-expenses-hint").textContent = r.expensesManual
      ? `Введено вручную. В выписке найдено ${fmt(r.foundExpenses)}.`
      : `Найдено в выписке: ${fmt(r.foundExpenses)}. Можно ввести свою сумму.`;

    // Доход по кварталам: из накопленных сумм УСН получаем приросты.
    const cum = u.periods.map((p) => p.income);
    const quarters = cum.map((v, i) => v - (i ? cum[i - 1] : 0));
    const max = Math.max(...quarters, 1);
    $("chart").innerHTML = quarters.map((q) =>
      `<div class="chart__col"><span class="chart__value num">${q ? short(q) : "—"}</span>` +
      `<div class="chart__bar" style="height:${Math.round(q / max * 100)}%" role="img" aria-label="${fmt(q)}"></div></div>`).join("");

    if (!calendarRegime) calendarRegime = r.cheaper === "usn15" ? "usn15" : "usn6";
    renderCalendar();

    const label = { income: "доход", check: "проверить", excluded: "не доход", expense: "расход", "not-expense": "не расход" };
    const all = [...r.income, ...r.check, ...r.excluded, ...r.expenses, ...r.notExpenses].sort((a, b) =>
      (a.date.y - b.date.y) || (a.date.m - b.date.m) || (a.date.d - b.date.d));
    $("ops").innerHTML = all.map((o) => {
      const out = o.kind === "expense" || o.kind === "not-expense";
      const muted = o.kind === "excluded" || o.kind === "not-expense";
      return `<tr class="${muted ? "is-muted" : ""}"><td class="num">${day(o.date)}</td>` +
        `<td>${esc([o.payer, o.description].filter(Boolean).join(" — "))}</td>` +
        `<td><span class="pill pill--${o.kind}">${label[o.kind]}</span></td>` +
        `<td class="table__sum num">${out ? "−" : ""}${fmt(o.amount)}</td></tr>`;
    }).join("");

    $("steps").hidden = true;
    $("result").hidden = false;
    if (scroll) $("result").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderCalendar() {
    document.querySelectorAll(".segmented__btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.regime === calendarRegime)));
    $("calendar").innerHTML = result.calendars[calendarRegime].map((c) =>
      `<li class="timeline__item"><span class="timeline__date num">${c.date}</span>` +
      `<span class="timeline__what">${esc(c.what)}</span><span class="timeline__sum num">${fmt(c.sum)}</span></li>`).join("");
  }

  function downloadIcs() {
    const blob = new Blob([Nalog.toIcs(result.calendars[calendarRegime])], { type: "text/calendar;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `nalogi-${result.year}.ics`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function readFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      // Банки часто отдают CSV в Windows-1251: если UTF-8 не прочитался, пробуем её.
      if (reader.result.includes("�")) {
        const r2 = new FileReader();
        r2.onload = () => load(r2.result);
        r2.readAsText(file, "windows-1251");
        return;
      }
      load(reader.result);
    };
    reader.readAsText(file, "utf-8");
  }

  $("pick").addEventListener("click", (e) => { e.preventDefault(); $("file").click(); });
  $("demo").addEventListener("click", (e) => { e.preventDefault(); load(window.NALOG_DEMO); });
  $("file").addEventListener("change", (e) => e.target.files[0] && readFile(e.target.files[0]));
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("drop--over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("drop--over"); }));
  drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && readFile(e.dataTransfer.files[0]));

  $("settings").addEventListener("submit", (e) => e.preventDefault());
  $("settings").addEventListener("input", () => {
    $("opt-staff-sum").disabled = !$("opt-staff").checked;
    if (statement) render(false);
  });
  document.querySelectorAll(".segmented__btn").forEach((b) => b.addEventListener("click", () => {
    calendarRegime = b.dataset.regime;
    renderCalendar();
  }));
  $("ics").addEventListener("click", downloadIcs);
})();
