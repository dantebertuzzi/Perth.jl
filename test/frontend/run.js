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
  delete w.CSS;                 // idem loadKanbanApp: espelha o jsdom do CI
  w.console.error = () => {};   // init() loga o fetch rejeitado de propósito acima; ruído esperado

  const inject = (code) => {
    const s = w.document.createElement("script");
    s.textContent = code;
    w.document.head.appendChild(s);
  };
  inject(read("frontend/shared/i18n.js"));
  inject(read("frontend/shared/presence.js"));
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
    const t = document.getElementById("hide-bg-toggle");
    t.checked = true;
    t.dispatchEvent(new Event("change"));
    return { has: document.documentElement.classList.contains("has-bg"),
             guardado: localStorage.getItem("perth-kanban-hide-background"),
             servidor: bgInfo.set };`);
  check(r.has === false, "kanban: esconder tira a camada deste navegador");
  check(r.guardado === "on", "kanban: e a preferência persiste no localStorage");
  check(r.servidor === true, "kanban: sem mexer no que o servidor manda");

  r = runIn(`const t = document.getElementById("hide-bg-toggle");
    t.checked = false;
    t.dispatchEvent(new Event("change"));
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
    const t = document.getElementById("hide-new-toggle");
    t.checked = true;
    t.dispatchEvent(new Event("change"));
    return { classe: document.documentElement.classList.contains("hide-new-badges"),
             guardado: localStorage.getItem("perth-kanban-hide-new"),
             nodom: ${has("hoje")},
             carimbo: state.board.columns[0].cards[0].at };`);
  check(r.classe === true, "esconder marca a classe no <html>");
  check(r.guardado === "on", "e a preferência persiste no localStorage");
  check(r.nodom === true && !!r.carimbo,
        "o CSS é que esconde: o nó e o carimbo do board continuam intactos");

  r = runIn(`const t = document.getElementById("hide-new-toggle");
    t.checked = false;
    t.dispatchEvent(new Event("change"));
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
