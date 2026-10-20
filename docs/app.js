(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Nalog.fmt(n) + " ₽";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const day = (d) => `${String(d.d).padStart(2, "0")}.${String(d.m).padStart(2, "0")}.${d.y}`;
  const short = (n) => n >= 1e6 ? (n / 1e6).toFixed(1).replace(".", ",") + " млн" : Math.round(n / 1000) + " тыс.";

  function card({ label, value, rows, mod = "", tag = "" }) {
    return `<article class="card ${mod}">
      <div class="card__label"><span>${label}</span>${tag}</div>
      <div class="card__value num">${value}</div>
      <ul class="card__rows">${rows.map(([k, v]) => `<li><span>${k}</span><b class="num">${v}</b></li>`).join("")}</ul>
    </article>`;
  }

  function show(text) {
    $("error").hidden = true;
    let r;
    try { r = Nalog.analyze(text); } catch (e) {
      $("error").textContent = e.message;
      $("error").hidden = false;
      $("result").hidden = true;
      return;
    }

    $("warnings").innerHTML = r.warnings.map((w) =>
      `<div class="alert alert--${w.level}">${esc(w.text)}</div>`).join("");

    const u = r.usn, n = r.npd;
    const npdAllowed = r.totalIncome <= r.params.npdLimit;
    const best = '<span class="tag">выгоднее</span>';
    $("cards").innerHTML =
      card({ label: `Доход за ${r.year} год`, value: fmt(r.totalIncome), mod: "card--income",
        rows: [["Поступлений учтено", r.income.length], ["Нужно проверить", r.check.length], ["Не доход", r.excluded.length]] }) +
      card({ label: "ИП на УСН 6%", value: fmt(u.total), mod: r.cheaper === "usn6" ? "card--best" : "", tag: r.cheaper === "usn6" ? best : "",
        rows: [["Налог 6% до вычета", fmt(u.grossTax)], ["Фиксированные взносы", fmt(u.contributions.fixed)],
          ["Взнос 1%", fmt(u.contributions.onePercent)], ["Налог после вычета", fmt(u.tax)]] }) +
      card({ label: "Самозанятый (НПД)", value: npdAllowed ? fmt(n.total) : "недоступно",
        mod: r.cheaper === "npd" ? "card--best" : "", tag: r.cheaper === "npd" ? best : "",
        rows: [["Ставка", "4% / 6%"], ["Остаток вычета", fmt(n.deductionLeft)], ["Пенсионный стаж", "не идёт"]] });

    // Доход по кварталам: из накопленных сумм УСН получаем приросты.
    const cum = u.periods.map((p) => p.income);
    const quarters = cum.map((v, i) => v - (i ? cum[i - 1] : 0));
    const max = Math.max(...quarters, 1);
    $("chart").innerHTML = quarters.map((q) =>
      `<div class="chart__col"><span class="chart__value num">${q ? short(q) : "—"}</span>` +
      `<div class="chart__bar" style="height:${Math.round(q / max * 100)}%" role="img" aria-label="${fmt(q)}"></div></div>`).join("");

    $("calendar").innerHTML = r.calendar.map((c) =>
      `<li class="timeline__item"><span class="timeline__date num">${c.date}</span>` +
      `<span class="timeline__what">${esc(c.what)}</span><span class="timeline__sum num">${fmt(c.sum)}</span></li>`).join("");

    const label = { income: "доход", check: "проверить", excluded: "не доход" };
    const all = [...r.income, ...r.check, ...r.excluded].sort((a, b) =>
      (a.date.y - b.date.y) || (a.date.m - b.date.m) || (a.date.d - b.date.d));
    $("ops").innerHTML = all.map((o) =>
      `<tr class="${o.kind === "excluded" ? "is-muted" : ""}"><td class="num">${day(o.date)}</td>` +
      `<td>${esc([o.payer, o.description].filter(Boolean).join(" — "))}</td>` +
      `<td><span class="pill pill--${o.kind}">${label[o.kind]}</span></td><td class="table__sum num">${fmt(o.amount)}</td></tr>`).join("");

    $("steps").hidden = true;
    $("result").hidden = false;
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function readFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      // Банки часто отдают CSV в Windows-1251: если UTF-8 не прочитался, пробуем её.
      if (reader.result.includes("�")) {
        const r2 = new FileReader();
        r2.onload = () => show(r2.result);
        r2.readAsText(file, "windows-1251");
        return;
      }
      show(reader.result);
    };
    reader.readAsText(file, "utf-8");
  }

  $("pick").addEventListener("click", (e) => { e.preventDefault(); $("file").click(); });
  $("demo").addEventListener("click", (e) => { e.preventDefault(); show(window.NALOG_DEMO); });
  $("file").addEventListener("change", (e) => e.target.files[0] && readFile(e.target.files[0]));
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("drop--over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("drop--over"); }));
  drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && readFile(e.dataTransfer.files[0]));
})();
