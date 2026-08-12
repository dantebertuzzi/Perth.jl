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
function loadGanttApp() {
  const html = read("frontend/index.html")
    .replace(/<script src="\/shared\/presence.js"><\/script>/, "")
    .replace(/<script src="\/app.js"><\/script>/, "");
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
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
  w.fetch = () => Promise.reject(new Error("fetch disabled in test"));
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.structuredClone = structuredClone;
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
  window.fetch = (url, opts) => {
    if (opts && opts.method === "POST") {
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

})().then(() => {
  console.log(failures ? `\n${failures} falha(s)` : "\nTodos os testes passaram.");
  process.exit(failures ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
