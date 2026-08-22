/* kanban · cliente colaborativo
 *
 * Modelo de sincronização: o servidor é a autoridade. Cada ação é aplicada
 * localmente na hora (otimismo, zero latência percebida) e enviada como op;
 * todo broadcast do servidor traz o board completo, então qualquer
 * divergência dura no máximo uma mensagem.
 *
 * Presença: cada cliente publica onde está (card/coluna sob o cursor,
 * card arrastado ou em edição). Cursores remotos são ancorados a elementos
 * — não a pixels — para funcionarem entre janelas de tamanhos diferentes.
 */

"use strict";

// paleta de peers: cores Julia + complementares (espelha NCOLORS do server)
const PALETTE = ["#9558b2", "#389826", "#cb3c33", "#4063d8",
                 "#b58900", "#2aa198", "#d33682", "#6c71c4"];
const COL_ACCENTS = ["#9558b2", "#4063d8", "#389826", "#b58900",
                     "#cb3c33", "#2aa198", "#d33682", "#6c71c4"];

// As mesmas 21 ações que o servidor sabe restringir por IP (espelha
// _KANBAN_GATED_ACTIONS em src/kanban.jl) — colunas da matriz de permissões
// e rótulo do toast quando uma ação é bloqueada. Fora daqui ficam as ações
// de administração do board inteiro (reset, auto-archive, apelidos, trocar
// de board), que já são só-host independentemente da matriz.
const GATED_ACTIONS = [
  { type: "addCard", label: "add card" },
  { type: "editCard", label: "edit card text" },
  { type: "setBody", label: "edit card description" },
  { type: "delCard", label: "delete card" },
  { type: "moveCard", label: "move card between columns" },
  { type: "setDone", label: "mark card done" },
  { type: "archiveCard", label: "archive card" },
  { type: "restoreCard", label: "restore from archive" },
  { type: "delArchived", label: "delete archived forever" },
  { type: "setAssignee", label: "set assignee" },
  { type: "setDue", label: "set due date" },
  { type: "setImages", label: "attach images" },
  { type: "addCheck", label: "add checklist item" },
  { type: "toggleCheck", label: "check/uncheck checklist item" },
  { type: "delCheck", label: "delete checklist item" },
  { type: "addCol", label: "add column" },
  { type: "renameCol", label: "rename column" },
  { type: "delCol", label: "delete column" },
  { type: "moveCol", label: "reorder columns" },
  { type: "setWip", label: "set WIP limit" },
  { type: "sortCol", label: "sort column" },
];

function actionLabel(type) {
  const found = GATED_ACTIONS.find((a) => a.type === type);
  const label = found ? found.label : type;
  return window.PerthI18n ? PerthI18n.t(label) : label;
}

// Chave de acesso (share protegido): vem no link ?key=... e fica na
// sessão para sobreviver a navegação/reload
// Tradução no ponto de uso: texto criado em JS nasce depois da varredura do
// PerthI18n (que passa uma vez, no set()), então literal solto aqui fica em
// inglês para sempre. Mesmo T do gantt, um só para o arquivo — eram oito
// cópias idênticas espalhadas pelas funções.
const T = (k) => (window.PerthI18n ? PerthI18n.t(k) : k);
const $  = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const urlKey = new URLSearchParams(location.search).get("key");
if (urlKey) sessionStorage.setItem("perth-kanban-key", urlKey);
const accessKey = () => sessionStorage.getItem("perth-kanban-key") || "";
const keyQS = () => (accessKey() ? "?key=" + encodeURIComponent(accessKey()) : "");
// idem, para caminhos que já trazem query (ex.: /background?v=…)
const withKey = (path) =>
  !accessKey() ? path
    : path + (path.includes("?") ? "&" : "?") +
      "key=" + encodeURIComponent(accessKey());

const state = {
  board: { columns: [] },
  rev: 0,
  me: null,                 // {id, ip, name, color}
  peers: new Map(),         // id -> {id, ip, name, color, presence}
  selected: null,           // âncora da seleção (ver selectCard)
  selection: new Set(),     // a seleção inteira — um id só no caso comum
  selEdge: null,            // ponta longe do intervalo com Shift
  editing: null,            // {cardId | null, colId, draft, isNew}
  cardDialog: null,         // {cardId, title, body} — o card aberto como documento
  drag: null,               // estado do arrasto local
  pendingBoard: null,       // board recebido durante um arrasto
  filter: "",               // busca ativa (texto/#tag/autor), minúsculas
  log: [],                  // eventos recentes vindos do servidor
  chat: [],                 // mensagens recentes do chat geral
  chatOpen: false,          // painel de chat aberto (não-modal, não bloqueia o board)
  openModal: null,          // "archived" | "aliases" | "activity" | "share" | ...
  boardName: "board",       // board ativo (multi-board)
  denied: false,            // servidor recusou por falta de chave
  presenting: false,        // modo apresentação: menubar escondida + fullscreen
};

const boardEl   = $("#board");
const cursorsEl = $("#cursors");

const uid = () => "k" + Math.random().toString(36).slice(2, 9);

/* ================================================================ ws */

let ws = null;
let retryMs = 800;
// trava de re-entrância da render (ver função render)
let _rendering = false;
let _renderQueued = false;

let lastMsgAt = Date.now();
// o servidor manda um heartbeat a cada 30s; sem mensagens por 75s a
// conexão está morta (proxy/roteador engoliu) — fecha e reconecta
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMsgAt > 75000)
    ws.close();
}, 15000);

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws${keyQS()}`);

  ws.onopen = () => {
    retryMs = 800;
    setConn(true);
    const name = localStorage.getItem("perth-kanban-name") || "";
    if (name) send({ type: "hello", name });
  };

  ws.onmessage = (ev) => {
    lastMsgAt = Date.now();
    handleMessage(JSON.parse(ev.data));
  };

  ws.onclose = () => {
    setConn(false);
    if (state.denied) return;   // aguardando a chave: sem retry automático
    state.peers.clear();
    renderPeers();
    renderCursors();
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 1.6, 6000);
  };

  ws.onerror = () => ws.close();
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sendOp(op) {
  send({ type: "op", op });
}

function setConn(live) {
  $("#conn").classList.toggle("live", live);
  // pelo i18n, como o presence.js faz no gantt: o texto é gerado em JS, e
  // sem isto o kanban mostrava "live" enquanto o gantt mostrava "ao vivo"
  const txt = live ? "live" : "reconnecting…";
  $("#conn-label").textContent = window.PerthI18n ? PerthI18n.t(txt) : txt;
}

function handleMessage(msg) {
  switch (msg.type) {
    case "hb":
      break;   // heartbeat: só atualiza lastMsgAt (já feito no onmessage)
    case "denied": {
      state.denied = true;
      if (msg.reason === "share_off") showShareOff();
      else showKeyGate();
      break;
    }
    case "background":   // o REPL trocou a imagem de fundo: aplica sem reload
      applyBackground(msg);
      break;
    case "share": {
      // a transmissão foi ligada/desligada (aqui, no REPL ou em outra aba
      // do host): só o host continua conectado, então isto é informativo
      if (msg.log) {
        state.log.push(msg.log);
        state.log.length > 500 && state.log.shift();
        if (state.openModal === "activity") showActivity();
      }
      // sem aviso flutuante: quem ligou a transmissão acabou de clicar no
      // botão, e o botão já muda de cor e de rótulo. O gantt nunca avisou,
      // e a diferença entre os dois era só herança.
      refreshShare();
      break;
    }
    case "board": {
      // um board foi apagado (aqui, no REPL ou noutra aba do host). O board
      // ativo não muda — só a lista — então basta refazer o diálogo, se ele
      // estiver aberto, e guardar a linha do log como "key"/"share" fazem.
      if (msg.log) {
        state.log.push(msg.log);
        state.log.length > 500 && state.log.shift();
        if (state.openModal === "activity") showActivity();
      }
      if (state.openModal === "boards") showBoards();
      break;
    }
    case "key": {
      // a chave foi trocada (aqui, no REPL ou em outra aba do host): quem
      // é de fora já foi desconectado, então isto só alcança o host — os
      // links do diálogo mudam junto com a chave
      if (msg.log) {
        state.log.push(msg.log);
        state.log.length > 500 && state.log.shift();
        if (state.openModal === "activity") showActivity();
      }
      refreshShare();
      break;
    }
    case "init": {
      state.denied = false;
      state.rev = msg.rev;
      state.me = msg.you;
      state.boardName = msg.board_name || "board";
      $("#board-name").textContent = state.boardName;
      if (state.openModal === "boards" || state.openModal === "keygate" ||
          state.openModal === "shareoff") closeModal();
      state.peers.clear();
      for (const p of msg.peers)
        if (p.id !== msg.you.id) state.peers.set(p.id, { ...p, presence: null });
      state.log = msg.log || [];
      state.chat = msg.chat || [];
      renderChat();
      acceptBoard(msg.board);
      renderPeers();
      renderStatus();
      refreshShareBtn();
      $("#aliases-item").hidden = !msg.you.host;
      $("#permissions-item").hidden = !msg.you.host;
      $("#reset-item").hidden = !msg.you.host;
      $("#autoarch-item").hidden = !msg.you.host;
      break;
    }
    case "op": {
      state.rev = msg.rev;
      acceptBoard(msg.board);
      if (msg.op && msg.op.type === "resetBoard") {
        undoStack.length = 0;   // o passado não existe mais
        redoStack.length = 0;
      }
      if (msg.log) {
        state.log.push(msg.log);
        state.log.length > 500 && state.log.shift();
        const mine = state.me && msg.log.ip === state.me.ip;
        if (msg.log.notify && !mine) {
          toast(msg.log);
          playAlert();
          if (document.hidden) {
            unseen += 1;
            updateTitle();
          }
        }
        if (state.openModal === "activity") showActivity();
        else if (state.openModal === "archived") showArchived();
        else if (state.openModal === "permissions") showPermissions();
        else if (state.openModal === "card") syncCardDialog();
      }
      renderStatus();
      break;
    }
    case "join": {
      state.peers.set(msg.peer.id, { ...msg.peer, presence: null });
      renderPeers();
      break;
    }
    case "leave": {
      state.peers.delete(msg.id);
      clearTyping(msg.id);
      renderPeers();
      renderCursors();
      render();          // remove marcações de hold/edição do peer
      break;
    }
    case "peer": {
      if (state.me && msg.peer.id === state.me.id) {
        // merge, não substitui: _kanban_peer_payload não traz "host" (só o
        // "init" traz), então um replace aqui apagaria a flag de host do
        // próprio cliente a cada troca de nome — mesmo padrão já usado em
        // shared/presence.js para o gantt
        state.me = { ...state.me, ...msg.peer };
        renderStatus();
      } else {
        const prev = state.peers.get(msg.peer.id);
        state.peers.set(msg.peer.id, { ...msg.peer, presence: prev?.presence ?? null });
      }
      renderPeers();
      renderCursors();
      break;
    }
    case "presence": {
      const p = state.peers.get(msg.from);
      if (!p) break;
      const hadHold = p.presence?.dragging || p.presence?.editing;
      p.presence = msg.state;
      const hasHold = p.presence?.dragging || p.presence?.editing;
      renderCursors();
      if (hadHold !== hasHold || hasHold) renderHolds();
      break;
    }
    case "typing": {
      if (state.chatOpen) markTyping(msg.from);
      break;
    }
    case "chat": {
      state.chat.push(msg.entry);
      state.chat.length > 500 && state.chat.shift();
      clearTypingByIp(msg.entry.ip);
      const mine = state.me && msg.entry.ip === state.me.ip;
      if (state.chatOpen) {
        appendChatMsg(msg.entry);
      } else {
        chatUnseen += 1;
        updateChatBadge();
      }
      if (!mine) {
        playAlert();
        if (document.hidden) {
          unseen += 1;
          updateTitle();
        }
      }
      break;
    }
    // O servidor recusou a op (permissão restrita pelo host) — cobre corrida
    // com o próprio "op" que o init já resincroniza (revertendo a aplicação
    // otimista); isto só acrescenta o motivo, visível na hora.
    case "opDenied": {
      deniedToast(msg.action);
      break;
    }
  }
}

// board autoritativo chegou; se estou no meio de um arrasto, guarda para
// aplicar quando eu soltar (senão o re-render mataria o gesto)
function acceptBoard(board) {
  if (state.drag) {
    state.pendingBoard = board;
    return;
  }
  state.board = board;
  render();
}

/* ================================================== mutações locais */

const cols = () => state.board.columns;
const colById = (id) => cols().find((c) => c.id === id);

function findCard(id) {
  for (const c of cols()) {
    const i = c.cards.findIndex((k) => k.id === id);
    if (i !== -1) return { col: c, index: i };
  }
  return null;
}

// Undo/redo local: cada ação do usuário guarda a op inversa, calculada
// ANTES da mutação (precisa do estado atual p/ posições e textos antigos).
// Desfazer = enviar a inversa como uma op nova — modelo padrão em apps
// colaborativos: não reverte o que os colegas fizeram depois, e se o alvo
// já mudou de estado o servidor só ressincroniza este cliente.
const undoStack = [];
const redoStack = [];
const UNDO_LIMIT = 100;

function inverseOf(op) {
  switch (op.type) {
    case "addCard":
      return { type: "delCard", id: op.id };
    case "editCard": {
      const f = findCard(op.id);
      return f ? { type: "editCard", id: op.id, text: f.col.cards[f.index].text } : null;
    }
    case "delCard": {
      const f = findCard(op.id);
      if (!f) return null;
      const c = f.col.cards[f.index];
      return { type: "addCard", col: f.col.id, id: c.id, text: c.text,
               done: !!c.done, by: c.by, at: c.at, due: c.due,
               assignee: c.assignee, done_at: c.done_at,
               task: c.task, project: c.project,
               body: c.body, images: c.images ? [...c.images] : undefined,
               checklist: c.checklist ? structuredClone(c.checklist) : undefined,
               index: f.index };
    }
    case "setBody": {
      const f = findCard(op.id);
      return f ? { type: "setBody", id: op.id,
                   body: f.col.cards[f.index].body || "" } : null;
    }
    case "setImages": {
      const f = findCard(op.id);
      return f ? { type: "setImages", id: op.id,
                   images: [...(f.col.cards[f.index].images || [])] } : null;
    }
    case "moveCard": {
      const f = findCard(op.id);
      return f ? { type: "moveCard", id: op.id, toCol: f.col.id, toIndex: f.index } : null;
    }
    case "setDone":
      return { type: "setDone", id: op.id, done: !op.done };
    case "archiveCard":
      return { type: "restoreCard", id: op.id };
    case "restoreCard":
      return { type: "archiveCard", id: op.id };
    case "addCol":
      return { type: "delCol", id: op.id };
    case "delCol": {
      const i = cols().findIndex((c) => c.id === op.id);
      if (i === -1) return null;
      const c = cols()[i];
      return { type: "addCol", id: c.id, name: c.name,
               cards: structuredClone(c.cards), index: i };
    }
    case "renameCol": {
      const c = colById(op.id);
      return c ? { type: "renameCol", id: op.id, name: c.name } : null;
    }
    case "moveCol": {
      const i = cols().findIndex((c) => c.id === op.id);
      return i === -1 ? null : { type: "moveCol", id: op.id, toIndex: i };
    }
    case "setWip": {
      const c = colById(op.id);
      return c ? { type: "setWip", id: op.id, wip: c.wip || 0 } : null;
    }
    case "setDue": {
      const f = findCard(op.id);
      return f ? { type: "setDue", id: op.id, due: f.col.cards[f.index].due || "" } : null;
    }
    case "setAssignee": {
      const f = findCard(op.id);
      return f ? { type: "setAssignee", id: op.id,
                   name: f.col.cards[f.index].assignee || "" } : null;
    }
    case "addCheck":
      return { type: "delCheck", card: op.card, id: op.id };
    case "delCheck": {
      const f = findCard(op.card);
      const it = f && (f.col.cards[f.index].checklist || [])
        .find((c) => c.id === op.id);
      return it ? { type: "addCheck", card: op.card, id: op.id, text: it.text } : null;
    }
    case "toggleCheck":
      return { type: "toggleCheck", card: op.card, id: op.id, done: !op.done };
    case "setAutoArchive":
      return { type: "setAutoArchive", days: state.board.auto_archive_days || 0 };
    case "setAlias":
      return { type: "setAlias", ip: op.ip, name: aliasOf(op.ip) };
    default:
      return null;   // delArchived: exclusão definitiva, sem volta
  }
}

// Ações que sobrescrevem um campo (texto/nome/valor) em vez de criar,
// apagar ou mover algo por ID: o undo delas só é seguro se ninguém
// mexeu no mesmo campo depois da sua edição — ver fieldUnchangedSince.
// Ações estruturais (addCard, delCard, moveCard, archiveCard...) ficam
// de fora: operam por ID e não pisam em conteúdo alheio.
const FIELD_OPS = new Set(["editCard", "renameCol", "setWip", "setDue",
                           "setAssignee", "setAutoArchive", "setAlias"]);

// Confere se o campo alvo de refOp ainda está com o valor que refOp
// deixou. Usado antes de aplicar a inversa (undo) ou reaplicar a ação
// original (redo): se o valor mudou nesse meio tempo, um colega editou
// o mesmo campo depois — desfazer/refazer aqui apagaria a edição dele.
function fieldUnchangedSince(refOp) {
  switch (refOp.type) {
    case "editCard": {
      const f = findCard(refOp.id);
      return !!f && f.col.cards[f.index].text === refOp.text;
    }
    case "renameCol": {
      const c = colById(refOp.id);
      return !!c && c.name === refOp.name;
    }
    case "setWip": {
      const c = colById(refOp.id);
      return !!c && (c.wip || 0) === refOp.wip;
    }
    case "setDue": {
      const f = findCard(refOp.id);
      return !!f && (f.col.cards[f.index].due || "") === (refOp.due || "");
    }
    case "setAssignee": {
      const f = findCard(refOp.id);
      return !!f && (f.col.cards[f.index].assignee || "") === (refOp.name || "");
    }
    case "setAutoArchive":
      return (state.board.auto_archive_days || 0) === refOp.days;
    case "setAlias":
      return aliasOf(refOp.ip) === (refOp.name || "");
    default:
      return true;
  }
}

// Permissões: lidas direto de state.board.permissions (parte do board que
// já chega inteiro em cada broadcast) — nunca fica desatualizada esperando
// um payload à parte, e é o que a própria matriz do host também lê/edita.
// Sem restrição configurada para o IP (ou ação fora da lista restringível,
// como resetBoard) a ação é permitida: comportamento atual, sem mudança.
function canDo(action) {
  if (!state.me || state.me.host) return true;
  const perms = (state.board.permissions || {})[state.me.ip];
  if (!perms) return true;
  return perms[action] !== false;
}

// Desabilita o controle e explica o motivo no title — evita o clique morto
// nos controles mais comuns; commit() já bloqueia por baixo de qualquer
// forma (atalho de teclado, drag-and-drop), então isto é só afordância.
function applyRestriction(el, action) {
  if (canDo(action)) return;
  el.disabled = true;
  const reason = window.PerthI18n
    ? PerthI18n.t("Restricted by the host") : "Restricted by the host";
  el.title = reason + ": " + actionLabel(action);
}

// Delega ao componente compartilhado (shared/toast.js). Era daqui que ele
// saiu: o gantt não tinha aviso nenhum e reportava tudo por alert().
function showToast(msg, cls = "toast-denied") {
  return cls === "toast-error" ? PerthToast.error(msg) : PerthToast.info(msg);
}

function deniedToast(action) {
  const label = actionLabel(action);
  showToast((window.PerthI18n ? PerthI18n.t("The host restricted this action for your machine") :
    "The host restricted this action for your machine") + (label ? ": " + label : ""));
}

// Undo/redo pulou um campo porque um colega mexeu nele depois da sua
// edição (ver fieldUnchangedSince) — avisa em vez de sobrescrever calado.
function concurrentEditToast(action) {
  const label = actionLabel(action);
  showToast((window.PerthI18n ? PerthI18n.t("Someone changed this since your edit — undo skipped") :
    "Someone changed this since your edit — undo skipped") + (label ? ": " + label : ""));
}

// único ponto de bloqueio no cliente: drag-and-drop, botões, atalhos de
// teclado e o editor de card passam todos por aqui antes de mandar a op —
// cobre as 19 ações restringíveis sem precisar caçar cada call site. O
// servidor é sempre a autoridade final (ver _kanban_permitted em kanban.jl);
// isto só evita o round-trip óbvio e dá o motivo na hora.
function commit(op) {
  commitMany([op]);
}

/* Um lote de ops como UMA entrada de desfazer.
 *
 * Ação em lote (arquivar seis cards, mover seis de coluna) é um gesto só, e
 * desfazer tem que ser um Ctrl+Z só — não seis. Do lado do servidor cada op
 * continua sendo uma op independente: é ele que resolve conflito, WIP e
 * permissão card por card, e um "op composta" nova no protocolo obrigaria a
 * ensinar tudo isso de novo do outro lado.
 *
 * As inversas são calculadas ANTES de qualquer mutação, na ordem original; em
 * que ordem elas são APLICADAS depende do que elas fazem (ver replayEntry).
 *
 * Uma op sem permissão não derruba o lote: as outras seguem, e o toast diz
 * qual ficou de fora (é o servidor que decide de verdade, isto só evita o
 * round-trip óbvio).
 */
function commitMany(ops) {
  const feitas = [], inversas = [];
  let negada = null;
  for (const op of ops) {
    if (!canDo(op.type)) { negada = negada || op.type; continue; }
    const inv = inverseOf(op);            // antes da mutação: lê o estado atual
    feitas.push(structuredClone(op));
    inversas.push(inv);
    applyLocal(op);
    sendOp(op);
  }
  if (negada) deniedToast(negada);
  if (!feitas.length) return;
  if (inversas.some(Boolean)) {
    undoStack.push({ do: feitas, undo: inversas });
    undoStack.length > UNDO_LIMIT && undoStack.shift();
    redoStack.length = 0;
  }
  render();
}

/* Ops cuja aplicação carrega uma POSIÇÃO. Um lote delas tem de ser aplicado
 * de trás para frente: cada inserção desloca os índices das seguintes, e na
 * ordem direta o segundo card cairia no lugar que o primeiro acabou de
 * ocupar.
 *
 * As outras vão na ordem direta. restoreCard devolve o card ao PÉ da coluna
 * (sempre foi assim), e de trás para frente seis cards arquivados voltariam
 * empilhados na ordem trocada; archiveCard, delCard, setDone e setAssignee
 * trabalham por id, e para elas a ordem não muda nada. */
const POSITIONAL_OPS = new Set(["addCard", "moveCard", "addCol", "moveCol"]);

/* Aplica um lado da entrada, na ordem que as ops pedem (ver POSITIONAL_OPS).
 *
 * `referencia` são as ops opostas, alinhadas por índice: a guarda de conflito
 * pergunta se o campo ainda está com o valor que a op OPOSTA escreveu (é ela
 * a última a ter tocado nele), e não com o valor que estamos a ponto de
 * escrever. Ops de campo que um colega mexeu no meio são puladas uma a uma,
 * com aviso — o resto do lote vai.
 */
function replayEntry(aplicar, referencia) {
  const indices = aplicar.map((_, i) => i);
  if (aplicar.some((o) => o && POSITIONAL_OPS.has(o.type))) indices.reverse();
  let pulou = null, fez = false;
  for (const i of indices) {
    const op = aplicar[i], ref = referencia[i];
    if (!op) continue;
    if (ref && FIELD_OPS.has(ref.type) && !fieldUnchangedSince(ref)) {
      pulou = pulou || ref.type;
      continue;
    }
    applyLocal(op);
    sendOp(op);
    fez = true;
  }
  if (pulou) concurrentEditToast(pulou);
  if (fez) render();
  return fez;
}

function undo() {
  const e = undoStack.pop();
  if (!e) return;
  // nada aplicável (tudo pulado por conflito): a entrada é descartada, não
  // vai para a pilha de refazer — ela já não descreve o estado atual
  if (!replayEntry(e.undo, e.do)) return;
  redoStack.push(e);
}

function redo() {
  const e = redoStack.pop();
  if (!e) return;
  if (!replayEntry(e.do, e.undo)) return;
  undoStack.push(e);
}

function applyLocal(op) {
  switch (op.type) {
    case "addCard": {
      const c = colById(op.col);
      if (!c) break;
      const card = { id: op.id, text: op.text, done: !!op.done };
      if (op.by) card.by = op.by;
      if (op.at) card.at = op.at;
      if (op.due) card.due = op.due;
      if (op.assignee) card.assignee = op.assignee;
      if (op.done_at) card.done_at = op.done_at;
      if (op.body) card.body = op.body;
      if (Array.isArray(op.images) && op.images.length) card.images = [...op.images];
      if (Array.isArray(op.checklist)) card.checklist = structuredClone(op.checklist);
      const i = Number.isInteger(op.index)
        ? Math.min(op.index, c.cards.length) : c.cards.length;
      c.cards.splice(i, 0, card);
      break;
    }
    case "editCard": {
      const f = findCard(op.id);
      if (f) f.col.cards[f.index].text = op.text;
      break;
    }
    case "setBody": {
      const f = findCard(op.id);
      if (!f) break;
      const c = f.col.cards[f.index];
      op.body ? (c.body = op.body) : delete c.body;
      break;
    }
    case "setImages": {
      const f = findCard(op.id);
      if (!f) break;
      const c = f.col.cards[f.index];
      op.images && op.images.length ? (c.images = [...op.images]) : delete c.images;
      break;
    }
    case "delCard": {
      const f = findCard(op.id);
      if (f) f.col.cards.splice(f.index, 1);
      break;
    }
    case "moveCard": {
      const f = findCard(op.id);
      const dest = colById(op.toCol);
      if (!f || !dest) break;
      const [card] = f.col.cards.splice(f.index, 1);
      dest.cards.splice(Math.min(op.toIndex, dest.cards.length), 0, card);
      break;
    }
    case "addCol": {
      const col = { id: op.id, name: op.name,
                    cards: Array.isArray(op.cards) ? op.cards : [] };
      const i = Number.isInteger(op.index)
        ? Math.min(op.index, cols().length) : cols().length;
      cols().splice(i, 0, col);
      break;
    }
    case "renameCol": {
      const c = colById(op.id);
      if (c) c.name = op.name;
      break;
    }
    case "delCol": {
      const i = cols().findIndex((c) => c.id === op.id);
      if (i !== -1) cols().splice(i, 1);
      break;
    }
    case "moveCol": {
      const i = cols().findIndex((c) => c.id === op.id);
      if (i === -1) break;
      const [c] = cols().splice(i, 1);
      cols().splice(Math.min(op.toIndex, cols().length), 0, c);
      break;
    }
    case "setDone": {
      const f = findCard(op.id);
      if (!f) break;
      const c = f.col.cards[f.index];
      c.done = op.done;
      if (op.done) c.done_at = localStamp();
      else delete c.done_at;
      break;
    }
    case "archiveCard": {
      const f = findCard(op.id);
      if (!f) break;
      const [card] = f.col.cards.splice(f.index, 1);
      (state.board.archive ||= []).push({ ...card, col: f.col.name });
      break;
    }
    case "restoreCard": {
      const arch = state.board.archive || [];
      const i = arch.findIndex((c) => c.id === op.id);
      if (i === -1 || !cols().length) break;
      const [entry] = arch.splice(i, 1);
      const { col, archived_at, ...card } = entry;
      (cols().find((x) => x.name === col) || cols()[0]).cards.push(card);
      break;
    }
    case "delArchived": {
      const arch = state.board.archive || [];
      const i = arch.findIndex((c) => c.id === op.id);
      if (i !== -1) arch.splice(i, 1);
      break;
    }
    case "setWip": {
      const c = colById(op.id);
      if (!c) break;
      op.wip > 0 ? (c.wip = op.wip) : delete c.wip;
      break;
    }
    case "setDue": {
      const f = findCard(op.id);
      if (!f) break;
      const c = f.col.cards[f.index];
      op.due ? (c.due = op.due) : delete c.due;
      break;
    }
    case "sortCol": {
      const c = colById(op.id);
      if (!c) break;
      // mesmas chaves do Julia (_kanban_apply!): "yyyy-mm-dd HH:MM" e
      // "yyyy-mm-dd" ordenam alfabeticamente na ordem do relógio. O prazo
      // sobe (o mais urgente primeiro) e a criação DESCE (o mais novo no
      // topo) — daí o x e o y trocados. Sem prazo vai para o fim; sem
      // carimbo de criação também, porque card sem `at` é de board anterior
      // ao campo, logo o mais velho de todos.
      if (op.by === "created")
        c.cards.sort((x, y) => (y.at || "").localeCompare(x.at || ""));
      else
        c.cards.sort((x, y) =>
          (x.due || "9999").localeCompare(y.due || "9999"));
      break;
    }
    case "setAlias": {
      const a = (state.board.aliases ||= {});
      if (op.name) a[op.ip] = op.name;
      else delete a[op.ip];
      break;
    }
    case "resetBoard": {
      const aliases = state.board.aliases || {};
      state.board = {
        columns: [
          { id: "c1", name: "backlog", cards: [] },
          { id: "c2", name: "doing", cards: [] },
          { id: "c3", name: "done", cards: [] },
        ],
        archive: [],
        aliases,
      };
      break;
    }
    case "setAssignee": {
      const f = findCard(op.id);
      if (!f) break;
      const c = f.col.cards[f.index];
      op.name ? (c.assignee = op.name) : delete c.assignee;
      break;
    }
    case "addCheck": {
      const f = findCard(op.card);
      if (!f) break;
      (f.col.cards[f.index].checklist ||= []).push(
        { id: op.id, text: op.text, done: false });
      break;
    }
    case "toggleCheck": {
      const f = findCard(op.card);
      if (!f) break;
      const it = (f.col.cards[f.index].checklist || [])
        .find((c) => c.id === op.id);
      if (it) it.done = op.done;
      break;
    }
    case "delCheck": {
      const f = findCard(op.card);
      if (!f) break;
      const cl = f.col.cards[f.index].checklist || [];
      const i = cl.findIndex((c) => c.id === op.id);
      if (i !== -1) cl.splice(i, 1);
      break;
    }
    case "setAutoArchive": {
      op.days > 0 ? (state.board.auto_archive_days = op.days)
                  : delete state.board.auto_archive_days;
      break;
    }
  }
}

/* ========================================================== render */

function render() {
  // trava de re-entrância: se algo disparar render() durante um render em
  // andamento (ex.: um focusout no meio do rebuild), a segunda chamada
  // apenas re-agenda — senão o board seria montado em cima de si mesmo
  if (_rendering) { _renderQueued = true; return; }
  _rendering = true;
  pruneMissingSelection();
  // FLIP: posições antes do re-render, para animar cards que mudaram de lugar
  const before = new Map();
  for (const el of $$(".card", boardEl))
    before.set(el.dataset.card, el.getBoundingClientRect());

  // Rolagem antes da limpeza. O render reconstrói o board inteiro, e
  // elemento novo nasce no topo: concluir um card lá embaixo devolvia a
  // coluna ao começo e tirava da vista justamente o card em que se
  // acabou de mexer. Guardado por id de coluna (elas podem ser
  // reordenadas ou apagadas entre um render e outro), mais a rolagem
  // horizontal do próprio board.
  const scrolls = new Map();
  for (const el of $$(".col", boardEl)) {
    const box = $(".cards", el);
    if (box) scrolls.set(el.dataset.col, box.scrollTop);
  }
  const boardLeft = boardEl.scrollLeft;

  boardEl.textContent = "";

  cols().forEach((col, ci) => {
    const colEl = document.createElement("section");
    colEl.className = "col";
    colEl.dataset.col = col.id;
    colEl.style.setProperty("--accent", COL_ACCENTS[ci % COL_ACCENTS.length]);

    // cabeçalho
    const head = document.createElement("div");
    head.className = "col-head";
    const name = document.createElement("span");
    name.className = "col-name";
    name.textContent = col.name;
    if (canDo("renameCol")) {
      name.title = T("double-click to rename");
      name.addEventListener("dblclick", () => renameColInline(col, name));
    } else {
      name.classList.add("locked");
      name.title = (window.PerthI18n ? PerthI18n.t("Restricted by the host") : "Restricted by the host") +
        ": " + actionLabel("renameCol");
    }
    const count = document.createElement("span");
    count.className = "col-count";
    count.textContent = col.wip ? `${col.cards.length}/${col.wip}` : col.cards.length;
    if (col.wip && col.cards.length > col.wip) {
      count.classList.add("over");
      count.title = T("WIP limit exceeded");
    }
    head.append(name, count, colMenu(col, ci));
    colEl.append(head);

    // cards
    const cardsEl = document.createElement("div");
    cardsEl.className = "cards";
    for (const card of col.cards) {
      if (state.editing && state.editing.cardId === card.id) {
        cardsEl.append(editorEl(col, card));
      } else {
        cardsEl.append(cardEl(card));
      }
    }
    if (state.editing && state.editing.isNew && state.editing.colId === col.id)
      cardsEl.append(editorEl(col, null));
    colEl.append(cardsEl);

    // rodapé
    const foot = document.createElement("div");
    foot.className = "col-foot";
    const add = document.createElement("button");
    add.className = "add-card";
    add.textContent = T("+ card");
    add.addEventListener("click", () => openNewCard(col.id));
    applyRestriction(add, "addCard");
    foot.append(add);
    colEl.append(foot);

    boardEl.append(colEl);
  });

  const addCol = document.createElement("button");
  addCol.className = "add-col";
  addCol.textContent = T("+ new column");
  addCol.addEventListener("click", newColumn);
  applyRestriction(addCol, "addCol");
  boardEl.append(addCol);

  // Rolagem de volta ANTES de medir o FLIP: as posições de `before` foram
  // tiradas com a rolagem antiga, então medir `now` com o board no topo
  // faria todo card "voltar" de uma distância que ninguém percorreu.
  // O navegador limita sozinho se o conteúdo encolheu.
  boardEl.scrollLeft = boardLeft;
  for (const el of $$(".col", boardEl)) {
    const box = $(".cards", el);
    const top = scrolls.get(el.dataset.col);
    if (box && top) box.scrollTop = top;
  }

  // FLIP: anima quem se moveu
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    for (const el of $$(".card", boardEl)) {
      const prev = before.get(el.dataset.card);
      if (!prev) continue;
      const now = el.getBoundingClientRect();
      const dx = prev.left - now.left;
      const dy = prev.top - now.top;
      if (dx || dy)
        el.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
          { duration: 180, easing: "ease-out" }
        );
    }
  }

  renderHolds();
  renderCursors();
  renderPeers();   // aliases mudam os rótulos dos chips
  renderStatus();

  _rendering = false;
  if (_renderQueued) { _renderQueued = false; render(); }
}

function cardEl(card) {
  const el = document.createElement("article");
  el.className = "card" + (card.done ? " done" : "");
  el.dataset.card = card.id;

  if (state.filter && !matchesFilter(card)) el.classList.add("dimmed");

  const text = document.createElement("div");
  text.className = "card-text";
  renderCardText(text, card.text);
  el.append(text);

  // As imagens vêm antes do corpo porque é assim que o card é lido: a
  // captura é a evidência, o texto é o comentário dela.
  if (card.images && card.images.length) el.append(cardImagesEl(card));

  // O corpo aparece RECORTADO na face (o resto está na caixa expandida): a
  // coluna tem a largura que tem, e um card de trinta linhas empurra para
  // fora da tela os outros cinco que a coluna existe para mostrar juntos.
  if (card.body) {
    const body = document.createElement("div");
    body.className = "card-body";
    PerthInline.renderBlocks(body, card.body, inlineOpts());
    el.append(body);
  }

  // checklist: itens marcáveis direto no card + barrinha de progresso
  if (card.checklist && card.checklist.length) {
    const list = document.createElement("div");
    list.className = "checklist";
    for (const it of card.checklist) {
      const row = document.createElement("div");
      row.className = "check-item" + (it.done ? " done" : "");
      const box = document.createElement("button");
      box.className = "check-box";
      box.textContent = "✓";
      box.title = it.done ? "uncheck" : "check";
      box.addEventListener("pointerdown", (e) => e.stopPropagation());
      box.addEventListener("click", (e) => {
        e.stopPropagation();
        commit({ type: "toggleCheck", card: card.id, id: it.id, done: !it.done });
      });
      applyRestriction(box, "toggleCheck");
      const label = document.createElement("span");
      label.textContent = it.text;
      row.append(box, label);
      list.append(row);
    }
    const ndone = card.checklist.filter((c) => c.done).length;
    const bar = document.createElement("div");
    bar.className = "check-bar";
    bar.title = `${ndone}/${card.checklist.length} done`;
    const fill = document.createElement("i");
    fill.style.width = `${(ndone / card.checklist.length) * 100}%`;
    bar.append(fill);
    el.append(list, bar);
  }

  // rodapé: novo hoje + quem criou (alias do host > IP) + responsável +
  // prazo + arquivar. A etiqueta de novo entra à esquerda, junto do carimbo
  // de autoria (as duas dizem *de onde veio* o card); as pastilhas com
  // moldura à direita continuam sendo só o que se pode acionar.
  const fresh = isNewCard(card);
  if (card.by || card.done || card.due || card.assignee || fresh) {
    const meta = document.createElement("div");
    meta.className = "card-meta";
    if (fresh) {
      const tag = document.createElement("span");
      tag.className = "card-new";
      tag.textContent = T("new");
      tag.title = T("added today");
      meta.append(tag);
    }
    if (card.by) {
      const by = document.createElement("span");
      by.className = "card-by";
      by.textContent = T("by") + " " + displayFor(card.by);
      by.title = card.by + (card.at ? " · " + card.at : "");
      meta.append(by);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "card-by";
      meta.append(spacer);
    }
    if (card.assignee) {
      const as = document.createElement("button");
      as.className = "card-assignee";
      as.textContent = "@" + card.assignee;
      as.title = T("assigned to") + " " + card.assignee + " — " + T("click to filter");
      as.style.setProperty("--tagc", tagColor(card.assignee.toLowerCase()));
      as.addEventListener("pointerdown", (e) => e.stopPropagation());
      as.addEventListener("click", (e) => {
        e.stopPropagation();
        setFilter(card.assignee);
      });
      meta.append(as);
    }
    const due = dueInfo(card);
    if (due) {
      const chip = document.createElement("button");
      chip.className = "card-due" + (due.cls ? " " + due.cls : "");
      chip.textContent = due.label;
      chip.title = T("due") + " " + card.due + " — " + T("click to edit");
      chip.addEventListener("pointerdown", (e) => e.stopPropagation());
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        openEditor(card.id);
      });
      meta.append(chip);
    }
    if (card.done) {
      const arch = document.createElement("button");
      arch.className = "card-archive";
      arch.textContent = T("archive");
      arch.title = T("move to the archive");
      arch.addEventListener("pointerdown", (e) => e.stopPropagation());
      arch.addEventListener("click", (e) => {
        e.stopPropagation();
        commit({ type: "archiveCard", id: card.id });
      });
      applyRestriction(arch, "archiveCard");
      meta.append(arch);
    }
    el.append(meta);
  }

  const done = document.createElement("button");
  done.className = "card-done";
  done.textContent = "✓";
  done.title = card.done ? "mark as not done" : "mark as done";
  done.addEventListener("pointerdown", (e) => e.stopPropagation());
  done.addEventListener("click", (e) => {
    e.stopPropagation();
    // o estouro sai ANTES do commit: depois dele o card já foi repintado e
    // este nó não existe mais para dizer de onde as partículas partem
    if (!card.done && canDo("setDone")) celebrate(done);
    commit({ type: "setDone", id: card.id, done: !card.done });
  });
  applyRestriction(done, "setDone");
  el.append(done);

  if (state.selection.has(card.id)) el.classList.add("selected");
  el.addEventListener("pointerdown", (e) => maybeDrag(e, card));
  el.addEventListener("click", (e) => {
    if (Date.now() - justDragged < 300) return;   // clique fantasma pós-arrasto
    if (lastPointerType === "touch" && state.selected === card.id)
      return openEditor(card.id);                 // 2º toque = editar
    // Ctrl/Shift mexem em vários cards de uma vez: aí não dá para repintar
    // só este nó, e o render() inteiro é o caminho. O clique simples segue
    // pelo atalho de sempre — é o que acontece o tempo todo.
    if (selectCard(card.id, e)) return render();
    $$(".card.selected", boardEl).forEach((c) => c.classList.remove("selected"));
    el.classList.add("selected");
    renderStatus();
  });
  el.addEventListener("dblclick", () => openEditor(card.id));
  return el;
}

/* Markdown inline + #tags do card: **negrito**, *itálico*, `código`,
 * ~~riscado~~, [texto](url), URL solta e #etiqueta.
 *
 * O tokenizador mudou-se para shared/inline.js quando as notas de uma tarefa
 * do gantt passaram a usar o mesmo subconjunto — duas telas com o mesmo
 * significado não podem ter dois analisadores. O que fica aqui é o que é do
 * kanban: a cor da etiqueta, o clique que filtra o quadro, e a guarda que
 * impede o link de abrir no fim de um arrasto. */
const inlineOpts = () => ({
  linkClass: "card-link",
  tagClass: "tag",
  tagColor,
  onTag: setFilter,
  podeAbrirLink: () => Date.now() - justDragged >= 300,
});

function renderCardText(container, text) {
  return PerthInline.render(container, text, inlineOpts());
}

function colMenu(col, ci) {
  const wrap = document.createElement("div");
  wrap.className = "col-menu menu";
  const btn = document.createElement("button");
  btn.textContent = "⋯";
  btn.title = T("column options");
  const drop = document.createElement("div");
  drop.className = "menu-drop";

  const item = (label, fn, cls, action) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      wrap.classList.remove("open");
      fn();
    });
    if (action) applyRestriction(b, action);
    return b;
  };

  drop.append(
    item("Rename…", () => renameColInline(col, $(".col-name", wrap.closest(".col"))),
         null, "renameCol"),
    item("WIP limit…", () => {
      const v = prompt(`WIP limit for "${col.name}" (0 = none):`, col.wip || 0);
      if (v === null) return;
      const w = parseInt(v, 10);
      if (!Number.isNaN(w) && w >= 0) commit({ type: "setWip", id: col.id, wip: w });
    }, null, "setWip"),
    item("Sort by due date",
         () => commit({ type: "sortCol", id: col.id, by: "due" }), null, "sortCol"),
    item("Sort by newest first",
         () => commit({ type: "sortCol", id: col.id, by: "created" }), null, "sortCol"),
  );
  if (ci > 0)
    drop.append(item("Move left", () =>
      commit({ type: "moveCol", id: col.id, toIndex: ci - 1 }), null, "moveCol"));
  if (ci < cols().length - 1)
    drop.append(item("Move right", () =>
      commit({ type: "moveCol", id: col.id, toIndex: ci + 1 }), null, "moveCol"));
  const hr = document.createElement("hr");
  drop.append(hr, item("Delete column", () => {
    if (col.cards.length === 0 ||
        confirm(`Delete "${col.name}" and its ${col.cards.length} cards?`))
      commit({ type: "delCol", id: col.id });
  }, "danger", "delCol"));

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeMenus();
    wrap.classList.add("open");
  });
  wrap.append(btn, drop);
  return wrap;
}

function renameColInline(col, nameEl) {
  const input = document.createElement("input");
  input.className = "col-name-input";
  input.value = col.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  const done = (save) => {
    const v = input.value.trim();
    if (save && v && v !== col.name)
      commit({ type: "renameCol", id: col.id, name: v });
    else render();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") done(true);
    if (e.key === "Escape") done(false);
  });
  input.addEventListener("blur", () => done(true));
}

function newColumn() {
  const name = prompt("column name:");
  if (name && name.trim())
    commit({ type: "addCol", id: uid(), name: name.trim() });
}

/* ========================================================== editor */

function openEditor(cardId) {
  const f = findCard(cardId);
  if (!f) return;
  const c = f.col.cards[f.index];
  state.editing = { cardId, colId: f.col.id, draft: c.text,
                    due: c.due || "", assignee: c.assignee || "",
                    checks: [], focused: false, isNew: false };
  render();
}

function openNewCard(colId) {
  state.editing = { cardId: null, colId, draft: "", due: "", assignee: "",
                    checks: [], focused: false, isNew: true };
  render();
}

// nomes conhecidos para o datalist do responsável
function knownNames() {
  const names = new Set();
  if (state.me) names.add(peerLabel(state.me));
  for (const p of state.peers.values()) names.add(peerLabel(p));
  for (const v of Object.values(state.board.aliases || {})) names.add(v);
  for (const c of cols()) for (const k of c.cards) k.assignee && names.add(k.assignee);
  names.delete("");
  return [...names].sort();
}

function editorEl(col, card) {
  const wrap = document.createElement("div");
  wrap.className = "editor-wrap";
  const ta = document.createElement("textarea");
  ta.className = "card-editor";
  ta.value = state.editing.draft;
  ta.placeholder = T("type and press Enter — #tags, **bold**, [links](url)…");
  // um card existente pode ter editCard negado mas ainda assim aceitar
  // mudança de prazo/responsável (ops independentes) — só o texto trava
  if (card) applyRestriction(ta, "editCard");
  requestAnimationFrame(() => {
    ta.style.height = "auto";
    ta.style.height = Math.max(ta.scrollHeight, 54) + "px";
  });
  if (!state.editing.focused) {
    state.editing.focused = true;   // rouba o foco só na abertura, não a cada render
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }, 0);
  }

  ta.addEventListener("input", () => {
    state.editing.draft = ta.value;
    ta.style.height = "auto";
    ta.style.height = Math.max(ta.scrollHeight, 54) + "px";
    if (card) sendPresenceNow({ editing: card.id });
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commitEditor();
    } else if (e.key === "Escape") {
      cancelEditor();
    }
    e.stopPropagation();   // não dispara atalhos globais enquanto digita
  });

  const row = document.createElement("div");
  row.className = "editor-row";
  const lbl = document.createElement("label");
  lbl.textContent = T("due");
  const date = document.createElement("input");
  date.type = "date";
  date.value = state.editing.due || "";
  date.addEventListener("input", () => {
    state.editing.due = date.value;
  });
  date.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commitEditor();
    else if (e.key === "Escape") cancelEditor();
    e.stopPropagation();
  });
  // card novo: prazo vai junto no addCard, não como setDue separado
  if (card) applyRestriction(date, "setDue");
  row.append(lbl, date);

  const lblA = document.createElement("label");
  lblA.textContent = T("assignee");
  const who = document.createElement("input");
  who.className = "assignee-input";
  who.placeholder = T("name");
  who.maxLength = 24;
  who.value = state.editing.assignee || "";
  const dl = document.createElement("datalist");
  dl.id = "known-names";
  for (const n of knownNames()) {
    const o = document.createElement("option");
    o.value = n;
    dl.append(o);
  }
  who.setAttribute("list", "known-names");
  who.addEventListener("input", () => {
    state.editing.assignee = who.value;
  });
  who.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commitEditor();
    else if (e.key === "Escape") cancelEditor();
    e.stopPropagation();
  });
  // card novo: responsável vai junto no addCard, não como setAssignee separado
  if (card) applyRestriction(who, "setAssignee");
  row.append(lblA, who, dl);

  // checklist: em card existente as mudanças são ops imediatas (aparecem ao
  // vivo para todos); em card novo ficam pendentes e vão junto no addCard
  const checks = document.createElement("div");
  checks.className = "editor-checks";
  const items = state.editing.isNew
    ? state.editing.checks
    : (card && card.checklist) || [];
  for (const it of items) {
    const rowc = document.createElement("div");
    rowc.className = "check-item" + (it.done ? " done" : "");
    const label = document.createElement("span");
    label.textContent = it.text;
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.title = T("remove item");
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.editing.isNew) {
        const i = state.editing.checks.findIndex((c) => c.id === it.id);
        i !== -1 && state.editing.checks.splice(i, 1);
        render();
      } else {
        commit({ type: "delCheck", card: card.id, id: it.id });
      }
    });
    if (!state.editing.isNew) applyRestriction(del, "delCheck");
    rowc.append(label, del);
    checks.append(rowc);
  }
  const addCheck = document.createElement("input");
  addCheck.className = "add-check";
  addCheck.placeholder = T("+ checklist item");
  // um card novo ainda não existe no servidor: o checklist fica pendente e
  // vai junto no addCard, então addCheck não se aplica a esse caminho
  if (!state.editing.isNew) applyRestriction(addCheck, "addCheck");
  addCheck.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") return cancelEditor();
    if (e.key !== "Enter") return;
    const v = addCheck.value.trim();
    if (!v) return;
    state.editing.refocusChecks = true;
    if (state.editing.isNew) {
      state.editing.checks.push({ id: uid(), text: v, done: false });
      render();
    } else {
      commit({ type: "addCheck", card: card.id, id: uid(), text: v });
    }
  });
  if (state.editing.refocusChecks) {
    state.editing.refocusChecks = false;
    setTimeout(() => addCheck.focus(), 0);
  }
  checks.append(addCheck);

  wrap.append(ta, row, checks);

  /* A porta da caixa expandida para quem não tem teclado.
   *
   * Só em card que JÁ existe: no campo de criar ele apareceria vazio e
   * desabilitado, que é onde ficou feio — e descrição e imagem precisam de
   * um card a que pertencer, então ali ele não teria o que abrir.
   *
   * Existe por causa do TOQUE. Com teclado o caminho é Shift+Enter; num
   * tablet não há Shift+Enter, e as outras entradas possíveis colidem com
   * gestos que já têm dono: o duplo toque é este editor, e o segurar é o
   * arrasto do card (LONGPRESS_MS), que é o que descarta um menu de
   * contexto. Aqui dentro não colide com nada, porque este editor só existe
   * depois de alguém pedir por ele.
   *
   * Grava o que já está no editor antes de abrir: título, prazo e
   * responsável são ops daqui, e perdê-los ao trocar de tela seria a
   * armadilha clássica de um botão que "só abre outra coisa". */
  if (card) {
    const more = document.createElement("div");
    more.className = "editor-more";
    const open = document.createElement("button");
    open.className = "editor-open";
    open.textContent = T("description…") + " ⤢";
    open.title = T("open card (description, code, images)");
    open.addEventListener("click", (e) => {
      e.preventDefault();
      const id = card.id;
      commitEditor();
      openCardDialog(id);
    });
    more.append(open);
    wrap.append(more);
  }

  if (card) sendPresenceNow({ editing: card.id });
  return wrap;
}

function commitEditor() {
  const ed = state.editing;
  if (!ed) return;
  state.editing = null;
  sendPresenceNow({});
  const text = ed.draft.trim();
  if (ed.isNew) {
    if (text) {
      const id = uid();
      commit({ type: "addCard", col: ed.colId, id, text,
               due: ed.due || undefined,
               assignee: (ed.assignee || "").trim() || undefined,
               checklist: ed.checks.length ? ed.checks : undefined,
               by: state.me?.ip,
               at: localStamp() });
      selectOnlyCard(id);
    } else render();
  } else {
    const f = findCard(ed.cardId);
    if (!f) return render();
    const cur = f.col.cards[f.index];
    const textChanged = text && text !== cur.text;
    const dueChanged = (ed.due || "") !== (cur.due || "");
    const asgChanged = (ed.assignee || "").trim() !== (cur.assignee || "");
    if (textChanged) commit({ type: "editCard", id: ed.cardId, text });
    if (dueChanged) commit({ type: "setDue", id: ed.cardId, due: ed.due || "" });
    if (asgChanged)
      commit({ type: "setAssignee", id: ed.cardId, name: (ed.assignee || "").trim() });
    if (!textChanged && !dueChanged && !asgChanged) render();
  }
}

function cancelEditor() {
  state.editing = null;
  sendPresenceNow({});
  render();
}


/* ====================================== o card como documento (caixa expandida)
 *
 * A LINHA DO CARD É UM TÍTULO, e continua sendo. Ela vira o nome da tarefa
 * vinculada no gantt (_apply_card_sync em src/kanban.jl), viaja para o CSV e
 * para o iCalendar, e é por onde a busca acha as coisas. Por isso o parágrafo
 * que explica a decisão e o bloco de código que o card existe por causa NÃO
 * entram nela: `body` é campo próprio, com teto próprio (_BODY_CAP em
 * src/types.jl), e é o único lugar do card onde cabe mais que uma linha.
 *
 * A CAIXA GRAVA AO FECHAR — Esc, ✕, clique fora e Ctrl+Enter fazem a mesma
 * coisa. Não existe "cancelar": num campo que convida a escrever trinta
 * linhas, um botão que as joga fora é uma armadilha, e quem se arrependeu de
 * verdade tem o Ctrl+Z, que aqui é uma entrada de desfazer como qualquer
 * outra.
 *
 * O Enter também é o contrário do editor de uma linha, e tem que ser: lá
 * Enter grava e Shift+Enter quebra a linha, porque o campo É uma linha; aqui
 * Enter quebra a linha e Ctrl+Enter grava, porque um bloco de código com
 * Shift+Enter em cada linha não se escreve.
 */

const BODY_CAP = 20000;      // espelha _BODY_CAP em src/types.jl

function openCardDialog(id) {
  const f = findCard(id);
  if (!f) return;
  const card = f.col.cards[f.index];
  state.cardDialog = { cardId: id, title: card.text, body: card.body || "" };
  state.editing = null;                    // a caixa substitui o editor de linha
  showModal(T("Card"), cardDialogEl(card), "card");
  $("#modal-root .modal")?.classList.add("modal-card");
  sendPresenceNow({ editing: id });
}

/* Grava o que mudou e larga o card. Chamado por closeModal — ou seja, por
 * TODO caminho de fechamento, inclusive o Esc global e o clique no fundo. */
function saveCardDialog() {
  const d = state.cardDialog;
  if (!d) return;
  state.cardDialog = null;
  sendPresenceNow({});
  const f = findCard(d.cardId);
  if (!f) return;
  const card = f.col.cards[f.index];
  const title = d.title.trim();
  const body = d.body.trim();
  // Fechar a caixa é UM gesto, então é UM desfazer — mesmo tendo mexido no
  // título e no corpo, que são duas ops (é o servidor que resolve permissão
  // e conflito campo a campo). Mesma regra das ações em lote.
  const ops = [];
  // título vazio não apaga o card: um card sem linha nenhuma não é
  // editável nem selecionável na tela, e ninguém pediu para excluí-lo
  if (title && title !== card.text)
    ops.push({ type: "editCard", id: d.cardId, text: title });
  if (body !== (card.body || ""))
    ops.push({ type: "setBody", id: d.cardId, body });
  if (ops.length) commitMany(ops);
}

/* O board mudou embaixo da caixa aberta (outra máquina, ou o próprio upload
 * daqui): as imagens são relidas do card, e um card que deixou de existir
 * fecha a caixa em vez de gravar num id morto.
 *
 * O texto NÃO é relido: quem está com o cursor no meio de um parágrafo
 * perderia o que digitou por causa de um card qualquer que outra pessoa
 * mexeu do outro lado do quadro. */
function syncCardDialog() {
  const d = state.cardDialog;
  if (!d) return;
  if (!findCard(d.cardId)) {
    state.cardDialog = null;      // o card sumiu: não há o que gravar
    closeModal();
    return;
  }
  const strip = $("#modal-root .dlg-images");
  if (strip) renderDialogImages(strip);
  const warn = $("#modal-root .dlg-peer");
  if (warn) fillPeerWarning(warn, d.cardId);
}

function cardDialogEl(card) {
  const wrap = document.createElement("div");
  wrap.className = "card-dialog";

  // Quem mais está com este card aberto. Some quando ninguém está, e é
  // deliberadamente barulhento: duas pessoas no mesmo texto é última
  // gravação vence (o servidor não funde texto), e perder uma linha é
  // chateação — perder vinte é parar de confiar no quadro.
  const peer = document.createElement("div");
  peer.className = "dlg-peer";
  fillPeerWarning(peer, card.id);
  wrap.append(peer);

  const title = document.createElement("input");
  title.className = "dlg-title";
  title.value = state.cardDialog.title;
  title.maxLength = 2000;                 // _TEXT_CAP: o mesmo teto do servidor
  title.placeholder = T("card title — one line");
  title.addEventListener("input", () => { state.cardDialog.title = title.value; });
  title.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape" || e.key === "Enter") closeModal();
  });
  applyRestriction(title, "editCard");
  wrap.append(title);

  const ta = document.createElement("textarea");
  ta.className = "dlg-body";
  ta.value = state.cardDialog.body;
  ta.placeholder = T("description — **bold**, `code`, ``` for a block · paste an image");
  applyRestriction(ta, "setBody");

  // barra e campo num invólucro só: são um controle, e o `gap` do diálogo
  // não pode abrir uma fresta entre a faixa de botões e o que ela edita
  const editor = document.createElement("div");
  editor.className = "dlg-editor";
  editor.append(toolbarEl(ta), ta);
  wrap.append(editor);

  const strip = document.createElement("div");
  strip.className = "dlg-images";
  renderDialogImages(strip);
  wrap.append(strip);

  const foot = document.createElement("div");
  foot.className = "dlg-foot";
  const count = document.createElement("span");
  count.className = "dlg-count";
  const contar = () => {
    // O teto é do servidor e ele trunca calado (_cap_body). Dizer o número
    // enquanto ainda dá para editar é a diferença entre um limite e uma
    // perda: a contagem só aparece perto do fim, para não virar ruído.
    const n = ta.value.length;
    count.textContent = n > BODY_CAP * 0.8 ? `${n} / ${BODY_CAP}` : "";
    count.classList.toggle("over", n >= BODY_CAP);
  };
  foot.append(count);

  ta.addEventListener("input", () => {
    if (ta.value.length > BODY_CAP) ta.value = ta.value.slice(0, BODY_CAP);
    state.cardDialog.body = ta.value;
    contar();
    sendPresenceNow({ editing: card.id });
  });
  ta.addEventListener("keydown", (e) => {
    e.stopPropagation();                  // atalhos globais ficam de fora
    if (e.key === "Escape") return closeModal();
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) return closeModal();
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k !== "b" && k !== "i") return;
    e.preventDefault();                   // senão o navegador rouba o Ctrl+B
    wrapSelection(ta, k === "b" ? "**" : "*");
  });
  wireImagePaste(ta, card.id);
  contar();

  wrap.append(foot);
  // Foco no começo, não no fim: abrir um texto de trinta linhas já rolado
  // até o rodapé esconde justamente o que a pessoa veio ler.
  setTimeout(() => {
    ta.focus();
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 0;
  }, 0);
  return wrap;
}

function fillPeerWarning(el, cardId) {
  const quem = [...state.peers.values()]
    .filter((p) => p.presence && p.presence.editing === cardId)
    .map(peerLabel);
  el.textContent = quem.length
    ? quem.join(", ") + " " + T("is editing this card right now") : "";
  el.hidden = !quem.length;
}

/* Os botões escrevem MARCAÇÃO no textarea, não formatam texto rico: o que
 * fica gravado é o que a pessoa poderia ter digitado à mão, e é o mesmo que
 * a face do card renderiza. Um editor rico aqui seria um segundo formato. */
function toolbarEl(ta) {
  const bar = document.createElement("div");
  bar.className = "dlg-bar";
  const botao = (conteudo, titulo, fn, cls) => {
    const b = document.createElement("button");
    b.className = "dlg-btn" + (cls ? " " + cls : "");
    b.append(conteudo);
    b.title = titulo;
    b.addEventListener("click", (e) => { e.preventDefault(); fn(); });
    applyRestriction(b, "setBody");
    bar.append(b);
    return b;
  };
  const separador = () => {
    const s = document.createElement("span");
    s.className = "dlg-sep";
    bar.append(s);
    return s;
  };
  botao("B", T("bold") + " (Ctrl+B)", () => wrapSelection(ta, "**"), "b-bold");
  botao("I", T("italic") + " (Ctrl+I)", () => wrapSelection(ta, "*"), "b-ital");
  botao("S", T("strikethrough"), () => wrapSelection(ta, "~~"), "b-strike");
  separador();
  botao("`", T("inline code"), () => wrapSelection(ta, "`"));
  botao("<>", T("code block"), () => wrapBlock(ta, "```\n", "\n```"));
  separador();
  botao("•", T("list item"), () => prefixLines(ta, "- "));
  botao(iconeLink(), T("link"), () => {
    const url = prompt(T("Link address"), "https://");
    if (url) wrapSelection(ta, "[", "](" + url + ")", T("text"));
  });
  return bar;
}

/* O ícone do link é desenhado, e não um emoji: 🔗 vem colorido do sistema e
 * era a única mancha de cor numa faixa que só tem glifos monocromáticos. Um
 * SVG em currentColor acompanha o tema e o hover como as letras acompanham. */
function iconeLink() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  for (const d of ["M6.6 9.4a3 3 0 0 0 4.25 0l2-2a3 3 0 1 0-4.25-4.25l-.7.7",
                   "M9.4 6.6a3 3 0 0 0-4.25 0l-2 2a3 3 0 1 0 4.25 4.25l.7-.7"]) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/* Envolve a seleção. Sem seleção, escreve o marcador com um texto de exemplo
 * dentro e deixa ele selecionado — senão o botão só move o cursor e parece
 * que não fez nada. */
function wrapSelection(ta, antes, depois = antes, exemplo = "") {
  const a = ta.selectionStart, b = ta.selectionEnd;
  const sel = ta.value.slice(a, b) || exemplo || T("text");
  ta.setRangeText(antes + sel + depois, a, b, "end");
  ta.selectionStart = a + antes.length;
  ta.selectionEnd = ta.selectionStart + sel.length;
  ta.focus();
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

// Bloco quer linha própria dos dois lados: uma cerca colada no fim de um
// parágrafo não é uma cerca, é três crases no meio do texto.
function wrapBlock(ta, antes, depois) {
  const a = ta.selectionStart, b = ta.selectionEnd;
  const pre = a > 0 && ta.value[a - 1] !== "\n" ? "\n" : "";
  const pos = b < ta.value.length && ta.value[b] !== "\n" ? "\n" : "";
  wrapSelection(ta, pre + antes, depois + pos, T("code"));
}

function prefixLines(ta, prefixo) {
  const a = ta.selectionStart, b = ta.selectionEnd;
  const ini = ta.value.lastIndexOf("\n", a - 1) + 1;
  const trecho = ta.value.slice(ini, b) || "";
  const novo = trecho.split("\n").map((l) => (l.startsWith(prefixo) ? l : prefixo + l))
                     .join("\n");
  ta.setRangeText(novo, ini, b, "end");
  ta.focus();
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

/* --------------------------------------------------------- imagens */

const IMG_MAX_SIDE = 1400;              // lado maior depois de reduzir
const IMG_MAX_BYTES = 700 * 1024;       // abaixo do teto do servidor (_ASSET_MAX_BYTES)
const IMG_MAX_PER_CARD = 3;             // espelha _ASSET_MAX_PER_CARD

const toBlob = (canvas, tipo, q) =>
  new Promise((res) => canvas.toBlob(res, tipo, q));

/* REDUZIR NO NAVEGADOR, ANTES DE SUBIR, é o que torna o endpoint de upload
 * defensável: uma captura de tela de 4 MB vira duzentos e poucos KB antes de
 * atravessar a rede, e o teto do servidor deixa de ser o que decide o
 * tamanho normal das coisas — passa a ser só o porteiro de quem não passou
 * por aqui.
 *
 * PNG primeiro porque captura de tela é texto, e texto em JPEG borra. Se o
 * PNG não couber, JPEG com qualidade decrescente: uma foto um pouco pior é
 * melhor que uma foto recusada. */
async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  const escala = Math.min(1, IMG_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * escala));
  const h = Math.max(1, Math.round(bitmap.height * escala));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  let out = await toBlob(canvas, "image/png");
  for (const q of [0.85, 0.7, 0.5]) {
    if (out && out.size <= IMG_MAX_BYTES) break;
    out = await toBlob(canvas, "image/jpeg", q);
  }
  return out;
}

async function uploadImage(blob) {
  const r = await fetch(withKey("/api/asset"), { method: "POST", body: blob });
  let j = {};
  try { j = await r.json(); } catch { /* resposta sem corpo JSON */ }
  if (!r.ok || !j.name) throw new Error(j.error || r.statusText || "upload failed");
  return j.name;
}

/* Cola uma imagem no card. O upload é imediato (como o item de checklist),
 * não fica pendurado até fechar a caixa: o blob já está no servidor quando o
 * op sai, então nenhum cliente recebe um card apontando para um arquivo que
 * ainda não existe. */
async function attachPastedImage(cardId, file) {
  const f = findCard(cardId);
  if (!f) return;
  const atuais = f.col.cards[f.index].images || [];
  if (atuais.length >= IMG_MAX_PER_CARD)
    return showToast(T("a card holds at most") + " " + IMG_MAX_PER_CARD + " " + T("images"));
  try {
    const blob = await shrinkImage(file);
    if (!blob) throw new Error("could not read the image");
    const name = await uploadImage(blob);
    const agora = findCard(cardId);        // o card pode ter mudado no caminho
    if (!agora) return;
    const lista = [...(agora.col.cards[agora.index].images || [])];
    if (lista.includes(name) || lista.length >= IMG_MAX_PER_CARD) return;
    lista.push(name);
    commit({ type: "setImages", id: cardId, images: lista });
    syncCardDialog();
  } catch (err) {
    showToast(T("could not attach the image") + ": " + err.message, "toast-error");
  }
}

function wireImagePaste(el, cardId) {
  el.addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items || [])]
      .find((i) => i.kind === "file" && i.type.startsWith("image/"));
    if (!item) return;                      // colagem de texto segue normal
    if (!canDo("setImages")) return deniedToast("setImages");
    e.preventDefault();
    const file = item.getAsFile();
    if (file) attachPastedImage(cardId, file);
  });
}

function renderDialogImages(strip) {
  strip.textContent = "";
  const d = state.cardDialog;
  const f = d && findCard(d.cardId);
  const imagens = (f && f.col.cards[f.index].images) || [];
  for (const name of imagens) {
    const fig = document.createElement("figure");
    fig.className = "dlg-thumb";
    fig.append(imageEl(name));
    const del = document.createElement("button");
    del.className = "dlg-thumb-del";
    del.textContent = "✕";
    del.title = T("remove image");
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      commit({ type: "setImages", id: d.cardId,
               images: imagens.filter((n) => n !== name) });
      renderDialogImages(strip);
    });
    applyRestriction(del, "setImages");
    fig.append(del);
    strip.append(fig);
  }
}

function cardImagesEl(card) {
  const box = document.createElement("div");
  box.className = "card-images";
  for (const name of card.images) box.append(imageEl(name));
  return box;
}

/* Um clique amplia — não dois. O duplo clique num card já abre o editor
 * (ver cardEl), e uma imagem que precisa ser acertada duas vezes é uma
 * imagem que abre a coisa errada em metade das tentativas. */
function imageEl(name) {
  const img = document.createElement("img");
  img.className = "card-img";
  img.loading = "lazy";
  img.alt = T("attached image");
  img.src = withKey("/asset/" + encodeURIComponent(name));
  img.addEventListener("pointerdown", (e) => e.stopPropagation());
  img.addEventListener("click", (e) => {
    e.stopPropagation();
    if (Date.now() - justDragged < 300) return;
    openLightbox(name);
  });
  return img;
}

/* Um estouro pequeno ao concluir um card.
 *
 * Mora no <body>, em posição fixa, e não dentro do card: o commit repinta o
 * card no mesmo quadro, e uma partícula pendurada no botão morreria antes de
 * sair do lugar. Mesma razão do lightbox estar fora do modal.
 *
 * O `-4` no eixo Y é a única licença poética: as partículas saem em círculo
 * mas sobem um pouco, senão o efeito lê como um respingo em vez de um
 * estouro. Quem pediu menos movimento no sistema não vê nada (o CSS esconde
 * .pop inteiro em prefers-reduced-motion) — por isso a decisão está lá e não
 * aqui: um `matchMedia` no JS teria que ser repetido em cada chamador. */
function celebrate(el) {
  const r = el.getBoundingClientRect();
  const box = document.createElement("div");
  box.className = "pop";
  box.style.left = r.left + r.width / 2 + "px";
  box.style.top = r.top + r.height / 2 + "px";
  const cores = [getComputedStyle(document.documentElement)
                   .getPropertyValue("--green").trim() || "#389826",
                 "#9558b2", "#4063d8", "#b58900"];
  for (let i = 0; i < 9; i++) {
    const p = document.createElement("i");
    const ang = (Math.PI * 2 * i) / 9 + Math.random() * 0.5;
    const dist = 18 + Math.random() * 16;
    p.style.setProperty("--dx", (Math.cos(ang) * dist).toFixed(1) + "px");
    p.style.setProperty("--dy", (Math.sin(ang) * dist - 4).toFixed(1) + "px");
    p.style.setProperty("--s", (4 + Math.random() * 3).toFixed(1) + "px");
    p.style.setProperty("--c", cores[i % cores.length]);
    box.append(p);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 800);
}

/* A ampliação é uma camada própria, e não um modal: showModal é o diálogo do
 * quadro (um de cada vez, com Esc gravando o card aberto), e a foto tem que
 * poder abrir POR CIMA da caixa expandida sem fechá-la. */
function openLightbox(name) {
  const ov = document.createElement("div");
  ov.className = "lightbox";
  const img = document.createElement("img");
  img.src = withKey("/asset/" + encodeURIComponent(name));
  img.alt = T("attached image");
  ov.append(img);
  const fechar = () => {
    ov.remove();
    document.removeEventListener("keydown", tecla, true);
  };
  const tecla = (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();          // o Esc fecha a foto, não a caixa atrás dela
    e.preventDefault();
    fechar();
  };
  ov.addEventListener("click", fechar);
  document.addEventListener("keydown", tecla, true);
  document.body.append(ov);
}

/* ============================================== seleção (uma ou várias) */

/* Mesmo modelo do gantt: `selection` é o conjunto e `selected` é a âncora —
 * o card que o Enter edita e de onde o Shift mede o intervalo. Ver o
 * comentário de selectTask em app.js; o que é do kanban está aqui.
 *
 * A ordem em que a seleção é lida é a ORDEM DO QUADRO (coluna por coluna, de
 * cima para baixo), não a de clique: mover seis cards para outra coluna tem
 * que empilhá-los lá na ordem em que estavam, senão o lote embaralha o que
 * alguém arrumou à mão.
 */
function selectedCards() {
  const out = [];
  for (const c of cols())
    for (const card of c.cards)
      if (state.selection.has(card.id)) out.push({ card, col: c });
  return out;
}

const selCount = () => state.selection.size;

function clearCardSelection() {
  state.selection.clear();
  state.selected = null;
  state.selEdge = null;
}

function selectOnlyCard(id) {
  state.selection = new Set(id ? [id] : []);
  state.selected = id || null;
  state.selEdge = null;
}

/* Intervalo do Shift: só DENTRO de uma coluna.
 *
 * Num quadro não existe "o que está entre os dois" atravessando colunas — a
 * ordem entre a terceira de "Fazendo" e a primeira de "Feito" é uma invenção
 * da tela, e o intervalo apanharia cards que ninguém aponta. Com a âncora em
 * outra coluna o Shift vira o Ctrl: soma só o card clicado.
 */
function extendCardSelection(id) {
  const a = findCard(state.selected), b = findCard(id);
  if (!a || !b || a.col.id !== b.col.id) return false;
  const ids = a.col.cards.slice(Math.min(a.index, b.index),
                               Math.max(a.index, b.index) + 1).map((c) => c.id);
  state.selection = new Set(ids);
  state.selEdge = id;
  return true;
}

/* O clique num card. Sem modificador é o que sempre foi; Ctrl/⌘ soma ou
 * tira; Shift pega o intervalo na coluna. Devolve true se a seleção passou a
 * ser múltipla — o chamador usa isso para decidir entre repintar as classes
 * na mão (caminho rápido de sempre) e um render() inteiro. */
function selectCard(id, ev) {
  const add = ev && (ev.ctrlKey || ev.metaKey);
  if (ev && ev.shiftKey && state.selected && !add && extendCardSelection(id)) return true;
  if (add) {
    state.selEdge = null;
    if (state.selection.delete(id)) {
      if (state.selected === id)
        state.selected = state.selection.size === 1 ? [...state.selection][0] : null;
    } else {
      state.selection.add(id);
      state.selected = id;
    }
    return true;
  }
  selectOnlyCard(id);
  return false;
}

/* Card que saiu do quadro sai da seleção: quem apagou ou arquivou pode ter
 * sido um colega, e a contagem na barra de status promete quantos a próxima
 * ação em lote vai atingir. Roda a cada render — é o único ponto por onde
 * todo board novo passa. */
function pruneMissingSelection() {
  if (!state.selection.size) return;
  const vivos = new Set();
  for (const c of cols()) for (const card of c.cards) vivos.add(card.id);
  for (const id of [...state.selection]) if (!vivos.has(id)) state.selection.delete(id);
  if (state.selEdge && !state.selection.has(state.selEdge)) state.selEdge = null;
  if (state.selected && !state.selection.has(state.selected)) {
    state.selected = state.selection.size === 1 ? [...state.selection][0] : null;
  }
}

/* Ctrl+A pega o quadro inteiro — menos o que o filtro apagou. Com "#obra"
 * digitado, os outros cards estão esmaecidos justamente porque não são o
 * assunto, e "selecionar tudo" seguido de "arquivar" tem que valer sobre o
 * que se está olhando. Mesma regra do Ctrl+A do gantt com um destaque ligado.
 *
 * O intervalo do Shift é o contrário e de propósito: ele promete "daqui até
 * ali na coluna", e o que está entre as duas pontas vai junto. */
function selectAllCards() {
  const ids = [];
  for (const c of cols()) for (const card of c.cards) if (matchesFilter(card)) ids.push(card.id);
  state.selection = new Set(ids);
  state.selEdge = null;
  if (!state.selection.has(state.selected)) state.selected = null;
  render();
}

/* ================================================== drag & drop */

const DRAG_THRESHOLD = 5;
const LONGPRESS_MS = 300;

let lastPointerType = "mouse";
document.addEventListener("pointerdown", (e) => {
  lastPointerType = e.pointerType || "mouse";
}, true);

function maybeDrag(e, card) {
  // sem permissão de mover: nem inicia o gesto — clicar/selecionar o card
  // continua funcionando normalmente, só o arrasto fica fora
  if (!canDo("moveCard")) return;
  const el = e.currentTarget;

  // Toque: arrastar exige segurar (estilo Trello) — assim o dedo continua
  // podendo rolar o board normalmente; mover antes do tempo cancela.
  if (e.pointerType === "touch") {
    const origin = { x: e.clientX, y: e.clientY };
    let lastEv = e;
    const timer = setTimeout(() => {
      cleanup();
      navigator.vibrate?.(12);
      startDrag(lastEv, card, el);
    }, LONGPRESS_MS);
    const onMove = (ev) => {
      lastEv = ev;
      if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) > 8) cleanup();
    };
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
    return;
  }

  if (e.button !== 0) return;
  const origin = { x: e.clientX, y: e.clientY };

  const onMove = (ev) => {
    if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < DRAG_THRESHOLD)
      return;
    cleanup();
    startDrag(ev, card, el);
  };
  const cleanup = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", cleanup);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", cleanup);
}

// durante o arrasto por toque o scroll nativo precisa ser suprimido
const _preventScroll = (e) => e.preventDefault();

function _onDragCancel() {
  if (state.drag) {
    state.drag.target = null;
    endDrag();
  }
}

function startDrag(e, card, el) {
  const rect = el.getBoundingClientRect();
  const clone = el.cloneNode(true);
  clone.classList.add("drag-clone");
  clone.classList.remove("selected");
  clone.style.width = rect.width + "px";

  // Arrastar um da seleção arrasta a seleção inteira. O card sob o cursor é
  // o que voa; os outros saem do lugar de origem junto com ele (.ghost), e o
  // que voa mostra a PILHA — senão o gesto move seis cards mostrando um.
  const lote = state.selection.has(card.id) && selCount() > 1
    ? selectedCards().map((f) => f.card.id) : [card.id];

  // O que segue o ponteiro é o embrulho, não o card: as camadas de trás são
  // pseudo-elementos DELE. No próprio clone não daria — o z-index negativo
  // dentro de um contexto de empilhamento pinta acima do fundo do elemento,
  // então as camadas apareceriam por CIMA do card em vez de atrás dele.
  const flier = document.createElement("div");
  flier.className = "drag-flier";
  if (lote.length > 1) {
    // uma camada para dois, duas para três ou mais: a pilha diz "vários" de
    // relance e o número diz quantos, que é o que a pilha para de dizer
    // sozinha assim que passa de três
    flier.classList.add("stacked");
    if (lote.length > 2) flier.classList.add("stacked-3");
    const n = document.createElement("span");
    n.className = "drag-count";
    n.textContent = lote.length;
    clone.append(n);
  }
  flier.append(clone);
  document.body.append(flier);

  const slot = document.createElement("div");
  slot.className = "drop-slot";

  state.drag = {
    card,
    lote,                  // ids na ordem do quadro (ver selectedCards)
    el,
    flier,                 // o embrulho que voa (o clone e as camadas de trás)
    slot,
    dx: e.clientX - rect.left,
    dy: e.clientY - rect.top,
    target: null,          // {colId, beforeId}
  };
  for (const id of lote) {
    const n = $(`.card[data-card="${id}"]`, boardEl);
    if (n) n.classList.add("ghost");
  }
  document.body.style.cursor = "grabbing";
  sendPresenceNow({ dragging: card.id });
  positionFlier(e);
  updateDropTarget(e);

  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", endDrag, { once: true });
  window.addEventListener("pointercancel", _onDragCancel, { once: true });
  if (lastPointerType === "touch")
    window.addEventListener("touchmove", _preventScroll, { passive: false });
}

function onDragMove(e) {
  positionFlier(e);
  updateDropTarget(e);
  trackPointer(e);
}

function positionFlier(e) {
  const d = state.drag;
  d.flier.style.transform =
    `translate(${e.clientX - d.dx}px, ${e.clientY - d.dy}px) rotate(2deg)`;
  // auto-scroll horizontal perto das bordas do board
  const b = boardEl.getBoundingClientRect();
  if (e.clientX > b.right - 48) boardEl.scrollLeft += 14;
  else if (e.clientX < b.left + 48) boardEl.scrollLeft -= 14;
}

function updateDropTarget(e) {
  const d = state.drag;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const colEl = under?.closest?.(".col");
  if (!colEl) {
    d.slot.remove();
    d.target = null;
    return;
  }
  const cardsEl = $(".cards", colEl);
  // fora os que estão voando (todos os do lote, não só o de baixo do cursor):
  // o vão vai abrir onde eles NÃO estão mais
  const others = $$(".card", cardsEl).filter(
    (c) => !c.classList.contains("ghost") && !c.classList.contains("drag-clone"));
  let index = others.length;
  for (let i = 0; i < others.length; i++) {
    const r = others[i].getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) { index = i; break; }
  }
  const ref = others[index] ?? null;
  cardsEl.insertBefore(d.slot, ref);
  // Guarda o VIZINHO, não o índice: com seis cards saindo de lugares
  // diferentes, "índice 3" quer dizer coisas diferentes a cada op aplicada,
  // enquanto "antes deste card aqui" continua querendo dizer a mesma coisa.
  d.target = { colId: colEl.dataset.col, beforeId: ref?.dataset.card ?? null };
}

/* Índices para mover um lote: o mesmo remove-depois-insere que applyLocal (e
 * o servidor, em _kanban_apply!) faz, simulado sobre uma lista de ids.
 *
 * Precisa simular porque as ops são aplicadas uma a uma, em ordem, e cada
 * uma muda os índices da seguinte: mover A e C de [A,B,C,D] para o fim de
 * [X] são os índices 1 e 2, mas mover os dois DENTRO da própria coluna são
 * outros dois números. Calcular "antes do vizinho" na hora, por op, é o
 * único jeito de o resultado ser o que o vão na tela prometeu.
 *
 * Arrasto que devolve o lote exatamente ao lugar onde estava não é uma
 * edição: sai lista vazia, e nenhum desfazer é queimado. A comparação é do
 * QUADRO INTEIRO no fim, não op por op — no meio do caminho cada card passa
 * por um índice que não é o dele (mover "a" e "b" para antes de "c" tira o
 * "a" da frente do "b" antes de recolocá-lo), e olhar só uma op de cada vez
 * diria que houve mudança quando não houve.
 */
function moveOpsFor(ids, toColId, beforeId) {
  const sim = new Map(cols().map((c) => [c.id, c.cards.map((x) => x.id)]));
  const antes = JSON.stringify([...sim]);
  if (!sim.has(toColId)) return [];
  const ops = [];
  for (const id of ids) {
    let deOnde = null;
    for (const [colId, lista] of sim) {
      const i = lista.indexOf(id);
      if (i >= 0) { deOnde = colId; lista.splice(i, 1); break; }
    }
    if (deOnde === null) continue;              // card sumiu (colega apagou)
    const dest = sim.get(toColId);
    let at = beforeId ? dest.indexOf(beforeId) : -1;
    if (at < 0) at = dest.length;
    dest.splice(at, 0, id);
    ops.push({ type: "moveCard", id, toCol: toColId, toIndex: at });
  }
  return JSON.stringify([...sim]) === antes ? [] : ops;
}

let justDragged = 0;

function endDrag() {
  justDragged = Date.now();
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointercancel", _onDragCancel);
  window.removeEventListener("touchmove", _preventScroll);
  const d = state.drag;
  state.drag = null;
  document.body.style.cursor = "";
  d.flier.remove();
  d.slot.remove();
  for (const n of $$(".card.ghost", boardEl)) n.classList.remove("ghost");
  sendPresenceNow({});

  if (d.target) {
    const ops = moveOpsFor(d.lote, d.target.colId, d.target.beforeId);
    if (ops.length) commitMany(ops);
  }
  if (state.pendingBoard) {          // mudanças que chegaram durante o gesto
    const b = state.pendingBoard;
    state.pendingBoard = null;
    acceptBoard(b);
  } else if (!d.target) {
    render();
  }
}

/* ==================================================== presença */

/* O cursor de cada peer é publicado como âncora: elemento (card, coluna ou
 * board) + posição fracionária dentro dele. Cada janela resolve a âncora na
 * sua própria geometria, então funciona com zoom/tamanhos diferentes. */

let myAnchor = null;
let extraPresence = {};       // {dragging} ou {editing}
let presenceDirty = false;

function trackPointer(e) {
  const t = document.elementFromPoint(e.clientX, e.clientY);
  const cardEl2 = t?.closest?.(".card:not(.drag-clone)");
  const colEl = t?.closest?.(".col");
  let a = null;
  if (cardEl2) {
    const r = cardEl2.getBoundingClientRect();
    a = { kind: "card", id: cardEl2.dataset.card,
          fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height };
  } else if (colEl) {
    const r = colEl.getBoundingClientRect();
    a = { kind: "col", id: colEl.dataset.col,
          fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height };
  } else {
    const r = boardEl.getBoundingClientRect();
    a = { kind: "board",
          fx: (boardEl.scrollLeft + e.clientX - r.left) / Math.max(boardEl.scrollWidth, 1),
          fy: (e.clientY - r.top) / Math.max(r.height, 1) };
  }
  myAnchor = a;
  presenceDirty = true;
}

function sendPresenceNow(extra) {
  extraPresence = extra;
  send({ type: "presence", state: { anchor: myAnchor, ...extraPresence } });
  presenceDirty = false;
}

document.addEventListener("pointermove", trackPointer);
document.addEventListener("pointerleave", () => {
  myAnchor = null;
  presenceDirty = true;
});
setInterval(() => {
  if (presenceDirty) sendPresenceNow(extraPresence);
}, 60);

function peerColor(p) {
  return PALETTE[p.color % PALETTE.length];
}
// cor estável derivada do texto (tags e IPs sem peer conectado)
function tagColor(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function colorForIp(ip) {
  if (state.me && state.me.ip === ip) return peerColor(state.me);
  for (const p of state.peers.values()) if (p.ip === ip) return peerColor(p);
  return tagColor(ip);
}

function matchesFilter(card) {
  if (!state.filter) return true;
  // o corpo entra na busca: a partir do momento em que dá para escrever um
  // parágrafo no card, "onde é que estava aquilo" é uma pergunta sobre ele
  const hay = (card.text + " " + (card.body || "") + " " +
    (card.assignee || "") + " " +
    (card.by ? displayFor(card.by) + " " + card.by : "")).toLowerCase();
  return hay.includes(state.filter);
}

function setFilter(v) {
  $("#search").value = v;
  state.filter = v.trim().toLowerCase();
  render();
}

// Carimbo de momento no formato do servidor (_kanban_now no kanban.jl:
// "yyyy-mm-dd HH:MM"), na hora LOCAL. toISOString devolve UTC, e usá-lo
// aqui gravava num campo que o REPL preenche em hora local — o mesmo
// campo passava a ter dois significados conforme o card tivesse nascido
// no navegador ou no Julia, e num fuso negativo o carimbo do navegador
// caía no dia seguinte depois do fim da tarde.
function localStamp() {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

// data local (toISOString é UTC; compensa o fuso p/ comparar prazos)
function localISO(plusDays = 0) {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000 +
                     plusDays * 86400000);
  return d.toISOString().slice(0, 10);
}

const MONTHS = new Proxy([], {   // meses no idioma da interface
  get: (_, i) => (window.PerthI18n
    ? PerthI18n.months()
    : ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"])[i],
});

function dueInfo(card) {
  if (!card.due) return null;
  const cls = card.done ? "" :
    card.due < localISO() ? "overdue" :
    card.due <= localISO(1) ? "soon" : "";
  const d = new Date(card.due + "T00:00");
  const label = isNaN(d) ? card.due : d.getDate() + " " + MONTHS[d.getMonth()];
  return { cls, label };
}

// Card criado hoje. O servidor carimba `at` na criação ("yyyy-mm-dd HH:MM",
// _kanban_now no kanban.jl) e nunca mais mexe nele — restaurar do arquivo
// preserva o carimbo original, então card velho não volta a ser "novo".
// Concluído não conta: "novo" só interessa enquanto ainda há o que fazer
// com o card, e é o que impede o board de um dia cheio de virar um mural
// de etiquetas. Card sem `at` (board anterior a este campo) fica sem nada.
const isNewCard = (card) =>
  !card.done && !!card.at && String(card.at).slice(0, 10) === localISO();

// Prazo e etiqueta "new" saem da data de HOJE, mas só são montados em
// render() — que roda em cima de op, não de relógio. Um board deixado
// aberto durante a virada do dia mostraria o "hoje" de ontem até alguém
// mexer nele; este timer redesenha logo depois da meia-noite e se reagenda.
function renderAtMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1,
                        0, 0, 5);
  setTimeout(() => {
    render();
    renderAtMidnight();
  }, next - now);
}

// apelido definido pelo host tem precedência sobre o nome auto-escolhido
const aliasOf = (ip) => (state.board.aliases || {})[ip] || "";
// resolução de nome: alias do host > nome que a pessoa escolheu > IP
function displayFor(ip) {
  const a = aliasOf(ip);
  if (a) return a;
  if (state.me && state.me.ip === ip && state.me.name !== ip) return state.me.name;
  for (const p of state.peers.values())
    if (p.ip === ip && p.name !== ip) return p.name;
  return ip;
}
function peerLabel(p) {
  return aliasOf(p.ip) || (p.name && p.name !== p.ip ? p.name : p.ip);
}

function resolveAnchor(a) {
  if (!a) return null;
  let el = null;
  if (a.kind === "card") el = $(`.card[data-card="${a.id}"]`, boardEl);
  else if (a.kind === "col") el = $(`.col[data-col="${a.id}"]`, boardEl);
  if (el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + a.fx * r.width, y: r.top + a.fy * r.height };
  }
  if (a.kind === "board") {
    const r = boardEl.getBoundingClientRect();
    return { x: r.left - boardEl.scrollLeft + a.fx * Math.max(boardEl.scrollWidth, 1),
             y: r.top + a.fy * r.height };
  }
  return null;
}

function renderCursors() {
  cursorsEl.textContent = "";
  for (const p of state.peers.values()) {
    const pos = resolveAnchor(p.presence?.anchor);
    if (!pos) continue;
    const c = document.createElement("div");
    c.className = "cursor";
    c.style.setProperty("--peer", peerColor(p));
    c.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    c.innerHTML =
      `<svg width="15" height="15" viewBox="0 0 24 24">` +
      `<path d="M4 2l16 8.5-7 1.7L9 20z" fill="${peerColor(p)}" ` +
      `stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    const label = document.createElement("div");
    label.className = "cursor-label";
    const lbl = peerLabel(p);
    if (lbl !== p.ip) {
      label.textContent = lbl + " ";
      const ip = document.createElement("span");
      ip.className = "cursor-ip";
      ip.textContent = "· " + p.ip;
      label.append(ip);
    } else {
      label.textContent = p.ip;
    }
    label.title = p.ip;
    c.append(label);
    cursorsEl.append(c);
  }
}

// contorno + etiqueta nos cards que outros estão arrastando/editando
function renderHolds() {
  $$(".card.peer-hold", boardEl).forEach((el) => {
    el.classList.remove("peer-hold");
    $(".peer-tag", el)?.remove();
  });
  for (const p of state.peers.values()) {
    const hold = p.presence?.dragging || p.presence?.editing;
    if (!hold) continue;
    const el = $(`.card[data-card="${hold}"]`, boardEl);
    if (!el) continue;
    el.classList.add("peer-hold");
    el.style.setProperty("--peer", peerColor(p));
    const tag = document.createElement("span");
    tag.className = "peer-tag";
    tag.textContent =
      peerLabel(p) + (p.presence?.editing ? " is editing…" : " is moving…");
    tag.title = p.ip;
    el.append(tag);
  }
}

// Cap de chips visíveis: sem isso, muitos peers conectados fazem #peers
// crescer sem limite e empurram o resto da menubar (chat/conn/tema) para
// fora — a largura de #peers precisa ser determinística (ver ui.css).
// "Você" é sempre o primeiro do array e nunca é cortado.
const PEERS_VISIBLE_MAX = 6;

function peerChipEl(p) {
  const chip = document.createElement("span");
  chip.className = "peer-chip" + (p.__me ? " me" : "");
  chip.style.background = peerColor(p);
  chip.textContent = peerLabel(p).replace(/^\D*/, "").charAt(0) ||
                     peerLabel(p).charAt(0).toUpperCase();
  chip.title = (p.__me ? "you — " : "") + peerLabel(p) + " · " + p.ip;
  return chip;
}

// chip "+N" com a lista completa das máquinas excedentes — quem quiser ver
// todo mundo ainda consegue, sem estourar a largura da menubar
function peerOverflowEl(hidden) {
  const wrap = document.createElement("div");
  wrap.className = "menu peer-more-wrap";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "peer-chip peer-more";
  btn.textContent = "+" + hidden.length;
  const label = window.PerthI18n ? PerthI18n.t("more connected machines") : "more connected machines";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  const drop = document.createElement("div");
  drop.className = "menu-drop peer-more-drop";
  for (const p of hidden) {
    const row = document.createElement("div");
    row.className = "peer-more-row";
    const dot = document.createElement("span");
    dot.className = "peer-more-dot";
    dot.style.background = peerColor(p);
    const name = document.createElement("span");
    name.className = "peer-more-name";
    name.textContent = (p.__me ? "you — " : "") + peerLabel(p);
    const ip = document.createElement("span");
    ip.className = "peer-more-ip";
    ip.textContent = p.ip;
    row.append(dot, name, ip);
    drop.append(row);
  }
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = wrap.classList.contains("open");
    closeMenus();
    if (!open) wrap.classList.add("open");
  });
  wrap.append(btn, drop);
  return wrap;
}

function renderPeers() {
  const box = $("#peers");
  box.textContent = "";
  const all = state.me
    ? [{ ...state.me, __me: true }, ...state.peers.values()]
    : [...state.peers.values()];
  for (const p of all.slice(0, PEERS_VISIBLE_MAX)) box.append(peerChipEl(p));
  const hidden = all.slice(PEERS_VISIBLE_MAX);
  if (hidden.length) box.append(peerOverflowEl(hidden));
}

function renderStatus() {
  const ncards = cols().reduce((n, c) => n + c.cards.length, 0);
  const narch = (state.board.archive || []).length;
  let txt = `${cols().length} columns · ${ncards} cards` +
    (narch ? ` · ${narch} archived` : "");
  if (state.filter) {
    const nmatch = cols().reduce(
      (n, c) => n + c.cards.filter(matchesFilter).length, 0);
    txt += ` · ${nmatch} match`;
  }
  // o número que toda ação em lote vai usar, visível antes de a ação rodar
  if (selCount() > 1) txt += ` · ${selCount()} ${T("cards selected")}`;
  $("#st-board").textContent = txt;
  $("#st-me").textContent = state.me
    ? `you: ${peerLabel(state.me)} (${state.me.ip})` : "";
  $("#st-rev").textContent = `rev ${state.rev}`;
}

// cursores são ancorados a elementos: reancorar em scroll/resize
boardEl.addEventListener("scroll", renderCursors, { passive: true });
window.addEventListener("resize", renderCursors);

/* ==================================================== modais */

function closeModal() {
  // a caixa do card grava ao fechar, por qualquer caminho de fechamento
  if (state.cardDialog) saveCardDialog();
  const root = $("#modal-root");
  root.hidden = true;
  root.textContent = "";
  state.openModal = null;
}

function showModal(title, body, key = null) {
  state.openModal = key;
  const root = $("#modal-root");
  root.hidden = false;
  root.textContent = "";
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.addEventListener("click", (e) => {
    if (e.target === ov) closeModal();
  });
  const m = document.createElement("div");
  m.className = "modal";
  const head = document.createElement("div");
  head.className = "modal-head";
  head.textContent = title;
  const x = document.createElement("button");
  x.textContent = "✕";
  x.title = T("close (Esc)");
  x.addEventListener("click", closeModal);
  head.append(x);
  const b = document.createElement("div");
  b.className = "modal-body";
  b.append(body);
  m.append(head, b);
  ov.append(m);
  root.append(ov);
}

function showArchived() {
  const body = document.createElement("div");
  const arch = state.board.archive || [];
  if (!arch.length) {
    const p = document.createElement("div");
    p.className = "empty-note";
    p.textContent = T("Nothing archived yet — finish a card (✓) and hit \"archive\".");
    body.append(p);
  }
  for (const entry of [...arch].reverse()) {   // mais recente primeiro
    const row = document.createElement("div");
    row.className = "arch-item";
    const txt = document.createElement("div");
    txt.className = "arch-text";
    txt.textContent = entry.text;
    const sub = document.createElement("div");
    sub.className = "arch-sub";
    sub.textContent = [
      entry.col ? "from " + entry.col : "",
      entry.by ? "by " + displayFor(entry.by) : "",
      entry.archived_at || "",
    ].filter(Boolean).join(" · ");
    txt.append(sub);
    const restore = document.createElement("button");
    restore.textContent = T("restore");
    restore.addEventListener("click", () => {
      commit({ type: "restoreCard", id: entry.id });
      showArchived();
    });
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = T("delete");
    del.title = T("delete forever (cannot be undone)");
    del.addEventListener("click", () => {
      if (!confirm("Delete this card forever? This cannot be undone.")) return;
      commit({ type: "delArchived", id: entry.id });
      showArchived();
    });
    row.append(txt, restore, del);
    body.append(row);
  }
  showModal("Archived cards", body, "archived");
}

// Renomear máquinas (só o host vê o item de menu; o servidor também valida)
function showAliases() {
  const body = document.createElement("div");
  const ips = new Set();
  if (state.me) ips.add(state.me.ip);
  for (const p of state.peers.values()) ips.add(p.ip);
  for (const c of cols()) for (const k of c.cards) k.by && ips.add(k.by);
  for (const e of state.board.archive || []) e.by && ips.add(e.by);
  for (const ip of Object.keys(state.board.aliases || {})) ips.add(ip);
  for (const ip of [...ips].sort()) {
    const row = document.createElement("div");
    row.className = "alias-row";
    const lbl = document.createElement("span");
    lbl.className = "alias-ip";
    lbl.textContent = ip + (state.me && ip === state.me.ip ? " (you)" : "");
    lbl.title = ip;
    const input = document.createElement("input");
    input.placeholder = T("e.g. Paulo");
    input.maxLength = 24;
    input.value = aliasOf(ip);
    const save = () => {
      const v = input.value.trim();
      if (v !== aliasOf(ip)) commit({ type: "setAlias", ip, name: v });
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      e.stopPropagation();
    });
    input.addEventListener("blur", save);
    row.append(lbl, input);
    body.append(row);
  }
  const hint = document.createElement("div");
  hint.className = "alias-hint";
  hint.textContent = T("Names apply to everyone's screen: cursors, chips and card stamps. Empty = back to the IP.");
  body.append(hint);
  showModal("Rename machines", body, "aliases");
}

// Matriz de permissões (só o host vê o item de menu; o servidor também
// valida). Estende o mesmo padrão de showAliases() — mesma coleta de IPs,
// mesmo modal host-only — em vez de um componente novo: aqui a diferença é
// só o corpo (uma tabela larga, com a primeira coluna fixa) e a classe
// "modal-wide". O host nunca aparece como linha: ele é sempre permitido
// no servidor (_kanban_permitted em kanban.jl), então uma linha para ele
// seria enganosa.
function showPermissions() {

  // reconstruída do zero a cada eco do servidor (mesmo padrão de
  // showActivity/showArchived) — preserva a rolagem entre reconstruções
  // para um clique não resetar a posição horizontal da tabela
  const prevScroll = $(".perm-scroll");
  const savedLeft = prevScroll ? prevScroll.scrollLeft : 0;
  const prevBody = $("#modal-root .modal-body");
  const savedTop = prevBody ? prevBody.scrollTop : 0;

  const ips = new Set();
  for (const p of state.peers.values()) ips.add(p.ip);
  for (const c of cols()) for (const k of c.cards) k.by && ips.add(k.by);
  for (const e of state.board.archive || []) e.by && ips.add(e.by);
  for (const ip of Object.keys(state.board.aliases || {})) ips.add(ip);
  for (const ip of Object.keys(state.board.permissions || {})) ips.add(ip);
  if (state.me) ips.delete(state.me.ip);   // host: sempre permitido, linha própria seria enganosa
  const rows = [...ips].sort();

  const permsOf = (ip) => (state.board.permissions || {})[ip] || {};
  const allowedNow = (ip, action) => permsOf(ip)[action] !== false;
  const commitPermissions = (changes) => commit({ type: "setPermissions", changes });

  const body = document.createElement("div");

  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = T("No other machines have connected yet.");
    body.append(empty);
    showModal(T("Permissions"), body, "permissions");
    $("#modal-root .modal")?.classList.add("modal-wide");
    return;
  }

  const scroll = document.createElement("div");
  scroll.className = "perm-scroll";
  const table = document.createElement("table");
  table.className = "perm-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.className = "perm-corner";
  const cornerBox = document.createElement("input");
  cornerBox.type = "checkbox";
  cornerBox.title = T("check/uncheck everything");
  corner.append(cornerBox);
  headRow.append(corner);

  const colMasters = [];   // um checkbox mestre por ação (topo da coluna)
  for (const a of GATED_ACTIONS) {
    const th = document.createElement("th");
    th.className = "perm-col-head";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.title = T("check/uncheck this action for everyone");
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      commitPermissions(rows.map((ip) => ({ ip, action: a.type, allowed: box.checked })));
    });
    const lbl = document.createElement("span");
    lbl.textContent = actionLabel(a.type);
    th.append(box, lbl);
    headRow.append(th);
    colMasters.push({ action: a.type, box });
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  const rowMasters = [];   // um checkbox mestre por participante (início da linha)
  for (const ip of rows) {
    const tr = document.createElement("tr");
    const rowHead = document.createElement("th");
    rowHead.className = "perm-row-head";
    const master = document.createElement("input");
    master.type = "checkbox";
    master.title = T("check/uncheck this machine");
    master.addEventListener("click", (e) => {
      e.stopPropagation();
      commitPermissions(GATED_ACTIONS.map((a) =>
        ({ ip, action: a.type, allowed: master.checked })));
    });
    const name = document.createElement("span");
    name.className = "perm-row-name";
    name.textContent = displayFor(ip);
    const ipEl = document.createElement("span");
    ipEl.className = "perm-row-ip";
    ipEl.textContent = ip;
    const inner = document.createElement("div");
    inner.className = "perm-row-head-inner";
    inner.append(master, name, ipEl);
    rowHead.append(inner);
    tr.append(rowHead);

    for (const a of GATED_ACTIONS) {
      const td = document.createElement("td");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = allowedNow(ip, a.type);
      box.addEventListener("click", (e) => {
        e.stopPropagation();
        commitPermissions([{ ip, action: a.type, allowed: box.checked }]);
      });
      td.append(box);
      tr.append(td);
    }
    tbody.append(tr);
    rowMasters.push({ ip, box: master });
  }
  table.append(tbody);
  scroll.append(table);
  body.append(scroll);

  // Estado inicial dos mestres (checked/indeterminate) — os cliques em
  // massa reconstroem o modal inteiro no eco do servidor, então isto
  // também cobre "depois de aplicado"
  for (const { action, box } of colMasters) {
    const states = rows.map((ip) => allowedNow(ip, action));
    box.checked = states.every(Boolean);
    box.indeterminate = !box.checked && states.some(Boolean);
  }
  for (const { ip, box } of rowMasters) {
    const states = GATED_ACTIONS.map((a) => allowedNow(ip, a.type));
    box.checked = states.every(Boolean);
    box.indeterminate = !box.checked && states.some(Boolean);
  }
  cornerBox.checked = rowMasters.every((r) => r.box.checked);
  cornerBox.indeterminate = !cornerBox.checked &&
    rowMasters.some((r) => r.box.checked || r.box.indeterminate);
  cornerBox.addEventListener("click", (e) => {
    e.stopPropagation();
    const changes = [];
    for (const ip of rows)
      for (const a of GATED_ACTIONS) changes.push({ ip, action: a.type, allowed: cornerBox.checked });
    commitPermissions(changes);
  });

  const hint = document.createElement("div");
  hint.className = "alias-hint";
  hint.textContent = T("Unchecked = blocked on that machine. The host machine is always allowed here, no matter this matrix.");
  body.append(hint);

  showModal(T("Permissions"), body, "permissions");
  $("#modal-root .modal")?.classList.add("modal-wide");
  scroll.scrollLeft = savedLeft;
  const newBody = $("#modal-root .modal-body");
  if (newBody) newBody.scrollTop = savedTop;
}

/* ============================================ notificações */

let unseen = 0;

// Som de alerta (junto do toast). Navegadores bloqueiam áudio antes da
// primeira interação do usuário na página — o catch engole esse caso.
const alertSound = typeof Audio !== "undefined" ? new Audio("/alert.mp3") : null;
if (alertSound) alertSound.volume = 0.55;

function playAlert() {
  if (!alertSound) return;
  if (localStorage.getItem("perth-kanban-sound") === "off") return;
  try {
    alertSound.currentTime = 0;
    const p = alertSound.play();   // nem toda engine retorna Promise
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    // áudio indisponível (autoplay bloqueado etc.): segue sem som
  }
}
const BASE_TITLE = document.title;

function updateTitle() {
  document.title = unseen > 0 ? `(${unseen}) ${BASE_TITLE}` : BASE_TITLE;
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    unseen = 0;
    updateTitle();
  }
});

// Aviso de presença: nome em negrito na cor da máquina, a mesma do cursor
// remoto. É o único que carrega marcação, por isso tem função própria no
// componente compartilhado.
function toast(entry) {
  return PerthToast.peer(displayFor(entry.ip), " " + entry.text,
                         colorForIp(entry.ip), entry.ip);
}

/* ============================================ chat geral
 *
 * Painel flutuante, não-modal: fica aberto enquanto se arrasta e edita
 * cards, ao contrário do overlay bloqueante de Activity/Archived. Sem
 * eco otimista — a mensagem só aparece quando o servidor a rebroadcasta
 * (mesmo canal instantâneo do resto do board, sem lock de op).
 */

const chatPanel = $("#chat-panel");
const chatLogEl = $("#chat-log");
const chatBadgeEl = $("#chat-badge");
const chatInput = $("#chat-input");
const chatTypingEl = $("#chat-typing");
let chatUnseen = 0;

// widget flutuante arrastável (ver frontend/shared/draggable.js); restaura
// a posição salva na hora — não precisa esperar a primeira abertura
const chatDrag = window.PerthDraggable
  ? PerthDraggable(chatPanel, chatPanel.querySelector(".chat-head"), "perth-chat-pos")
  : null;
chatDrag?.restore();

// "alguém está digitando": sinal efêmero (não entra no histórico). Cada
// peer some da lista sozinho se não reenviar em TYPING_TTL — sem
// "parei de digitar" explícito, mais simples e tolerante a desconexão.
const TYPING_TTL = 4000;
const typingPeers = new Map();   // peer id -> timeout handle
let lastTypingSent = 0;

function renderTyping() {
  const names = [...typingPeers.keys()]
    .map((id) => state.peers.get(id))
    .filter(Boolean)
    .map(peerLabel);
  chatTypingEl.hidden = !names.length;
  chatTypingEl.textContent = names.length === 0 ? "" :
    names.length === 1 ? `${names[0]} is typing…` :
    `${names.length} people are typing…`;
}

function markTyping(peerId) {
  if (typingPeers.has(peerId)) clearTimeout(typingPeers.get(peerId));
  typingPeers.set(peerId, setTimeout(() => {
    typingPeers.delete(peerId);
    renderTyping();
  }, TYPING_TTL));
  renderTyping();
}

function clearTyping(peerId) {
  if (!typingPeers.has(peerId)) return;
  clearTimeout(typingPeers.get(peerId));
  typingPeers.delete(peerId);
  renderTyping();
}

function clearTypingByIp(ip) {
  for (const [id, p] of state.peers) if (p.ip === ip) clearTyping(id);
}

function updateChatBadge() {
  chatBadgeEl.hidden = chatUnseen === 0;
  chatBadgeEl.textContent = chatUnseen > 9 ? "9+" : String(chatUnseen);
}

function chatMsgEl(e) {
  const mine = state.me && e.ip === state.me.ip;
  const row = document.createElement("div");
  row.className = "chat-msg" + (mine ? " mine" : "");
  row.style.setProperty("--peer", colorForIp(e.ip));
  const meta = document.createElement("div");
  meta.className = "chat-meta";
  const who = document.createElement("span");
  who.className = "chat-who";
  who.textContent = displayFor(e.ip);
  who.title = e.ip;
  meta.append(who, " " + e.at);
  const text = document.createElement("div");
  text.className = "chat-text";
  text.textContent = e.text;
  row.append(meta, text);
  return row;
}

function appendChatMsg(e) {
  const nearBottom = chatLogEl.scrollHeight - chatLogEl.scrollTop -
                     chatLogEl.clientHeight < 60;
  chatLogEl.append(chatMsgEl(e));
  if (nearBottom) chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function renderChat() {
  chatLogEl.textContent = "";
  if (!state.chat.length) {
    const p = document.createElement("div");
    p.className = "empty-note";
    p.textContent = window.PerthI18n
      ? PerthI18n.t("No messages yet — say hi.") : "No messages yet — say hi.";
    chatLogEl.append(p);
  } else {
    for (const e of state.chat) chatLogEl.append(chatMsgEl(e));
  }
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function openChat() {
  state.chatOpen = true;
  document.body.classList.add("chat-open");
  chatPanel.hidden = false;
  chatUnseen = 0;
  updateChatBadge();
  renderChat();
  chatInput.focus();
}

function closeChat() {
  state.chatOpen = false;
  document.body.classList.remove("chat-open");
  chatPanel.hidden = true;
  for (const id of typingPeers.keys()) clearTimeout(typingPeers.get(id));
  typingPeers.clear();
}

function submitChat() {
  const v = chatInput.value.trim();
  if (!v) return;
  send({ type: "chat", text: v });
  chatInput.value = "";
  chatInput.style.height = "";
  lastTypingSent = 0;   // próxima letra já reavisa, sem esperar o throttle
}

$("#chat-toggle").addEventListener("click", () =>
  state.chatOpen ? closeChat() : openChat());
$("#chat-close").addEventListener("click", closeChat);
$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  submitChat();
});
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
  const now = Date.now();
  if (chatInput.value.trim() && now - lastTypingSent > 2000) {
    lastTypingSent = now;
    send({ type: "typing" });
  }
});
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitChat();
  } else if (e.key === "Escape") {
    closeChat();
  }
});

/* ============================================ atividade e share */

function showActivity() {
  const body = document.createElement("div");
  if (!state.log.length) {
    const p = document.createElement("div");
    p.className = "empty-note";
    p.textContent = T("No activity yet.");
    body.append(p);
  }
  for (const e of [...state.log].reverse()) {
    const row = document.createElement("div");
    row.className = "log-item";
    const at = document.createElement("span");
    at.className = "log-at";
    at.textContent = e.at;
    const text = document.createElement("div");
    text.className = "log-text";
    const who = document.createElement("span");
    who.className = "log-who";
    who.textContent = displayFor(e.ip);
    who.title = e.ip;
    who.style.setProperty("--logc", colorForIp(e.ip));
    text.append(who, " " + e.text);
    row.append(at, text);
    body.append(row);
  }
  showModal("Activity", body, "activity");
}

function qrSvg(rows) {
  const n = rows.length;
  const pad = 3;                       // quiet zone (a matriz vem sem borda)
  const size = n + pad * 2;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("width", "220");
  svg.setAttribute("height", "220");
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", size);
  bg.setAttribute("height", size);
  bg.setAttribute("fill", "#fff");     // QR sempre preto-no-branco, tema à parte
  svg.append(bg);
  const d = [];
  rows.forEach((row, i) => {
    [...row].forEach((ch, j) => {
      if (ch === "1") d.push(`M${j + pad} ${i + pad}h1v1h-1z`);
    });
  });
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", d.join(""));
  p.setAttribute("fill", "#000");
  svg.append(p);
  return svg;
}

// O corpo do diálogo é recarregado do servidor: ao abrir, ao alternar a
// transmissão aqui e quando ela é alternada em outro lugar (REPL ou outra
// aba — chega como mensagem "share" pelo WS, ver handleMessage)
let shareBody = null;

function showShare() {
  const body = document.createElement("div");
  const note = document.createElement("div");
  note.className = "empty-note";
  note.textContent = T("loading…");
  body.append(note);
  shareBody = body;
  showModal(window.PerthI18n ? PerthI18n.t("Share this board") : "Share this board",
            body, "share");
  refreshShare();
}

// Botão de transmitir da menubar: reflete o estado do servidor e alterna
// direto, sem passar pelo diálogo. Escondido para quem não pode alternar —
// máquina remota, ou servidor preso a um `host` fixo (can_share = false).
function renderShareBtn(info) {
  const btn = $("#share-toggle");
  if (!btn) return;
  const usable = !!(info && info.can_share && info.host);
  btn.hidden = !usable;
  if (!usable) return;
  btn.classList.toggle("broadcasting", !!info.shared);
  btn.setAttribute("aria-pressed", info.shared ? "true" : "false");
  const label = T(info.shared ? "Transmitting — click to stop"
                              : "Transmit to your network");
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

function refreshShareBtn() {
  fetch(`/api/share${keyQS()}`)
    .then((r) => r.json())
    .then(renderShareBtn)
    .catch(() => {});
}

function toggleShare() {
  const btn = $("#share-toggle");
  fetch(`/api/share${keyQS()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ on: !btn?.classList.contains("broadcasting") }),
  })
    .then((r) => r.json())
    .then((next) => {
      if (next.error) throw new Error(next.error);
      renderShareBtn(next);
      if (state.openModal === "share" && shareBody) renderShare(shareBody, next);
    })
    .catch((err) => PerthToast.error(err.message));
}

function refreshShare() {
  refreshShareBtn();
  const body = shareBody;
  if (!body || state.openModal !== "share") return;
  fetch(`/api/share${keyQS()}`)
    .then((r) => r.json())
    .then((info) => renderShare(body, info))
    .catch(() => {
      body.textContent = "";
      const note = document.createElement("div");
      note.className = "empty-note";
      note.textContent = T("could not load share info");
      body.append(note);
    });
}

// Linha da chave de acesso no diálogo de Share (só o host a vê) — gêmea da
// do gantt. Aplicar uma chave nova derruba quem está na rede: a chave
// antiga passou a ser a errada, e cada um é reperguntado na tela.
function shareKeyRow(body, info) {
  const wrap = document.createElement("div");
  const row = document.createElement("div");
  row.className = "share-key";
  const label = document.createElement("span");
  label.textContent = T(info.keyed ? "Access key required" : "No access key");
  const input = document.createElement("input");
  input.type = "password";
  input.className = "share-key-input";
  input.placeholder = T(info.keyed ? "new access key" : "access key");

  const apply = (key, btn) => {
    btn.disabled = true;
    fetch(`/api/key${keyQS()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    })
      .then((r) => r.json())
      .then((next) => {
        if (next.error) throw new Error(next.error);
        renderShare(body, next);   // links e QR mudam junto com a chave
      })
      .catch((err) => {
        btn.disabled = false;
        PerthToast.error(err.message);
      });
  };

  const set = document.createElement("button");
  set.className = "primary";
  set.textContent = T("apply");
  set.addEventListener("click", () => {
    const v = input.value.trim();
    v && apply(v, set);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") set.click();
    e.stopPropagation();
  });
  row.append(label, input, set);

  if (info.keyed) {
    const drop = document.createElement("button");
    drop.className = "danger";
    drop.textContent = T("remove");
    drop.addEventListener("click", () => apply("", drop));
    row.append(drop);
  }

  const hint = document.createElement("div");
  hint.className = "alias-hint";
  hint.textContent = info.keyed
    ? T("The links below already carry the key. Changing it disconnects everyone on the network — they are asked for the new one.")
    : T("Without a key, anyone on the network who knows the port can open and edit this board.");
  wrap.append(row, hint);
  return wrap;
}

function renderShare(body, info) {
  body.textContent = "";

  // Chave da transmissão: só o host manda, e só quando o servidor subiu
  // sem `host` fixo (aí o alcance está no socket e não dá para alternar)
  if (info.can_share && info.host) {
    const row = document.createElement("div");
    row.className = "share-toggle";
    const label = document.createElement("span");
    label.textContent = T(info.shared ? "Transmitting to your network"
                                      : "Localhost only");
    const btn = document.createElement("button");
    btn.className = info.shared ? "danger" : "primary";
    btn.textContent = T(info.shared ? "Stop transmitting" : "Start transmitting");
    btn.addEventListener("click", () => {
      btn.disabled = true;
      fetch(`/api/share${keyQS()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on: !info.shared }),
      })
        .then((r) => r.json())
        .then((next) => {
          if (next.error) throw new Error(next.error);
          renderShare(body, next);
          renderShareBtn(next);        // o botão da menubar acompanha
        })
        .catch((err) => {
          btn.disabled = false;
          PerthToast.error(err.message);
        });
    });
    row.append(label, btn);
    body.append(row);
  }

  // Chave de acesso: só o host troca. Fora do `can_share` de propósito —
  // com o alcance preso no socket (host fixo) a chave continua valendo.
  if (info.host) body.append(shareKeyRow(body, info));

  for (const u of info.urls) {
    const row = document.createElement("div");
    row.className = "share-url";
    const code = document.createElement("code");
    code.textContent = u;
    const btn = document.createElement("button");
    btn.textContent = T("copy");
    btn.addEventListener("click", () => {
      navigator.clipboard?.writeText(u);
      btn.textContent = T("copied!");
      setTimeout(() => (btn.textContent = T("copy")), 1400);
    });
    row.append(code, btn);
    body.append(row);
  }

  const hint = document.createElement("div");
  hint.className = "alias-hint";
  if (!info.shared) {
    hint.textContent = info.can_share && info.host
      ? T("Nobody else can reach this board yet — start transmitting to hand out a link.")
      : T("Localhost only — the machine running Perth turns transmission on.");
    body.append(hint);
  } else if (info.qr) {
    const wrap = document.createElement("div");
    wrap.className = "qr-wrap";
    wrap.append(qrSvg(info.qr));
    body.append(wrap);
    hint.textContent = T("Scan with a phone on the same Wi-Fi to open") + " " +
      info.target + ".";
    body.append(hint);
  } else {
    hint.textContent = T("Tip: run `using QRCoders` before Perth.kanban() to get a QR code here and in the terminal.");
    body.append(hint);
  }
}

function showKeyGate() {
  const body = document.createElement("div");
  const p = document.createElement("div");
  p.className = "empty-note";
  p.textContent = T("This board requires an access key. Ask whoever started the server.");
  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = T("access key");
  input.className = "keygate-input";
  const join = () => {
    const v = input.value.trim();
    if (!v) return;
    sessionStorage.setItem("perth-kanban-key", v);
    // o ?key= do link tem prioridade na carga, então um valor velho
    // voltaria no F5 depois de o host trocar a chave — some da barra
    const q = new URLSearchParams(location.search);
    if (q.has("key")) {
      q.delete("key");
      const rest = q.toString();
      history.replaceState(null, "", location.pathname + (rest ? "?" + rest : ""));
    }
    state.denied = false;
    closeModal();
    connect();
    refreshBackground();   // o fundo tinha levado 403 sem a chave
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") join();
    e.stopPropagation();
  });
  const btn = document.createElement("button");
  btn.className = "keygate-btn";
  btn.textContent = T("enter board");
  btn.addEventListener("click", join);
  body.append(p, input, btn);
  showModal(T("Access key"), body, "keygate");
  setTimeout(() => input.focus(), 0);
}

// Transmissão desligada pelo host: sem retry automático (o servidor recusa
// a conexão), mas com um botão para tentar de novo quando religarem
function showShareOff() {
  const body = document.createElement("div");
  const p = document.createElement("div");
  p.className = "empty-note";
  p.textContent = T("The machine running Perth stopped transmitting this board.");
  const btn = document.createElement("button");
  btn.className = "keygate-btn";
  btn.textContent = T("try again");
  btn.addEventListener("click", () => {
    state.denied = false;
    closeModal();
    connect();
  });
  body.append(p, btn);
  showModal(T("Transmission off"), body, "shareoff");
}

function showBoards() {
  const body = document.createElement("div");
  const note = document.createElement("div");
  note.className = "empty-note";
  note.textContent = T("loading…");
  body.append(note);
  showModal("Boards", body, "boards");
  fetch(`/api/boards${keyQS()}`)
    .then((r) => r.json())
    .then((info) => {
      body.textContent = "";
      for (const name of info.boards) {
        const row = document.createElement("div");
        row.className = "boards-row";
        const lbl = document.createElement("span");
        lbl.className = "boards-name";
        lbl.textContent = name;
        row.append(lbl);
        if (name === info.current) {
          const cur = document.createElement("span");
          cur.className = "boards-current";
          cur.textContent = T("current");
          row.append(cur);
        } else if (state.me?.host) {
          const sw = document.createElement("button");
          sw.textContent = T("switch");
          sw.title = T("switches the board for everyone");
          sw.addEventListener("click", () => send({ type: "useBoard", name }));
          // o board ATIVO não ganha este botão: apagar o que está na tela de
          // todo mundo não é uma pergunta que valha a pena fazer — troque
          // primeiro. O servidor recusa de novo, não confia nesta ausência.
          const del = document.createElement("button");
          del.className = "danger";
          del.textContent = T("delete");
          del.title = T("deletes the board, its history and its chat — forever");
          del.addEventListener("click", () => {
            if (!confirm(T("Delete the board") + ' "' + name + '"? ' +
                         T("Its cards, its history and its chat go with it. This cannot be undone.")))
              return;
            send({ type: "delBoard", name });
          });
          row.append(sw, del);
        }
        body.append(row);
      }
      const hint = document.createElement("div");
      hint.className = "alias-hint";
      if (state.me?.host) {
        const create = document.createElement("div");
        create.className = "boards-row";
        const input = document.createElement("input");
        input.placeholder = T("new board name");
        input.maxLength = 32;
        const go = () => {
          const v = input.value.trim();
          v && send({ type: "newBoard", name: v });
        };
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") go();
          e.stopPropagation();
        });
        const btn = document.createElement("button");
        btn.textContent = T("create");
        btn.addEventListener("click", go);
        create.append(input, btn);
        body.append(create);
        hint.textContent =
          T("One board is active at a time — switching changes it for every connected machine.") +
          " " + T("Deleting one is permanent, and the board in use cannot be deleted.");
      } else {
        hint.textContent = T("Only the host machine can switch, create or delete boards.");
      }
      body.append(hint);
    })
    .catch(() => {
      note.textContent = T("could not load the board list");
    });
}

/* ==================================================== métricas */

// Métricas de fluxo calculadas do próprio board (cards + arquivo):
// lead time = done_at - at; throughput = concluídos por janela; WIP =
// cards não concluídos, com a idade do mais antigo.
function showMetrics() {
  const parseAt = (s) => (s ? new Date(String(s).replace(" ", "T")) : null);
  const now = Date.now();
  const day = 86400000;

  const all = [...cols().flatMap((c) => c.cards), ...(state.board.archive || [])];
  const doneCards = all.filter((c) => (c.done || c.archived_at) && c.done_at);
  const leads = doneCards
    .map((c) => (parseAt(c.done_at) - parseAt(c.at)) / day)
    .filter((d) => isFinite(d) && d >= 0);
  const doneWithin = (days) => doneCards.filter((c) => {
    const d = parseAt(c.done_at);
    return d && now - d.getTime() <= days * day;
  }).length;
  const wip = cols().flatMap((c) => c.cards).filter((c) => !c.done && c.at);
  const oldest = wip
    .map((c) => (now - parseAt(c.at)) / day)
    .filter(isFinite)
    .sort((a, b) => b - a)[0];

  const body = document.createElement("div");
  const row = (label, value) => {
    const r = document.createElement("div");
    r.className = "metric-row";
    r.innerHTML = `<span>${T(label)}</span><b>${value}</b>`;
    body.append(r);
  };
  if (!doneCards.length && !wip.length) {
    body.textContent = T("not enough data yet — complete some cards first");
  } else {
    if (leads.length)
      row("avg lead time",
          (leads.reduce((a, b) => a + b, 0) / leads.length).toFixed(1) +
          " " + T("days"));
    row("done last 7 days", doneWithin(7));
    row("done last 30 days", doneWithin(30));
    row("cards in progress", wip.length);
    if (oldest !== undefined)
      row("oldest in progress", oldest.toFixed(0) + " " + T("days"));
  }
  showModal(window.PerthI18n ? PerthI18n.t("Metrics") : "Metrics", body, "metrics");
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => null);
}

// Troca kanban -> gantt na MESMA aba; sobe o gantt se necessário.
$("#app-switch")?.addEventListener("click", async () => {
  try {
    let info = await fetch(`/api/apps${keyQS()}`).then((r) => r.json());
    if (!info.gantt) {
      info = { gantt: (await fetch(`/api/launch/gantt${keyQS()}`,
        { method: "POST" }).then((r) => r.json())).port };
    }
    // portas são origens distintas: leva tema/idioma/nome na URL
    const prefs = new URLSearchParams();
    for (const [param, key] of [["pref-theme", "perth-theme"],
                                ["pref-lang", "perth-lang"],
                                ["pref-name", "perth-kanban-name"]]) {
      const v = localStorage.getItem(key);
      v && prefs.set(param, v);
    }
    const qs = prefs.toString();
    location.href = `${location.protocol}//${location.hostname}:${info.gantt}/` +
      (qs ? "?" + qs : "");
  } catch (err) {
    PerthToast.error(err.message || T("could not open the gantt"));
  }
});

/* ============================================== menus e atalhos */

function closeMenus() {
  $$(".menu.open").forEach((m) => m.classList.remove("open"));
}

// Clique dentro de um dropdown (ex.: no textbox de renomear) não pode
// borbulhar até o document e fechar o próprio dropdown
$$("#menubar .menu-drop").forEach((d) =>
  d.addEventListener("click", (e) => e.stopPropagation()));

$$("#menubar .menu > .menu-title").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = btn.parentElement;
    const open = menu.classList.contains("open");
    closeMenus();
    if (!open) menu.classList.add("open");
  });
});
document.addEventListener("click", closeMenus);

// Fechar o editor ao clicar fora dele. Usamos pointerdown (não focusout):
// um re-render nosso remove o campo focado e dispararia focusout à toa,
// duplicando/fechando o editor. pointerdown só ocorre em ação real do usuário.
document.addEventListener("pointerdown", (e) => {
  if (!state.editing) return;
  const wrap = $(".editor-wrap");
  if (wrap && !wrap.contains(e.target)) commitEditor();
});

/* Modo apresentação: some com a menubar e pede tela cheia do navegador —
   sobra só o board. */
function enterPresentation() {
  state.presenting = true;
  document.body.classList.add("presenting");
  document.documentElement.requestFullscreen?.().catch(() => {});
}

function exitPresentation() {
  state.presenting = false;
  document.body.classList.remove("presenting");
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

function togglePresentation() {
  state.presenting ? exitPresentation() : enterPresentation();
}

// Esc nativo do navegador sai da tela cheia sem passar pelo nosso handler
// de teclado — sincroniza o estado quando isso acontece (F11, gesto do SO...)
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && state.presenting) exitPresentation();
});

function doAction(action) {
  switch (action) {
    case "new-card": {
      const first = cols()[0];
      if (first) openNewCard(first.id);
      break;
    }
    case "new-col":
      newColumn();
      break;
    case "select-all":
      selectAllCards();
      break;
    /* Os quatro em lote abaixo. Um confirm só e um desfazer só, porque o
       gesto foi um — ver commitMany. Cada um continua valendo para um card
       (a seleção de um é uma seleção), então não há dois caminhos para a
       mesma coisa: o item do menu é o mesmo, some a contagem. */
    case "delete-card": {
      const alvos = selectedCards();
      if (!alvos.length) break;
      if (alvos.length > 1 &&
          !confirm(`${T("Delete these cards?")} (${alvos.length})`)) break;
      commitMany(alvos.map((f) => ({ type: "delCard", id: f.card.id })));
      clearCardSelection();
      render();
      break;
    }
    case "archive-selected": {
      const alvos = selectedCards();
      if (!alvos.length) break;
      commitMany(alvos.map((f) => ({ type: "archiveCard", id: f.card.id })));
      clearCardSelection();
      render();
      break;
    }
    case "done-selected": {
      const alvos = selectedCards();
      if (!alvos.length) break;
      // Um alvo: alterna, como o ✓ do card. Vários: liga todos — com seis
      // cards em estados diferentes, "alternar" deixaria metade de cada
      // lado, que não é o que ninguém pediu. Já todos concluídos, desliga.
      const querDone = alvos.length === 1
        ? !alvos[0].card.done : !alvos.every((f) => f.card.done);
      commitMany(alvos.filter((f) => !!f.card.done !== querDone)
        .map((f) => ({ type: "setDone", id: f.card.id, done: querDone })));
      break;
    }
    case "assign-selected": {
      const alvos = selectedCards();
      if (!alvos.length) break;
      const donos = new Set(alvos.map((f) => (f.card.assignee || "").trim()));
      const atual = donos.size === 1 ? [...donos][0] : "";
      const v = prompt(T("Assign to whom? (empty clears)"), atual);
      if (v === null) break;
      const nome = v.trim();
      commitMany(alvos.filter((f) => (f.card.assignee || "") !== nome)
        .map((f) => ({ type: "setAssignee", id: f.card.id, name: nome })));
      break;
    }
    case "toggle-theme": {
      const root = document.documentElement;
      root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
      localStorage.setItem("perth-theme", root.dataset.theme);
      break;
    }
    case "presentation":
      togglePresentation();
      break;
    case "resync":
      send({ type: "sync" });
      break;
    case "undo":
      undo();
      break;
    case "redo":
      redo();
      break;
    case "archived":
      showArchived();
      break;
    case "aliases":
      showAliases();
      break;
    case "permissions":
      showPermissions();
      break;
    case "activity":
      showActivity();
      break;
    case "metrics":
      showMetrics();
      break;
    case "share":
      showShare();
      break;
    case "share-toggle":
      toggleShare();
      break;
    case "boards":
      showBoards();
      break;
    case "reset": {
      if (!state.me?.host) break;
      if (confirm("Reset the board for EVERYONE? Every card and the whole " +
                  "archive will be deleted. This cannot be undone."))
        commit({ type: "resetBoard" });
      break;
    }
    /* O kanban tinha oito teclas globais e nenhum lugar onde descobri-las —
       o único anunciado era o "/", dentro do placeholder do filtro. Mesma
       entrada do gantt, mesma lista desenhada por shared/shortcuts.js. */
    case "shortcuts":
      showModal(T("Keyboard shortcuts"), PerthShortcuts.list([
        ["N", "new card"],
        ["Enter", "edit selected card"],
        ["Shift+Enter", "open card (description, code, images)"],
        ["Ctrl+click", "add or remove one card from the selection"],
        ["Shift+click", "select everything in between (same column)"],
        ["Ctrl+A", "select all — with a filter on, only what it leaves lit"],
        ["Del", "delete selected card"],
        ["A", "archive the selection"],
        ["Space", "mark the selection done"],
        ["/", "filter cards"],
        ["Ctrl+Z", "undo"],
        ["Ctrl+Shift+Z / Ctrl+Y", "redo"],
        ["D", "toggle dark mode"],
        ["P", "presentation mode"],
        ["Esc", "close / deselect / exit presentation"],
      ]), "shortcuts");
      break;
    case "autoarch": {
      if (!state.me?.host) break;
      const v = prompt("Auto-archive done cards after how many days? (0 disables)",
                       state.board.auto_archive_days || 0);
      if (v === null) break;
      const d = parseInt(v, 10);
      if (!Number.isNaN(d) && d >= 0) commit({ type: "setAutoArchive", days: d });
      break;
    }
  }
}

$$("[data-action]").forEach((el) =>
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    closeMenus();
    doAction(el.dataset.action);
  })
);

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea")) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
    e.preventDefault();
    redo();
    return;
  }
  if (e.key === "/") {
    e.preventDefault();
    $("#search").focus();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
    e.preventDefault();     // senão o navegador seleciona o texto da página
    selectAllCards();
    return;
  }
  if (e.key === "n" || e.key === "N") doAction("new-card");
  else if (e.key === "a" || e.key === "A") doAction("archive-selected");
  else if (e.key === " " && state.selection.size) {
    e.preventDefault();          // com nada selecionado, Espaço segue sendo do navegador
    doAction("done-selected");
  }
  else if (e.key === "d" || e.key === "D") doAction("toggle-theme");
  else if (e.key === "p" || e.key === "P") doAction("presentation");
  else if (e.key === "Delete") doAction("delete-card");
  else if (e.key === "Enter" && state.selected)
    e.shiftKey ? openCardDialog(state.selected) : openEditor(state.selected);
  else if (e.key === "Escape") {
    if (state.presenting) { exitPresentation(); return; }
    clearCardSelection();
    $$(".card.selected", boardEl).forEach((c) => c.classList.remove("selected"));
    renderStatus();
    closeMenus();
    closeModal();
    if (state.chatOpen) closeChat();
  }
});

/* ==================================================== busca */

const searchInput = $("#search");
searchInput.addEventListener("input", () => {
  state.filter = searchInput.value.trim().toLowerCase();
  render();
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    setFilter("");
    searchInput.blur();
  } else if (e.key === "Enter") {
    searchInput.blur();
  }
  e.stopPropagation();
});

/* ==================================================== nome */

const nameInput = $("#name-input");
nameInput.value = localStorage.getItem("perth-kanban-name") || "";
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") nameInput.blur();
  e.stopPropagation();
});
nameInput.addEventListener("blur", () => {
  const v = nameInput.value.trim();
  localStorage.setItem("perth-kanban-name", v);
  send({ type: "hello", name: v });
});

/* Interruptores do painel: <button aria-pressed>, o mesmo componente do
 * gantt (.toggle em shared/ui.css). Eram <input type=checkbox> logo depois
 * do texto, então cada um parava numa coluna diferente conforme o
 * comprimento da etiqueta — e as que quebravam em duas linhas pioravam o
 * desalinhamento. Com etiqueta absorvendo a folga, todos encostam na
 * mesma borda.
 *
 * `on` guarda a preferência, aplica e devolve o estado; um helper só
 * porque os quatro fazem exatamente a mesma coisa. */
const pressed = (el) => el.getAttribute("aria-pressed") === "true";

function prefToggle(id, chave, ligadoPorPadrao, aplicar) {
  const el = $("#" + id);
  const salvo = localStorage.getItem(chave);
  const on = salvo === null ? ligadoPorPadrao : salvo === "on";
  el.setAttribute("aria-pressed", String(on));
  aplicar(on, true);                    // true = ainda é a montagem da página
  el.addEventListener("click", () => {
    const novo = !pressed(el);
    el.setAttribute("aria-pressed", String(novo));
    localStorage.setItem(chave, novo ? "on" : "off");
    aplicar(novo, false);
  });
  return el;
}

// playAlert consulta o localStorage sozinho, então aqui não há nada a
// "aplicar": só o feedback de volume ao LIGAR — e nunca ao abrir a página,
// que tocaria um alerta a cada F5
const soundToggle = prefToggle("sound-toggle", "perth-kanban-sound", true,
  (on, inicial) => { if (on && !inicial) playAlert(); });

// preferência local, não afeta o protocolo: a máquina continua visível para
// os outros (peers/menubar), só para de desenhar os cursores alheios aqui
const hideCursorsToggle = prefToggle("hide-cursors-toggle",
  "perth-kanban-hide-cursors", false,
  (on) => document.documentElement.classList.toggle("hide-remote-cursors", on));

// Etiqueta de card novo: preferência local deste navegador, como os cursores
// acima. É classe no <html> em vez de estado lido por cardEl, para o toggle
// valer na hora — sem re-render, e sem cardEl depender de um elemento do
// painel que ele não deveria conhecer.
const hideNewToggle = prefToggle("hide-new-toggle", "perth-kanban-hide-new",
  false,
  (on) => document.documentElement.classList.toggle("hide-new-badges", on));

/* ============================== fundo da UI (Perth.background!)
 *
 * A imagem é setting do servidor e vale para os dois apps; esconder é
 * preferência local deste navegador, como os cursores acima. */
let bgInfo = null;
const hideBgToggle = $("#hide-bg-toggle");
hideBgToggle.setAttribute("aria-pressed",
  String(localStorage.getItem("perth-kanban-hide-background") === "on"));

// A camada, a rotação e o fade vivem em shared/background.js (os dois apps
// usam o mesmo). Daqui vão só as duas coisas que são deste app: a
// preferência local de esconder e como a chave de acesso entra na URL.
PerthBackground.init({
  isHidden: () => pressed(hideBgToggle),
  withKey,
});

function applyBackground(info) {
  if (info !== undefined) bgInfo = info;
  PerthBackground.apply(info);
}

function refreshBackground() {
  fetch(`/api/background${keyQS()}`)
    .then((r) => r.json())
    .then(applyBackground)
    .catch(() => {});
}

hideBgToggle.addEventListener("click", () => {
  const novo = !pressed(hideBgToggle);
  hideBgToggle.setAttribute("aria-pressed", String(novo));
  localStorage.setItem("perth-kanban-hide-background", novo ? "on" : "off");
  applyBackground();          // sem argumento: só redesenha com o que já se sabe
});

/* Etiqueta de versão da barra de status. Quem sabe qual Perth está rodando é
 * o servidor — o navegador só tem arquivos estáticos, que um cache pode servir
 * de uma versão anterior —, e /api/apps já é a resposta que descreve este
 * processo. Perguntada uma vez, no boot: a versão não muda com o servidor de
 * pé. Falhou, a etiqueta continua escondida: dizer a versão errada é pior do
 * que não dizer nenhuma. */
function showVersion() {
  fetch(`/api/apps${keyQS()}`)
    .then((r) => r.json())
    .then(({ version, update }) => {
      if (!version) return;
      $("#version-num").textContent = version;
      /* Saiu versão nova (src/update.jl): número em verde depois da seta e a
       * dica no title. A CHAVE em inglês vai para o dataset porque o apply()
       * do i18n memoriza a chave no primeiro passe — sem isso a próxima troca
       * de idioma devolveria "Perth version" por cima desta. */
      if (update) {
        $("#version-new").textContent = `→ ${update}`;
        $("#version-new").hidden = false;
        $("#version-tag").classList.add("has-update");
        const dica =
          "A newer Perth is out — whoever started the server can update with ] up Perth";
        $("#version-tag").dataset.i18nTitle = dica;
        $("#version-tag").title = T(dica);
      }
      $("#version-tag").hidden = false;
    })
    .catch(() => {});
}

/* ==================================================== boot */

refreshBackground();
showVersion();
connect();
render();
renderAtMidnight();
