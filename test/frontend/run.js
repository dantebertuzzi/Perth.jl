/* Perth · testes de frontend (jsdom), rodados no CI (Frontend.yml).
 * Cobre o módulo de i18n contra os DOMs reais das duas páginas e as
 * invariantes do chrome compartilhado. Sem framework: node run.js sai
 * com código != 0 em qualquer falha. */
"use strict";

const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

function loadPage(htmlPath) {
  const html = read(htmlPath)
    .replace(/<script src="\/app.js"><\/script>/, "")
    .replace(/<script src="\/shared\/presence.js"><\/script>/, "");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/" });
  dom.window.eval(read("frontend/shared/i18n.js"));
  return dom.window;
}

console.log("i18n · gantt");
{
  const w = loadPage("frontend/index.html");
  const $ = (s) => w.document.querySelector(s);
  const sel = $("#lang-select");
  check(sel && sel.options.length === 5, "seletor com 5 idiomas");
  w.PerthI18n.set("pt");
  check($('.menu[data-menu="file"] .menu-title').textContent.trim() === "Arquivo",
        "menu File → Arquivo");
  check($('button[data-action="export-csv"]').textContent.trim() ===
        "Exportar tarefas (CSV)", "novo item Export CSV traduzido");
  check($('button[data-action="scurve"]').textContent.trim() === "Curva S…",
        "novo item S-curve traduzido");
  w.PerthI18n.set("en");
  w.PerthI18n.set("zh");
  check($('.menu[data-menu="help"] .menu-title').textContent.trim() === "帮助",
        "ida e volta en→zh");
  check($('button[data-action="new-task"]').querySelector("kbd")?.textContent === "N",
        "kbd preservado");
  check($("#gh-link").getAttribute("title") === "GitHub 源码", "title traduzido");
  check(w.localStorage.getItem("perth-lang") === "zh", "persistência");
  check(Array.isArray(w.PerthI18n.months()) && w.PerthI18n.months()[0] === "1月",
        "meses localizados");
}

console.log("i18n · kanban");
{
  const w = loadPage("frontend/kanban/index.html");
  const $ = (s) => w.document.querySelector(s);
  check($("#lang-select") !== null, "seletor presente");
  w.PerthI18n.set("fr");
  check($('.menu[data-menu="board"] .menu-title').textContent.trim() === "Tableau",
        "menu Board → Tableau");
  check($('button[data-action="metrics"]').textContent.trim() === "Métriques…",
        "novo item Metrics traduzido");
  check($("#search").getAttribute("placeholder") === "filtrer les cartes…  ( / )",
        "placeholder da busca");
}

console.log("chrome compartilhado");
{
  for (const p of ["frontend/index.html", "frontend/kanban/index.html"]) {
    const s = read(p);
    check(s.includes('href="/shared/ui.css"'), p + " usa shared/ui.css");
    check(s.indexOf('href="/shared/ui.css"') < s.indexOf('href="/style.css"'),
          p + " carrega shared/ui.css ANTES do CSS do app (base → específico)");
    check(s.includes('href="https://github.com/dantebertuzzi/Perth.jl"'),
          p + " aponta o GitHub para o repositório");
    check(s.includes('rel="manifest"'), p + " tem manifest PWA");
  }
  const ui = read("frontend/shared/ui.css");
  check((ui.match(/\.menubar \{/g) || []).length === 1,
        "menubar definida uma única vez (fonte de verdade)");
  check((ui.match(/^\.board-chip \{/gm) || []).length === 1 &&
        !read("frontend/kanban/style.css").includes(".board-chip {"),
        "board-chip vive só no shared (chip unificado)");
  const g = read("frontend/index.html");
  const header = g.slice(g.indexOf("<header"), g.indexOf("</header>"));
  check(header.includes('id="project-select"'),
        "project-select está na menubar do gantt (como o board-chip)");
  check(!g.slice(g.indexOf('class="toolbar"')).slice(0, 400)
          .includes("project-select"),
        "project-select saiu da toolbar");
}

console.log(failures ? `\n${failures} falha(s)` : "\nTodos os testes passaram.");
process.exit(failures ? 1 : 0);
