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

const $  = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const state = {
  board: { columns: [] },
  rev: 0,
  me: null,                 // {id, ip, name, color}
  peers: new Map(),         // id -> {id, ip, name, color, presence}
  selected: null,           // id do card selecionado
  editing: null,            // {cardId | null, colId, draft, isNew}
  drag: null,               // estado do arrasto local
  pendingBoard: null,       // board recebido durante um arrasto
  filter: "",               // busca ativa (texto/#tag/autor), minúsculas
  log: [],                  // eventos recentes vindos do servidor
  openModal: null,          // "archived" | "aliases" | "activity" | "share"
};

const boardEl   = $("#board");
const cursorsEl = $("#cursors");

const uid = () => "k" + Math.random().toString(36).slice(2, 9);

/* ================================================================ ws */

let ws = null;
let retryMs = 800;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    retryMs = 800;
    setConn(true);
    const name = localStorage.getItem("perth-kanban-name") || "";
    if (name) send({ type: "hello", name });
  };

  ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));

  ws.onclose = () => {
    setConn(false);
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
  $("#conn-label").textContent = live ? "live" : "reconnecting…";
}

function handleMessage(msg) {
  switch (msg.type) {
    case "init": {
      state.rev = msg.rev;
      state.me = msg.you;
      state.peers.clear();
      for (const p of msg.peers)
        if (p.id !== msg.you.id) state.peers.set(p.id, { ...p, presence: null });
      state.log = msg.log || [];
      acceptBoard(msg.board);
      renderPeers();
      renderStatus();
      $("#aliases-item").hidden = !msg.you.host;
      break;
    }
    case "op": {
      state.rev = msg.rev;
      acceptBoard(msg.board);
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
      renderPeers();
      renderCursors();
      render();          // remove marcações de hold/edição do peer
      break;
    }
    case "peer": {
      if (state.me && msg.peer.id === state.me.id) {
        state.me = msg.peer;
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
               done: !!c.done, by: c.by, at: c.at, index: f.index };
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
    case "setAlias":
      return { type: "setAlias", ip: op.ip, name: aliasOf(op.ip) };
    default:
      return null;   // delArchived: exclusão definitiva, sem volta
  }
}

// aplica localmente + envia; o eco do servidor confirma com o board oficial
function commit(op) {
  const inv = inverseOf(op);
  if (inv) {
    undoStack.push({ do: structuredClone(op), undo: inv });
    undoStack.length > UNDO_LIMIT && undoStack.shift();
    redoStack.length = 0;
  }
  commitRaw(op);
}

function commitRaw(op) {
  applyLocal(op);
  render();
  sendOp(op);
}

function undo() {
  const e = undoStack.pop();
  if (!e) return;
  commitRaw(e.undo);
  redoStack.push(e);
}

function redo() {
  const e = redoStack.pop();
  if (!e) return;
  commitRaw(e.do);
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
      if (f) f.col.cards[f.index].done = op.done;
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
      if (c) c.cards.sort((x, y) =>
        (x.due || "9999").localeCompare(y.due || "9999"));
      break;
    }
    case "setAlias": {
      const a = (state.board.aliases ||= {});
      if (op.name) a[op.ip] = op.name;
      else delete a[op.ip];
      break;
    }
  }
}

/* ========================================================== render */

function render() {
  // FLIP: posições antes do re-render, para animar cards que mudaram de lugar
  const before = new Map();
  for (const el of $$(".card", boardEl))
    before.set(el.dataset.card, el.getBoundingClientRect());

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
    name.title = "double-click to rename";
    name.addEventListener("dblclick", () => renameColInline(col, name));
    const count = document.createElement("span");
    count.className = "col-count";
    count.textContent = col.wip ? `${col.cards.length}/${col.wip}` : col.cards.length;
    if (col.wip && col.cards.length > col.wip) {
      count.classList.add("over");
      count.title = "WIP limit exceeded";
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
    add.textContent = "+ card";
    add.addEventListener("click", () => openNewCard(col.id));
    foot.append(add);
    colEl.append(foot);

    boardEl.append(colEl);
  });

  const addCol = document.createElement("button");
  addCol.className = "add-col";
  addCol.textContent = "+ new column";
  addCol.addEventListener("click", newColumn);
  boardEl.append(addCol);

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

  // rodapé: quem criou (alias do host > IP) + prazo + arquivar
  if (card.by || card.done || card.due) {
    const meta = document.createElement("div");
    meta.className = "card-meta";
    if (card.by) {
      const by = document.createElement("span");
      by.textContent = "by " + displayFor(card.by);
      by.title = card.by + (card.at ? " · " + card.at : "");
      meta.append(by);
    } else {
      meta.append(document.createElement("span"));
    }
    const due = dueInfo(card);
    if (due) {
      const chip = document.createElement("button");
      chip.className = "card-due" + (due.cls ? " " + due.cls : "");
      chip.textContent = due.label;
      chip.title = "due " + card.due + " — click to edit";
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
      arch.textContent = "archive";
      arch.title = "move to the archive";
      arch.addEventListener("pointerdown", (e) => e.stopPropagation());
      arch.addEventListener("click", (e) => {
        e.stopPropagation();
        commit({ type: "archiveCard", id: card.id });
      });
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
    commit({ type: "setDone", id: card.id, done: !card.done });
  });
  el.append(done);

  if (state.selected === card.id) el.classList.add("selected");
  el.addEventListener("pointerdown", (e) => maybeDrag(e, card));
  el.addEventListener("click", () => {
    state.selected = card.id;
    $$(".card.selected", boardEl).forEach((c) => c.classList.remove("selected"));
    el.classList.add("selected");
  });
  el.addEventListener("dblclick", () => openEditor(card.id));
  return el;
}

// #tags no texto viram chips coloridos e clicáveis (clicar filtra).
// Montado só com textContent/spans — nunca innerHTML com texto do usuário.
function renderCardText(container, text) {
  const re = /#[\p{L}\p{N}_-]+/gu;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) container.append(text.slice(last, m.index));
    const val = m[0];
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = val;
    const c = tagColor(val.toLowerCase());
    tag.style.setProperty("--tagc", c);
    tag.style.setProperty("--tagbg", c + "26");
    tag.title = "filter by " + val;
    tag.addEventListener("click", (e) => {
      e.stopPropagation();
      setFilter(val);
    });
    container.append(tag);
    last = m.index + val.length;
  }
  if (last < text.length) container.append(text.slice(last));
}

function colMenu(col, ci) {
  const wrap = document.createElement("div");
  wrap.className = "col-menu menu";
  const btn = document.createElement("button");
  btn.textContent = "⋯";
  btn.title = "column options";
  const drop = document.createElement("div");
  drop.className = "menu-drop";

  const item = (label, fn, cls) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      wrap.classList.remove("open");
      fn();
    });
    return b;
  };

  drop.append(
    item("Rename…", () => renameColInline(col, $(".col-name", wrap.closest(".col")))),
    item("WIP limit…", () => {
      const v = prompt(`WIP limit for "${col.name}" (0 = none):`, col.wip || 0);
      if (v === null) return;
      const w = parseInt(v, 10);
      if (!Number.isNaN(w) && w >= 0) commit({ type: "setWip", id: col.id, wip: w });
    }),
    item("Sort by due date", () => commit({ type: "sortCol", id: col.id })),
  );
  if (ci > 0)
    drop.append(item("Move left", () =>
      commit({ type: "moveCol", id: col.id, toIndex: ci - 1 })));
  if (ci < cols().length - 1)
    drop.append(item("Move right", () =>
      commit({ type: "moveCol", id: col.id, toIndex: ci + 1 })));
  const hr = document.createElement("hr");
  drop.append(hr, item("Delete column", () => {
    if (col.cards.length === 0 ||
        confirm(`Delete "${col.name}" and its ${col.cards.length} cards?`))
      commit({ type: "delCol", id: col.id });
  }, "danger"));

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
                    due: c.due || "", isNew: false };
  render();
}

function openNewCard(colId) {
  state.editing = { cardId: null, colId, draft: "", due: "", isNew: true };
  render();
}

function editorEl(col, card) {
  const wrap = document.createElement("div");
  const ta = document.createElement("textarea");
  ta.className = "card-editor";
  ta.value = state.editing.draft;
  ta.placeholder = "type and press Enter — #tags become chips";
  setTimeout(() => {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, 0);

  ta.addEventListener("input", () => {
    state.editing.draft = ta.value;
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
  lbl.textContent = "due";
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
  row.append(lbl, date);
  wrap.append(ta, row);

  // clicar do textarea para o campo de data não pode fechar o editor:
  // só commita quando o foco sai do wrapper inteiro
  wrap.addEventListener("focusout", (e) => {
    if (!wrap.contains(e.relatedTarget)) commitEditor();
  });

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
               due: ed.due || undefined, by: state.me?.ip,
               at: new Date().toISOString().slice(0, 16).replace("T", " ") });
      state.selected = id;
    } else render();
  } else {
    const f = findCard(ed.cardId);
    if (!f) return render();
    const cur = f.col.cards[f.index];
    const textChanged = text && text !== cur.text;
    const dueChanged = (ed.due || "") !== (cur.due || "");
    if (textChanged) commit({ type: "editCard", id: ed.cardId, text });
    if (dueChanged) commit({ type: "setDue", id: ed.cardId, due: ed.due || "" });
    if (!textChanged && !dueChanged) render();
  }
}

function cancelEditor() {
  state.editing = null;
  sendPresenceNow({});
  render();
}

/* ================================================== drag & drop */

const DRAG_THRESHOLD = 5;

function maybeDrag(e, card) {
  if (e.button !== 0) return;
  const origin = { x: e.clientX, y: e.clientY };
  const el = e.currentTarget;

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

function startDrag(e, card, el) {
  const rect = el.getBoundingClientRect();
  const clone = el.cloneNode(true);
  clone.classList.add("drag-clone");
  clone.classList.remove("selected");
  clone.style.width = rect.width + "px";
  document.body.append(clone);

  const slot = document.createElement("div");
  slot.className = "drop-slot";

  state.drag = {
    card,
    el,
    clone,
    slot,
    dx: e.clientX - rect.left,
    dy: e.clientY - rect.top,
    target: null,          // {colId, index}
  };
  el.classList.add("ghost");
  document.body.style.cursor = "grabbing";
  sendPresenceNow({ dragging: card.id });
  positionClone(e);
  updateDropTarget(e);

  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", endDrag, { once: true });
}

function onDragMove(e) {
  positionClone(e);
  updateDropTarget(e);
  trackPointer(e);
}

function positionClone(e) {
  const d = state.drag;
  d.clone.style.transform =
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
  const others = $$(".card", cardsEl).filter(
    (c) => c !== d.el && !c.classList.contains("drag-clone"));
  let index = others.length;
  for (let i = 0; i < others.length; i++) {
    const r = others[i].getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) { index = i; break; }
  }
  const ref = others[index] ?? null;
  cardsEl.insertBefore(d.slot, ref);
  d.target = { colId: colEl.dataset.col, index };
}

function endDrag() {
  window.removeEventListener("pointermove", onDragMove);
  const d = state.drag;
  state.drag = null;
  document.body.style.cursor = "";
  d.clone.remove();
  d.slot.remove();
  d.el.classList.remove("ghost");
  sendPresenceNow({});

  if (d.target) {
    const f = findCard(d.card.id);
    const same = f && f.col.id === d.target.colId && f.index === d.target.index;
    if (!same)
      commit({ type: "moveCard", id: d.card.id,
               toCol: d.target.colId, toIndex: d.target.index });
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
  const hay = (card.text + " " +
    (card.by ? displayFor(card.by) + " " + card.by : "")).toLowerCase();
  return hay.includes(state.filter);
}

function setFilter(v) {
  $("#search").value = v;
  state.filter = v.trim().toLowerCase();
  render();
}

// data local (toISOString é UTC; compensa o fuso p/ comparar prazos)
function localISO(plusDays = 0) {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000 +
                     plusDays * 86400000);
  return d.toISOString().slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dueInfo(card) {
  if (!card.due) return null;
  const cls = card.done ? "" :
    card.due < localISO() ? "overdue" :
    card.due <= localISO(1) ? "soon" : "";
  const d = new Date(card.due + "T00:00");
  const label = isNaN(d) ? card.due : d.getDate() + " " + MONTHS[d.getMonth()];
  return { cls, label };
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

function renderPeers() {
  const box = $("#peers");
  box.textContent = "";
  const all = state.me
    ? [{ ...state.me, __me: true }, ...state.peers.values()]
    : [...state.peers.values()];
  for (const p of all) {
    const chip = document.createElement("span");
    chip.className = "peer-chip" + (p.__me ? " me" : "");
    chip.style.background = peerColor(p);
    chip.textContent = peerLabel(p).replace(/^\D*/, "").charAt(0) ||
                       peerLabel(p).charAt(0).toUpperCase();
    chip.title = (p.__me ? "you — " : "") + peerLabel(p) + " · " + p.ip;
    box.append(chip);
  }
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
  x.title = "close (Esc)";
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
    p.textContent = "Nothing archived yet — finish a card (✓) and hit \"archive\".";
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
    restore.textContent = "restore";
    restore.addEventListener("click", () => {
      commit({ type: "restoreCard", id: entry.id });
      showArchived();
    });
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "delete";
    del.title = "delete forever (cannot be undone)";
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
    input.placeholder = "e.g. Paulo";
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
  hint.textContent = "Names apply to everyone's screen: cursors, chips and card stamps. Empty = back to the IP.";
  body.append(hint);
  showModal("Rename machines", body, "aliases");
}

/* ============================================ notificações */

const toastsEl = $("#toasts");
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

function toast(entry) {
  const t = document.createElement("div");
  t.className = "toast";
  t.style.setProperty("--peer", colorForIp(entry.ip));
  const who = document.createElement("b");
  who.textContent = displayFor(entry.ip);
  who.title = entry.ip;
  t.append(who, " " + entry.text);
  toastsEl.append(t);
  while (toastsEl.children.length > 4) toastsEl.firstChild.remove();
  setTimeout(() => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 260);
  }, 4200);
}

/* ============================================ atividade e share */

function showActivity() {
  const body = document.createElement("div");
  if (!state.log.length) {
    const p = document.createElement("div");
    p.className = "empty-note";
    p.textContent = "No activity yet.";
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

function showShare() {
  const body = document.createElement("div");
  const note = document.createElement("div");
  note.className = "empty-note";
  note.textContent = "loading…";
  body.append(note);
  showModal("Share this board", body, "share");
  fetch("/api/share")
    .then((r) => r.json())
    .then((info) => {
      body.textContent = "";
      for (const u of info.urls) {
        const row = document.createElement("div");
        row.className = "share-url";
        const code = document.createElement("code");
        code.textContent = u;
        const btn = document.createElement("button");
        btn.textContent = "copy";
        btn.addEventListener("click", () => {
          navigator.clipboard?.writeText(u);
          btn.textContent = "copied!";
          setTimeout(() => (btn.textContent = "copy"), 1400);
        });
        row.append(code, btn);
        body.append(row);
      }
      const hint = document.createElement("div");
      hint.className = "alias-hint";
      if (!info.shared) {
        hint.textContent = "Localhost only — start with Perth.kanban(share = true) to open the board to your network.";
        body.append(hint);
      } else if (info.qr) {
        const wrap = document.createElement("div");
        wrap.className = "qr-wrap";
        wrap.append(qrSvg(info.qr));
        body.append(wrap);
        hint.textContent = "Scan with a phone on the same Wi-Fi to open " + info.target + ".";
        body.append(hint);
      } else {
        hint.textContent = "Tip: run `using QRCoders` before Perth.kanban() to get a QR code here and in the terminal.";
        body.append(hint);
      }
    })
    .catch(() => {
      note.textContent = "could not load share info";
    });
}

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
    case "delete-card":
      if (state.selected && findCard(state.selected)) {
        commit({ type: "delCard", id: state.selected });
        state.selected = null;
      }
      break;
    case "toggle-theme": {
      const root = document.documentElement;
      root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
      localStorage.setItem("perth-kanban-theme", root.dataset.theme);
      break;
    }
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
    case "activity":
      showActivity();
      break;
    case "share":
      showShare();
      break;
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
  if (e.key === "n" || e.key === "N") doAction("new-card");
  else if (e.key === "d" || e.key === "D") doAction("toggle-theme");
  else if (e.key === "Delete") doAction("delete-card");
  else if (e.key === "Enter" && state.selected) openEditor(state.selected);
  else if (e.key === "Escape") {
    state.selected = null;
    $$(".card.selected", boardEl).forEach((c) => c.classList.remove("selected"));
    closeMenus();
    closeModal();
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

const soundToggle = $("#sound-toggle");
soundToggle.checked = localStorage.getItem("perth-kanban-sound") !== "off";
soundToggle.addEventListener("change", () => {
  localStorage.setItem("perth-kanban-sound", soundToggle.checked ? "on" : "off");
  if (soundToggle.checked) playAlert();   // feedback imediato do volume
});

/* ==================================================== boot */

connect();
render();
