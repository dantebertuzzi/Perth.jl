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

// IIFE assíncrona: o novo bloco "gantt · chat" precisa aguardar o init()
// do app (rejeita o fetch stub de propósito — ver loadGanttApp — pra
// PerthPresence.connect() rodar) antes de simular mensagens no WS.
(async () => {

function loadPage(htmlPath) {
  const html = read(htmlPath)
    .replace(/<script src="\/app.js"><\/script>/, "")
    .replace(/<script src="\/shared\/presence.js"><\/script>/, "");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/" });
  dom.window.eval(read("frontend/shared/i18n.js"));
  return dom.window;
}

// Carrega o app do kanban de verdade (não só o i18n): script tags reais via
// runScripts:"dangerously", não window.eval — em eval o "use strict" do topo
// do arquivo isola cada chamada em seu próprio escopo e function/const de
// topo somem; como <script> de verdade, ficam no ambiente léxico global da
// página, do jeito que o próprio devtools do navegador os vê. Precisa de
// stubs pro que o jsdom não implementa (WebSocket, fetch, matchMedia,
// structuredClone) — a conexão nunca abre de verdade, então toda a lógica
// exercida aqui é local: commit/undo/redo, canDo, inverseOf.
function loadKanbanApp() {
  const html = read("frontend/kanban/index.html")
    .replace(/<script src="\/shared\/presence.js"><\/script>/, "")
    .replace(/<script src="app.js"><\/script>/, "");
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/board" });
  const w = dom.window;

  class FakeWebSocket {
    constructor(url) { this.url = url; this.readyState = 0; }
    send() {}
    close() { this.readyState = 3; }
    addEventListener() {}
  }
  Object.assign(FakeWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  w.WebSocket = FakeWebSocket;
  w.fetch = () => new Promise(() => {});   // nunca resolve: nada depende da rede aqui
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.structuredClone = structuredClone;     // não existe em window por padrão no jsdom
  // o jsdom que o CI instala (sempre o mais novo) não traz o namespace
  // global CSS; some com ele aqui também, senão uma dependência de
  // CSS.escape passa local e quebra só lá — foi o que aconteceu uma vez
  delete w.CSS;

  const inject = (code) => {
    const s = w.document.createElement("script");
    s.textContent = code;
    w.document.head.appendChild(s);
  };
  inject(read("frontend/shared/i18n.js"));
  inject(read("frontend/shared/background.js"));
  inject(read("frontend/shared/shortcuts.js"));
  inject(read("frontend/shared/toast.js"));
  inject(read("frontend/kanban/app.js"));

  // Roda `code` como mais um <script> na mesma página — mesmo ambiente
  // léxico do app.js injetado acima, então commit/state/undo/etc. são
  // identificadores livres ali dentro, como num console de devtools real.
  // `code` deve terminar numa expressão JSON-serializável.
  const runIn = (code) => {
    inject(`window.__r__ = JSON.stringify((function(){ ${code} })());`);
    return JSON.parse(w.__r__);
  };
  return { w, runIn, close: () => w.close() };
}

// Mesma técnica de loadKanbanApp(), pro app do gantt.
// `opts.fetch` troca o stub de rede (ver o bloco da chave de acesso, que
// precisa de um 403 de verdade em vez da rejeição padrão) e `opts.url`, o
// endereço da página (é de lá que sai o ?key= do share).
function loadGanttApp(opts = {}) {
  const html = read("frontend/index.html")
    .replace(/<script src="\/shared\/presence.js"><\/script>/, "")
    .replace(/<script src="\/app.js"><\/script>/, "");
  const dom = new JSDOM(html, { runScripts: "dangerously",
                                url: opts.url || "http://localhost/" });
  const w = dom.window;

  // window.__ws sempre aponta pra instância mais recente: PerthPresence.
  // connect() reabre em cada retry de "onclose", então o teste precisa do
  // socket ATUAL, não de uma referência congelada no momento do load.
  class FakeWebSocket {
    constructor(url) { this.url = url; this.readyState = 0; w.__ws = this; }
    send() {}
    close() { this.readyState = 3; }
    addEventListener() {}
  }
  Object.assign(FakeWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  w.WebSocket = FakeWebSocket;
  // rejeita na hora (não trava pra sempre): o init() do gantt só chama
  // PerthPresence.connect() DEPOIS do try/catch de fetchRev()/loadProjects
  // — sem rejeitar, esse await nunca resolve e o WS nunca chega a abrir
  w.fetch = opts.fetch || (() => Promise.reject(new Error("fetch disabled in test")));
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.structuredClone = structuredClone;
  // o jsdom só define rAF com pretendToBeVisual; o arrasto de barra
  // re-renderiza dentro de um. Síncrono aqui: determinístico e sem callback
  // pendente sobrando depois do close() da janela.
  w.requestAnimationFrame = (fn) => { fn(); return 0; };
  // jsdom não implementa Element.scrollTo, que o app usa para mover os dois
  // eixos numa tacada só (ver goToHit). Sem isto, o teste morre de
  // TypeError num detalhe do jsdom, não num defeito do app.
  w.Element.prototype.scrollTo = function (o) {
    if (!o || typeof o !== "object") return;
    if (o.top !== undefined) this.scrollTop = o.top;
    if (o.left !== undefined) this.scrollLeft = o.left;
  };
  delete w.CSS;                 // idem loadKanbanApp: espelha o jsdom do CI
  w.console.error = () => {};   // init() loga o fetch rejeitado de propósito acima; ruído esperado

  const inject = (code) => {
    const s = w.document.createElement("script");
    s.textContent = code;
    w.document.head.appendChild(s);
  };
  inject(read("frontend/shared/i18n.js"));
  inject(read("frontend/shared/presence.js"));
  inject(read("frontend/shared/background.js"));
  inject(read("frontend/shared/shortcuts.js"));
  inject(read("frontend/shared/toast.js"));
  inject(read("frontend/app.js"));

  const runIn = (code) => {
    inject(`window.__r__ = JSON.stringify((function(){ ${code} })());`);
    return JSON.parse(w.__r__);
  };
  // simula o servidor mandando `msg` pelo socket atual (dispara handle()
  // dentro de presence.js, que por sua vez chama onChat/onTyping/onRev)
  const simulate = (msg) => w.__ws.onmessage({ data: JSON.stringify(msg) });
  return { w, runIn, simulate, close: () => w.close() };
}

console.log("i18n · o dicionário não pode ter chave repetida");
{
  // Num objeto literal de JS a chave repetida não é erro: a última vence, em
  // silêncio. O sintoma é a tradução MUDAR por causa de uma linha adicionada
  // 200 linhas abaixo — foi assim que quatro chaves acabaram com duas
  // traduções diferentes cada. O dicionário é grande e cresce por blocos;
  // achar isso com o olho não é plano.
  //
  // A varredura é sobre o TEXTO do bloco, não linha a linha: muito par está
  // quebrado em duas linhas (chave numa, tradução na outra), e uma varredura
  // por linha simplesmente não os vê.
  const fonte = read("frontend/shared/i18n.js");
  const linhaDe = (pos) => fonte.slice(0, pos).split(/\r?\n/).length;
  const blocos = [...fonte.matchAll(/^\s*(pt|es|fr|zh)\s*:\s*\{/gm)];
  const par = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

  const chaves = {};
  const repetidas = [];
  for (const [i, b] of blocos.entries()) {
    const lang = b[1];
    const texto = fonte.slice(b.index, i + 1 < blocos.length ? blocos[i + 1].index : fonte.length);
    const vistos = new Map();
    for (const p of texto.matchAll(par)) {
      if (vistos.has(p[1])) repetidas.push(`${lang}:${linhaDe(b.index + p.index)} "${p[1]}"`);
      else vistos.set(p[1], p[2]);
    }
    chaves[lang] = new Set(vistos.keys());
  }
  check(blocos.length === 4, "os quatro blocos de idioma foram encontrados");
  check(repetidas.length === 0,
        `nenhuma chave repetida${repetidas.length ? " — " + repetidas.join(", ") : ""}`);

  // e todo idioma tem que traduzir as MESMAS chaves: uma chave só no pt
  // aparece em inglês no meio de uma tela em francês
  const faltando = [];
  for (const a of Object.keys(chaves)) {
    for (const b of Object.keys(chaves)) {
      if (a === b) continue;
      for (const k of chaves[a]) if (!chaves[b].has(k)) faltando.push(`${b}: "${k}"`);
    }
  }
  check(faltando.length === 0,
        `os quatro idiomas cobrem as mesmas chaves${faltando.length
          ? " — falta " + faltando.slice(0, 5).join("; ") + ` (${faltando.length})` : ""}`);
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
  check($('button[data-action="export-ics"]').textContent.trim() ===
        "Exportar calendário (.ics)", "novo item Export .ics traduzido");
  check($('button[data-action="export-ics"]').getAttribute("title") ===
        "Marcos e prazos num arquivo .ics para o seu aplicativo de calendário",
        "explicação do .ics traduzida no title");
  // este item carrega um <kbd>: só o primeiro nó de texto é traduzido
  check($('button[data-action="resources"]').childNodes[0].textContent.trim() === "Recursos",
        "novo item Resources traduzido");
  check($(".res-head span").textContent.trim() === "recursos",
        "cabeçalho do painel de recursos traduzido");
  check($('label[title] > #f-deadline').parentElement.childNodes[0]
          .textContent.trim() === "Prazo limite", "campo Deadline traduzido");
  check($("#f-pinned").parentElement.getAttribute("title") ===
        "Data contratual: o auto-schedule não a move",
        "explicação da data fixa traduzida no title");
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

console.log("kanban · commit/undo/redo");
{
  const { runIn, close } = loadKanbanApp();
  const seedBoard = `state.board = { columns: [{ id: "c1", name: "backlog", cards: [] }],
                                     archive: [], aliases: {} };`;

  // ida e volta básica: addCard -> undo remove -> redo recoloca
  let r = runIn(`${seedBoard}
    commit({type: "addCard", col: "c1", id: "card1", text: "hello"});
    const afterAdd = state.board.columns[0].cards.map(c => c.text);
    undo();
    const afterUndo = state.board.columns[0].cards.map(c => c.text);
    redo();
    const afterRedo = state.board.columns[0].cards.map(c => c.text);
    return { afterAdd, afterUndo, afterRedo };`);
  check(JSON.stringify(r.afterAdd) === '["hello"]', "addCard: commit aplica local");
  check(JSON.stringify(r.afterUndo) === "[]", "addCard: undo remove");
  check(JSON.stringify(r.afterRedo) === '["hello"]', "addCard: redo reaplica");

  // undo sem conflito: edita duas vezes, desfaz uma, volta ao valor anterior
  r = runIn(`${seedBoard}
    commit({type: "addCard", col: "c1", id: "card1", text: "foo"});
    commit({type: "editCard", id: "card1", text: "bar"});
    undo();
    return { text: state.board.columns[0].cards[0].text };`);
  check(r.text === "foo", "editCard: undo sem conflito volta ao valor anterior");

  // o achado do last-write-wins: undo NÃO pode sobrescrever uma edição
  // que um colega fez depois da sua (ver fieldUnchangedSince em app.js)
  r = runIn(`${seedBoard}
    commit({type: "addCard", col: "c1", id: "card1", text: "foo"});
    commit({type: "editCard", id: "card1", text: "bar"});
    state.board.columns[0].cards[0].text = "colleague-edit";   // broadcast simulado
    const stackLenBefore = undoStack.length;
    undo();
    return { text: state.board.columns[0].cards[0].text,
             stackLenBefore, stackLenAfter: undoStack.length,
             toast: document.querySelector(".toast")?.textContent || null };`);
  check(r.text === "colleague-edit",
        "editCard: undo com conflito preserva a edição do colega");
  check(r.stackLenAfter === r.stackLenBefore - 1,
        "editCard: entrada conflitante é descartada da undo stack (não vai pro redo)");
  check(typeof r.toast === "string" && r.toast.includes("edit card text"),
        "editCard: toast avisa que o undo foi pulado");

  // mesmo guard, sentido redo: undo (sem conflito), colega edita, redo pula
  r = runIn(`${seedBoard}
    commit({type: "addCard", col: "c1", id: "card1", text: "foo"});
    commit({type: "editCard", id: "card1", text: "bar"});
    undo();                                            // volta pra "foo", sem conflito
    state.board.columns[0].cards[0].text = "colleague-edit-2";
    redo();
    return { text: state.board.columns[0].cards[0].text };`);
  check(r.text === "colleague-edit-2", "editCard: redo com conflito preserva o colega");

  // ação estrutural (delCard) não entra no guard: sempre opera por ID
  r = runIn(`${seedBoard}
    commit({type: "addCard", col: "c1", id: "card1", text: "foo"});
    commit({type: "delCard", id: "card1"});
    undo();
    return { texts: state.board.columns[0].cards.map(c => c.text) };`);
  check(JSON.stringify(r.texts) === '["foo"]',
        "delCard: undo estrutural não é bloqueado pelo guard de campo");

  close();
}

console.log("kanban · permissões (client-side, canDo)");
{
  const { runIn, close } = loadKanbanApp();
  const seed = `state.board = { columns: [], archive: [], aliases: {},
                                 permissions: { "192.168.0.9": { addCard: false } } };`;

  let r = runIn(`${seed} state.me = null; return canDo("addCard");`);
  check(r === true, "sem state.me (ainda não conectou): permitido por padrão");

  r = runIn(`${seed} state.me = { ip: "192.168.0.9", host: true };
             return canDo("addCard");`);
  check(r === true, "host nunca é restringido, mesmo com entrada bloqueando");

  r = runIn(`${seed} state.me = { ip: "192.168.0.9", host: false };
             return canDo("addCard");`);
  check(r === false, "IP com a ação explicitamente bloqueada: negado");

  r = runIn(`${seed} state.me = { ip: "192.168.0.9", host: false };
             return canDo("delCard");`);
  check(r === true, "mesmo IP, ação não listada na matriz: permitido (fail-open)");

  r = runIn(`${seed} state.me = { ip: "10.0.0.5", host: false };
             return canDo("addCard");`);
  check(r === true, "outro IP, sem entrada na matriz: permitido");

  close();
}

console.log("gantt · undo/redo (reconciliação por tarefa)");
{
  // Regressão: undo/redo do gantt restaurava o snapshot do PROJETO INTEIRO,
  // sem checar o que mudou por fora (poll, outra aba, REPL) desde a edição
  // local — um Ctrl+Z podia apagar por completo o trabalho concorrente de
  // alguém, não só o campo editado. Ver _reconcile/_touchedTaskIds em app.js.
  const seedOne = `state.current = { id: "p1", name: "Proj", tasks: [
    { id: "t1", name: "Tarefa 1", start: "2026-08-03", duration: 5, dependencies: [] }
  ] };`;

  let { runIn, close } = loadGanttApp();
  await new Promise((r) => setTimeout(r, 50));   // deixa init() assentar antes de fechar
  let r = runIn(`${seedOne}
    pushUndo();
    state.current.tasks[0].name = "editada localmente";
    markDirty();
    // reload por polling: REPL adicionou uma tarefa nesse meio tempo
    state.current = { id: "p1", name: "Proj", tasks: [
      { id: "t1", name: "editada localmente", start: "2026-08-03", duration: 5, dependencies: [] },
      { id: "t2", name: "Tarefa do REPL", start: "2026-08-10", duration: 3, dependencies: [] }
    ] };
    undo();
    return state.current.tasks.map(t => t.name);`);
  check(r.includes("Tarefa do REPL"), "undo: preserva tarefa concorrente do REPL");
  check(r.includes("Tarefa 1"), "undo: reverte a edição local mesmo assim");
  close();

  ({ runIn, close } = loadGanttApp());
  await new Promise((r) => setTimeout(r, 50));   // deixa init() assentar antes de fechar
  r = runIn(`${seedOne}
    pushUndo();
    state.current.tasks[0].name = "editada";
    markDirty();
    undo();
    return state.current.tasks[0].name;`);
  check(r === "Tarefa 1", "undo sem conflito: continua revertendo normalmente");
  close();

  ({ runIn, close } = loadGanttApp());
  await new Promise((r) => setTimeout(r, 50));   // deixa init() assentar antes de fechar
  r = runIn(`state.current = { id: "p1", name: "Proj", tasks: [
      { id: "t1", name: "Tarefa 1", start: "2026-08-03", duration: 5, dependencies: [] },
      { id: "t2", name: "Tarefa 2", start: "2026-08-05", duration: 2, dependencies: [] }
    ] };
    pushUndo();
    state.current.tasks[0].name = "editada";              // só t1
    markDirty();
    state.current.tasks[1].name = "mudou por fora";        // concorrente, t2 nunca tocada
    undo();
    return { t1: state.current.tasks[0].name, t2: state.current.tasks[1].name };`);
  check(r.t1 === "Tarefa 1", "undo: reverte a tarefa tocada pela ação");
  check(r.t2 === "mudou por fora", "undo: não mexe numa tarefa que a ação nunca tocou");
  close();

  ({ runIn, close } = loadGanttApp());
  await new Promise((r) => setTimeout(r, 50));   // deixa init() assentar antes de fechar
  r = runIn(`state.current = { id: "p1", name: "Proj", tasks: [
      { id: "t1", name: "foo", start: "2026-08-03", duration: 5, dependencies: [] }
    ] };
    pushUndo();
    state.current.tasks[0].name = "bar";
    markDirty();
    undo();                                    // sem conflito -> volta pra "foo"
    state.current.tasks[0].name = "colega-editou";   // concorrente, depois do undo
    redo();
    return state.current.tasks[0].name;`);
  check(r === "colega-editou", "redo: mesmo guard, sentido contrário, preserva o colega");
  close();

  ({ runIn, close } = loadGanttApp());
  await new Promise((r) => setTimeout(r, 50));   // deixa init() assentar antes de fechar
  r = runIn(`state.current = { id: "p1", name: "Original", tasks: [] };
    pushUndo();
    state.current.name = "Renomeado localmente";
    markDirty();
    state.current.name = "Renomeado pelo REPL";   // concorrente
    undo();
    return state.current.name;`);
  check(r === "Renomeado pelo REPL", "undo: conflito no nome do projeto também preserva o de fora");
  close();

  ({ runIn, close } = loadGanttApp());
  await new Promise((r) => setTimeout(r, 50));   // deixa init() assentar antes de fechar
  r = runIn(`state.current = { id: "p1", name: "Proj", tasks: [
      { id: "t1", name: "Vai ser apagada", start: "2026-08-03", duration: 5, dependencies: [] }
    ] };
    pushUndo();
    state.current.tasks = [];                    // simula deleteSelectedTask
    markDirty();
    state.current.tasks.push({ id: "t2", name: "Nova do REPL", start: "2026-08-10",
                               duration: 2, dependencies: [] });
    undo();
    return state.current.tasks.map(t => t.name).sort();`);
  check(JSON.stringify(r) === JSON.stringify(["Nova do REPL", "Vai ser apagada"]),
        "undo: restaura a tarefa apagada e preserva a adicionada por fora");
  close();

  ({ runIn, close } = loadGanttApp());
  await new Promise((r) => setTimeout(r, 50));   // deixa init() assentar antes de fechar
  r = runIn(`state.current = { id: "p1", name: "Proj", tasks: [
      { id: "t1", name: "v0", start: "2026-08-03", duration: 5, dependencies: [] }
    ] };
    const seq = [];
    for (const v of ["v1", "v2", "v3"]) { pushUndo(); state.current.tasks[0].name = v; markDirty(); }
    undo(); seq.push(state.current.tasks[0].name);
    undo(); seq.push(state.current.tasks[0].name);
    undo(); seq.push(state.current.tasks[0].name);
    redo(); seq.push(state.current.tasks[0].name);
    redo(); seq.push(state.current.tasks[0].name);
    redo(); seq.push(state.current.tasks[0].name);
    return seq;`);
  check(JSON.stringify(r) === JSON.stringify(["v2", "v1", "v0", "v1", "v2", "v3"]),
        "múltiplos ciclos de undo/redo sem conflito: sem degradar (sem aliasing entre snapshots)");
  close();
}

console.log("gantt · chave de acesso");
{
  // Servidor com Perth.run(key = "…") e navegador com a chave errada (aqui
  // um link antigo, de antes de o host trocá-la): a API responde 403
  // "access key required" e a UI tem que PEDIR a chave, não morrer com um
  // erro na barra de status.
  const calls = [];
  const fetch403 = (url) => {
    calls.push(url);
    if (!/[?&]key=s3cr3t\b/.test(url)) {
      return Promise.resolve({
        ok: false, status: 403,
        json: () => Promise.resolve({ error: "access key required" }),
      });
    }
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(url.startsWith("/api/rev") ? { rev: 7 } : []),
    });
  };
  const { w, runIn, close } = loadGanttApp({
    fetch: fetch403, url: "http://localhost/?key=velha",
  });
  await new Promise((r) => setTimeout(r, 50));   // deixa o init() assentar

  const $ = (s) => w.document.querySelector(s);
  check(calls.some((u) => u.includes("key=velha")),
        "a chave do link vai na primeira chamada");
  check($(".keygate-input") !== null, "403 com a chave errada abre o diálogo");
  check(w.document.getElementById("perth-overlay") !== null, "diálogo é um overlay");

  // a recusa do WS chega logo depois do 403 da API: um diálogo só
  w.__ws.onmessage({ data: JSON.stringify({ type: "denied", reason: "key" }) });
  check(w.document.querySelectorAll(".keygate-input").length === 1,
        "recusa do WS não empilha um segundo diálogo");

  $(".keygate-input").value = "s3cr3t";
  $(".keygate-btn").click();
  await new Promise((r) => setTimeout(r, 50));

  check(w.sessionStorage.getItem("perth-key") === "s3cr3t",
        "a chave digitada fica na sessão (sobrevive a reload sem ?key=)");
  check($(".keygate-input") === null, "diálogo fecha depois da chave certa");
  check(calls.some((u) => u === "/api/rev?key=s3cr3t") &&
        calls.some((u) => u === "/api/projects?key=s3cr3t"),
        "a carga inicial é refeita já com a chave");
  check(/[?&]key=s3cr3t\b/.test(w.__ws.url),
        "o WS reconecta com a chave (PerthPresence.setKey)");
  check(!/key=/.test(w.location.search),
        "o ?key= velho sai da URL (senão voltaria no F5, à frente da sessão)");

  // /background também é rota de dados: a URL da imagem (que já vem com
  // ?v=…) leva a chave em & — senão o fundo some para quem não é o host
  const bg = runIn(`
    applyBackground({ set: true, url: "/background?v=abc", opacity: 0.2 });
    return document.documentElement.style.getPropertyValue("--perth-bg");
  `);
  check(bg.includes("/background?v=abc&key=s3cr3t"),
        "a URL do fundo leva a chave");
  close();
}

console.log("gantt · trocar a chave pelo diálogo de Share");
{
  // Só a máquina do servidor (info.host) vê o controle; aplicar manda
  // POST /api/key e o diálogo se redesenha com os links novos.
  const calls = [];
  const share = (keyed) => ({
    urls: ["http://192.168.0.7:8123" + (keyed ? "?key=k" : "")],
    target: "http://192.168.0.7:8123", qr: null,
    shared: true, can_share: true, keyed, host: true,
  });
  const { runIn, close } = loadGanttApp({
    fetch: (url, opts) => {
      calls.push({ url, body: opts && opts.body, method: opts && opts.method });
      const body = url.startsWith("/api/rev") ? { rev: 1 }
                 : url.startsWith("/api/projects") ? []
                 : share(true);
      return Promise.resolve({ ok: true, status: 200,
                               json: () => Promise.resolve(body) });
    },
  });
  await new Promise((r) => setTimeout(r, 50));

  const draw = (info) => runIn(`
    const body = document.createElement("div");
    body.id = "share-body-test";
    document.body.append(body);
    renderShare(body, ${JSON.stringify(info)});
    return {
      row: !!body.querySelector(".share-key"),
      input: !!body.querySelector(".share-key-input"),
      remove: !!body.querySelector(".share-key .danger"),
      label: body.querySelector(".share-key span")?.textContent || null,
    };
  `);

  let r = draw(share(false));
  check(r.row && r.input, "host sem chave: o diálogo oferece pôr uma");
  check(r.remove === false, "sem chave não há o que remover");
  check(r.label === "No access key", "estado da chave no rótulo");

  r = draw(share(true));
  check(r.remove === true, "com chave, aparece o botão de remover");
  check(r.label === "Access key required", "rótulo acompanha o estado");

  r = draw({ ...share(true), host: false });
  check(r.row === false, "máquina remota não vê o controle da chave");

  calls.length = 0;
  runIn(`
    const body = document.querySelector("#share-body-test");
    renderShare(body, ${JSON.stringify(share(false))});
    body.querySelector(".share-key-input").value = "  nova-chave  ";
    body.querySelector(".share-key .primary").click();
    return 1;
  `);
  await new Promise((r) => setTimeout(r, 50));
  const post = calls.find((c) => c.url.startsWith("/api/key"));
  check(!!post && post.method === "POST", "aplicar manda POST /api/key");
  check(post && JSON.parse(post.body).key === "nova-chave",
        "a chave vai sem os espaços em volta");

  calls.length = 0;
  runIn(`
    const body = document.querySelector("#share-body-test");
    renderShare(body, ${JSON.stringify(share(true))});
    body.querySelector(".share-key .danger").click();
    return 1;
  `);
  await new Promise((r) => setTimeout(r, 50));
  const drop = calls.find((c) => c.url.startsWith("/api/key"));
  check(drop && JSON.parse(drop.body).key === "", "remover manda chave vazia");
  close();
}

console.log("gantt · chat");
{
  const { w, runIn, simulate, close } = loadGanttApp();
  // init() só chama PerthPresence.connect() depois do catch do fetch
  // rejeitado (ver loadGanttApp) — espera essa volta assíncrona terminar
  await new Promise((r) => setTimeout(r, 50));
  check(!!w.__ws, "WS do PerthPresence abriu (init assíncrono completou)");

  simulate({ type: "init", you: { id: 1, ip: "127.0.0.1", name: "127.0.0.1", color: 0, host: true },
             peers: [], chat: [{ at: "2026-01-01 10:00", ip: "10.0.0.2", text: "oi time" }] });
  let r = runIn(`return PerthPresence.chat().length;`);
  check(r === 1, "init popula o histórico via PerthPresence.chat()");

  // painel fechado (estado inicial): mensagem nova só incrementa o badge
  simulate({ type: "chat", entry: { at: "2026-01-01 10:01", ip: "10.0.0.3", text: "primeira" } });
  r = runIn(`return { badgeHidden: el.chatBadge.hidden, badgeText: el.chatBadge.textContent };`);
  check(r.badgeHidden === false, "mensagem nova com painel fechado: badge aparece");
  check(r.badgeText === "1", "badge mostra a contagem certa");

  // abrir zera o badge e renderiza o histórico inteiro
  r = runIn(`
    openChat();
    return { badgeHidden: el.chatBadge.hidden, rows: el.chatLog.querySelectorAll(".chat-msg").length };
  `);
  check(r.badgeHidden === true, "abrir o chat zera o badge de não lidas");
  check(r.rows === 2, "abrir o chat renderiza todo o histórico (init + a nova)");

  // mensagem do próprio IP ganha a classe .mine
  simulate({ type: "chat", entry: { at: "2026-01-01 10:02", ip: "127.0.0.1", text: "minha" } });
  r = runIn(`
    const rows = [...el.chatLog.querySelectorAll(".chat-msg")];
    const last = rows[rows.length - 1];
    return { count: rows.length, mine: last.classList.contains("mine"),
             text: last.querySelector(".chat-text").textContent };
  `);
  check(r.count === 3, "painel aberto: mensagem nova é anexada na hora");
  check(r.mine === true, "mensagem do próprio IP ganha a classe .mine");
  check(r.text === "minha", "texto da mensagem renderizado corretamente");

  // enviar: chama PerthPresence.sendChat com o texto sem espaços, limpa o campo
  r = runIn(`
    let sent = null;
    const orig = PerthPresence.sendChat;
    PerthPresence.sendChat = (t) => { sent = t; };
    el.chatInput.value = "  mensagem de teste  ";
    submitChat();
    const out = { sent, value: el.chatInput.value };
    PerthPresence.sendChat = orig;
    return out;
  `);
  check(r.sent === "mensagem de teste", "submitChat manda o texto aparado");
  check(r.value === "", "submitChat limpa o campo depois de enviar");

  // vazio (ou só espaço) não envia
  r = runIn(`
    let sent = null;
    const orig = PerthPresence.sendChat;
    PerthPresence.sendChat = (t) => { sent = t; };
    el.chatInput.value = "   ";
    submitChat();
    PerthPresence.sendChat = orig;
    return sent;
  `);
  check(r === null, "submitChat não manda mensagem vazia/só espaço");

  // indicador de digitação: só atualiza com o painel aberto
  runIn(`closeChat(); return null;`);
  simulate({ type: "typing", from: 42 });
  r = runIn(`return el.chatTyping.hidden;`);
  check(r === true, "typing com painel fechado: não mostra o indicador");

  runIn(`openChat(); return null;`);
  simulate({ type: "join", peer: { id: 42, ip: "10.0.0.9", name: "10.0.0.9", color: 2 } });
  simulate({ type: "typing", from: 42 });
  r = runIn(`return { hidden: el.chatTyping.hidden, text: el.chatTyping.textContent };`);
  check(r.hidden === false, "typing com painel aberto: mostra o indicador");
  check(r.text.includes("10.0.0.9"), "indicador de digitação mostra quem está digitando");

  close();
}

/* ------------------------------------------------------------------ *
 * Transmitir (share): o diálogo é montado a partir do payload de
 * /api/share e a chave de ligar/desligar só aparece pra quem é host num
 * servidor que pode alternar. Servidor de mentira via window.fetch — o
 * que importa aqui é o DOM que o app monta e o POST que ele dispara.
 * ------------------------------------------------------------------ */

const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

// payload igual ao de _kanban_share_payload/_gantt_share_payload no Julia
const fakeShareServer = (host, canShare) => `
  window.__posts = [];
  window.__share = { urls: ["http://localhost:8150"], target: "http://localhost:8150",
                     qr: null, shared: false, can_share: ${canShare}, keyed: false,
                     host: ${host} };
  window.__keys = [];
  window.fetch = (url, opts) => {
    if (opts && opts.method === "POST" && url.startsWith("/api/key")) {
      const key = JSON.parse(opts.body).key;
      window.__keys.push(key);
      window.__share = Object.assign({}, window.__share, { keyed: key !== "" });
    } else if (opts && opts.method === "POST") {
      const on = JSON.parse(opts.body).on;
      window.__posts.push(on);
      window.__share = Object.assign({}, window.__share, { shared: on,
        urls: on ? ["http://localhost:8150", "http://192.168.0.7:8150"]
                 : ["http://localhost:8150"] });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(window.__share) });
  };`;

console.log("kanban · transmitir (share)");
{
  const { runIn, close } = loadKanbanApp();

  runIn(`${fakeShareServer(true, true)} showShare(); return null;`);
  await tick();
  let r = runIn(`return { toggle: !!document.querySelector(".share-toggle"),
                          btn: document.querySelector(".share-toggle button")?.textContent,
                          urls: document.querySelectorAll(".share-url").length,
                          modal: state.openModal };`);
  check(r.modal === "share", "kanban: diálogo de share abre");
  check(r.toggle === true, "kanban: host vê a chave de transmissão");
  check(r.btn === "Start transmitting", "kanban: desligado, o botão oferece transmitir");
  check(r.urls === 1, "kanban: desligado, só o link de localhost");

  runIn(`document.querySelector(".share-toggle button").click(); return null;`);
  await tick();
  r = runIn(`return { posts: window.__posts,
                      btn: document.querySelector(".share-toggle button")?.textContent,
                      urls: document.querySelectorAll(".share-url").length };`);
  check(JSON.stringify(r.posts) === "[true]", "kanban: clique manda POST {on:true}");
  check(r.btn === "Stop transmitting", "kanban: ligado, o botão oferece desligar");
  check(r.urls === 2, "kanban: ligado, o link da LAN entra na lista");

  runIn(`document.querySelector(".share-toggle button").click(); return null;`);
  await tick();
  r = runIn(`return { posts: window.__posts,
                      btn: document.querySelector(".share-toggle button")?.textContent };`);
  check(JSON.stringify(r.posts) === "[true,false]", "kanban: toggle é simétrico (POST {on:false})");
  check(r.btn === "Start transmitting", "kanban: volta a oferecer transmitir");

  // máquina remota: sem chave de transmissão (o servidor também recusaria)
  runIn(`closeModal(); ${fakeShareServer(false, true)} showShare(); return null;`);
  await tick();
  r = runIn(`return { toggle: !!document.querySelector(".share-toggle"),
                      hint: document.querySelector(".alias-hint")?.textContent };`);
  check(r.toggle === false, "kanban: quem não é host não vê a chave");
  check(/machine running Perth/.test(r.hint), "kanban: e a dica explica quem liga");

  // servidor preso a um `host` fixo: o toggle não existe nem pro host
  runIn(`closeModal(); ${fakeShareServer(true, false)} showShare(); return null;`);
  await tick();
  r = runIn(`return !!document.querySelector(".share-toggle");`);
  check(r === false, "kanban: sem can_share, nem o host vê a chave");

  // ...mas a chave de acesso continua valendo com o alcance preso no
  // socket, então o controle dela sobrevive ao interruptor sumir
  r = runIn(`return { key: !!document.querySelector(".share-key"),
                      remove: !!document.querySelector(".share-key .danger") };`);
  check(r.key === true, "kanban: com host fixo, o host ainda troca a chave");
  check(r.remove === false, "kanban: sem chave configurada, nada a remover");

  runIn(`document.querySelector(".share-key-input").value = "  k2  ";
         document.querySelector(".share-key .primary").click(); return null;`);
  await tick();
  r = runIn(`return { keys: window.__keys,
                      remove: !!document.querySelector(".share-key .danger") };`);
  check(JSON.stringify(r.keys) === '["k2"]', "kanban: aplicar manda a chave sem espaços");
  check(r.remove === true, "kanban: com chave, o diálogo passa a oferecer remover");

  runIn(`document.querySelector(".share-key .danger").click(); return null;`);
  await tick();
  r = runIn(`return window.__keys;`);
  check(JSON.stringify(r) === '["k2",""]', "kanban: remover manda chave vazia");

  runIn(`closeModal(); ${fakeShareServer(false, true)} showShare(); return null;`);
  await tick();
  r = runIn(`return !!document.querySelector(".share-key");`);
  check(r === false, "kanban: máquina remota não vê o controle da chave");

  // botão da menubar: espelha o estado e alterna sem abrir o diálogo
  runIn(`closeModal(); ${fakeShareServer(true, true)} refreshShareBtn(); return null;`);
  await tick();
  r = runIn(`const b = document.getElementById("share-toggle");
             return { hidden: b.hidden, on: b.classList.contains("broadcasting"),
                      pressed: b.getAttribute("aria-pressed") };`);
  check(r.hidden === false, "kanban: host vê o botão de transmitir na menubar");
  check(r.on === false && r.pressed === "false", "kanban: botão apagado com a transmissão desligada");

  runIn(`document.getElementById("share-toggle").click(); return null;`);
  await tick();
  r = runIn(`const b = document.getElementById("share-toggle");
             return { posts: window.__posts, on: b.classList.contains("broadcasting"),
                      pressed: b.getAttribute("aria-pressed"), title: b.title };`);
  check(JSON.stringify(r.posts) === "[true]", "kanban: botão da menubar alterna direto (POST {on:true})");
  check(r.on === true && r.pressed === "true", "kanban: botão acende transmitindo");
  check(/click to stop/.test(r.title), "kanban: e o tooltip passa a oferecer parar");

  runIn(`document.getElementById("share-toggle").click(); return null;`);
  await tick();
  r = runIn(`return { posts: window.__posts,
                      on: document.getElementById("share-toggle").classList.contains("broadcasting") };`);
  check(JSON.stringify(r.posts) === "[true,false]", "kanban: segundo clique desliga");
  check(r.on === false, "kanban: e o botão apaga");

  // quem não pode alternar não vê o botão
  runIn(`${fakeShareServer(false, true)} refreshShareBtn(); return null;`);
  await tick();
  r = runIn(`return document.getElementById("share-toggle").hidden;`);
  check(r === true, "kanban: máquina remota não vê o botão da menubar");

  runIn(`${fakeShareServer(true, false)} refreshShareBtn(); return null;`);
  await tick();
  r = runIn(`return document.getElementById("share-toggle").hidden;`);
  check(r === true, "kanban: sem can_share o botão some da menubar");

  // "denied" com motivo share_off: modal próprio, não o de chave de acesso
  r = runIn(`closeModal();
    handleMessage({ type: "denied", reason: "share_off" });
    return { modal: state.openModal, denied: state.denied };`);
  check(r.modal === "shareoff", "kanban: denied/share_off abre o aviso de transmissão desligada");
  check(r.denied === true, "kanban: e para o retry automático");

  r = runIn(`handleMessage({ type: "denied" });
    return state.openModal;`);
  check(r === "keygate", "kanban: denied sem motivo continua pedindo a chave");

  close();
}

/* Espelho em disco e navegador de pastas são só-host (o servidor recusa com
 * 403 — ver _gantt_host_only). Num convidado a caixa inteira some: deixá-la
 * ali seria oferecer um controle que sempre falha, e ela ainda mostraria um
 * caminho da máquina anfitriã. */
console.log("gantt · a caixa de caminho é só do host");
{
  const { runIn, close } = loadGanttApp();
  await new Promise((r) => setTimeout(r, 50));

  let r = runIn(`renderShareBtn({ host: false, can_share: true, shared: true });
    return document.getElementById("filebox").hidden;`);
  check(r === true, "gantt: convidado não vê a caixa de caminho");

  r = runIn(`renderShareBtn({ host: true, can_share: true, shared: true });
    return document.getElementById("filebox").hidden;`);
  check(r === false, "gantt: a máquina que roda o Perth vê");

  // sem informação nenhuma (ex.: /api/share falhou), some — o padrão seguro
  r = runIn(`renderShareBtn(null); return document.getElementById("filebox").hidden;`);
  check(r === true, "gantt: sem saber quem é, esconde em vez de arriscar");

  close();
}

console.log("gantt · transmitir (share)");
{
  const { runIn, simulate, close } = loadGanttApp();

  runIn(`${fakeShareServer(true, true)} showShare(); return null;`);
  await tick();
  let r = runIn(`return { overlay: !!document.getElementById("perth-overlay"),
                          btn: document.querySelector(".share-toggle button")?.textContent,
                          urls: document.querySelectorAll(".share-url").length };`);
  check(r.overlay === true, "gantt: diálogo de share abre");
  check(r.btn === "Start transmitting", "gantt: desligado, o botão oferece transmitir");
  check(r.urls === 1, "gantt: desligado, só o link de localhost");

  runIn(`document.querySelector(".share-toggle button").click(); return null;`);
  await tick();
  r = runIn(`return { posts: window.__posts,
                      btn: document.querySelector(".share-toggle button")?.textContent,
                      urls: document.querySelectorAll(".share-url").length };`);
  check(JSON.stringify(r.posts) === "[true]", "gantt: clique manda POST {on:true}");
  check(r.btn === "Stop transmitting", "gantt: ligado, o botão oferece desligar");
  check(r.urls === 2, "gantt: ligado, o link da LAN entra na lista");

  // o menu File tem a entrada e ela dispara a mesma função
  r = runIn(`document.getElementById("perth-overlay")?.remove();
    document.querySelector('[data-action="share"]').click();
    return !!document.getElementById("perth-overlay");`);
  check(r === true, "gantt: File → Share / QR… abre o diálogo");

  // o servidor avisa pelo WS quando a transmissão muda: o diálogo aberto
  // se redesenha sozinho (o host pode ter alternado pelo REPL)
  runIn(`window.__share = Object.assign({}, window.__share, { shared: false,
           urls: ["http://localhost:8150"] }); return null;`);
  simulate({ type: "share", shared: false });
  await tick();
  r = runIn(`return { btn: document.querySelector(".share-toggle button")?.textContent,
                      urls: document.querySelectorAll(".share-url").length };`);
  check(r.btn === "Start transmitting", "gantt: msg \"share\" do servidor redesenha o diálogo");
  check(r.urls === 1, "gantt: e os links acompanham o novo estado");

  // botão da menubar: alterna direto e acompanha o diálogo aberto
  runIn(`document.getElementById("perth-overlay")?.remove();
         ${fakeShareServer(true, true)} refreshShareBtn(); return null;`);
  await tick();
  r = runIn(`const b = document.getElementById("share-toggle");
             return { hidden: b.hidden, on: b.classList.contains("broadcasting") };`);
  check(r.hidden === false && r.on === false, "gantt: botão da menubar aparece apagado");

  runIn(`document.getElementById("share-toggle").click(); return null;`);
  await tick();
  r = runIn(`const b = document.getElementById("share-toggle");
             return { posts: window.__posts, on: b.classList.contains("broadcasting"),
                      title: b.title };`);
  check(JSON.stringify(r.posts) === "[true]", "gantt: botão da menubar alterna direto (POST {on:true})");
  check(r.on === true, "gantt: botão acende transmitindo");
  check(/click to stop/.test(r.title), "gantt: e o tooltip passa a oferecer parar");

  runIn(`${fakeShareServer(false, true)} refreshShareBtn(); return null;`);
  await tick();
  r = runIn(`return document.getElementById("share-toggle").hidden;`);
  check(r === true, "gantt: máquina remota não vê o botão da menubar");

  // recusa por transmissão desligada: aviso próprio, com botão de repetir
  simulate({ type: "denied", reason: "share_off" });
  await tick();
  r = runIn(`return document.getElementById("perth-overlay")?.textContent || "";`);
  check(/stopped transmitting/.test(r), "gantt: denied/share_off avisa que o host parou");

  close();
}

/* ------------------------------------------------------------------ *
 * Fundo da UI (Perth.background!): a imagem vem do servidor, e esconder
 * é preferência local do navegador. O que se testa aqui é a camada que
 * o app monta a partir do payload — e que esconder não some com ela do
 * servidor, só de quem escondeu.
 * ------------------------------------------------------------------ */

const bgPayload = `{ set: true, url: "/background?v=abc123", opacity: 0.3, name: "foto.jpg" }`;

console.log("fundo da UI · rotação de imagens (shared/background.js)");
{
  // Roda contra o app do kanban só porque precisa de UMA página montada;
  // o módulo é o mesmo nos dois (o gantt injeta o mesmo arquivo).
  const { w, runIn, close } = loadKanbanApp();

  const rot = (interval) => `{ set: true, opacity: 0.4, interval: ${interval},
    url: "/background?v=a", name: "a.png",
    images: [{ url: "/background?v=a", name: "a.png" },
             { url: "/background?i=1&v=b", name: "b.png" },
             { url: "/background?i=2&v=c", name: "c.jpg" }] }`;

  // índice derivado do relógio: quem calcula é cada navegador, sem tick do
  // servidor — então a conta tem de bater com a do próximo cliente
  let r = runIn(`applyBackground(${rot(60)});
    const per = 60000;
    return { i: PerthBackground.indexNow(),
             esperado: Math.floor(Date.now() / per) % 3,
             n: PerthBackground.images().length,
             img: document.documentElement.style.getPropertyValue("--perth-bg"),
             op: document.documentElement.style.getPropertyValue("--perth-bg-opacity") };`);
  check(r.n === 3, "a rotação chega inteira do servidor");
  check(r.i === r.esperado, "o índice em exibição sai do relógio (mesma conta em toda máquina)");
  check(new RegExp(`background\\?(i=${r.i}&)?v=`).test(r.img),
        "e a camada aponta a imagem desse índice");
  check(r.op === "0.4", "opacidade vem do servidor, como antes");

  // payload antigo (sem `images`) continua valendo: um cliente pode estar
  // aberto de antes da feature
  r = runIn(`applyBackground({ set: true, url: "/background?v=x", opacity: 0.2 });
    return { n: PerthBackground.images().length,
             img: document.documentElement.style.getPropertyValue("--perth-bg") };`);
  check(r.n === 1 && /v=x/.test(r.img), "payload de uma imagem só (formato antigo) segue funcionando");

  // intervalo 0 = sem rotação: fica na primeira, sem timer
  r = runIn(`applyBackground(${rot(0)});
    return PerthBackground.indexNow();`);
  check(r === 0, "interval = 0 trava na primeira imagem");

  // a troca é apagar -> trocar a imagem no vale -> acender. O vale (camada
  // em opacidade 0, só a cor do papel aparecendo) É o escurecimento pedido.
  // O relógio é adiantado na mão: é dele que sai o índice, então empurrar
  // Date.now um período à frente é exatamente o que acontece na virada.
  r = runIn(`applyBackground(${rot(60)});
    const st = document.documentElement.style;
    window.__antes = { i: PerthBackground.indexNow(),
                       img: st.getPropertyValue("--perth-bg") };
    window.__realNow = Date.now;
    Date.now = () => window.__realNow() + 60000;   // um período à frente
    PerthBackground.tick();
    return { antesIdx: window.__antes.i,
             agoraIdx: PerthBackground.indexNow(),
             opNoVale: st.getPropertyValue("--perth-bg-opacity"),
             imgNoVale: st.getPropertyValue("--perth-bg") };`);
  check(r.agoraIdx === (r.antesIdx + 1) % 3, "um período adiante = próxima imagem");
  check(r.opNoVale === "0", "a troca começa apagando a camada (o escurecimento)");
  check(r.imgNoVale === w.__antes.img,
        "e a imagem só troca no vale, não antes — nada de corte seco");

  await new Promise((res) => setTimeout(res, 600));   // passa o fade

  r = runIn(`const st = document.documentElement.style;
    return { img: st.getPropertyValue("--perth-bg"),
             op: st.getPropertyValue("--perth-bg-opacity"),
             mudou: st.getPropertyValue("--perth-bg") !== window.__antes.img };`);
  check(r.mudou === true, "passado o vale, a imagem é a nova");
  check(r.op === "0.4", "e a camada volta à opacidade do servidor");
  check(/i=/.test(r.img) || /v=a/.test(r.img), "apontando uma das URLs da rotação");

  runIn(`Date.now = window.__realNow; return null;`);   // devolve o relógio

  // esconder localmente para a rotação (não adianta girar o que não se vê)
  r = runIn(`applyBackground(${rot(60)});
    document.getElementById("hide-bg-toggle").click();
    return { has: document.documentElement.classList.contains("has-bg"),
             op: document.documentElement.style.getPropertyValue("--perth-bg-opacity"),
             servidor: PerthBackground.images().length };`);
  check(r.has === false && r.op === "0", "esconder apaga a camada");
  check(r.servidor === 3, "e não mexe no que o servidor mandou");

  r = runIn(`document.getElementById("hide-bg-toggle").click();
    return { has: document.documentElement.classList.contains("has-bg"),
             op: document.documentElement.style.getPropertyValue("--perth-bg-opacity") };`);
  check(r.has === true && r.op === "0.4", "desmarcar traz a rotação de volta sem recarregar");

  // sem fundo nenhum: nada de URL velha pendurada na camada
  r = runIn(`applyBackground({ set: false });
    return { img: document.documentElement.style.getPropertyValue("--perth-bg"),
             n: PerthBackground.images().length };`);
  check(/none/.test(r.img) && r.n === 0, "sem fundo, a camada solta a imagem que segurava");

  close();
}

console.log("kanban · fundo da UI");
{
  const { runIn, close } = loadKanbanApp();

  let r = runIn(`applyBackground(${bgPayload});
    const root = document.documentElement;
    return { has: root.classList.contains("has-bg"),
             img: root.style.getPropertyValue("--perth-bg"),
             op: root.style.getPropertyValue("--perth-bg-opacity") };`);
  check(r.has === true, "kanban: fundo ativo marca has-bg no root");
  check(/background\?v=abc123/.test(r.img), "kanban: e aponta a URL versionada do servidor");
  check(r.op === "0.3", "kanban: opacidade vem do servidor");

  r = runIn(`applyBackground({ set: false });
    return { has: document.documentElement.classList.contains("has-bg"),
             op: document.documentElement.style.getPropertyValue("--perth-bg-opacity") };`);
  check(r.has === false && r.op === "0", "kanban: sem imagem no servidor, camada apagada");

  // esconder localmente: a camada some aqui, o setting do servidor não muda
  r = runIn(`applyBackground(${bgPayload});
    document.getElementById("hide-bg-toggle").click();
    return { has: document.documentElement.classList.contains("has-bg"),
             guardado: localStorage.getItem("perth-kanban-hide-background"),
             servidor: bgInfo.set };`);
  check(r.has === false, "kanban: esconder tira a camada deste navegador");
  check(r.guardado === "on", "kanban: e a preferência persiste no localStorage");
  check(r.servidor === true, "kanban: sem mexer no que o servidor manda");

  r = runIn(`document.getElementById("hide-bg-toggle").click();
    return document.documentElement.classList.contains("has-bg");`);
  check(r === true, "kanban: desmarcar traz o fundo de volta sem recarregar");

  // mensagem do WS (REPL trocou a imagem) aplica na hora
  r = runIn(`handleMessage({ type: "background", set: true,
                             url: "/background?v=zzz999", opacity: 0.5 });
    return { img: document.documentElement.style.getPropertyValue("--perth-bg"),
             op: document.documentElement.style.getPropertyValue("--perth-bg-opacity") };`);
  check(/v=zzz999/.test(r.img), "kanban: msg \"background\" do servidor troca a imagem ao vivo");
  check(r.op === "0.5", "kanban: e acompanha a nova opacidade");

  close();
}

console.log("kanban · interruptores do painel de configurações");
{
  // Regressão visual: eram <input type=checkbox> logo depois do texto, então
  // cada um parava numa coluna diferente conforme o comprimento da etiqueta
  // — pior ainda nas que quebram em duas linhas. Agora são o mesmo
  // <button class="toggle" aria-pressed> do gantt, com a etiqueta
  // absorvendo a folga.
  const { runIn, close } = loadKanbanApp();
  const IDS = ["sound-toggle", "hide-cursors-toggle", "hide-bg-toggle",
               "hide-new-toggle"];

  let r = runIn(`return ${JSON.stringify(IDS)}.map((id) => {
      const el = document.getElementById(id);
      return { id, tag: el.tagName, classe: el.className,
               pressed: el.getAttribute("aria-pressed"),
               rotulo: el.getAttribute("aria-label"),
               irmaoEtiqueta: el.previousElementSibling.className };
    });`);
  check(r.every((x) => x.tag === "BUTTON" && x.classe === "toggle"),
        "os quatro são o .toggle do gantt, não checkbox");
  check(r.every((x) => x.pressed === "true" || x.pressed === "false"),
        "cada um declara o estado em aria-pressed");
  check(r.every((x) => x.rotulo && x.irmaoEtiqueta === "sp-label"),
        "cada um tem etiqueta .sp-label ao lado e aria-label para leitor de tela");

  // O alinhamento em si é layout, e o jsdom não faz layout (nem busca CSS
  // externo, então document.styleSheets vem vazio). O que dá para travar é
  // a regra que o produz, lida do fonte — e o lugar dela: .toggle e
  // .sp-label têm de estar no CSS COMPARTILHADO, senão o kanban herdaria
  // um componente definido só na folha do gantt.
  const uiCss = read("frontend/shared/ui.css");
  const kanbanCss = read("frontend/kanban/style.css");
  check(/\.sp-label\s*\{[^}]*flex:\s*1/.test(uiCss),
        "a etiqueta absorve a folga (.sp-label { flex: 1 }) no CSS compartilhado");
  check(/\.toggle\s*\{/.test(uiCss) && /\.toggle\[aria-pressed="true"\]/.test(uiCss),
        "o componente .toggle vive no shared/ui.css, servido aos dois apps");
  check(!/^\.toggle\s*\{/m.test(read("frontend/style.css")),
        "e não ficou duplicado na folha só do gantt");
  check(/\.settings-check\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center/s.test(kanbanCss),
        "a linha é flex centrada, então o interruptor encosta na direita");

  // clicar alterna, persiste e aplica — sem depender de evento "change"
  r = runIn(`localStorage.removeItem("perth-kanban-hide-new");
    const el = document.getElementById("hide-new-toggle");
    const antes = el.getAttribute("aria-pressed");
    el.click();
    const depois = el.getAttribute("aria-pressed");
    const classe = document.documentElement.classList.contains("hide-new-badges");
    el.click();
    return { antes, depois, classe,
             guardado: localStorage.getItem("perth-kanban-hide-new"),
             voltou: el.getAttribute("aria-pressed") };`);
  check(r.antes === "false" && r.depois === "true" && r.voltou === "false",
        "clicar alterna o aria-pressed nos dois sentidos");
  check(r.classe === true && r.guardado === "off",
        "e cada clique aplica o efeito e persiste a preferência");

  close();
}

console.log("kanban · a rolagem sobrevive ao re-render");
{
  // Regressão de uso real: render() reconstrói o board inteiro
  // (boardEl.textContent = ""), e elemento novo nasce com scrollTop 0.
  // Concluir um card no fim de uma coluna longa devolvia a coluna ao topo
  // e tirava da vista justamente o card em que se tinha acabado de mexer.
  const { w, runIn, close } = loadKanbanApp();

  // jsdom não faz layout, então scrollHeight é sempre 0 e a rolagem não
  // "pega" sozinha: os contêineres ganham uma altura falsa para que
  // atribuir scrollTop valha alguma coisa
  const seed = `
    state.board = { columns: [{ id: "c1", name: "backlog", cards:
      Array.from({ length: 30 }, (_, i) => ({ id: "k" + i, text: "Card " + i })) },
      { id: "c2", name: "doing", cards: [{ id: "z", text: "outro" }] }],
      archive: [], aliases: {} };
    render();
    for (const box of document.querySelectorAll(".cards")) {
      Object.defineProperty(box, "scrollHeight", { value: 4000, configurable: true });
      Object.defineProperty(box, "clientHeight", { value: 400, configurable: true });
    }`;

  let r = runIn(`${seed}
    const box = document.querySelector('.col[data-col="c1"] .cards');
    box.scrollTop = 900;
    const antes = box.scrollTop;
    // a ação que o usuário faz: concluir um card lá embaixo
    commit({ type: "setDone", id: "k27", done: true });
    const depois = document.querySelector('.col[data-col="c1"] .cards').scrollTop;
    return { antes, depois };`);
  check(r.antes === 900, "cenário: coluna rolada para baixo");
  check(r.depois === 900, "concluir um card não devolve a coluna ao topo");

  // cada coluna guarda a sua, e a rolagem horizontal do board também
  r = runIn(`${seed}
    document.querySelector('.col[data-col="c1"] .cards').scrollTop = 700;
    document.querySelector('.col[data-col="c2"] .cards').scrollTop = 120;
    Object.defineProperty(boardEl, "scrollWidth", { value: 3000, configurable: true });
    Object.defineProperty(boardEl, "clientWidth", { value: 800, configurable: true });
    boardEl.scrollLeft = 260;
    commit({ type: "editCard", id: "k3", text: "editado" });
    return { c1: document.querySelector('.col[data-col="c1"] .cards').scrollTop,
             c2: document.querySelector('.col[data-col="c2"] .cards').scrollTop,
             board: boardEl.scrollLeft };`);
  check(r.c1 === 700 && r.c2 === 120, "cada coluna guarda a própria rolagem");
  check(r.board === 260, "e a rolagem horizontal do board também sobrevive");

  // a rolagem é por COLUNA: apagar uma muito rolada não empurra o valor
  // dela para a que sobrou (seria o bug se a chave fosse a posição)
  r = runIn(`${seed}
    document.querySelector('.col[data-col="c1"] .cards').scrollTop = 800;
    document.querySelector('.col[data-col="c2"] .cards').scrollTop = 40;
    commit({ type: "delCol", id: "c1" });
    return { colunas: document.querySelectorAll(".col").length,
             ids: [...document.querySelectorAll(".col")].map((e) => e.dataset.col),
             c2: document.querySelector('.col[data-col="c2"] .cards').scrollTop };`);
  check(r.colunas === 1 && r.ids[0] === "c2" && r.c2 === 40,
        "a rolagem é por coluna: apagar a de cima não move a que sobrou");

  close();
}

console.log("kanban · carimbo de momento é hora LOCAL");
{
  // Regressão de uso real: o navegador carimbava `at` e `done_at` com
  // toISOString (UTC) num campo que o servidor preenche em hora local
  // (_kanban_now). O mesmo campo passava a ter dois significados conforme
  // o card nascesse no navegador ou no REPL — e num fuso negativo o
  // carimbo do navegador caía no DIA SEGUINTE depois do fim da tarde,
  // que é como isto apareceu: card criado às 21h ficava com data de
  // amanhã e a etiqueta "new" não aparecia.
  const { runIn, close } = loadKanbanApp();
  const seed = `state.board = { columns: [{ id: "c1", name: "backlog", cards: [] }],
                                archive: [], aliases: {} };`;

  let r = runIn(`${seed}
    const local = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const esperado = local.getFullYear() + "-" + pad(local.getMonth() + 1) + "-" +
                     pad(local.getDate()) + " " + pad(local.getHours()) + ":" +
                     pad(local.getMinutes());
    return { carimbo: localStamp(), esperado, utc: new Date().toISOString().slice(0, 16).replace("T", " ") };`);
  check(r.carimbo === r.esperado,
        "localStamp() é a hora local da máquina, no formato do servidor");
  check(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.carimbo),
        "e no formato exato de _kanban_now (yyyy-mm-dd HH:MM)");

  // a data do carimbo tem de ser a MESMA que localISO() usa para decidir
  // o que é "hoje" — é a divergência entre as duas que sumia com a etiqueta
  r = runIn(`return { doCarimbo: localStamp().slice(0, 10), deHoje: localISO() };`);
  check(r.doCarimbo === r.deHoje,
        "a data do carimbo e o 'hoje' da UI são sempre o mesmo dia");

  // ponta a ponta: card criado agora nasce com etiqueta
  r = runIn(`${seed}
    state.editing = { colId: "c1", isNew: true, draft: "recém-criado",
                      due: "", assignee: "", checks: [] };
    commitEditor();
    const c = state.board.columns[0].cards[0];
    render();
    return { at: c.at, novo: !!document.querySelector('.card .card-new') };`);
  check(r.at.slice(0, 10) === new Date().toLocaleDateString("sv"),
        "card criado pela UI nasce com a data local de hoje");
  check(r.novo === true, "e a etiqueta aparece — era isto que falhava à noite");

  // done_at idem: é ele que o auto-arquivamento por idade compara com o
  // relógio local do servidor
  r = runIn(`${seed}
    commit({ type: "addCard", col: "c1", id: "x", text: "t" });
    commit({ type: "setDone", id: "x", done: true });
    return state.board.columns[0].cards[0].done_at;`);
  check(r.slice(0, 10) === new Date().toLocaleDateString("sv"),
        "done_at também é local (o auto-arquivamento compara com o relógio do servidor)");

  close();
}

console.log("kanban · etiqueta de card novo");
{
  const { runIn, close } = loadKanbanApp();
  // `at` é carimbado pelo servidor na criação (_kanban_now, "yyyy-mm-dd HH:MM");
  // localISO() é a data local do navegador, a mesma que os prazos usam
  const seed = `state.board = { columns: [{ id: "c1", name: "backlog", cards: [
      { id: "hoje",     text: "criado hoje",   by: "repl", at: localISO() + " 09:00" },
      { id: "ontem",    text: "de ontem",      by: "repl", at: "2020-01-01 09:00" },
      { id: "feito",    text: "feito hoje",    by: "repl", at: localISO() + " 09:00", done: true },
      { id: "semdata",  text: "board antigo",  by: "repl" },
      { id: "sozinho",  text: "só o carimbo",  at: localISO() + " 10:00" }
    ] }], archive: [], aliases: {} };`;
  const has = (id) => `!!document.querySelector('.card[data-card="${id}"] .card-new')`;

  let r = runIn(`${seed} render();
    return { hoje: ${has("hoje")}, ontem: ${has("ontem")},
             feito: ${has("feito")}, semdata: ${has("semdata")},
             sozinho: ${has("sozinho")},
             texto: document.querySelector('.card[data-card="hoje"] .card-new').textContent,
             titulo: document.querySelector('.card[data-card="hoje"] .card-new').title };`);
  check(r.hoje === true, "card criado hoje ganha a etiqueta");
  check(r.ontem === false, "card de outro dia não ganha");
  check(r.feito === false, "concluído hoje não ganha — a etiqueta some ao concluir");
  check(r.semdata === false, "card sem carimbo `at` (board antigo) fica sem etiqueta");
  check(r.sozinho === true, "carimbo sozinho já monta o rodapé para a etiqueta");
  check(r.texto === "new" && /today/.test(r.titulo), "a etiqueta é uma palavra, com o motivo no title");

  // não é botão: clicar não pode selecionar/filtrar nem virar ação
  r = runIn(`${seed} render();
    const el = document.querySelector('.card[data-card="hoje"] .card-new');
    return { tag: el.tagName, filtro: state.filter };`);
  check(r.tag === "SPAN" && !r.filtro, "a etiqueta é texto, não um controle");

  // esconder é preferência local: classe no <html>, sem re-render e sem
  // tocar no board (o carimbo `at` continua lá para as outras máquinas)
  r = runIn(`${seed} render();
    document.getElementById("hide-new-toggle").click();
    return { classe: document.documentElement.classList.contains("hide-new-badges"),
             guardado: localStorage.getItem("perth-kanban-hide-new"),
             nodom: ${has("hoje")},
             carimbo: state.board.columns[0].cards[0].at };`);
  check(r.classe === true, "esconder marca a classe no <html>");
  check(r.guardado === "on", "e a preferência persiste no localStorage");
  check(r.nodom === true && !!r.carimbo,
        "o CSS é que esconde: o nó e o carimbo do board continuam intactos");

  r = runIn(`document.getElementById("hide-new-toggle").click();
    return document.documentElement.classList.contains("hide-new-badges");`);
  check(r === false, "desmarcar traz a etiqueta de volta sem recarregar");

  close();
}

console.log("gantt · fundo da UI");
{
  const { runIn, simulate, close } = loadGanttApp();
  // init() só conecta o PerthPresence depois do catch do fetch rejeitado
  // (ver loadGanttApp): sem esta volta, simulate() não tem socket
  await new Promise((r) => setTimeout(r, 50));

  let r = runIn(`applyBackground(${bgPayload});
    const root = document.documentElement;
    return { has: root.classList.contains("has-bg"),
             img: root.style.getPropertyValue("--perth-bg"),
             op: root.style.getPropertyValue("--perth-bg-opacity") };`);
  check(r.has === true, "gantt: fundo ativo marca has-bg no root");
  check(/background\?v=abc123/.test(r.img), "gantt: e aponta a URL versionada do servidor");
  check(r.op === "0.3", "gantt: opacidade vem do servidor");

  // o toggle do painel de configurações usa o mesmo `ui` persistido do resto
  r = runIn(`document.getElementById("set-hide-bg").click();
    return { has: document.documentElement.classList.contains("has-bg"),
             pressed: document.getElementById("set-hide-bg").getAttribute("aria-pressed"),
             guardado: JSON.parse(localStorage.getItem("perth-ui")).hideBackground };`);
  check(r.has === false, "gantt: esconder tira a camada deste navegador");
  check(r.pressed === "true", "gantt: o toggle reflete o estado");
  check(r.guardado === true, "gantt: e a preferência entra no perth-ui");

  r = runIn(`document.getElementById("set-hide-bg").click();
    return document.documentElement.classList.contains("has-bg");`);
  check(r === true, "gantt: desmarcar traz o fundo de volta sem recarregar");

  simulate({ type: "background", set: true, url: "/background?v=zzz999", opacity: 0.5 });
  await tick();
  r = runIn(`return { img: document.documentElement.style.getPropertyValue("--perth-bg"),
                      op: document.documentElement.style.getPropertyValue("--perth-bg-opacity") };`);
  check(/v=zzz999/.test(r.img), "gantt: msg \"background\" do servidor troca a imagem ao vivo");
  check(r.op === "0.5", "gantt: e acompanha a nova opacidade");

  close();
}

console.log("gantt · prazo e data fixa");
{
  const { runIn, close } = loadGanttApp();
  // deixa o init() assíncrono assentar antes de qualquer close(): fechar a
  // janela com ele ainda pendente deixa um init órfão que acorda contra um
  // document já destruído e derruba o processo inteiro — com o stack
  // apontando para o bloco SEGUINTE, que é onde ele por acaso acordou
  await new Promise((r) => setTimeout(r, 50));

  const seed = `
    const mk = (id, name, start, duration, extra) => Object.assign({
      id, name, start, duration, assignee: "", progress: 0, dependencies: [],
      color: "", notes: "", milestone: false, parent: "", cost: 0,
      baseline_start: null, baseline_duration: 0, deadline: null, pinned: false },
      extra || {});
    state.current = { id: "p1", name: "P", tasks: [
      mk("t1", "No prazo", "2026-03-02", 4, { deadline: "2026-03-06" }),
      mk("t2", "Estourada", "2026-03-02", 6, { deadline: "2026-03-04" }),
      mk("t3", "Fixa", "2026-03-02", 3, { pinned: true }),
      mk("t4", "Solta", "2026-03-02", 3) ] };
    state.cpm = { cycle: false, finish: "2026-03-07", calendar: "",
      byId: new Map([["t3", { id: "t3", early_start: "2026-03-09",
                              early_finish: "2026-03-11", slack_days: 0,
                              critical: true }]]) };
    renderAll();`;

  // Marcadores são consultados por data-id, não por posição: sortTasks()
  // reordena as linhas e o índice do vetor não é a tarefa que se pensa
  let r = runIn(`${seed}
    const flag = (id) => document.querySelector('#chart .deadline-mark.flag[data-id="' + id + '"]');
    return {
      flags: document.querySelectorAll("#chart .deadline-mark.flag").length,
      lines: document.querySelectorAll("#chart .deadline-mark:not(.flag)").length,
      late: ["t1", "t2"].map((id) => flag(id).getAttribute("class").includes("late")),
      tip: flag("t2").querySelector("title").textContent,
      // a bandeira fica no FIM do dia do prazo: t1 vence 06/03, então x cai
      // no começo de 07/03
      flagX: Math.round(Number(flag("t1").getAttribute("points").split(",")[0])),
      dayX: Math.round(xOf(parseDate("2026-03-07"))),
      status: document.getElementById("status-left").textContent };`);

  check(r.flags === 2 && r.lines === 2, "gantt: uma bandeira por tarefa com prazo");
  check(r.late.join(",") === "false,true",
        "gantt: só a que estoura o prazo fica vermelha");
  check(r.flagX === r.dayX, "gantt: a bandeira marca o FIM do dia do prazo");
  // t2: começa 02/03 e dura 6 dias -> termina 07/03, três dias além de 04/03
  check(/2026-03-04/.test(r.tip) && /\+3d/.test(r.tip),
        "gantt: o tooltip diz o prazo e o tamanho do estouro");
  check(/1 past deadline/.test(r.status), "gantt: a barra de status conta os estouros");

  r = runIn(`
    const pins = [...document.querySelectorAll("#chart .pin-mark")];
    return { n: pins.length, id: pins[0].dataset.id,
             stuck: pins[0].getAttribute("class").includes("stuck"),
             tip: pins[0].querySelector("title").textContent };`);
  check(r.n === 1 && r.id === "t3", "gantt: alfinete só na tarefa de data fixa");
  check(r.stuck === true && /2026-03-09/.test(r.tip),
        "gantt: alfinete âmbar quando o motor quer empurrar a data (early_start > start)");

  // destaques novos, no mesmo mecanismo do seletor da toolbar
  r = runIn(`state.highlight = { kind: "status", value: "past-deadline" };
    renderTable();
    return [...document.querySelectorAll(".tt-row")]
             .map((x) => x.dataset.id + ":" + !x.className.includes("dim")).sort();`);
  check(r.join(",") === "t1:false,t2:true,t3:false,t4:false",
        "gantt: destaque 'past deadline' acende só a estourada");

  r = runIn(`state.highlight = { kind: "status", value: "pinned" };
    renderTable();
    const opts = [...document.getElementById("highlight-select").options].map((o) => o.value);
    return { on: [...document.querySelectorAll(".tt-row")]
                   .filter((x) => !x.className.includes("dim"))
                   .map((x) => x.dataset.id),
             hasOpts: opts.includes("status:past-deadline") && opts.includes("status:pinned") };`);
  check(r.on.join(",") === "t3", "gantt: destaque 'pinned' acende só a de data fixa");
  check(r.hasOpts === true, "gantt: os dois destaques entram no seletor");

  // modal: campos novos são lidos e gravados, e resumo os desabilita
  r = runIn(`openModal("t2");
    const before = { deadline: document.getElementById("f-deadline").value,
                     pinned: document.getElementById("f-pinned").checked };
    document.getElementById("f-deadline").value = "2026-03-20";
    document.getElementById("f-pinned").checked = true;
    submitModal();
    const t = state.current.tasks.find((x) => x.id === "t2");
    return { before, after: { deadline: t.deadline, pinned: t.pinned } };`);
  check(r.before.deadline === "2026-03-04" && r.before.pinned === false,
        "gantt: o modal mostra o prazo da tarefa");
  check(r.after.deadline === "2026-03-20" && r.after.pinned === true,
        "gantt: e grava os dois campos");

  r = runIn(`openModal("t2");
    document.getElementById("f-deadline").value = "";
    submitModal();
    return state.current.tasks.find((x) => x.id === "t2").deadline;`);
  check(r === null, "gantt: limpar o campo remove o compromisso (null, não \"\")");

  r = runIn(`state.current.tasks.push(Object.assign({}, state.current.tasks[3],
      { id: "t5", name: "Filha", parent: "t4" }));
    renderAll();
    openModal("t4");
    return { deadline: document.getElementById("f-deadline").disabled,
             pinned: document.getElementById("f-pinned").disabled };`);
  check(r.deadline === true && r.pinned === true,
        "gantt: resumo desabilita prazo e data fixa (datas derivam dos filhos)");

  close();
}

console.log("gantt · painel de configurações padronizado");
{
  // O painel do kanban tinha ícone em cada linha e o do gantt não. Agora os
  // dois usam o mesmo token (.sp-icon, shared/ui.css) e o mesmo desenho
  // onde a opção é a mesma.
  const w = loadPage("frontend/index.html");
  const $$g = (sel) => [...w.document.querySelectorAll(sel)];
  const linhas = $$g(".sp-row");
  check(linhas.length === 8, "o painel do gantt tem as 8 linhas de sempre");
  check(linhas.every((r) => r.querySelector(".sp-icon")),
        "e agora todas têm ícone, como as do kanban");
  check(linhas.every((r) => r.querySelector(".sp-label")),
        "cada linha tem a etiqueta .sp-label, que absorve a folga");

  // ícone idêntico onde a opção é idêntica: é o que faz os dois apps
  // parecerem o mesmo programa
  const kb = loadPage("frontend/kanban/index.html");
  const dOf = (doc, id) => {
    const ctl = doc.querySelector("#" + id);
    const svg = ctl.closest(".sp-row, .settings-check").querySelector(".sp-icon");
    return [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d")).join("|");
  };
  check(dOf(w.document, "set-hide-cursors") === dOf(kb.document, "hide-cursors-toggle"),
        "ocultar cursores: mesmo ícone nos dois apps");
  check(dOf(w.document, "set-hide-bg") === dOf(kb.document, "hide-bg-toggle"),
        "esconder o fundo: mesmo ícone nos dois apps");

  // o token do ícone é compartilhado, não copiado em cada folha
  check(/\.sp-icon\s*\{/.test(read("frontend/shared/ui.css")),
        ".sp-icon vive no shared/ui.css");
  check(!/snd-icon/.test(read("frontend/kanban/style.css") +
                        read("frontend/kanban/index.html")),
        "e o antigo .snd-icon (\"sound icon\") não sobrou em lugar nenhum");

  // o botão que ABRE o painel também é o mesmo nos dois: o do kanban era um
  // boneco, que descrevia só o campo de nome — hoje uma linha entre cinco
  const botao = (doc) => {
    const b = doc.querySelector(".settings-menu .menu-title");
    return { title: b.getAttribute("title"),
             d: [...b.querySelectorAll("path")].map((x) => x.getAttribute("d")).join("|") };
  };
  const bg = botao(w.document), bk = botao(kb.document);
  check(bg.d === bk.d && bg.d.length > 0,
        "o botão do painel tem o mesmo ícone nos dois apps");
  check(bg.title === "Interface settings" && bk.title === bg.title,
        "e o mesmo rótulo, que o dicionário já traduz");

  // rótulo de conexão: gerado em JS, tem de passar pelo i18n nos DOIS
  check(/PerthI18n\.t\(txt\)/.test(read("frontend/shared/presence.js")),
        "gantt: o rótulo de conexão passa pelo i18n (presence.js)");
  check(/PerthI18n\.t\(txt\)/.test(read("frontend/kanban/app.js")),
        "kanban: idem — mostrava \"live\" onde o gantt mostrava \"ao vivo\"");
  for (const chave of ["live", "reconnecting…"]) {
    kb.PerthI18n.set("pt");
    check(kb.PerthI18n.t(chave) !== chave,
          `e o dicionário pt traduz "${chave}"`);
  }
}

console.log("gantt · redesenho na virada do dia");
{
  // A linha de hoje, o destaque "past deadline" e o deadlineSlip saem todos
  // de render*(), que roda quando a REVISÃO muda — não quando o relógio
  // anda. Sem este timer, um gantt aberto na parede durante a noite segue
  // desenhando a linha de ontem até alguém editar alguma coisa.
  const { runIn, close } = loadGanttApp();
  await new Promise((r) => setTimeout(r, 50));

  // agenda para logo depois da PRÓXIMA meia-noite local, não daqui a 24h
  let r = runIn(`
    const real = window.setTimeout;
    window.__ms = null;
    window.setTimeout = (fn, ms) => { window.__ms = ms; window.__fn = fn; return 0; };
    renderAtMidnight();
    window.setTimeout = real;
    const now = new Date();
    const meiaNoite = new Date(now.getFullYear(), now.getMonth(),
                               now.getDate() + 1, 0, 0, 0) - now;
    return { ms: window.__ms, meiaNoite };`);
  check(r.ms > r.meiaNoite && r.ms <= r.meiaNoite + 10000,
        "gantt: agenda para logo depois da próxima meia-noite");
  check(r.ms <= 24 * 3600 * 1000,
        "gantt: e nunca além de um dia (setTimeout longo demais estoura o int32)");

  // ao disparar, redesenha E se reagenda — senão valeria uma noite só
  r = runIn(`
    let desenhou = 0, reagendou = 0;
    const realRender = renderAll, real = window.setTimeout;
    renderAll = () => { desenhou++; };
    window.setTimeout = () => { reagendou++; return 0; };
    window.__fn();                       // simula a virada do dia
    window.setTimeout = real;
    renderAll = realRender;
    return { desenhou, reagendou };`);
  check(r.desenhou === 1, "gantt: a virada redesenha");
  check(r.reagendou === 1, "gantt: e se reagenda para a noite seguinte");

  close();
}

console.log("gantt · estimativa de três pontos (PERT)");
{
  const { runIn, close } = loadGanttApp();
  await new Promise((r) => setTimeout(r, 50));   // deixa o init() assentar

  const seed = `
    const mk = (id, name, start, duration, extra) => Object.assign({
      id, name, start, duration, assignee: "", progress: 0, dependencies: [],
      color: "", notes: "", milestone: false, parent: "", cost: 0,
      baseline_start: null, baseline_duration: 0, deadline: null, pinned: false,
      optimistic: 0, most_likely: 0, pessimistic: 0 }, extra || {});
    state.current = { id: "p1", name: "P", tasks: [
      mk("t1", "Estimada", "2026-03-02", 5,
         { optimistic: 4, most_likely: 6, pessimistic: 14 }),
      mk("t2", "Sem estimativa", "2026-03-02", 3),
      mk("t3", "Marco", "2026-03-10", 1, { milestone: true }) ] };
    state.cpm = { cycle: false, finish: "2026-03-07", calendar: "", pert: null,
                  byId: new Map() };
    renderAll();`;

  const fields = (o, m, p) => `
    document.getElementById("f-optimistic").value = "${o}";
    document.getElementById("f-most-likely").value = "${m}";
    document.getElementById("f-pessimistic").value = "${p}";
    document.getElementById("f-optimistic").dispatchEvent(new Event("input"));`;

  // o modal lê os três números e mostra te = (4 + 4*6 + 14)/6 = 7 e σ = 10/6
  let r = runIn(`${seed} openModal("t1");
    return { o: document.getElementById("f-optimistic").value,
             m: document.getElementById("f-most-likely").value,
             p: document.getElementById("f-pessimistic").value,
             out: document.getElementById("f-pert-out").textContent,
             btn: document.getElementById("f-pert-apply").hidden };`);
  check(r.o === "4" && r.m === "6" && r.p === "14", "gantt: o modal mostra a estimativa");
  check(/7/.test(r.out) && /1\.7/.test(r.out),
        "gantt: e a prévia calcula a duração esperada e o σ");
  check(r.btn === false, "gantt: com te (7) diferente da duração (5), oferece aplicar");

  // aplicar escreve na duração e some — o botão só existe enquanto há diferença
  r = runIn(`document.getElementById("f-pert-apply").click();
    return { dur: document.getElementById("f-duration").value,
             btn: document.getElementById("f-pert-apply").hidden };`);
  check(r.dur === "7" && r.btn === true,
        "gantt: aplicar escreve te na duração e o botão se recolhe");

  // a prévia repete a coerção do servidor: o otimista é o piso
  r = runIn(`${fields(8, 5, 6)}
    return document.getElementById("f-pert-out").textContent;`);
  check(/8/.test(r) && /σ 0/.test(r),
        "gantt: prévia coerente com _normalize_estimate! (8,5,6 -> 8,8,8)");

  // estimativa parcial: o que falta vem da duração em vigor (7, após aplicar)
  r = runIn(`${fields("", "", 20)}
    return { dur: document.getElementById("f-duration").value,
             out: document.getElementById("f-pert-out").textContent };`);
  check(r.dur === "7" && /9\.2/.test(r.out),
        "gantt: parcial completa pela duração ((7 + 4*7 + 20)/6 = 9.2)");

  r = runIn(`${fields("", "", "")}
    return { out: document.getElementById("f-pert-out").textContent,
             none: document.getElementById("f-pert-out").className,
             btn: document.getElementById("f-pert-apply").hidden };`);
  check(/no estimate/.test(r.out) && /none/.test(r.none) && r.btn === true,
        "gantt: sem os três números não há prévia nem botão");

  // grava como digitado: normalizar é do servidor, não do navegador
  r = runIn(`${fields(2, 9, 3)} submitModal();
    const t = state.current.tasks.find((x) => x.id === "t1");
    return [t.optimistic, t.most_likely, t.pessimistic];`);
  check(r.join(",") === "2,9,3", "gantt: o modal grava os três campos crus");

  r = runIn(`openModal("t2");
    ${fields(1, 2, 3)} submitModal();
    const t = state.current.tasks.find((x) => x.id === "t2");
    return [t.optimistic, t.most_likely, t.pessimistic, t.duration];`);
  check(r.join(",") === "1,2,3,3",
        "gantt: estimar não muda a duração sozinho (quem aplica é pert!)");

  // marco ocupa o próprio dia: não faz sentido oferecer te como duração
  r = runIn(`openModal("t3"); ${fields(3, 5, 9)}
    return document.getElementById("f-pert-apply").hidden;`);
  check(r === true, "gantt: marco não recebe duração do PERT");

  // regressão: com um campo em branco, te vinha da duração — aplicar mudava a
  // duração, que mudava o te, e cada clique empurrava o número mais um pouco.
  // Aplicar materializa os três números antes de escrever, então o segundo
  // clique não tem o que mudar.
  r = runIn(`openModal("t2"); ${fields(2, "", 10)}
    document.getElementById("f-pert-apply").click();
    const um = document.getElementById("f-duration").value;
    document.getElementById("f-pert-apply").click();
    return { um, dois: document.getElementById("f-duration").value,
             m: document.getElementById("f-most-likely").value,
             btn: document.getElementById("f-pert-apply").hidden };`);
  check(r.um === "4", "gantt: parcial (2, -, 10) sobre duração 3 aplica te = 4");
  check(r.dois === "4", "gantt: clicar de novo não soma nada na duração");
  check(r.m === "3" && r.btn === true,
        "gantt: aplicar fixa o branco na duração de então e recolhe o botão");

  // resumo (tem filha): a estimativa é de quem faz o trabalho
  r = runIn(`state.current.tasks.push(Object.assign({}, state.current.tasks[1],
      { id: "t4", name: "Filha", parent: "t2" }));
    renderAll();
    openModal("t2");
    return ["f-optimistic", "f-most-likely", "f-pessimistic"]
             .map((id) => document.getElementById(id).disabled);`);
  check(r.join(",") === "true,true,true",
        "gantt: resumo desabilita a estimativa (datas derivam dos filhos)");

  // barra de status: só o P80, o resto no title
  r = runIn(`closeModal(false);
    state.cpm.pert = { expected: "2026-03-11", sd_days: 2.13, estimated: 2,
                       p80: "2026-03-13" };
    renderStatus();
    const el = document.getElementById("status-left");
    return { text: el.textContent, title: el.title };`);
  check(/P80 2026-03-13/.test(r.text), "gantt: a barra de status mostra o P80");
  check(!/2\.13/.test(r.text) && /2026-03-11/.test(r.title) && /2\.1/.test(r.title),
        "gantt: esperado e σ ficam no tooltip, fora da barra");

  r = runIn(`state.cpm.pert = null; renderStatus();
    const el = document.getElementById("status-left");
    return { text: el.textContent, title: el.getAttribute("title") };`);
  check(!/P80/.test(r.text) && r.title === null,
        "gantt: sem estimativa no projeto, a barra não mostra nada disso");

  close();
}

/* Texto criado em JS nasce DEPOIS da varredura do PerthI18n — que passa uma
 * vez, no set() — então um literal solto num textContent fica em inglês para
 * sempre, dentro de uma tela traduzida no resto. O defeito já apareceu quatro
 * vezes (rótulo `live` do kanban, título do modal, `(top level)`, e mais seis
 * de uma varredura), sempre igual. Este bloco não conserta uma ocorrência:
 * fecha a torneira. Qualquer literal novo atribuído a textContent/innerHTML
 * tem que passar por T() ou existir no dicionário.
 *
 * O critério é "existe tradução em pt": PerthI18n.t(k) devolve a própria
 * chave quando não conhece a string, então t(s) === s é exatamente o que o
 * usuário veria em inglês. Strings que são iguais nos dois idiomas (nomes
 * próprios, símbolos) vão na lista de isentas, com o motivo. */
/* O T do kanban era declarado oito vezes, uma por função. Virou um só, do
 * módulo — o que só é seguro se todas as funções ainda o enxergarem. Um
 * escopo errado aqui não dá erro de sintaxe: dá ReferenceError na hora de
 * desenhar um card, com a tela em branco. Este bloco desenha de verdade. */
console.log("kanban · rótulos criados em JS falam o idioma da tela");
{
  const { runIn, close } = loadKanbanApp();

  const seed = `state.board = { columns: [{ id: "c1", name: "backlog", cards: [
      { id: "k1", text: "com dono", by: "repl", at: "2020-01-01 09:00", done: true }
    ] }], archive: [{ id: "k9", text: "arquivado", by: "repl" }], aliases: {} };`;

  let r = runIn(`${seed} PerthI18n.set("pt"); render();
    return { arquivar: document.querySelector(".card-archive").textContent,
             dica: document.querySelector(".card-archive").title,
             por: document.querySelector(".card-by").textContent,
             novaColuna: document.querySelector(".add-col").textContent,
             novoCard: document.querySelector(".add-card").textContent };`);
  check(r.arquivar === "arquivar", "kanban: o botão de arquivar do card fala pt");
  check(r.dica === "mover para o arquivo",
        "kanban: e o title dele também — dica de uso conta como texto de tela");
  check(/^por /.test(r.por), "kanban: o crédito do card é \"por <nome>\", não \"by\"");
  check(r.novaColuna === "+ nova coluna", "kanban: o botão de nova coluna também");

  r = runIn(`PerthI18n.set("fr"); render();
    return { arquivar: document.querySelector(".card-archive").textContent,
             novaColuna: document.querySelector(".add-col").textContent };`);
  check(r.arquivar === "archiver" && r.novaColuna === "+ nouvelle colonne",
        "kanban: e troca junto quando o idioma muda");

  // o arquivo e o editor de card são construídos por outras funções, que
  // tinham cópias próprias de T — cada uma precisa enxergar o do módulo
  r = runIn(`PerthI18n.set("pt"); showArchived();
    const txt = document.body.textContent;
    return { restaurar: txt.includes("restaurar"), excluir: txt.includes("excluir"),
             semIngles: !txt.includes("restore") && !txt.includes("delete") };`);
  check(r.restaurar && r.excluir && r.semIngles,
        "kanban: o arquivo mostra restaurar/excluir, sem sobra em inglês");

  close();
}

/* Atalhos e Sobre eram alert(): sem formatação, sem tradução, travando a
 * página. E o kanban tinha oito teclas globais e nenhum lugar onde
 * descobri-las. Agora os dois abrem a mesma lista (shared/shortcuts.js) no
 * contêiner de cada um. */
/* Falha de ação era alert(): travava a página até alguém clicar, sem tema e
 * sem tradução. O que ele fazia de certo era não deixar a falha passar em
 * branco — por isso o aviso de erro dura o dobro do informativo e traz botão
 * de fechar, em vez de piscar e sumir. */
console.log("avisos · o toast substitui o alert() das falhas");
{
  const { w, runIn, close } = loadGanttApp();
  await new Promise((r) => setTimeout(r, 50));

  // nenhum alert() sobrou no caminho de erro: um alert em teste trava o jsdom
  // do mesmo jeito que trava o navegador
  const fonte = read("frontend/app.js") + read("frontend/kanban/app.js");
  const sobrou = [...fonte.matchAll(/^\s*alert\(/gm)].length;
  check(sobrou === 0, "nenhuma falha de ação chama alert() ainda");

  let r = runIn(`PerthToast.clear();
    PerthToast.error("deu ruim");
    const t = document.querySelector("#perth-toasts .toast");
    return { pilha: !!document.getElementById("perth-toasts"),
             texto: t.querySelector(".toast-text").textContent,
             classe: t.className, papel: t.getAttribute("role"),
             vivo: document.getElementById("perth-toasts").getAttribute("aria-live") };`);
  check(r.pilha && r.texto === "deu ruim", "o aviso aparece com a mensagem");
  check(/toast-error/.test(r.classe) && r.papel === "alert",
        "erro se anuncia como alert para leitor de tela");
  check(r.vivo === "polite", "a pilha é aria-live: anuncia sem roubar o foco");

  r = runIn(`PerthToast.clear(); PerthToast.info("pronto");
    const t = document.querySelector(".toast");
    return { classe: t.className, papel: t.getAttribute("role") };`);
  check(/toast-info/.test(r.classe) && r.papel === "status",
        "informativo é status, não alerta");

  r = runIn(`PerthToast.clear();
    for (let i = 0; i < 7; i++) PerthToast.error("erro " + i);
    const t = [...document.querySelectorAll(".toast-text")].map((x) => x.textContent);
    return t;`);
  check(r.length === 4 && r[0] === "erro 3" && r[3] === "erro 6",
        "a pilha para em 4: entram os novos, sai o mais antigo");

  r = runIn(`PerthToast.clear();
    PerthToast.error("fecha em mim");
    document.querySelector(".toast-close").click();
    return document.querySelector(".toast").className;`);
  check(/leaving/.test(r), "o botão de fechar tira o aviso na hora");

  r = runIn(`PerthToast.clear();
    return [PerthToast.error(""), PerthToast.error("   "), PerthToast.error(null),
            document.querySelectorAll(".toast").length];`);
  check(r[3] === 0, "erro sem mensagem não vira um aviso vazio na tela");

  // caminho real, ponta a ponta: o fetch do harness rejeita de propósito,
  // então "Aplicar estimativas PERT" falha de verdade e tem que reportar
  runIn(`PerthToast.clear();
    state.current = { id: "p1", name: "P", tasks: [] };
    applyPert();
    return 1;`);
  await new Promise((res) => setTimeout(res, 60));   // deixa a promessa cair
  r = runIn(`const t = document.querySelector(".toast");
    return { existe: !!t, texto: t ? t.querySelector(".toast-text").textContent : "",
             erro: t ? /toast-error/.test(t.className) : false,
             modal: !!document.querySelector(".modal-backdrop:not([hidden])") };`);
  check(r.existe && r.erro && /PERT/.test(r.texto),
        "uma ação que falha de verdade reporta num aviso, com o nome da ação");
  check(/fetch disabled/.test(r.texto),
        "e leva junto a mensagem do erro, como o alert levava");

  close();
}

/* O kanban já tinha toast; o gantt não tinha nada e usava alert(). Em vez de
 * dois sistemas de aviso no mesmo produto, o do kanban virou o compartilhado.
 * Estes testes cobrem o lado que se perde numa unificação: a variante de
 * presença, que é a única com marcação, e o container antigo, que não pode
 * ter ficado para trás no HTML. */
console.log("avisos · o kanban usa o mesmo componente, sem o dele");
{
  const { runIn, close } = loadKanbanApp();

  let r = runIn(`PerthToast.clear();
    toast({ ip: "10.0.0.9", text: "moveu um card", notify: true });
    const t = document.querySelector(".toast");
    return { classe: t.className, negrito: t.querySelector("b")?.textContent,
             titulo: t.querySelector("b")?.title,
             cor: t.style.getPropertyValue("--peer"),
             texto: t.querySelector(".toast-text").textContent };`);
  check(/toast-peer/.test(r.classe) && !!r.negrito,
        "kanban: a notificação de presença sobreviveu à mudança de componente");
  check(r.titulo === "10.0.0.9" && /moveu um card/.test(r.texto) && !!r.cor,
        "kanban: com o nome em negrito, o IP no title e a cor da máquina");

  r = runIn(`PerthToast.clear();
    showToast("bloqueado pelo host");
    const a = document.querySelector(".toast").className;
    PerthToast.clear();
    showToast("deu erro", "toast-error");
    return [a, document.querySelector(".toast").className];`);
  check(/toast-info/.test(r[0]) && /toast-error/.test(r[1]),
        "kanban: showToast continua existindo, mapeando para o componente novo");

  r = runIn(`return { antigo: !!document.getElementById("toasts"),
                     novo: !!document.getElementById("perth-toasts") };`);
  check(r.antigo === false && r.novo === true,
        "kanban: o container antigo saiu do HTML — sobra um só");

  close();
}

console.log("atalhos · a lista existe, fala o idioma e cobre os dois apps");
{
  const { runIn, close } = loadGanttApp();
  await new Promise((r) => setTimeout(r, 50));

  let r = runIn(`PerthI18n.set("pt"); showShortcuts();
    const linhas = [...document.querySelectorAll("#perth-overlay .shortcut-row")];
    // a linha é achada pela TECLA, não pelo índice: acrescentar um atalho no
    // meio da lista não pode quebrar a verificação da tradução
    const linhaN = linhas.find((l) => l.querySelector(".shortcut-keys").textContent === "N");
    return { titulo: document.querySelector("#perth-overlay h2").textContent,
             linhas: linhas.length,
             primeira: linhaN.querySelector(".shortcut-keys").textContent,
             descricao: linhaN.querySelector(".shortcut-desc").textContent,
             duasTeclas: linhas.find((l) => l.textContent.includes("Ctrl+Y"))
                               .querySelectorAll("kbd").length,
             fechar: document.querySelector("#perth-overlay .modal-actions button").textContent };`);
  check(r.titulo === "Atalhos de teclado" && r.linhas === 18,
        "gantt: Atalhos abre um overlay com as 18 teclas");
  check(r.primeira === "N" && r.descricao === "nova tarefa",
        "gantt: tecla de um lado, descrição traduzida do outro");
  check(r.duasTeclas === 2, "gantt: \"Ctrl+Shift+Z / Ctrl+Y\" vira dois <kbd>, não um");
  check(r.fechar === "Fechar",
        "gantt: o overlay é de leitura — o botão fecha, não cancela");

  r = runIn(`document.getElementById("perth-overlay").remove();
    state.current = { id: "p1", name: "Obra", tasks: [] };
    showAbout();
    return { titulo: document.querySelector("#perth-overlay h2").textContent,
             codigo: document.querySelector(".about-code").textContent,
             paragrafos: document.querySelectorAll(".about-box p").length };`);
  check(r.titulo === "Sobre o Perth" && r.paragrafos === 2,
        "gantt: Sobre abre no mesmo overlay, com texto formatado");
  check(/p = project\("Obra"\)/.test(r.codigo) && /"Tarefa"/.test(r.codigo),
        "gantt: o exemplo de REPL usa o projeto aberto, e só o que é texto é traduzido");

  close();
}
{
  const { runIn, close } = loadKanbanApp();

  const r = runIn(`PerthI18n.set("pt");
    state.board = { columns: [], archive: [], aliases: {} };
    doAction("shortcuts");
    const linhas = [...document.querySelectorAll(".shortcut-row")];
    return { linhas: linhas.length,
             barra: linhas.find((l) => l.querySelector("kbd").textContent === "/")
                          .querySelector(".shortcut-desc").textContent,
             menu: document.querySelector('[data-menu="help"] .menu-title').textContent,
             entrada: document.querySelector('[data-menu="help"] .menu-drop button')
                        .textContent.trim() };`);
  check(r.linhas === 9, "kanban: o mesmo componente lista as 9 teclas dele");
  check(r.barra === "filtrar cards",
        "kanban: inclusive a \"/\", que só existia escondida no placeholder do filtro");
  check(r.menu === "Ajuda" && r.entrada === "Atalhos de teclado",
        "kanban: e o menu Ajuda passou a existir, traduzido, como no gantt");

  close();
}

console.log("i18n · nenhum literal escapa da tradução");
{
  const w = loadPage("frontend/index.html");
  w.PerthI18n.set("pt");

  // iguais em pt de propósito, ou não-texto
  const ISENTAS = new Set(["Perth", "Kanban", "PERT", "P80", "WBS", "—", "…"]);

  // Texto de tela em literal, nas duas formas que o código usa:
  //   .textContent = "…" / .innerHTML = '…' / .title = "…" / .placeholder = "…"
  //   setAttribute("title" | "aria-label" | "placeholder", "…")
  // T(...) não casa em nenhuma: as duas exigem a aspa logo depois da vírgula
  // ou do "=". title e placeholder contam tanto quanto o texto — são
  // instrução de uso, não decoração.
  //
  // Crase entra só sem interpolação: `Olá` é texto solto e tem que falhar,
  // enquanto `x = ${T("y")}` é a forma normal de compor texto traduzido com
  // variável, e um trecho de código de exemplo (Julia, no diálogo Sobre)
  // também é montado assim — não é texto de tela, é código.
  const LITERAL = new RegExp(
    "\\.(?:textContent|innerHTML|title|placeholder)\\s*=\\s*" +
      "(\"(?:\\\\.|[^\"])*\"|'(?:\\\\.|[^'])*'|`[^`$]*`)" +
    "|setAttribute\\(\\s*[\"'](?:title|aria-label|placeholder)[\"']\\s*,\\s*" +
      "(\"(?:\\\\.|[^\"])*\"|'(?:\\\\.|[^'])*'|`[^`$]*`)", "g");

  const varrer = (arquivo) => {
    const src = read(arquivo);
    const achados = [];
    for (const m of src.matchAll(LITERAL)) {
      let txt = (m[1] || m[2]).slice(1, -1).replace(/\\(.)/g, "$1");
      txt = txt.replace(/<[^>]*>/g, "").trim();          // innerHTML: só o texto
      if (!/[A-Za-z]{2}/.test(txt)) continue;            // símbolo, número, vazio
      if (ISENTAS.has(txt)) continue;
      // NÃO vale perguntar "existe tradução para esta string?": um literal
      // solto que por acaso coincide com uma chave do dicionário continua
      // saindo em inglês na tela (era o caso de `chip.title = "due " + …`).
      // O que importa é estar dentro de T() — e literal dentro de T() nem
      // chega aqui, porque o regex exige a aspa colada no "=" ou na vírgula.
      const linha = src.slice(0, m.index).split("\n").length;
      achados.push(`${arquivo}:${linha}  ${JSON.stringify(txt.slice(0, 60))}`);
    }
    return achados;
  };

  for (const arquivo of ["frontend/app.js", "frontend/kanban/app.js",
                         "frontend/shared/presence.js",
                         "frontend/shared/shortcuts.js", "frontend/shared/toast.js"]) {
    const achados = varrer(arquivo);
    if (achados.length) achados.forEach((a) => console.error("      " + a));
    check(achados.length === 0,
          `${arquivo}: todo texto de tela passa por T() — inclusive title e placeholder`);
  }

  // a varredura precisa mesmo pegar o erro que ela existe para pegar
  const cobaia = `el.textContent = "Definitely untranslated sentence here";` +
                 `el.title = "Definitely untranslated sentence here";` +
                 `el.setAttribute("aria-label", "Definitely untranslated sentence here");` +
                 "el.textContent = \`Definitely untranslated sentence here\`;";
  const envolvido = `el.textContent = T("Definitely untranslated sentence here");` +
                    "el.textContent = \`p = project(\${nome})\`;";
  const pega = [...cobaia.matchAll(LITERAL)].length === 4 &&
               [...envolvido.matchAll(LITERAL)].length === 0;
  check(pega, "a varredura pega literal solto e ignora o que está em T() (auto-teste)");

  w.close();
}

/* Duplo clique na barra abre a tarefa — e isso é frágil de um jeito que não
 * aparece em teste de unidade nenhum: depende de o navegador conseguir FORMAR
 * o click. Duas coisas o impediam, e as duas voltam fácil numa refatoração:
 *
 *   1. preventDefault() no pointerdown suprime os eventos de mouse de
 *      compatibilidade; sem mousedown não há click, e sem click não há
 *      dblclick. O listener de dblclick vira código morto.
 *   2. selecionar a tarefa no pointerup re-renderiza o gráfico. pointerup
 *      roda ANTES do mouseup, então o nó que recebeu o mousedown morre no
 *      meio do gesto e o par deixa de existir no mesmo elemento.
 *
 * Os dois testes abaixo miram exatamente essas duas causas, não o sintoma. */
console.log("gantt · duplo clique na barra abre a tarefa");
{
  const { w, runIn, close } = loadGanttApp();
  await new Promise((r) => setTimeout(r, 50));

  const seed = `
    const mk = (id, name, start, duration, extra) => Object.assign({
      id, name, start, duration, assignee: "", progress: 0, dependencies: [],
      color: "", notes: "", milestone: false, parent: "", cost: 0,
      baseline_start: null, baseline_duration: 0, deadline: null, pinned: false,
      optimistic: 0, most_likely: 0, pessimistic: 0 }, extra || {});
    state.current = { id: "p1", name: "P", tasks: [
      mk("t1", "Barra", "2026-03-02", 5),
      mk("t2", "Marco", "2026-03-10", 1, { milestone: true }) ] };
    state.cpm = { cycle: false, finish: "2026-03-07", calendar: "", pert: null,
                  byId: new Map() };
    renderAll();`;

  // causa 1: o pointerdown não pode ser cancelado
  let r = runIn(`${seed}
    const ev = (alvo) => {
      const e = new MouseEvent("pointerdown",
        { button: 0, clientX: 100, clientY: 10, bubbles: true, cancelable: true });
      document.querySelector(alvo).dispatchEvent(e);
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      return e.defaultPrevented;
    };
    return { barra: ev("#chart .bar"), punho: ev("#chart .bar-handle"),
             marco: ev("#chart .milestone") };`);
  check(r.barra === false && r.punho === false && r.marco === false,
        "gantt: pointerdown da barra não é cancelado (senão não há click nem dblclick)");

  // causa 2: um clique parado não pode re-renderizar antes do mouseup —
  // o nó que recebeu o pointerdown tem que continuar na árvore
  r = runIn(`${seed}
    const bar = document.querySelector("#chart .bar");
    bar.dispatchEvent(new MouseEvent("pointerdown",
      { button: 0, clientX: 100, clientY: 10, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    return { naArvore: document.contains(bar), selecionou: state.selected };`);
  check(r.naArvore === true,
        "gantt: pointerup de clique parado não re-renderiza (o nó sobrevive ao gesto)");
  check(r.selecionou === null,
        "gantt: e a seleção não acontece ali — quem seleciona é o click");

  r = runIn(`document.querySelector("#chart .bar").dispatchEvent(
      new MouseEvent("click", { bubbles: true }));
    return state.selected;`);
  check(r === "t1", "gantt: o click é que seleciona a tarefa");

  // o gesto completo: dblclick chega ao nó e abre o modal
  r = runIn(`${seed}
    document.querySelector("#chart .bar").dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true }));
    return { aberto: !document.getElementById("modal").hidden,
             nome: document.getElementById("f-name").value };`);
  check(r.aberto === true && r.nome === "Barra",
        "gantt: duplo clique na barra abre o modal da tarefa certa");

  r = runIn(`closeModal(false); ${seed}
    document.querySelector("#chart .milestone").dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true }));
    return { aberto: !document.getElementById("modal").hidden,
             nome: document.getElementById("f-name").value };`);
  check(r.aberto === true && r.nome === "Marco",
        "gantt: e no losango do marco também");

  // arrastar continua arrastando, e não seleciona no fim do gesto
  r = runIn(`closeModal(false); ${seed}
    state.selected = null;
    const bar = document.querySelector("#chart .bar");
    bar.dispatchEvent(new MouseEvent("pointerdown",
      { button: 0, clientX: 100, clientY: 10, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent("pointermove",
      { clientX: 100 + 3 * PPD[state.zoom], clientY: 10, bubbles: true }));
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    const t = state.current.tasks.find((x) => x.id === "t1");
    document.querySelector("#chart .bar").dispatchEvent(
      new MouseEvent("click", { bubbles: true }));
    return { inicio: t.start, selecionou: state.selected };`);
  check(r.inicio === "2026-03-05", "gantt: arrastar a barra ainda move a tarefa (3 dias)");

  close();
}

/* pushUndo() guarda o "antes" e ZERA a pilha de refazer. Se um clique que só
 * seleciona passa por ele, cada clique numa barra empilha uma entrada que não
 * corresponde a edição nenhuma — e mata o refazer de uma edição de verdade.
 * Pior: a entrada fica sem "depois" (markDirty só roda em edição), e undo()
 * sem par completo cai no _restore() cru, que ignora o que chegou por fora. */
console.log("gantt · clicar numa barra não mexe no histórico");
{
  const { runIn, close } = loadGanttApp();
  await new Promise((r) => setTimeout(r, 50));

  const seed = `
    const mk = (id, name, start, duration) => ({
      id, name, start, duration, assignee: "", progress: 0, dependencies: [],
      color: "", notes: "", milestone: false, parent: "", cost: 0,
      baseline_start: null, baseline_duration: 0, deadline: null, pinned: false,
      optimistic: 0, most_likely: 0, pessimistic: 0 });
    state.current = { id: "p1", name: "P", tasks: [mk("t1", "Barra", "2026-03-02", 5)] };
    state.cpm = { cycle: false, finish: "2026-03-07", calendar: "", pert: null,
                  byId: new Map() };
    state.undoStack = []; state.redoStack = [];
    renderAll();`;

  // bloco proprio: o trecho e colado varias vezes na mesma funcao
  const clicar = `{
    const bar = document.querySelector("#chart .bar");
    bar.dispatchEvent(new MouseEvent("pointerdown",
      { button: 0, clientX: 100, clientY: 10, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    document.querySelector("#chart .bar").dispatchEvent(
      new MouseEvent("click", { bubbles: true }));
  }`;

  let r = runIn(`${seed} ${clicar} ${clicar} ${clicar}
    return { undo: state.undoStack.length, selecionada: state.selected };`);
  check(r.undo === 0, "gantt: três cliques numa barra não empilham nada para desfazer");

  // o dano concreto: um clique de seleção apagava o refazer de uma edição
  r = runIn(`${seed}
    pushUndo(); state.current.tasks[0].duration = 9; markDirty();
    undo();
    const refazerAntes = state.redoStack.length;
    ${clicar}
    return { refazerAntes, refazerDepois: state.redoStack.length };`);
  check(r.refazerAntes === 1 && r.refazerDepois === 1,
        "gantt: e não jogam fora o refazer de uma edição de verdade");

  // arrastar de verdade continua sendo desfazível
  r = runIn(`${seed}
    const bar = document.querySelector("#chart .bar");
    bar.dispatchEvent(new MouseEvent("pointerdown",
      { button: 0, clientX: 100, clientY: 10, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent("pointermove",
      { clientX: 100 + 4 * PPD[state.zoom], clientY: 10, bubbles: true }));
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    const movido = state.current.tasks[0].start;
    const entrada = state.undoStack[state.undoStack.length - 1];
    undo();
    return { movido, desfeito: state.current.tasks[0].start,
             pilha: state.undoStack.length + 1,
             parCompleto: !!(entrada && entrada.before && entrada.after) };`);
  check(r.movido === "2026-03-06" && r.desfeito === "2026-03-02",
        "gantt: arrastar continua registrando um desfazer que funciona");
  check(r.parCompleto === true,
        "gantt: e a entrada tem antes E depois (undo reconcilia em vez de sobrescrever)");

  close();
}

console.log("gantt · modal: título e campos ilegíveis");
{
  const { runIn, close } = loadGanttApp();
  await new Promise((r) => setTimeout(r, 50));

  const seed = `
    const mk = (id, name, start, duration, extra) => Object.assign({
      id, name, start, duration, assignee: "", progress: 0, dependencies: [],
      color: "", notes: "", milestone: false, parent: "", cost: 0,
      baseline_start: null, baseline_duration: 0, deadline: null, pinned: false,
      optimistic: 0, most_likely: 0, pessimistic: 0 }, extra || {});
    state.current = { id: "p1", name: "P", tasks: [
      mk("t1", "Um", "2026-03-02", 5, { cost: 1500 }) ] };
    state.cpm = { cycle: false, finish: "2026-03-07", calendar: "", pert: null,
                  byId: new Map() };
    renderAll();`;

  // o título é reescrito a cada abertura, depois da varredura do PerthI18n:
  // ficava em inglês dentro de um modal com todo o resto traduzido
  let r = runIn(`${seed} PerthI18n.set("pt"); openModal("t1");
    return { titulo: document.getElementById("modal-title").textContent,
             salvar: document.getElementById("modal-save").textContent };`);
  check(r.titulo === "Editar tarefa" && r.salvar === "Salvar",
        "gantt: o título do modal acompanha o idioma");

  r = runIn(`state.editingNew = true; openModal("t1");
    const pt = document.getElementById("modal-title").textContent;
    PerthI18n.set("en"); openModal("t1");
    state.editingNew = false;
    return [pt, document.getElementById("modal-title").textContent];`);
  check(r.join("|") === "Nova tarefa|New task",
        "gantt: e distingue tarefa nova de edição nos dois idiomas");

  // Campo numérico ilegível ("666+6") vale "" no navegador com badInput
  // ligado — o jsdom sanitiza na atribuição, então o estado é simulado aqui.
  // Sem a guarda, salvar trocava o que estava escrito por 0/1 caladamente.
  r = runIn(`PerthI18n.set("en"); openModal("t1");
    const c = document.getElementById("f-cost");
    Object.defineProperty(c, "validity", { configurable: true,
                                           value: { badInput: true } });
    submitModal();
    return { aberto: !document.getElementById("modal").hidden,
             foco: document.activeElement ? document.activeElement.id : null,
             cost: state.current.tasks[0].cost };`);
  check(r.aberto === true && r.foco === "f-cost" && r.cost === 1500,
        "gantt: número ilegível não salva — foca o campo e preserva o valor");

  r = runIn(`const c = document.getElementById("f-cost");
    Object.defineProperty(c, "validity", { configurable: true,
                                           value: { badInput: false } });
    c.value = "2000";
    submitModal();
    return { aberto: !document.getElementById("modal").hidden,
             cost: state.current.tasks[0].cost };`);
  check(r.aberto === false && r.cost === 2000,
        "gantt: corrigido o campo, o salvamento segue normal");

  // resumo desabilita os campos: um ilegível ali não é motivo pra travar
  // um salvamento que nem vai olhar pra ele
  r = runIn(`openModal("t1");
    const d = document.getElementById("f-duration");
    d.disabled = true;
    Object.defineProperty(d, "validity", { configurable: true,
                                           value: { badInput: true } });
    submitModal();
    d.disabled = false;
    return document.getElementById("modal").hidden;`);
  check(r === true, "gantt: campo desabilitado não segura o salvamento");

  close();
}

console.log("gantt · modal: lag, marco e descarte");
{
  const { runIn, close } = loadGanttApp();
  await new Promise((r) => setTimeout(r, 50));

  const seed = `
    const mk = (id, name, start, duration, extra) => Object.assign({
      id, name, start, duration, assignee: "", progress: 0, dependencies: [],
      color: "", notes: "", milestone: false, parent: "", cost: 0,
      baseline_start: null, baseline_duration: 0, deadline: null, pinned: false,
      optimistic: 0, most_likely: 0, pessimistic: 0 }, extra || {});
    state.current = { id: "p1", name: "P", tasks: [
      mk("t1", "Um", "2026-03-02", 5),
      mk("t2", "Dois", "2026-03-09", 3) ] };
    state.cpm = { cycle: false, finish: "2026-03-11", calendar: "", pert: null,
                  byId: new Map() };
    renderAll();`;

  // lag digitado numa linha desmarcada era descartado no salvamento
  let r = runIn(`${seed} openModal("t2");
    const cb = document.querySelector('#f-deps input[value="t1"]');
    const lag = cb.parentElement.querySelector(".dep-lag");
    lag.value = "3";
    lag.dispatchEvent(new Event("input"));
    const marcou = cb.checked;
    submitModal();
    return { marcou, deps: state.current.tasks.find((x) => x.id === "t2").dependencies };`);
  check(r.marcou === true, "gantt: digitar um lag marca a dependência");
  check(r.deps.join(",") === "t1+3", "gantt: e o lag chega ao salvamento");

  r = runIn(`openModal("t2");
    const cb = document.querySelector('#f-deps input[value="t1"]');
    cb.checked = false;
    const lag = cb.parentElement.querySelector(".dep-lag");
    lag.value = "0";
    lag.dispatchEvent(new Event("input"));
    return cb.checked;`);
  check(r === false, "gantt: lag zero é o default da linha, não marca nada");

  // marco: _effdur() conta 1 dia, então a duração digitada não valia nada
  r = runIn(`openModal("t1");
    const d = document.getElementById("f-duration");
    const antes = d.disabled;
    const ms = document.getElementById("f-milestone");
    ms.checked = true;
    ms.dispatchEvent(new Event("change"));
    return { antes, depois: d.disabled, valor: d.value };`);
  check(r.antes === false && r.depois === true,
        "gantt: marcar Marco trava a duração");
  check(r.valor === "5", "gantt: e o valor continua no campo");

  r = runIn(`submitModal();
    const t = state.current.tasks.find((x) => x.id === "t1");
    openModal("t1");
    const ms = document.getElementById("f-milestone");
    ms.checked = false;
    ms.dispatchEvent(new Event("change"));
    return { dur: t.duration, marco: t.milestone,
             destravou: document.getElementById("f-duration").disabled };`);
  check(r.dur === 5 && r.marco === true,
        "gantt: campo travado ainda é gravado — a duração de antes sobrevive");
  check(r.destravou === false, "gantt: desmarcar Marco destrava a duração");

  // Esc e clique no fundo descartam tudo; só perguntam se há o que perder
  r = runIn(`window.__ask = 0;
    window.confirm = (m) => { window.__ask++; window.__msg = m; return false; };
    closeModal(false);
    openModal("t2");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return { perguntou: window.__ask, hidden: document.getElementById("modal").hidden };`);
  check(r.perguntou === 0 && r.hidden === true,
        "gantt: Esc sem alterações fecha direto, sem perguntar");

  r = runIn(`openModal("t2");
    document.getElementById("f-name").value = "Renomeada";
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return { perguntou: window.__ask, msg: window.__msg,
             hidden: document.getElementById("modal").hidden,
             campo: document.getElementById("f-name").value };`);
  check(r.perguntou === 1 && r.hidden === false && r.campo === "Renomeada",
        "gantt: Esc com alterações pergunta, e o não mantém tudo na tela");
  check(/Discard the changes/.test(r.msg), "gantt: pergunta de edição, não de tarefa nova");

  r = runIn(`window.confirm = (m) => { window.__ask++; window.__msg = m; return true; };
    document.querySelector("#modal").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return { hidden: document.getElementById("modal").hidden,
             nome: state.current.tasks.find((x) => x.id === "t2").name };`);
  check(r.hidden === true && r.nome === "Dois",
        "gantt: clicar no fundo e confirmar descarta as alterações");

  // Cancelar diz o que faz: descarta na hora, sem diálogo no caminho
  r = runIn(`window.__ask = 0; openModal("t2");
    document.getElementById("f-name").value = "Outra";
    document.getElementById("modal-cancel").click();
    return { perguntou: window.__ask,
             hidden: document.getElementById("modal").hidden };`);
  check(r.perguntou === 0 && r.hidden === true,
        "gantt: o botão Cancelar não pergunta");

  r = runIn(`state.editingNew = true; openModal("t2");
    document.getElementById("f-name").value = "Nova";
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return { msg: window.__msg, resta: state.current.tasks.length };`);
  check(/Discard this new task/.test(r.msg) && r.resta === 1,
        "gantt: tarefa nova pergunta com as palavras dela, e some ao confirmar");

  close();
}

/* Busca de tarefa. O que ela acrescenta ao destaque que já existia é chegar
 * lá: num projeto de 141 tarefas (os do autor têm 98 e 141), ver a linha
 * acesa não adianta se ela está a 80 linhas de distância. */
/* Painel de avisos: reúne num lugar só o que o motor já sabia e estava
 * espalhado (o ciclo virava exceção, o prazo virava "+8d" na barra, a
 * sobrecarga acendia no painel de recursos). A ficha na barra só existe
 * quando há o que avisar — contador permanente marcando zero é decoração. */
console.log("gantt · painel de avisos");
{
  const { runIn, close } = loadGanttApp();
  await new Promise((r) => setTimeout(r, 50));

  const seed = `
    const mk = (id, name) => ({ id, name, start: "2026-03-02", duration: 3,
      assignee: "", progress: 0, dependencies: [], color: "", notes: "",
      milestone: false, parent: "", cost: 0, baseline_start: null,
      baseline_duration: 0, deadline: null, pinned: false,
      optimistic: 0, most_likely: 0, pessimistic: 0 });
    state.current = { id: "p1", name: "P", tasks: [mk("t1", "Fundação"), mk("t2", "Telhado")] };
    state.cpm = { cycle: false, finish: "2026-03-07", calendar: "", pert: null, byId: new Map() };
    renderAll();`;

  // sem problema nenhum, a ficha não existe
  let r = runIn(`${seed} state.warnings = []; renderWarningsChip();
    return document.getElementById("warnings-chip").hidden;`);
  check(r === true, "gantt: plano são não ganha contador marcando zero");

  r = runIn(`state.warnings = [
      { kind: "deadline", severity: "error", task_id: "t1", task: "Fundação",
        days: 3, at: "2026-03-01" },
      { kind: "slippage", severity: "warning", task_id: "t2", task: "Telhado", days: 7 }];
    renderWarningsChip();
    const c = document.getElementById("warnings-chip");
    return { escondida: c.hidden, texto: c.textContent,
             simbolo: c.querySelector(".warn-ico")?.textContent,
             grave: c.classList.contains("error") };`);
  check(r.escondida === false && r.texto === "⚠2" && r.simbolo === "⚠",
        "gantt: com problemas, a ficha conta — e o símbolo é elemento próprio,\n" +
        "        para poder ser maior que o número");
  check(r.grave === true,
        "gantt: um erro no meio pinta a ficha de erro — aviso e erro não pesam igual");

  // a frase é montada AQUI, com os campos: texto pronto do servidor sairia
  // em inglês no meio de uma tela traduzida
  r = runIn(`PerthI18n.set("pt"); showWarnings();
    const linhas = [...document.querySelectorAll(".warn-row")];
    return { n: linhas.length,
             etiquetas: linhas.map((l) => l.querySelector(".warn-kind").textContent),
             textos: linhas.map((l) => l.querySelector(".warn-text").textContent) };`);
  check(r.n === 2, "gantt: uma linha por problema");
  check(r.etiquetas[0] === "prazo estourado" && r.etiquetas[1] === "atrás do baseline",
        "gantt: a etiqueta diz o tipo, traduzida");
  check(/Fundação/.test(r.textos[0]) && /3 d/.test(r.textos[0]) && /2026-03-01/.test(r.textos[0]),
        "gantt: e a frase é montada dos campos, não vem pronta do servidor");

  // clicar leva ao problema: nomear sem levar até lá é meia ajuda
  r = runIn(`document.querySelectorAll(".warn-row")[1].click();
    return { selecionada: state.selected,
             fechou: !document.getElementById("perth-overlay") };`);
  check(r.selecionada === "t2" && r.fechou === true,
        "gantt: clicar num aviso fecha o painel e seleciona a tarefa dele");

  // ciclo é do plano inteiro: não tem para onde levar
  r = runIn(`state.warnings = [{ kind: "cycle", severity: "error", task_id: "" }];
    renderWarningsChip(); showWarnings();
    const l = document.querySelector(".warn-row");
    return { desabilitada: l.disabled, texto: l.querySelector(".warn-text").textContent };`);
  check(r.desabilitada === true && r.texto.length > 0,
        "gantt: o ciclo é do plano, não de uma tarefa — a linha não finge que leva a algum lugar");

  close();
}

console.log("gantt · busca de tarefa");
{
  const { runIn, close } = loadGanttApp();
  await new Promise((r) => setTimeout(r, 50));

  const seed = `
    const mk = (id, name, extra) => Object.assign({
      id, name, start: "2026-03-02", duration: 3, assignee: "", progress: 0,
      dependencies: [], color: "", notes: "", milestone: false, parent: "",
      cost: 0, baseline_start: null, baseline_duration: 0, deadline: null,
      pinned: false, optimistic: 0, most_likely: 0, pessimistic: 0 }, extra || {});
    state.current = { id: "p1", name: "P", tasks: [
      mk("t1", "Integração por partes"),
      mk("t2", "Frações parciais", { assignee: "Ana" }),
      mk("t3", "Estratégia de integração", { assignee: "Bruno" }),
      mk("t4", "Área entre curvas") ] };
    state.cpm = { cycle: false, finish: "2026-03-07", calendar: "", pert: null,
                  byId: new Map() };
    renderAll();`;

  const buscar = (texto) => `
    document.getElementById("task-search").value = ${JSON.stringify(texto)};
    document.getElementById("task-search").dispatchEvent(new Event("input"));`;

  // sem acento acha com acento: é o caso do português, e exigir o acento
  // certo seria exigir que a pessoa já saiba o que está procurando
  // .sort(): renderAll reordena as tarefas (por início, depois nome), então a
  // ordem em state.current.tasks é a da TELA, não a da criação
  let r = runIn(`${seed} ${buscar("integracao")}
    return { acesas: state.current.tasks.filter(taskMatchesHighlight)
                       .map((t) => t.id).sort(),
             contagem: document.getElementById("task-search-count").textContent,
             apagadas: document.querySelectorAll(".tt-row.dim").length,
             barrasApagadas: document.querySelectorAll("#chart .bar.dim").length };`);
  check(r.acesas.join(",") === "t1,t3",
        "gantt: busca sem acento acha as tarefas com acento");
  check(r.contagem === "1/2",
        "gantt: a contagem é posição/ocorrências, como caixa de busca de editor");
  check(r.apagadas === 2 && r.barrasApagadas === 2,
        "gantt: tabela e barras apagam juntas — é a mesma decisão para as duas");

  // caixa alta não importa
  r = runIn(`${buscar("FRAÇÕES")}
    return state.current.tasks.filter(taskMatchesHighlight).map((t) => t.id).sort();`);
  check(r.join(",") === "t2", "gantt: e não liga para maiúscula");

  // busca e destaque se SOMAM: filtrar por pessoa e procurar dentro disso
  r = runIn(`state.highlight = { kind: "assignee", value: "Bruno" };
    ${buscar("integracao")}
    return state.current.tasks.filter(taskMatchesHighlight).map((t) => t.id).sort();`);
  check(r.join(",") === "t3",
        "gantt: busca e destaque se somam, em vez de um anular o outro");

  // nada encontrado: avisa sem apagar o que foi digitado
  r = runIn(`state.highlight = null; ${buscar("xyz")}
    return { marcada: document.getElementById("task-search").classList.contains("empty-hit"),
             texto: document.getElementById("task-search").value,
             contagem: document.getElementById("task-search-count").textContent };`);
  check(r.marcada === true && r.texto === "xyz" && r.contagem === "0/0",
        "gantt: busca sem resultado se marca, e não engole o que foi digitado");

  // Enter percorre as ocorrências, uma a uma, e dá a volta no fim
  // bloco proprio: o trecho e colado varias vezes na mesma funcao
  const enter = (shift) => `{
    const cx = document.getElementById("task-search");
    cx.dispatchEvent(new KeyboardEvent("keydown",
      { key: "Enter", shiftKey: ${!!shift}, bubbles: true }));
  }`;

  r = runIn(`${seed} ${buscar("integracao")}
    const passo = [];
    const onde = () => ({ contagem: document.getElementById("task-search-count").textContent,
                          selecionada: state.current.tasks.find((t) => t.id === state.selected).name });
    passo.push(onde());
    ${enter(false)} passo.push(onde());
    ${enter(false)} passo.push(onde());   // aqui dá a volta
    return passo;`);
  check(r[0].contagem === "1/2" && r[1].contagem === "2/2" && r[2].contagem === "1/2",
        "gantt: cada Enter vai para a próxima ocorrência e dá a volta no fim");
  check(r[0].selecionada !== r[1].selecionada,
        "gantt: e seleciona a tarefa — numa tela de 141 linhas, rolar não basta");
  check(r[0].selecionada === r[2].selecionada,
        "gantt: a volta chega de novo na primeira");

  r = runIn(`${buscar("integracao")}
    ${enter(true)}
    return document.getElementById("task-search-count").textContent;`);
  check(r === "2/2", "gantt: Shift+Enter volta, para quem passou do ponto");

  // uma ocorrência só: Enter não pode se perder nem quebrar
  r = runIn(`${buscar("frações")}
    ${enter(false)} ${enter(false)}
    return { contagem: document.getElementById("task-search-count").textContent,
             selecionada: state.selected };`);
  check(r.contagem === "1/1" && r.selecionada === "t2",
        "gantt: com uma ocorrência só, Enter fica nela");

  // limpar devolve tudo
  r = runIn(`${buscar("")}
    return { acesas: state.current.tasks.filter(taskMatchesHighlight).length,
             contagemEscondida: document.getElementById("task-search-count").hidden };`);
  check(r.acesas === 4 && r.contagemEscondida === true,
        "gantt: limpar a busca devolve todas e esconde a contagem");

  // "/" foca a caixa, como no kanban; Esc limpa sem fechar mais nada
  r = runIn(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    return document.activeElement.id;`);
  check(r === "task-search", "gantt: a tecla / foca a busca, mesma tecla do kanban");

  r = runIn(`${buscar("area")}
    const cx = document.getElementById("task-search");
    cx.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return { valor: cx.value, acesas: state.current.tasks.filter(taskMatchesHighlight).length };`);
  check(r.valor === "" && r.acesas === 4, "gantt: Esc na busca limpa e devolve tudo");

  close();
}

console.log("gantt · cadastro de colaboradores");
{
  const { runIn, close } = loadGanttApp();

  // gravar() salva e recarrega do servidor; aqui não há rede, então os dois
  // viram no-op e o teste guarda o que TERIA sido salvo
  const seed = `
    const mk = (id, assignee) => ({
      id, name: id, start: "2026-03-02", duration: 1, assignee, progress: 0,
      dependencies: [], color: "", notes: "", milestone: false, parent: "",
      baseline_start: null, baseline_duration: 0, cost: 0 });
    window.__salvos = [];
    window.saveNowAfterDirty = async () => {
      window.__salvos.push(JSON.parse(JSON.stringify(state.current.people))); };
    window.loadProjects = async () => {};
    state.current = { id: "p1", name: "P",
      people: [{ name: "Bruno", role: "Eletricista", team: "Obra",
                 email: "", notes: "" }],
      tasks: [mk("t1", "Ana"), mk("t2", "Ana"), mk("t3", ""), mk("t4", "Chen Wei")] };
    state.cpm = { cycle: false, finish: "2026-03-03", calendar: "", pert: null,
                  byId: new Map() };
    renderAll();`;

  // O autocompletar oferece cadastrados E quem já aparece em alguma tarefa:
  // oferecer só o cadastro esconderia nomes existentes e convidaria a
  // redigitá-los — e redigitar é o que fragmenta
  let r = runIn(`${seed}
    fillPeopleList();
    return [...document.querySelectorAll("#people-list option")]
      .map((o) => o.value + "/" + o.label);`);
  check(r.join("|") === "Ana/|Bruno/Eletricista · Obra|Chen Wei/",
        "gantt: autocompletar junta cadastrados e usados, com cargo e setor");

  r = runIn(`showPeople();
    return { nomes: [...document.querySelectorAll(".people-name")].map((x) => x.textContent),
             cargos: [...document.querySelectorAll(".people-role")].map((x) => x.textContent),
             contas: [...document.querySelectorAll(".people-count")].map((x) => x.textContent),
             fichas: document.querySelectorAll(".people-form").length,
             soltos: document.querySelector(".people-loose").textContent };`);
  check(r.nomes.join("|") === "Bruno", "gantt: a lista mostra os cadastrados");
  check(r.cargos[0] === "Eletricista · Obra", "gantt: com cargo e setor na linha");
  check(r.contas[0] === "—", "gantt: cadastrado sem tarefa aparece com um travessão");
  check(r.fichas === 0, "gantt: a ficha começa fechada");
  check(/Ana/.test(r.soltos) && /Chen Wei/.test(r.soltos) && !/Bruno/.test(r.soltos),
        "gantt: quem trabalha sem estar cadastrado aparece no rodapé");

  // clicar na linha abre a ficha; o alvo é o nome inteiro, não um lápis
  r = runIn(`document.querySelector(".people-row").click();
    return [...document.querySelectorAll(".people-form input")]
      .map((i) => i.dataset.field + "=" + i.value);`);
  check(r.join("|") === "role=Eletricista|team=Obra|email=|notes=",
        "gantt: clicar na linha abre a ficha preenchida");

  // grava no change (sair do campo), não a cada tecla: uma letra por PUT
  // seria um PUT por letra
  runIn(`const i = document.querySelector(".people-form input[data-field=email]");
    i.value = " bruno@obra.com ";
    i.dispatchEvent(new Event("input"));
    return 0;`);
  check(runIn(`return window.__salvos.length;`) === 0,
        "gantt: digitar na ficha não salva a cada tecla");
  runIn(`document.querySelector(".people-form input[data-field=email]")
    .dispatchEvent(new Event("change")); return 0;`);
  await new Promise((ok) => setTimeout(ok, 0));
  check(runIn(`return window.__salvos.at(-1)[0].email;`) === "bruno@obra.com",
        "gantt: sair do campo salva a ficha, sem o espaço sobrando");

  r = runIn(`document.querySelector(".people-row").click();
    return document.querySelectorAll(".people-form").length;`);
  check(r === 0, "gantt: clicar de novo fecha a ficha");

  // é exatamente aqui que a fragmentação fica visível — e some com um clique
  runIn(`[...document.querySelectorAll(".people-loose button")][0].click(); return 0;`);
  await new Promise((ok) => setTimeout(ok, 0));
  r = runIn(`return { salvo: window.__salvos.at(-1).map((pe) => pe.name),
             contas: [...document.querySelectorAll(".people-count")].map((x) => x.textContent),
             soltos: document.querySelector(".people-loose").textContent };`);
  check(r.salvo.join("|") === "Bruno|Ana|Chen Wei",
        "gantt: \"cadastrar estes\" absorve os nomes soltos");
  check(r.soltos === "", "gantt: e o rodapé fica vazio depois disso");
  check(r.contas.join("|") === "—|2 tasks|1 task",
        "gantt: a contagem de tarefas por pessoa, no singular e no plural");

  // digitar um nome que já está lá com outra caixa é CORRIGIR a grafia,
  // não cadastrar de novo — e não pode ser um nada silencioso
  r = runIn(`const f = document.querySelector(".people-add");
    f.querySelector("input").value = "  BRUNO ";
    f.dispatchEvent(new Event("submit"));
    return f.querySelector("input").value;`);
  await new Promise((ok) => setTimeout(ok, 0));
  r = runIn(`return window.__salvos.at(-1);`);
  check(r.map((pe) => pe.name).join("|") === "BRUNO|Ana|Chen Wei",
        "gantt: grafia digitada substitui a cadastrada, sem duplicar");
  check(r[0].role === "Eletricista", "gantt: e o resto da ficha fica de pé");

  runIn(`const f = document.querySelector(".people-add");
    f.querySelector("input").value = "Diego";
    f.dispatchEvent(new Event("submit")); return 0;`);
  await new Promise((ok) => setTimeout(ok, 0));
  r = runIn(`return { nomes: window.__salvos.at(-1).map((pe) => pe.name),
             aberta: [...document.querySelectorAll(".people-item")]
               .findIndex((x) => x.querySelector(".people-form")) };`);
  check(r.nomes.join("|") === "BRUNO|Ana|Chen Wei|Diego",
        "gantt: nome novo entra no cadastro");
  check(r.aberta === 3, "gantt: e a ficha dele já abre, convidando a preencher");

  // tirar do cadastro tira da lista, não do trabalho
  runIn(`[...document.querySelectorAll(".people-row .icon-btn")][1].click(); return 0;`);
  await new Promise((ok) => setTimeout(ok, 0));
  r = runIn(`return { salvo: window.__salvos.at(-1).map((pe) => pe.name),
             assignees: state.current.tasks.map((t) => t.assignee) };`);
  check(!r.salvo.includes("Ana"), "gantt: remover tira o nome do cadastro");
  check(r.assignees.join("|") === "Ana|Ana||Chen Wei",
        "gantt: e as tarefas dela continuam com o nome dela");

  close();
}

console.log("gantt · zoom que faz o projeto caber");
{
  const { runIn, close } = loadGanttApp();

  // jsdom não tem layout: clientWidth é 0 e o "caber" não teria como medir
  // nada. O teste dá a largura, que é justamente a entrada da conta.
  // dois seeds no mesmo runIn compartilham escopo: a fábrica de tarefa vai
  // dentro de um bloco para o segundo não redeclarar o primeiro
  const seed = (largura, dias) => `
    { Object.defineProperty(el.tlBody, "clientWidth",
      { configurable: true, value: ${largura} });
    const mk = (id, name, start, dur) => ({
      id, name, start, duration: dur, assignee: "", progress: 0,
      dependencies: [], color: "", notes: "", milestone: false, parent: "",
      baseline_start: null, baseline_duration: 0, cost: 0, deadline: null,
      pinned: false });
    state.current = { id: "p1", name: "P", people: [], bands: [], markers: [],
      tasks: [mk("t1", "A", "2026-03-02", 1), mk("t2", "B", "2026-03-02", ${dias})] };
    state.cpm = { cycle: false, finish: "2026-03-02", calendar: "", pert: null,
                  byId: new Map() };
    setZoom("fit"); }`;

  let r = runIn(`${seed(1000, 200)}
    return { ppd: PPD.fit, dias: state.range.days,
             larguraSVG: Number(document.getElementById("chart").getAttribute("width")) };`);
  check(Math.abs(r.ppd * r.dias - 1000) < 1,
        "gantt: o passo do dia é a largura disponível dividida pelos dias");
  check(Math.abs(r.larguraSVG - 1000) < 1,
        "gantt: e o gráfico inteiro cabe na tela, sem rolagem horizontal");

  // um projeto curto não vira zoom de dia gigante, nem um de dez anos vira
  // um traço. (A janela desenhada sempre inclui HOJE com folga, então o vão
  // mínimo é da ordem de dois meses — daí a tela larguíssima aqui.)
  r = runIn(`${seed(9000, 1)} const curto = PPD.fit;
    ${seed(200, 4000)} return { curto, longo: PPD.fit, dias: state.range.days };`);
  check(r.curto === 36, "gantt: projeto curto para no teto do passo (zoom de dia)");
  check(r.longo === 0.6, "gantt: projeto longuíssimo para no piso, em vez de sumir");

  // a régua troca de granularidade pelo ESPAÇO, não pelo nome do zoom
  r = runIn(`${seed(1000, 200)}
    const apertado = { celulas: document.querySelectorAll("#tl-days .tl-cell").length,
                       dias: state.range.days, ppd: PPD.fit };
    ${seed(9000, 1)}
    const folgado = { celulas: document.querySelectorAll("#tl-days .tl-cell").length,
                      dias: state.range.days, ppd: PPD.fit };
    return { apertado, folgado,
             comData: !!document.querySelector("#tl-days .tl-cell").dataset.date };`);
  check(r.apertado.ppd < 20 && r.apertado.celulas < r.apertado.dias / 5,
        "gantt: com pouco espaço a régua mostra semanas, não dias");
  check(r.folgado.ppd >= 20 && r.folgado.celulas === r.folgado.dias,
        "gantt: com espaço de sobra ela volta a mostrar um dia por coluna");
  check(r.comData === true, "gantt: e as colunas continuam dizendo que dia são");

  // "caber" não rola para hoje: rolar seria desfazer o que o botão fez
  r = runIn(`${seed(1000, 200)}
    el.tlBody.scrollLeft = 0;
    setZoom("fit");
    const depoisDoCaber = el.tlBody.scrollLeft;
    setZoom("week");
    return { depoisDoCaber, depoisDaSemana: el.tlBody.scrollLeft,
             guardado: localStorage.getItem("perth-zoom") };`);
  check(r.depoisDoCaber === 0, "gantt: caber não mexe na rolagem");
  check(r.depoisDaSemana !== 0, "gantt: mas os zooms de passo fixo ainda vão para hoje");
  check(r.guardado === "week", "gantt: e o zoom escolhido é lembrado");

  await new Promise((ok) => setTimeout(ok, 0));
  close();
}

console.log("gantt · ligar tarefas arrastando");
{
  const { runIn, close } = loadGanttApp();

  // Estrutura(resumo) > Fundação, Alvenaria ; e três tarefas soltas
  const seed = `
    const mk = (id, name, start, dur, parent = "") => ({
      id, name, start, duration: dur, assignee: "", progress: 0,
      dependencies: [], color: "", notes: "", milestone: false, parent,
      baseline_start: null, baseline_duration: 0, cost: 0, deadline: null,
      pinned: false });
    window.__salvo = 0;
    window.markDirty = () => { window.__salvo++; };
    state.current = { id: "p1", name: "P", people: [], bands: [], markers: [],
      tasks: [
        mk("pai", "Estrutura", "2026-03-02", 1),
        mk("f1", "Fundação", "2026-03-02", 5, "pai"),
        mk("f2", "Alvenaria", "2026-03-09", 5, "pai"),
        mk("t1", "Telhado", "2026-03-16", 4),
        mk("t2", "Pintura", "2026-03-23", 3),
        mk("t3", "Limpeza", "2026-03-30", 2)] };
    state.cpm = { cycle: false, finish: "2026-04-01", calendar: "", pert: null,
                  byId: new Map() };
    renderAll();`;

  // o gesto: pointerdown no ponto, pointermove/up sobre a outra barra. O
  // alvo é resolvido por formaSobOPonteiro, então o teste troca
  // elementsFromPoint por uma função que devolve a barra pedida — jsdom não
  // tem layout, e sem isso o teste estaria medindo o nada.
  const arrastar = (deId, paraId, lado = "right") => `
    { // selectTask alterna; aqui o teste quer POR a seleção onde ela deve
      // estar, não brincar de liga-desliga
      state.selected = ${JSON.stringify(deId)};
      renderTable(); renderChart();
      document.elementsFromPoint = () => [
        document.querySelector(\`#chart [data-id="${paraId}"]\`)];
      const dot = [...document.querySelectorAll("#chart .link-dot")]
        .find((d) => d.dataset.side === ${JSON.stringify(lado)});
      dot.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })); }`;

  const avisos = `[...document.querySelectorAll("#perth-toasts > *")]
    .map((t) => t.textContent.replace("✕", ""))`;
  const deps = `state.current.tasks.map((t) => t.name + ":" +
    (t.dependencies || []).map((d) => state.current.tasks
      .find((x) => x.id === depId(d)).name).join("+")).filter((l) => !l.endsWith(":"))`;

  // os pontos só existem na barra SELECIONADA: um ponto por barra competiria
  // com o arrasto e com o punho de redimensionar, que moram nos mesmos pixels
  let r = runIn(`${seed} return { semSel: document.querySelectorAll(".link-dot").length,
    comSel: (selectTask("t1"), document.querySelectorAll(".link-dot").length),
    lados: [...document.querySelectorAll(".link-dot")].map((d) => d.dataset.side) };`);
  check(r.semSel === 0, "gantt: sem seleção não há ponto de ligação na tela");
  check(r.comSel === 2 && r.lados.join("|") === "left|right",
        "gantt: a barra selecionada mostra um ponto em cada ponta");

  // ponta direita: "esta alimenta a próxima"
  r = runIn(`${arrastar("t1", "t2")} return { deps: ${deps}, salvo: window.__salvo };`);
  check(r.deps.join("|") === "Pintura:Telhado",
        "gantt: arrastar da ponta direita cria término→início na outra tarefa");
  check(r.salvo === 1, "gantt: e a ligação é gravada (markDirty)");

  // ponta esquerda: "esta vem depois daquela" — mesma ligação, cadeia
  // montada de trás para frente
  r = runIn(`${arrastar("t3", "t2", "left")} return ${deps};`);
  check(r.join("|") === "Pintura:Telhado|Limpeza:Pintura",
        "gantt: arrastar da ponta esquerda liga na direção contrária");

  // as quatro recusas, cada uma com o seu motivo na tela
  r = runIn(`PerthToast.clear(); ${arrastar("t1", "t2")} return { deps: ${deps}, avisos: ${avisos} };`);
  check(r.deps.length === 2 && /Already linked/.test(r.avisos[0]),
        "gantt: ligar duas vezes não duplica — e diz por quê");

  r = runIn(`PerthToast.clear(); ${arrastar("t2", "t1")} return { deps: ${deps}, avisos: ${avisos} };`);
  check(r.deps.length === 2 && /close a loop/.test(r.avisos[0]),
        "gantt: a ligação que fecharia um ciclo é recusada antes de gravar");

  r = runIn(`PerthToast.clear(); ${arrastar("t1", "pai")} return { deps: ${deps}, avisos: ${avisos} };`);
  check(r.deps.length === 2 && /summary is scheduled/.test(r.avisos[0]),
        "gantt: resumo como sucessor é recusado — quem agenda são as folhas");

  r = runIn(`PerthToast.clear(); ${arrastar("pai", "f1")} return { deps: ${deps}, avisos: ${avisos} };`);
  check(r.deps.length === 2 && /own block/.test(r.avisos[0]),
        "gantt: uma tarefa não depende do próprio bloco");

  // resumo PODE ser predecessor: o fim dele é o fim do bloco
  r = runIn(`PerthToast.clear(); ${arrastar("pai", "t3")} return ${deps};`);
  check(r.some((l) => l === "Limpeza:Pintura+Estrutura"),
        "gantt: mas um resumo pode ser predecessor de quem vem depois do bloco");

  // e o desfazer alcança a ligação, como qualquer edição
  r = runIn(`undo(); return ${deps};`);
  check(!r.some((l) => /Estrutura/.test(l)), "gantt: Ctrl+Z desfaz a ligação");

  // criar com a mão e ter que abrir o modal para desfazer seria dar a ida
  // sem a volta: duplo clique na seta remove
  r = runIn(`const alvo = document.querySelector("#chart .dep-hit");
    alvo.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    return { deps: ${deps}, dicas: alvo.querySelector("title")?.textContent };`);
  check(r.deps.length === 1, "gantt: duplo clique na seta remove a dependência");
  check(/Double-click to remove/.test(r.dicas || ""),
        "gantt: e a seta diz isso ao passar o mouse");

  await new Promise((ok) => setTimeout(ok, 0));
  close();
}

console.log("gantt · arrastar a divisa da tabela");
{
  const { runIn, close } = loadGanttApp();

  // MouseEvent no lugar de PointerEvent: o handler só lê clientX, e assim o
  // teste não depende de o jsdom implementar PointerEvent
  const arrastar = (de, ate) => `
    { const a = document.getElementById("tt-resizer");
      const ev = (t, x) => a.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: x }));
      ev("pointerdown", ${de}); ev("pointermove", ${ate}); ev("pointerup", ${ate}); }`;

  let r = runIn(`setTableWidth(400);
    ${arrastar(400, 520)}
    return { largura: ui.tableWidth,
             regua: Number(document.getElementById("set-tablew").value),
             css: document.documentElement.style.getPropertyValue("--table-w") };`);
  check(r.largura === 520, "gantt: arrastar a divisa muda a largura da tabela");
  check(r.regua === 520, "gantt: e a régua das configurações anda junto");
  check(r.css === "520px", "gantt: a largura vai para a variável do CSS");

  // limites e passo saem da PRÓPRIA régua: dois lugares com o mesmo número
  // escrito à mão é um lugar que fica para trás
  r = runIn(`const reg = document.getElementById("set-tablew");
    setTableWidth(400);
    ${arrastar(400, 4000)}
    const cheio = ui.tableWidth;
    setTableWidth(400);
    ${arrastar(400, -4000)}
    return { cheio, vazio: ui.tableWidth,
             min: Number(reg.min), max: Number(reg.max) };`);
  check(r.cheio === r.max && r.vazio === r.min,
        "gantt: o arrasto para nos limites da régua, não em números próprios");

  r = runIn(`setTableWidth(400); ${arrastar(400, 437)}
    return { largura: ui.tableWidth,
             regua: Number(document.getElementById("set-tablew").value) };`);
  check(r.largura === 440 && r.regua === 440,
        "gantt: a largura anda no passo da régua — fora do passo os dois discordariam");

  // duplo clique volta ao padrão
  r = runIn(`document.getElementById("tt-resizer")
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    return ui.tableWidth;`);
  check(r === 380, "gantt: duplo clique na divisa volta à largura padrão");

  // e o teclado, já que a divisa tem foco
  r = runIn(`const a = document.getElementById("tt-resizer");
    a.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const dir = ui.tableWidth;
    a.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    return { dir, esq: ui.tableWidth };`);
  check(r.dir === 390 && r.esq === 380,
        "gantt: as setas movem a divisa um passo por vez");

  // o que foi arrastado fica guardado, como o tema e a densidade
  r = runIn(`return JSON.parse(localStorage.getItem("perth-ui")).tableWidth;`);
  check(r === 380, "gantt: a largura escolhida é lembrada no navegador");

  await new Promise((ok) => setTimeout(ok, 0));
  close();
}

console.log("gantt · andar pelo plano com o teclado");
{
  const { runIn, close } = loadGanttApp();
  // deixa o init() assíncrono assentar antes de mexer (e antes de fechar):
  // fechar a janela com ele pendente derruba o arquivo inteiro
  await new Promise((r) => setTimeout(r, 50));
  const seed = `
    const mk = (id, name, start, extra) => Object.assign({
      id, name, start, duration: 3, assignee: "", progress: 0, dependencies: [],
      color: "", notes: "", milestone: false, parent: "", cost: 0,
      baseline_start: null, baseline_duration: 0, deadline: null, pinned: false }, extra || {});
    state.current = { id: "pk", name: "P", people: [], bands: [], markers: [], tasks: [
      mk("f1", "Fase 1", "2026-03-02"),
      mk("a", "A", "2026-03-02", { parent: "f1" }),
      mk("b", "B", "2026-03-05", { parent: "f1" }),
      mk("f2", "Fase 2", "2026-03-10"),
      mk("c", "C", "2026-03-10", { parent: "f2" }) ] };
    state.cpm = { cycle: false, finish: "2026-03-13", calendar: "", pert: null, byId: new Map() };
    state.selected = null;
    renderAll();`;
  const tecla = (k) => `document.dispatchEvent(new KeyboardEvent("keydown", { key: "${k}", bubbles: true, cancelable: true }));`;

  // ↓ sem nada selecionado entra pelo topo; ↑ entraria pelo fim
  let r = runIn(`${seed} ${tecla("ArrowDown")} return state.selected;`);
  check(r === "f1", "gantt: ↓ sem seleção começa pela primeira linha");
  r = runIn(`${seed} ${tecla("ArrowUp")} return state.selected;`);
  check(r === "c", "gantt: ↑ sem seleção começa pela última");

  // anda pelas linhas VISÍVEIS, na ordem da tela
  r = runIn(`${seed} state.selected = "f1";
    ${tecla("ArrowDown")} ${tecla("ArrowDown")} return state.selected;`);
  check(r === "b", "gantt: ↓↓ desce duas linhas");
  r = runIn(`${seed} state.selected = "c"; ${tecla("Home")} return state.selected;`);
  check(r === "f1", "gantt: Home vai para a primeira");
  r = runIn(`${seed} state.selected = "f1"; ${tecla("End")} return state.selected;`);
  check(r === "c", "gantt: End vai para a última");

  // nas pontas, para — em vez de dar a volta e desorientar
  r = runIn(`${seed} state.selected = "c"; ${tecla("ArrowDown")} return state.selected;`);
  check(r === "c", "gantt: ↓ na última linha não dá a volta");

  // ← fecha o resumo; a linha recolhida some da lista e ↓ pula a subárvore
  r = runIn(`${seed} state.selected = "f1"; ${tecla("ArrowLeft")}
    return { fechado: state.wbsClosed.has("f1"),
             visiveis: displayRows().filter(x => x.kind === "task").length };`);
  check(r.fechado === true && r.visiveis === 3,
        "gantt: ← fecha o resumo e a subárvore sai da lista");
  r = runIn(`${seed} state.selected = "f1"; ${tecla("ArrowLeft")} ${tecla("ArrowRight")}
    return { fechado: state.wbsClosed.has("f1"),
             visiveis: displayRows().filter(x => x.kind === "task").length };`);
  check(r.fechado === false && r.visiveis === 5, "gantt: → abre de novo");

  // ← numa folha sobe para o pai, como em qualquer árvore de arquivos
  r = runIn(`${seed} state.selected = "b"; ${tecla("ArrowLeft")} return state.selected;`);
  check(r === "f1", "gantt: ← numa folha sobe para o pai");

  // digitando, as setas são do campo — não do plano
  r = runIn(`${seed} state.selected = "f1";
    el.taskSearch.focus();
    ${tecla("ArrowDown")}
    return state.selected;`);
  check(r === "f1", "gantt: com o foco num campo, as setas não movem a seleção");
  close();
}

console.log("gantt · o que está dobrado é lembrado");
{
  const { runIn, close } = loadGanttApp();
  // deixa o init() assíncrono assentar antes de mexer (e antes de fechar):
  // fechar a janela com ele pendente derruba o arquivo inteiro
  await new Promise((r) => setTimeout(r, 50));
  const seed = `
    const mk = (id, name, extra) => Object.assign({
      id, name, start: "2026-03-02", duration: 3, assignee: "", progress: 0,
      dependencies: [], color: "", notes: "", milestone: false, parent: "",
      cost: 0, baseline_start: null, baseline_duration: 0, deadline: null,
      pinned: false }, extra || {});
    localStorage.clear();
    // a janela do jsdom é a MESMA entre os runIn deste bloco: sem zerar aqui,
    // o teste seguinte herda o que o anterior dobrou
    state.wbsClosed.clear();
    state.lanesClosed.clear();
    state.current = { id: "pd", name: "P", people: [], bands: [], markers: [], tasks: [
      mk("f1", "Fase 1"), mk("a", "A", { parent: "f1" }), mk("b", "B", { parent: "f1" }) ] };
    state.cpm = { cycle: false, finish: "2026-03-05", calendar: "", pert: null, byId: new Map() };
    renderAll();`;

  let r = runIn(`${seed} toggleSummary("f1");
    return JSON.parse(localStorage.getItem("perth-folds-pd"));`);
  check(r && r.wbs.length === 1 && r.wbs[0] === "f1",
        "gantt: dobrar um resumo escreve no armazenamento do navegador");

  // abrir de novo apaga a chave: preferência vazia não precisa ocupar espaço
  r = runIn(`${seed} toggleSummary("f1"); toggleSummary("f1");
    return localStorage.getItem("perth-folds-pd");`);
  check(r === null, "gantt: desdobrar tudo apaga a chave em vez de guardar vazio");

  // é o que faz o F5 (e a volta do kanban) devolverem o plano como estava
  r = runIn(`${seed}
    localStorage.setItem("perth-folds-pd", JSON.stringify({ wbs: ["f1"], lanes: [] }));
    restauraDobras(state.current); renderAll();
    return { fechado: state.wbsClosed.has("f1"),
             visiveis: displayRows().filter(x => x.kind === "task").length };`);
  check(r.fechado === true && r.visiveis === 1,
        "gantt: ao abrir o projeto, o que estava dobrado volta dobrado");

  // id que não existe mais não pode continuar dobrando nada
  r = runIn(`${seed}
    localStorage.setItem("perth-folds-pd", JSON.stringify({ wbs: ["f1", "apagada"], lanes: [] }));
    restauraDobras(state.current);
    return [...state.wbsClosed];`);
  check(r.length === 1 && r[0] === "f1",
        "gantt: id de tarefa que não existe mais é descartado na volta");

  // e é POR PROJETO: "Fase 1" fechada aqui não fecha nada no projeto seguinte
  r = runIn(`${seed} toggleSummary("f1");
    state.current = { ...state.current, id: "outro" };
    restauraDobras(state.current);
    return [...state.wbsClosed];`);
  check(r.length === 0, "gantt: o que está dobrado é de um projeto só");
  close();
}

console.log("gantt · recolher um resumo de WBS");
{
  const { runIn, close } = loadGanttApp();

  // avó → mãe → filha, para provar que recolher pega a subárvore inteira e
  // não só os filhos diretos
  const seed = `
    const mk = (id, name, start, dur, parent = "") => ({
      id, name, start, duration: dur, assignee: "", progress: 0,
      dependencies: [], color: "", notes: "", milestone: false, parent,
      baseline_start: null, baseline_duration: 0, cost: 0, deadline: null,
      pinned: false });
    state.current = { id: "p1", name: "P", people: [], bands: [], markers: [],
      tasks: [
        mk("t0", "Projeto", "2026-03-02", 5),
        mk("pai", "Estrutura", "2026-03-09", 1),
        mk("meio", "Fundação", "2026-03-09", 8, "pai"),
        mk("neta", "Sapata", "2026-03-09", 3, "meio"),
        mk("fim", "Pintura", "2026-04-17", 4)] };
    state.cpm = { cycle: false, finish: "2026-04-20", calendar: "", pert: null,
                  byId: new Map() };
    renderAll();`;

  const nomes = `[...document.querySelectorAll("#task-rows .tt-row .c-name")]
    .map((x) => x.textContent.trim())`;

  let r = runIn(`${seed} return ${nomes};`);
  check(r.join("|") === "Projeto|▾Estrutura|▾Fundação|Sapata|Pintura",
        "gantt: a árvore inteira aparece, com seta em cada resumo");

  // clicar na seta recolhe — e NÃO seleciona a tarefa: o clique na seta é
  // sobre a árvore, o clique na linha é sobre a tarefa
  r = runIn(`document.querySelector(".tt-row .sum-mark").click();
    return { nomes: ${nomes}, sel: state.selected,
             marca: document.querySelector(".tt-row .sum-mark").textContent };`);
  check(!r.nomes.some((n) => /Fundação|Sapata/.test(n)),
        "gantt: recolher esconde a subárvore inteira, não só os filhos diretos");
  check(r.sel === null, "gantt: e não seleciona a tarefa do resumo");
  check(r.marca === "▸", "gantt: a seta vira ▸");

  // o colchete continua no gráfico: recolher esconde as tarefas, não o
  // período que elas ocupam
  r = runIn(`return { colchetes: document.querySelectorAll("#chart .bar-summary").length,
             barras: document.querySelectorAll("#chart .bar").length };`);
  check(r.colchetes === 1 && r.barras === 2,
        "gantt: o colchete do resumo fica, as barras de dentro saem");

  // buscar tem que ALCANÇAR o que está recolhido
  r = runIn(`el.taskSearch.value = "sapata";
    el.taskSearch.dispatchEvent(new Event("input"));
    el.taskSearch.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return { nomes: ${nomes}, sel: state.selected, conta: el.taskSearchCount.textContent };`);
  check(r.nomes.some((n) => /Sapata/.test(n)) && r.sel === "neta",
        "gantt: buscar dentro de um resumo recolhido abre o resumo");
  check(r.conta === "1/1", "gantt: e a busca conta a tarefa escondida");

  // trocar de projeto não leva o que estava recolhido junto
  r = runIn(`el.taskSearch.value = "";
    el.taskSearch.dispatchEvent(new Event("input"));
    document.querySelector(".tt-row .sum-mark").click();
    const antes = state.wbsClosed.size;
    state.lanesClosed.clear(); state.wbsClosed.clear();   // o que openProject faz
    return { antes, depois: state.wbsClosed.size };`);
  check(r.antes === 1 && r.depois === 0,
        "gantt: o que está recolhido é sobre AQUELE projeto");

  await new Promise((ok) => setTimeout(ok, 0));
  close();
}

console.log("gantt · raias por responsável");
{
  const { runIn, close } = loadGanttApp();

  const seed = `
    const mk = (id, name, start, dur, assignee, extra = {}) => ({
      id, name, start, duration: dur, assignee, progress: 0, dependencies: [],
      color: "", notes: "", milestone: false, parent: "", baseline_start: null,
      baseline_duration: 0, cost: 0, deadline: null, pinned: false, ...extra });
    state.current = { id: "p1", name: "P", people: [
        { name: "Ana", role: "Arquiteta", team: "Projetos", email: "", notes: "" },
        { name: "Bruno", role: "Eletricista", team: "Obra", email: "", notes: "" }],
      tasks: [
        mk("pai", "Estrutura", "2026-03-02", 12, ""),
        mk("t1", "Fundação", "2026-03-02", 5, "Ana", { parent: "pai" }),
        mk("t2", "Alvenaria", "2026-03-09", 5, "Bruno", { parent: "pai" }),
        mk("t3", "Pintura", "2026-03-16", 3, "Ana"),
        mk("t4", "Telhado", "2026-03-20", 2, "")] };
    state.cpm = { cycle: false, finish: "2026-03-21", calendar: "", pert: null,
                  byId: new Map() };
    renderAll();`;

  const linhas = `[...document.querySelectorAll("#task-rows > div")]
    .map((d) => (d.className.split(" ")[0] === "tt-lane"
      ? "lane:" + d.querySelector(".lane-name").textContent + ":" +
        d.querySelector(".lane-count").textContent
      : "task:" + d.querySelector(".c-name").textContent))`;

  // sem raias, a tela é a ordem do projeto e nada mais
  let r = runIn(`${seed} return ${linhas};`);
  check(r.join("|") === "task:▾Estrutura|task:Fundação|task:Alvenaria|task:Pintura|task:Telhado",
        "gantt: sem agrupamento, as linhas são as tarefas do projeto");

  const agrupar = (modo) => `el.groupSelect.value = ${JSON.stringify(modo)};
    el.groupSelect.dispatchEvent(new Event("change"));`;

  r = runIn(`${agrupar("assignee")} return ${linhas};`);
  check(r.join("|") === "lane:Ana:2|task:Fundação|task:Pintura|lane:Bruno:1|" +
        "task:Alvenaria|lane:(unassigned):1|task:Telhado",
        "gantt: raias em ordem alfabética, sem responsável por último");
  // Um resumo é o colchete de filhos que podem ser de gente diferente:
  // pendurá-lo numa raia diria que aquela pessoa é dona do bloco inteiro
  check(!r.some((x) => /Estrutura/.test(x)),
        "gantt: resumo de WBS não entra em raia nenhuma");

  r = runIn(`return [...document.querySelectorAll(".tt-row .c-name")]
    .map((x) => x.style.paddingLeft);`);
  check(r.every((x) => x === "0px"),
        "gantt: dentro da raia o recuo de hierarquia some — o pai está fora");

  // O invariante das duas metades: a barra tem que cair na MESMA linha do
  // nome, senão a tela mente sobre quem faz o quê
  r = runIn(`const y = (id) => +[...document.querySelectorAll("#chart .bar")]
      .find((b) => b.dataset.id === id).getAttribute("y");
    const linha = (nome) => [...document.querySelectorAll("#task-rows > div")]
      .findIndex((d) => d.textContent.includes(nome));
    return { yAlv: y("t2"), rowAlv: linha("Alvenaria"),
             yPin: y("t3"), rowPin: linha("Pintura"), h: ROW_H };`);
  check(r.yAlv === r.rowAlv * r.h + 6 && r.yPin === r.rowPin * r.h + 6,
        "gantt: a barra cai na mesma linha do nome, com raias no meio");

  // agrupar não pode repintar: a cor vem da posição no PROJETO
  const cor = `[...document.querySelectorAll("#chart .bar")]
    .find((b) => b.dataset.id === "t3").getAttribute("fill")`;
  const comRaia = runIn(`return ${cor};`);
  const semRaia = runIn(`${agrupar("")} return ${cor};`);
  check(comRaia === semRaia, "gantt: ligar a raia não muda a cor da barra");

  // recolher esconde as tarefas, não a pessoa: sobra uma barra do começo do
  // primeiro trabalho ao fim do último
  r = runIn(`${agrupar("assignee")} toggleLane("Ana");
    const roll = document.querySelector("#chart .lane-roll");
    return { linhas: ${linhas}, x: +roll.getAttribute("x"),
             w: +roll.getAttribute("width"),
             x0: xOf(parseDate("2026-03-02")),
             x1: xOf(parseDate("2026-03-18")) + PPD[state.zoom] };`);
  check(!r.linhas.includes("task:Fundação") && !r.linhas.includes("task:Pintura"),
        "gantt: raia recolhida esconde as tarefas dela");
  check(r.linhas[0] === "lane:Ana:2", "gantt: e o cabeçalho continua contando 2");
  check(r.x === r.x0 && r.x + r.w === r.x1,
        "gantt: a barra da raia recolhida vai do primeiro dia ao último");

  // seta entre raias existe; com uma ponta recolhida, some — apontar para
  // uma linha que não está na tela é pior do que seta nenhuma
  r = runIn(`toggleLane("Ana");
    state.current.tasks.find((t) => t.id === "t2").dependencies = ["t1"];
    renderChart();
    const antes = document.querySelectorAll("#chart .dep").length;
    toggleLane("Ana");
    return { antes, depois: document.querySelectorAll("#chart .dep").length };`);
  check(r.antes === 1 && r.depois === 0,
        "gantt: seta de dependência some quando uma ponta está numa raia fechada");

  // buscar tem que ALCANÇAR: se a tarefa está numa raia fechada, a raia abre
  r = runIn(`state.current.tasks.find((t) => t.id === "t2").dependencies = [];
    el.taskSearch.value = "fund";
    el.taskSearch.dispatchEvent(new Event("input"));
    el.taskSearch.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return { linhas: ${linhas}, conta: el.taskSearchCount.textContent,
             sel: state.selected };`);
  check(r.linhas.includes("task:Fundação") && r.sel === "t1",
        "gantt: buscar numa raia fechada abre a raia e seleciona a tarefa");
  check(r.conta === "1/1", "gantt: e a contagem bate com o que dá para alcançar");

  // o resumo escondido não pode entrar na contagem: ela promete que dá para
  // chegar em todas as ocorrências
  r = runIn(`el.taskSearch.value = "estrutura";
    el.taskSearch.dispatchEvent(new Event("input"));
    return el.taskSearchCount.textContent;`);
  check(r === "0/0", "gantt: resumo escondido pela raia não conta como ocorrência");

  // por setor: a raia sai da FICHA da pessoa, não da tarefa
  r = runIn(`el.taskSearch.value = "";
    el.taskSearch.dispatchEvent(new Event("input"));
    ${agrupar("team")} return ${linhas};`);
  check(r.join("|") === "lane:Obra:1|task:Alvenaria|lane:Projetos:2|task:Fundação|" +
        "task:Pintura|lane:(no team):1|task:Telhado",
        "gantt: raias por setor vêm do cadastro de colaboradores");

  // O init() do app é assíncrono e continua pendente enquanto o bloco roda
  // só com runIn síncrono. Fechar a janela com ele pendente não dá erro
  // AQUI: ele acorda no primeiro await do bloco SEGUINTE, já sem document, e
  // derruba a suíte num lugar que não tem nada a ver. Ceder o loop antes de
  // fechar deixa o init terminar enquanto a janela ainda existe.
  await new Promise((ok) => setTimeout(ok, 0));
  close();
}

console.log("gantt · faixas do calendário");
{
  const { runIn, close } = loadGanttApp();

  const seed = `
    window.__salvos = [];
    window.saveNowAfterDirty = async () => {
      window.__salvos.push(JSON.parse(JSON.stringify(state.current.bands)));
      // devolve o que o servidor devolveria: ordenado por início
      return { ...state.current,
               bands: [...state.current.bands].sort((a, b) => a.from < b.from ? -1 : 1) };
    };
    state.current = { id: "p1", name: "P", people: [], bands: [], tasks: [{
      id: "t1", name: "A", start: "2026-03-02", duration: 5, assignee: "",
      progress: 0, dependencies: [], color: "", notes: "", milestone: false,
      parent: "", baseline_start: null, baseline_duration: 0, cost: 0,
      deadline: null, pinned: false }] };
    state.cpm = { cycle: false, finish: "2026-03-06", calendar: "", pert: null,
                  byId: new Map() };
    renderAll();`;

  const addFaixa = (nome, de, ate) => `
    { const f = document.querySelector(".cal-add");
      const i = f.querySelectorAll("input");
      i[0].value = ${JSON.stringify(nome)};
      i[1].value = ${JSON.stringify(de)};
      i[2].value = ${JSON.stringify(ate)};
      f.dispatchEvent(new Event("submit")); }`;

  runIn(`${seed} showBands();
    ${addFaixa("Sprint 1", "2026-03-02", "2026-03-27")} return 0;`);
  await new Promise((ok) => setTimeout(ok, 0));

  // ponta invertida é engano de digitação, não plano
  runIn(`${addFaixa("Chuvas", "2026-04-20", "2026-03-25")} return 0;`);
  await new Promise((ok) => setTimeout(ok, 0));
  let r = runIn(`return window.__salvos.at(-1);`);
  check(r.length === 2, "gantt: duas edições seguidas não se atropelam");
  check(r[1].from === "2026-03-25" && r[1].to === "2026-04-20",
        "gantt: ponta invertida é virada na hora de gravar");

  // a cor sai da paleta automática e ANDA: duas faixas seguidas iguais
  // seriam duas faixas que não dá para distinguir
  check(r[0].color !== r[1].color, "gantt: cada faixa nova pega a próxima cor da paleta");

  r = runIn(`return { nomes: [...document.querySelectorAll(".cal-row .people-name")]
                        .map((x) => x.textContent),
             tipos: [...document.querySelectorAll(".cal-dot")].map((x) => x.type) };`);
  check(r.nomes.join("|") === "Sprint 1|Chuvas", "gantt: a lista mostra as faixas");
  check(r.tipos.join("|") === "color|color",
        "gantt: a bolinha da linha É o seletor de cor");

  // trocar a cor de uma faixa existente grava só isso
  r = runIn(`const dot = document.querySelector(".cal-dot");
    dot.value = "#123456";
    dot.dispatchEvent(new Event("change"));
    return 0;`);
  await new Promise((ok) => setTimeout(ok, 0));
  check(runIn(`return window.__salvos.at(-1)[0].color;`) === "#123456",
        "gantt: mudar a cor no seletor grava a faixa");

  // e a faixa aparece no gráfico, do primeiro ao último dia (fim inclusive)
  r = runIn(`renderChart();
    const b = [...document.querySelectorAll("#chart .cal-band")];
    return { n: b.length, fill: b[0].getAttribute("fill"),
             x: +b[0].getAttribute("x"), w: +b[0].getAttribute("width"),
             x0: xOf(parseDate("2026-03-02")),
             x1: xOf(parseDate("2026-03-27")) + PPD[state.zoom],
             rotulos: [...document.querySelectorAll("#chart .cal-label")]
               .map((t) => t.textContent),
             alturaDaFaixa: +b[0].getAttribute("height"),
             alturaDoGrafico: +document.getElementById("chart").getAttribute("height") };`);
  check(r.n === 2, "gantt: uma faixa desenhada para cada período");
  check(r.x === r.x0 && r.x + r.w === r.x1,
        "gantt: a faixa cobre do primeiro ao último dia, fim inclusive");
  check(r.fill === "#123456", "gantt: com a cor escolhida");
  check(r.alturaDaFaixa === r.alturaDoGrafico,
        "gantt: e vai de cima a baixo — é fundo, não mais uma barra");
  check(r.rotulos.join("|") === "Sprint 1|Chuvas", "gantt: cada faixa leva o nome");

  // faixa é anotação: não mexe em tarefa nenhuma
  check(runIn(`return state.current.tasks[0].start;`) === "2026-03-02",
        "gantt: sombrear o calendário não move tarefa");

  r = runIn(`[...document.querySelectorAll(".cal-row .icon-btn")][0].click(); return 0;`);
  await new Promise((ok) => setTimeout(ok, 0));
  check(runIn(`return window.__salvos.at(-1).map((f) => f.name).join("|");`) === "Chuvas",
        "gantt: o ✕ remove a faixa");

  await new Promise((ok) => setTimeout(ok, 0));
  close();
}

console.log("gantt · dias marcados");
{
  const { runIn, close } = loadGanttApp();

  const seed = `
    window.__salvos = [];
    window.saveNowAfterDirty = async () => {
      window.__salvos.push(JSON.parse(JSON.stringify(state.current.markers)));
      return { ...state.current,
               markers: [...state.current.markers]
                 .sort((a, b) => (a.date < b.date ? -1 : 1)) };
    };
    state.current = { id: "p1", name: "P", people: [], bands: [], markers: [],
      tasks: [{ id: "t1", name: "A", start: "2026-03-02", duration: 5,
        assignee: "", progress: 0, dependencies: [], color: "", notes: "",
        milestone: false, parent: "", baseline_start: null,
        baseline_duration: 0, cost: 0, deadline: null, pinned: false }] };
    state.cpm = { cycle: false, finish: "2026-03-06", calendar: "", pert: null,
                  byId: new Map() };
    renderAll();`;

  // O gesto: duplo clique na régua de dias abre o painel com AQUELE dia
  // posto. Digitar a data num formulário seria repetir para o computador uma
  // coisa que ele acabou de ver.
  let r = runIn(`${seed}
    const dia = 3;                    // quarto dia da janela desenhada
    const x = dia * PPD[state.zoom] + 2;
    el.tlDays.dispatchEvent(new MouseEvent("dblclick",
      { bubbles: true, clientX: x, clientY: 5 }));
    return { data: document.querySelector(".cal-add input[type=date]").value,
             esperada: fmtISO(addDays(state.range.start, dia)),
             foco: document.activeElement ===
                   document.querySelector(".cal-add input[type=text]") };`);
  check(r.data === r.esperada, "gantt: o duplo clique traz o dia que está sob o cursor");
  check(r.foco === true, "gantt: com o cursor no nome, o único campo que falta");

  runIn(`const f = document.querySelector(".cal-add");
    const i = f.querySelectorAll("input");
    i[0].value = "Entrega"; i[1].value = "2026-03-20"; i[2].value = "#cb3c33";
    f.dispatchEvent(new Event("submit")); return 0;`);
  await new Promise((ok) => setTimeout(ok, 0));
  r = runIn(`return window.__salvos.at(-1);`);
  check(r.length === 1 && r[0].name === "Entrega" && r[0].date === "2026-03-20",
        "gantt: o marco é gravado com nome, dia e cor");
  check(r[0].color === "#cb3c33", "gantt: a cor escolhida vai junto");

  // a linha: mesma ideia da linha de hoje, e no meio do dia marcado. Ela vem
  // em trechos — abre vão onde cruza um nome de tarefa —, então o que se
  // verifica é a coluna de todos eles e o alcance da soma: do topo ao pé.
  r = runIn(`renderChart();
    const ls = [...document.querySelectorAll("#chart .marker-line")];
    const rot = document.querySelector("#chart .marker-label");
    const hoje = document.querySelector("#chart .today-line");
    const todos = [...document.querySelectorAll("#chart *")];
    return { xs: ls.map(l => +l.getAttribute("x1")),
             xs2: ls.map(l => +l.getAttribute("x2")),
             esperado: xOf(parseDate("2026-03-20")) + PPD[state.zoom] / 2,
             topo: Math.min(...ls.map(l => +l.getAttribute("y1"))),
             pe: Math.max(...ls.map(l => +l.getAttribute("y2"))),
             alturaDoGrafico: +document.getElementById("chart").getAttribute("height"),
             cor: ls[0].getAttribute("stroke"), rotulo: rot.textContent,
             depoisDeHoje: todos.indexOf(hoje) > todos.indexOf(ls[0]) };`);
  check(r.xs.every((x) => x === r.esperado) && r.xs2.every((x) => x === r.esperado),
        "gantt: a linha cai no meio do dia marcado");
  check(r.topo === 0 && r.pe === r.alturaDoGrafico,
        "gantt: e atravessa o gráfico inteiro, do topo ao pé");
  check(r.cor === "#cb3c33" && r.rotulo === "Entrega",
        "gantt: com a cor e o nome do marco");
  check(r.depoisDeHoje === true,
        "gantt: desenhada por último, como a de hoje — linha de referência não passa por baixo de barra");

  // nome repetido MOVE de data em vez de duplicar
  runIn(`const f = document.querySelector(".cal-add");
    const i = f.querySelectorAll("input");
    i[0].value = "ENTREGA"; i[1].value = "2026-04-01";
    f.dispatchEvent(new Event("submit")); return 0;`);
  await new Promise((ok) => setTimeout(ok, 0));
  r = runIn(`return window.__salvos.at(-1);`);
  check(r.length === 1 && r[0].date === "2026-04-01",
        "gantt: o mesmo nome move o marco de dia, não cria outro");

  r = runIn(`return { nomes: [...document.querySelectorAll(".cal-row .people-name")]
                        .map((x) => x.textContent),
             dias: [...document.querySelectorAll(".cal-row .people-count")]
                        .map((x) => x.textContent) };`);
  check(r.nomes.join("|") === "ENTREGA" && r.dias.join("|") === "2026-04-01",
        "gantt: a lista mostra o marco com o dia dele");

  runIn(`document.querySelector(".cal-row .icon-btn").click(); return 0;`);
  await new Promise((ok) => setTimeout(ok, 0));
  check(runIn(`return window.__salvos.at(-1).length;`) === 0,
        "gantt: o ✕ remove o marco");

  await new Promise((ok) => setTimeout(ok, 0));
  close();
}

console.log("gantt · painel de estatísticas");
{
  const { runIn, close } = loadGanttApp();

  // a conta é do servidor (mesmo motor da curva-S); aqui o teste dá a
  // resposta pronta e olha o que a tela faz com ela
  const seed = `
    state.current = { id: "p1", name: "P", people: [], tasks: [] };
    // só a rota de estatísticas: deixar o stub responder a TUDO faria o
    // init do app seguir adiante e mexer no DOM depois do teste fechar a
    // janela — a rede aqui tem que continuar falhando como nos outros blocos
    window.api = async (url) => {
      if (!String(url).includes("/stats")) throw new Error("sem rede no teste");
      return {
      people: [
        { assignee: "Ana", role: "Arquiteta", team: "Projetos", tasks: 2,
          milestones: 0, effort: 10.0, done: 8.25, progress: 83,
          first: "2026-03-02", last: "2026-03-08", busy_days: 7,
          over_days: 3, late: 1 },
        { assignee: "", role: "", team: "", tasks: 1, milestones: 0,
          effort: 3.5, done: 0, progress: 0, first: "2026-04-01",
          last: "2026-04-03", busy_days: 3, over_days: 0, late: 0 }],
      teams: [
        { team: "Projetos", members: 2, people: ["Ana", "Bruno"], tasks: 2,
          milestones: 0, effort: 10.0, done: 8.25, progress: 83,
          first: "2026-03-02", last: "2026-03-08", busy_days: 7,
          over_days: 3, late: 1 }] };
    };`;

  runIn(`${seed} showStats(); return 0;`);
  await new Promise((ok) => setTimeout(ok, 0));

  let r = runIn(`return {
    cab: [...document.querySelectorAll(".stats-row.head .stats-cell")].map((c) => c.textContent),
    nomes: [...document.querySelectorAll(".stats-name")].map((x) => x.textContent),
    sub: [...document.querySelectorAll(".stats-sub")].map((x) => x.textContent),
    nums: [...document.querySelectorAll(".stats-row:not(.head)")]
      .map((l) => [...l.querySelectorAll(".stats-cell.num")].map((c) => c.textContent).join("|")),
    ruins: [...document.querySelectorAll(".stats-cell.num.bad")].map((c) => c.textContent) };`);
  check(r.cab.join("|") === "Person|tasks|effort|done|days|over|late",
        "gantt: cabeçalho com as sete colunas");
  check(r.nomes.join("|") === "Ana|(unassigned)",
        "gantt: trabalho sem dono aparece nomeado, não sumido");
  check(r.sub[0] === "Arquiteta · Projetos", "gantt: cargo e setor embaixo do nome");
  check(r.nums[0] === "2|10|83%|7|3|1",
        "gantt: 10.0 pessoa-dias vira \"10\" — casa decimal que o plano não tem");
  check(r.nums[1].startsWith("1|3.5|"), "gantt: e 3.5 continua 3.5");
  // zero é o normal em excesso e atraso: colorir tudo seria a tabela gritando
  check(r.ruins.join("|") === "3|1",
        "gantt: só sobrecarga e atraso diferentes de zero ganham cor");

  r = runIn(`const barra = document.querySelector(".stats-bar > span");
    return barra.style.width;`);
  check(r === "83%", "gantt: a barra de progresso acompanha o número");

  // a aba de setores usa a MESMA resposta: trocar de aba não vai à rede de
  // novo, e as duas leituras não podem ser de épocas diferentes
  r = runIn(`window.api = async () => { throw new Error("não devia buscar de novo"); };
    [...document.querySelectorAll(".stats-tabs button")][1].click();
    return { cab: document.querySelector(".stats-row.head .stats-cell").textContent,
             nome: document.querySelector(".stats-name").textContent,
             sub: document.querySelector(".stats-sub").textContent,
             ativa: document.querySelector(".stats-tabs .active").textContent };`);
  check(r.cab === "Team" && r.nome === "Projetos",
        "gantt: a aba de setores mostra os setores, sem nova ida à rede");
  check(r.sub === "Ana, Bruno", "gantt: e diz quem está no setor");
  check(r.ativa === "Teams", "gantt: a aba escolhida fica marcada");

  await new Promise((ok) => setTimeout(ok, 30));
  close();
}

console.log("gantt · geometria de quem não pode se sobrepor");
{
  // A regra de desenho é uma só: quem passa por cima de um texto abre vão, e
  // um texto deitado procura altura livre. Aqui vai a GEOMETRIA dela, com
  // caixas de mentira — nenhum layout é preciso, e é o que o CI roda mesmo
  // sem navegador. A conferência do resultado na tela de verdade (com fonte,
  // medida e todos os elementos juntos) está em test/browser/run.js.
  const { runIn, close } = loadGanttApp();

  const seg = (js) => runIn(`return JSON.stringify(${js});`);

  // linha limpa: um trecho só, do começo ao fim
  check(seg(`trechosVerticais(100, 0, 500, [])`) === "[[0,500]]",
        "sem rótulo no caminho, a linha é inteira");

  // rótulo no caminho: dois trechos, com folga dos dois lados
  check(seg(`trechosVerticais(100, 0, 500, [{x0: 90, x1: 140, y0: 200, y1: 220}])`)
        === "[[0,197],[223,500]]",
        "rótulo no caminho parte a linha em dois, com folga");

  // rótulo fora do x da linha não corta nada
  check(seg(`trechosVerticais(100, 0, 500, [{x0: 200, x1: 260, y0: 200, y1: 220}])`)
        === "[[0,500]]",
        "rótulo em outro x não abre vão nenhum");

  // dois rótulos, dois vãos, e a ordem em que chegam não importa
  const doisA = seg(`trechosVerticais(100, 0, 500, [
    {x0: 90, x1: 140, y0: 100, y1: 120}, {x0: 90, x1: 140, y0: 300, y1: 320}])`);
  const doisB = seg(`trechosVerticais(100, 0, 500, [
    {x0: 90, x1: 140, y0: 300, y1: 320}, {x0: 90, x1: 140, y0: 100, y1: 120}])`);
  check(doisA === "[[0,97],[123,297],[323,500]]", "dois rótulos, três trechos");
  check(doisA === doisB, "e o resultado não depende da ordem das caixas");

  // sobra de um pixel entre dois vãos é sujeira, não referência
  check(seg(`trechosVerticais(100, 0, 500, [
    {x0: 90, x1: 140, y0: 100, y1: 120}, {x0: 90, x1: 140, y0: 124, y1: 200}])`)
        === "[[0,97],[203,500]]",
        "trecho menor que 2px entre dois vãos não é desenhado");

  // a caixa do texto deitado é assimétrica: o glifo fica à DIREITA da âncora
  // (medido na tela). Seis pixels de erro aqui foi a linha do dia marcado
  // voltando a comer o próprio nome.
  const cd = JSON.parse(seg(`caixaDeitada(100, 20, 60)`));
  check(cd.x0 === 97 && cd.x1 === 111, "o texto deitado ocupa de x-3 a x+11");
  check(cd.y0 === 20 && cd.y1 === 80, "e desce o comprimento inteiro a partir do y");

  // altura livre: desce até achar espaço, e devolve o topo quando está limpo
  check(runIn(`return alturaLivre(100, 40, 600, []);`) === 10,
        "sem nada no caminho, o nome deitado fica no topo");
  const ocupado = `[{x0: 95, x1: 130, y0: 0, y1: 120}]`;
  const y = runIn(`return alturaLivre(100, 40, 600, ${ocupado});`);
  check(y > 120 - 40, `o nome desce para depois do que ocupa o topo (y = ${y})`);

  // ...e "o que ocupa" inclui DESENHO, não só texto: a primeira versão só
  // desviava de texto e pousava o nome em cima de uma barra
  const so_barra = runIn(`return alturaLivre(100, 40, 600, [{x0: 95, x1: 130, y0: 0, y1: 300}]);`);
  check(so_barra > 260, "caixa de barra também empurra o nome para baixo");

  // sem lugar livre nenhum, fica no menos ruim em vez de sumir
  const semSaida = runIn(`return alturaLivre(100, 40, 200, [{x0: 0, x1: 999, y0: 0, y1: 999}]);`);
  check(typeof semSaida === "number" && semSaida >= 10,
        "sem altura livre em lugar nenhum, o nome ainda é desenhado");

  close();
}

console.log("gantt · painel de recursos");
{
  const { runIn, close } = loadGanttApp();

  // Payload como o /api/projects/{id}/workload devolve: janela contígua de
  // dias + um vetor de carga por pessoa. O teste alimenta o render direto,
  // sem rede, e olha o DOM que sai.
  const seed = `
    const mk = (id, name, start, duration, assignee) => ({
      id, name, start, duration, assignee, progress: 0, dependencies: [],
      color: "", notes: "", milestone: false, parent: "",
      baseline_start: null, baseline_duration: 0, cost: 0 });
    state.current = { id: "p1", name: "P", tasks: [
      mk("t1", "A", "2026-03-02", 5, "Ana"),
      mk("t2", "B", "2026-03-04", 3, "Ana"),
      mk("t3", "C", "2026-03-02", 2, "") ] };
    state.resOpen = true;
    document.getElementById("res-pane").hidden = false;
    state.resources = { start: "2026-03-02", days: 6, calendar: "", people: [
      { assignee: "", load: [1, 1, 0, 0, 0, 0], effort: [1, 1, 0, 0, 0, 0],
        peak: 1, busy_days: 2, over_days: 0, total_effort: 2,
        tasks: [{ id: "t3", name: "C", from: "2026-03-02", to: "2026-03-03" }] },
      { assignee: "Ana", load: [1, 1, 2, 2, 1, 0], effort: [1, 1, 2, 2, 1, 0],
        peak: 2, busy_days: 5, over_days: 2, total_effort: 7,
        tasks: [{ id: "t1", name: "A", from: "2026-03-02", to: "2026-03-06" },
                { id: "t2", name: "B", from: "2026-03-04", to: "2026-03-06" }] } ] };
    renderAll();`;

  let r = runIn(`${seed}
    const rows = [...document.querySelectorAll("#res-names .res-row")];
    const cells = [...document.querySelectorAll("#res-chart .res-cell")];
    return {
      names: rows.map((x) => x.querySelector(".res-who").textContent),
      stats: rows.map((x) => x.querySelector(".res-stat").textContent),
      tiers: cells.map((c) => c.getAttribute("class")),
      xs: cells.map((c) => Number(c.getAttribute("x"))),
      ws: cells.map((c) => Number(c.getAttribute("width"))),
      tip: cells[cells.length - 2].querySelector("title").textContent,
      chartW: Number(document.getElementById("res-chart").getAttribute("width")),
      ppd: PPD[state.zoom], days: state.range.days };`);

  check(r.names.join("|") === "Ana|(unassigned)",
        "gantt: pessoas em ordem, sem responsável por último");
  check(r.stats[0].startsWith("5d") && r.stats[0].includes("2"),
        "gantt: dias ocupados e dias em excesso na coluna de nomes");
  // Ana = [1,1,2,2,1,0] → três blocos (1, 2, 1); "sem responsável" = um só
  check(r.tiers.join("|") === "res-cell l1|res-cell l2|res-cell l1|res-cell l1",
        "gantt: dias vizinhos de carga igual viram um bloco, com a faixa certa");
  check(r.ws[0] === 2 * r.ppd && r.ws[1] === 2 * r.ppd && r.ws[2] === r.ppd,
        "gantt: largura do bloco = dias corridos × pixels por dia");
  check(r.xs[1] - r.xs[0] === 2 * r.ppd, "gantt: blocos na escala de tempo do gantt");
  check(r.chartW === r.days * r.ppd,
        "gantt: SVG tem a MESMA largura da timeline (colunas alinhadas)");
  check(/Ana/.test(r.tip) && /A/.test(r.tip) && /B/.test(r.tip),
        "gantt: tooltip nomeia as tarefas que se cruzam no bloco");

  // Clicar na pessoa é o motivo de o painel ser docado: destaca as tarefas
  // dela no gantt acima, reusando o mesmo highlight do seletor da toolbar
  r = runIn(`document.querySelectorAll("#res-names .res-row")[0].click();
    return { hl: state.highlight,
             sel: document.getElementById("highlight-select").value,
             dim: [...document.querySelectorAll(".tt-row")]
                    .map((x) => x.dataset.id + ":" + x.className.includes("dim")),
             on: document.querySelectorAll("#res-names .res-row.on").length };`);
  check(r.hl && r.hl.kind === "assignee" && r.hl.value === "Ana",
        "gantt: clicar na faixa destaca as tarefas da pessoa");
  check(r.sel === "assignee:Ana", "gantt: e o seletor da toolbar acompanha");
  // t1/t2 são da Ana, t3 não tem dono (a ordem das linhas é a da tabela)
  check(r.dim.sort().join(",") === "t1:false,t2:false,t3:true",
        "gantt: só as tarefas dela ficam acesas");
  check(r.on === 1, "gantt: a faixa clicada fica marcada");

  r = runIn(`document.querySelectorAll("#res-names .res-row")[0].click();
    return { hl: state.highlight, on: document.querySelectorAll(".res-row.on").length };`);
  check(r.hl === null && r.on === 0, "gantt: clicar de novo desliga o destaque");

  // "sem responsável" reusa o status que já existia no seletor
  r = runIn(`document.querySelectorAll("#res-names .res-row")[1].click();
    return state.highlight;`);
  check(r && r.kind === "status" && r.value === "unassigned",
        "gantt: faixa sem responsável destaca as tarefas sem dono");

  // R fecha o painel; fechado, nada é renderizado
  r = runIn(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
    return { open: state.resOpen, hidden: document.getElementById("res-pane").hidden };`);
  check(r.open === false && r.hidden === true, "gantt: R fecha o painel");

  close();
}

})().then(() => {
  console.log(failures ? `\n${failures} falha(s)` : "\nTodos os testes passaram.");
  process.exit(failures ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
