(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Nalog.fmt(n) + " ₽";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const day = (d) => `${String(d.d).padStart(2, "0")}.${String(d.m).padStart(2, "0")}.${d.y}`;

  function show(text) {
    $("error").hidden = true;
    let r;
    try { r = Nalog.analyze(text); } catch (e) {
      $("error").textContent = e.message;
      $("error").hidden = false;
      $("result").hidden = true;
      return;
    }

    $("warnings").innerHTML = r.warnings.map((w) => `<div class="warn ${w.level}">${esc(w.text)}</div>`).join("");

    const u = r.usn, n = r.npd;
    const npdAllowed = r.totalIncome <= r.params.npdLimit;
    $("cards").innerHTML = `
      <div class="card"><h3>Доход за ${r.year} год</h3><div class="big">${fmt(r.totalIncome)}</div>
        <ul class="rows"><li>Поступлений учтено <b>${r.income.length}</b></li><li>Нужно проверить <b>${r.check.length}</b></li></ul></div>
      <div class="card ${r.cheaper === "usn6" ? "best" : ""}"><h3>ИП на УСН 6%${r.cheaper === "usn6" ? '<span class="tag">выгоднее</span>' : ""}</h3>
        <div class="big">${fmt(u.total)}</div>
        <ul class="rows"><li>Налог 6% до вычета <b>${fmt(u.grossTax)}</b></li><li>Фиксированные взносы <b>${fmt(u.contributions.fixed)}</b></li>
        <li>Взнос 1% <b>${fmt(u.contributions.onePercent)}</b></li><li>Налог к уплате после вычета взносов <b>${fmt(u.tax)}</b></li></ul></div>
      <div class="card ${r.cheaper === "npd" ? "best" : ""}"><h3>Самозанятый (НПД)${r.cheaper === "npd" ? '<span class="tag">выгоднее</span>' : ""}</h3>
        <div class="big">${npdAllowed ? fmt(n.total) : "недоступно"}</div>
        <ul class="rows"><li>Ставка <b>4% с физлиц, 6% с компаний</b></li><li>Остаток вычета 10 000 ₽ <b>${fmt(n.deductionLeft)}</b></li>
        <li>Пенсионный стаж <b>не идёт</b></li></ul></div>`;

    $("calendar").innerHTML = r.calendar.map((c) =>
      `<tr><td>${c.date}</td><td>${esc(c.what)}</td><td class="num">${fmt(c.sum)}</td></tr>`).join("");

    const label = { income: "доход", check: "проверить", excluded: "не доход" };
    const all = [...r.income, ...r.check, ...r.excluded].sort((a, b) =>
      (a.date.y - b.date.y) || (a.date.m - b.date.m) || (a.date.d - b.date.d));
    $("ops").innerHTML = all.map((o) =>
      `<tr><td>${day(o.date)}</td><td>${esc([o.payer, o.description].filter(Boolean).join(" — "))}</td>` +
      `<td>${label[o.kind]}</td><td class="num">${fmt(o.amount)}</td></tr>`).join("");

    $("result").hidden = false;
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function readFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let text = reader.result;
      // Банки часто отдают CSV в Windows-1251: если UTF-8 не прочитался, пробуем её.
      if (text.includes("�")) {
        const r2 = new FileReader();
        r2.onload = () => show(r2.result);
        r2.readAsText(file, "windows-1251");
        return;
      }
      show(text);
    };
    reader.readAsText(file, "utf-8");
  }

  $("pick").addEventListener("click", (e) => { e.preventDefault(); $("file").click(); });
  $("demo").addEventListener("click", (e) => { e.preventDefault(); show(window.NALOG_DEMO); });
  $("file").addEventListener("change", (e) => e.target.files[0] && readFile(e.target.files[0]));
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && readFile(e.dataTransfer.files[0]));
})();
