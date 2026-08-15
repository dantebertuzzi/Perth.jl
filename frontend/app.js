/* Perth — frontend vanilla JS.
 * Estado local espelha o projeto ativo; toda edição faz PUT (debounced) do
 * projeto inteiro. Um polling leve de /api/rev detecta mudanças feitas no
 * REPL Julia e recarrega a página de dados sem intervenção do usuário.
 */
"use strict";

/* ------------------------------------------------------------------ */
/* Constantes e estado                                                  */
/* ------------------------------------------------------------------ */

let ROW_H = 34;  // mutável: densidade cozy/compact
const HEAD_H = 46;
const PPD = { day: 36, week: 14, month: 5 };          // pixels por dia
const AUTO_COLORS = ["#9558b2", "#389826", "#4063d8", "#b58900", "#cb3c33"];
const POLL_MS = 2500;
const REPO_URL = "https://github.com/dantebertuzzi/Perth.jl";
const SAVE_DEBOUNCE_MS = 600;

// Referências de dependência: "id", "id+3" (lag), "SS:id"/"FF:id" (tipos,
// editáveis via REPL/arquivo). Espelha _parse_dep de src/schedule.jl.
function parseDep(d) {
  let s = String(d), type = "FS";
  if (s.startsWith("SS:")) { type = "SS"; s = s.slice(3); }
  else if (s.startsWith("FF:")) { type = "FF"; s = s.slice(3); }
  const m = s.match(/^(.+?)([+-]\d+)$/);
  return m ? { id: m[1], type, lag: parseInt(m[2], 10) }
           : { id: s, type, lag: 0 };
}
const depId = (d) => parseDep(d).id;

const state = {
  projects: [],        // resumos {id, name, ...}
  current: null,       // projeto completo {id, name, tasks: []}
  zoom: "week",
  selected: null,      // id da tarefa selecionada
  range: null,         // {start: Date, days: n}
  knownRev: -1,
  dirty: false,
  dragging: false,
  editingNew: false,   // tarefa recém-criada aberta no modal (cancelar remove)
  modalClean: null,    // instantâneo do formulário na abertura (ver modalSnapshot)
  cpm: null,           // análise CPM do servidor {cycle, finish, byId: Map}
  showCritical: false,
  highlight: null,      // {kind: "assignee"|"status"|"type", value} ou null
  wbs: null,            // {kids: Map, depth: Map, summary: Set} — computado a cada render
  overalloc: { pairs: [], ids: new Set() },
  resources: null,      // carga por responsável vinda do servidor (workload)
  resOpen: false,       // painel de recursos docado sob o gantt
  undoStack: [],       // snapshots para Ctrl+Z
  redoStack: [],       // snapshots para Ctrl+Y / Ctrl+Shift+Z
  presenting: false,   // modo apresentação: menubar/toolbar/tabela escondidos + fullscreen
};

function _snapshot() {
  if (!state.current) return null;
  return {
    name: state.current.name,
    tasks: state.current.tasks.map((t) => ({ ...t, dependencies: [...(t.dependencies || [])] })),
  };
}

function _restore(snap) {
  state.current.name = snap.name;
  state.current.tasks = snap.tasks.map((t) => ({ ...t, dependencies: [...t.dependencies] }));
  state.selected = null;
}

// pushUndo() só guarda o "antes" (antes de qualquer mutação local); o
// "depois" (o que a sua própria edição de fato produziu) é preenchido por
// _closeUndoEntry(), chamado de markDirty() — que já roda logo após toda
// edição local completar (submitModal, drag no pointerup, newTask, etc.).
// Sem o par completo não dá pra saber, na hora do undo, o que era "seu"
// versus o que chegou por fora (poll, outra aba, REPL) nesse meio tempo.
function pushUndo() {
  if (!state.current) return;
  const snap = _snapshot();
  if (!snap) return;
  state.undoStack.push({ before: snap, after: null });
  state.redoStack = [];
}

function _closeUndoEntry() {
  const e = state.undoStack[state.undoStack.length - 1];
  if (e && e.after === null) e.after = _snapshot();
}

function _tasksById(snap) {
  return new Map(snap.tasks.map((t) => [t.id, t]));
}
const _taskEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const _cloneTask = (t) => ({ ...t, dependencies: [...(t.dependencies || [])] });

// Tarefas que a ação original (o par before/after de uma entrada de undo)
// de fato tocou: criadas, apagadas ou com algum campo diferente. Undo/redo
// só mexem nessas — o resto do projeto é sempre preservado como está.
function _touchedTaskIds(before, after) {
  const B = _tasksById(before), A = _tasksById(after);
  const ids = new Set([...B.keys(), ...A.keys()]);
  const touched = new Set();
  for (const id of ids) if (!_taskEq(B.get(id), A.get(id))) touched.add(id);
  return touched;
}

// Aplica `target` (before no undo, after no redo) por cima do estado
// atual, mas só nas tarefas tocadas pela ação original — e só nelas se
// ninguém mexeu por fora desde `reference` (after no undo, before no
// redo). Tarefas concorrentes (adicionadas por fora, fora do par
// before/after) nunca são tocadas. Retorna true se algo foi pulado por
// conflito (aviso ao chamador).
function _reconcile(before, after, reference, target) {
  const cur = _snapshot();
  const touched = _touchedTaskIds(before, after);
  const C = _tasksById(cur), R = _tasksById(reference);
  const outTasks = [];
  const seen = new Set();
  let skipped = false;

  for (const t of target.tasks) {
    seen.add(t.id);
    if (!touched.has(t.id)) { const c = C.get(t.id); if (c) outTasks.push(c); continue; }
    const c = C.get(t.id), r = R.get(t.id);
    // clona: `t` referencia o snapshot guardado na entrada de undo/redo —
    // sem clonar, uma mutação futura em state.current vazaria pra ele
    if (_taskEq(c, r)) outTasks.push(_cloneTask(t));  // sem mudança concorrente: aplica
    else if (c !== undefined) { outTasks.push(c); skipped = true; }  // preserva o concorrente
    // c === undefined e a tarefa era tocada: já não existe em lugar nenhum, nada a fazer
  }
  for (const [id, c] of C) {                         // tarefas concorrentes fora do par
    if (seen.has(id) || touched.has(id)) continue;
    outTasks.push(c);
  }

  state.current.tasks = outTasks;
  if (before.name !== after.name) {                  // a ação tocou o nome do projeto
    if (cur.name === reference.name) state.current.name = target.name;
    else skipped = true;
  }
  state.selected = null;
  return skipped;
}

function undo() {
  const e = state.undoStack.pop();
  if (!e) return;
  if (!e.after) {
    _restore(e.before);                               // par incompleto: sem referência segura
  } else if (_reconcile(e.before, e.after, e.after, e.before)) {
    console.warn("Perth: undo pulou uma tarefa alterada por fora nesse meio tempo.");
  }
  state.redoStack.push(e);
  renderAll();
  markDirty();
}

function redo() {
  const e = state.redoStack.pop();
  if (!e) return;
  if (!e.after) return;                               // não deveria acontecer
  if (_reconcile(e.before, e.after, e.before, e.after)) {
    console.warn("Perth: redo pulou uma tarefa alterada por fora nesse meio tempo.");
  }
  state.undoStack.push(e);
  renderAll();
  markDirty();
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const el = {
  projectSelect: $("#project-select"),
  taskRows: $("#task-rows"),
  tlBody: $("#tl-body"),
  tlHead: $("#tl-head"),
  ttBody: document.querySelector(".tt-body"),
  tlMonths: $("#tl-months"),
  tlDays: $("#tl-days"),
  chart: $("#chart"),
  welcome: $("#welcome"),
  wRecent: $("#w-recent"),
  wRecentWrap: $("#w-recent-wrap"),
  wContinue: $("#w-continue"),
  statusLeft: $("#status-left"),
  statusSave: $("#status-save"),
  progressFill: $("#progress-fill"),
  progressPct: $("#progress-pct"),
  progressWrap: $("#progress-wrap"),
  modal: $("#modal"),
  importFile: $("#import-file"),
  filebox: $("#filebox"),
  savePath: $("#save-path"),
  savePathBtn: $("#save-path-btn"),
  pathCompletions: $("#path-completions"),
  fbBrowse: $("#fb-browse"),
  fbPanel: $("#fb-panel"),
  fbPlaces: $("#fb-places"),
  fbUp: $("#fb-up"),
  fbCwdPath: $("#fb-cwd-path"),
  fbDirs: $("#fb-dirs"),
  fbHint: $("#fb-hint"),
  fbChoose: $("#fb-choose"),
  highlightSelect: $("#highlight-select"),
  resPane: $("#res-pane"),
  resNames: $("#res-names"),
  resBody: $("#res-body"),
  resChart: $("#res-chart"),
  chatPanel: $("#chat-panel"),
  chatLog: $("#chat-log"),
  chatBadge: $("#chat-badge"),
  chatInput: $("#chat-input"),
  chatTyping: $("#chat-typing"),
};

/* ------------------------------------------------------------------ */
/* Configurações de interface (painel estilo VitePress na menubar)      */
/* ------------------------------------------------------------------ */

const UI_DEFAULTS = { density: "cozy", tableWidth: 380, weekends: true, labels: true, baseline: true, hideCursors: false, hideBackground: false };
let ui = { ...UI_DEFAULTS };
try {
  ui = { ...UI_DEFAULTS, ...JSON.parse(localStorage.getItem("perth-ui") || "{}") };
} catch { /* localStorage corrompido: usa defaults */ }

function applyUI() {
  ROW_H = ui.density === "compact" ? 28 : 34;
  const root = document.documentElement;
  root.style.setProperty("--row-h", ROW_H + "px");
  root.style.setProperty("--table-w", ui.tableWidth + "px");
  $$("#set-density button").forEach((b) =>
    b.classList.toggle("active", b.dataset.density === ui.density));
  $("#set-tablew").value = ui.tableWidth;
  $("#set-weekends").setAttribute("aria-pressed", String(ui.weekends));
  $("#set-labels").setAttribute("aria-pressed", String(ui.labels));
  $("#set-baseline").setAttribute("aria-pressed", String(ui.baseline));
  $("#set-hide-cursors").setAttribute("aria-pressed", String(ui.hideCursors));
  document.documentElement.classList.toggle("hide-remote-cursors", ui.hideCursors);
  $("#set-hide-bg").setAttribute("aria-pressed", String(ui.hideBackground));
  applyBackground();          // sem argumento: só redesenha com o que já se sabe
}

/* ------------------------------------------------------------------ */
/* Fundo da UI: a imagem é setting do servidor (Perth.background!), mas  */
/* cada navegador pode escondê-la — preferência de renderização, como o  */
/* "hide other cursors", não um opt-out de compartilhamento.            */
/* ------------------------------------------------------------------ */

let bgInfo = null;

// A camada, a rotação e o fade vivem em shared/background.js (os dois apps
// usam o mesmo). Daqui vão só as duas coisas que são deste app: a
// preferência local de esconder e como a chave de acesso entra na URL.
PerthBackground.init({
  isHidden: () => ui.hideBackground,
  withKey,
});

function applyBackground(info) {
  if (info !== undefined) bgInfo = info;
  PerthBackground.apply(info);
}

function refreshBackground() {
  api("/api/background").then(applyBackground).catch(() => {});
}

function saveUI() {
  localStorage.setItem("perth-ui", JSON.stringify(ui));
}

/* ------------------------------------------------------------------ */
/* Utilidades de data (sempre UTC para evitar surpresas de fuso)        */
/* ------------------------------------------------------------------ */

function parseDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmtISO(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date, n) {
  return new Date(date.getTime() + n * 86400000);
}

function diffDays(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function todayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function fmtShort(iso) {
  const d = parseDate(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

const MONTHS = new Proxy([], {   // meses no idioma da interface
  get: (_, i) => (window.PerthI18n
    ? PerthI18n.months()
    : ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"])[i],
});
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function taskEnd(t) {
  const start = parseDate(t.start);
  return t.milestone ? start : addDays(start, Math.max(t.duration, 1) - 1);
}

function baselineEnd(t) {
  return addDays(parseDate(t.baseline_start), Math.max(t.baseline_duration, 1) - 1);
}

/* Dias de derrapagem vs. baseline (positivo = termina depois do planejado) */
function slipDays(t) {
  if (!t.baseline_start) return 0;
  return diffDays(baselineEnd(t), taskEnd(t));
}

/* Dias além do prazo (0 = dentro do compromisso, ou sem compromisso).
   O prazo é do dia inteiro: terminar NO dia do prazo está em dia. */
function deadlineSlip(t) {
  if (!t.deadline) return 0;
  return Math.max(0, diffDays(parseDate(t.deadline), taskEnd(t)));
}

/* Filtro de destaque: tarefas que não casam são esmaecidas (classe .dim) */
function taskMatchesHighlight(t) {
  const h = state.highlight;
  if (!h) return true;
  if (h.kind === "assignee") return (t.assignee || "").trim() === h.value;
  if (h.kind === "status") {
    if (h.value === "not-started") return !t.milestone && t.progress === 0;
    if (h.value === "in-progress") return !t.milestone && t.progress > 0 && t.progress < 100;
    if (h.value === "done") return t.progress === 100;
    if (h.value === "overdue") return t.progress < 100 && taskEnd(t) < todayUTC();
    if (h.value === "unassigned") return !(t.assignee || "").trim();
    if (h.value === "slipped")
      return !state.wbs?.summary.has(t.id) && slipDays(t) > 0;
    if (h.value === "past-deadline") return deadlineSlip(t) > 0;
    if (h.value === "pinned") return !!t.pinned;
    if (h.value === "overallocated") return state.overalloc.ids.has(t.id);
  }
  if (h.kind === "type") return !!t.milestone;
  return true;
}

/* ------------------------------------------------------------------ */
/* API                                                                  */
/* ------------------------------------------------------------------ */

// Chave de acesso do share (Perth.run(share=true, key=...)): vem na URL e é
// reenviada em toda chamada de API. Fica na sessão para sobreviver a um
// reload sem a query (favorito, start_url do PWA, link repassado sem o
// ?key=) — quem não tem nenhuma das duas cai no diálogo de showKeyGate().
// Mesmo modelo do kanban.
const KEY_STORE = "perth-key";
let ACCESS_KEY = new URLSearchParams(location.search).get("key") ||
                 sessionStorage.getItem(KEY_STORE) || "";
if (ACCESS_KEY) sessionStorage.setItem(KEY_STORE, ACCESS_KEY);

function setAccessKey(value) {
  ACCESS_KEY = value || "";
  sessionStorage.setItem(KEY_STORE, ACCESS_KEY);
  window.PerthPresence?.setKey(ACCESS_KEY);   // o WS usa a mesma chave
  // A URL tem prioridade sobre a sessão na carga (um link novo manda), o
  // que deixaria um ?key= velho reaparecer no F5 depois de o host trocar a
  // chave. Quem digitou a chave não precisa mais dele: some da barra.
  const q = new URLSearchParams(location.search);
  if (q.has("key")) {
    q.delete("key");
    const rest = q.toString();
    history.replaceState(null, "", location.pathname + (rest ? "?" + rest : ""));
  }
}

function withKey(path) {
  if (!ACCESS_KEY) return path;
  return path + (path.includes("?") ? "&" : "?") +
    "key=" + encodeURIComponent(ACCESS_KEY);
}

// 403 do porteiro: falta a chave (pede) x transmissão desligada (avisa)
const isKeyError = (err) => err?.status === 403 && /access key/i.test(err.message || "");

async function api(path, opts = {}) {
  const res = await fetch(withKey(path), {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function fetchRev() {
  return (await api("/api/rev")).rev;
}

function noteBase() {
  state.baseUpdatedAt = state.current?.updated_at || "";
}

async function loadProjects(keepId = null) {
  state.projects = await api("/api/projects");
  renderProjectSelect();
  // Prioridade: pedido explícito > projeto já aberto > último aberto
  // (persistido — é o que faz a volta do kanban cair onde você estava)
  // > mais recente. Ids inválidos (projeto excluído) são pulados.
  const valid = (id) => id && state.projects.some((p) => p.id === id);
  const wanted = [keepId, state.current?.id,
                  localStorage.getItem("perth-last-project"),
                  state.projects[0]?.id].find(valid) ?? null;
  if (wanted) {
    await openProject(wanted);
  } else {
    state.current = null;
    renderAll();
    renderFilebox();
    showWelcome();
  }
}

async function openProject(id) {
  state.current = await api(`/api/projects/${id}`);
  noteBase();
  state.selected = null;
  el.projectSelect.value = id;
  localStorage.setItem("perth-last-project", id);
  await fetchAnalytics();
  renderAll();
  renderFilebox();
  hideWelcome();
}

/* Análise CPM (caminho crítico, folga, término) vinda do motor Julia */
async function fetchCPM() {
  state.cpm = null;
  if (!state.current || !state.current.tasks.length) return;
  try {
    const r = await api(`/api/projects/${state.current.id}/cpm`);
    state.cpm = {
      cycle: r.cycle,
      finish: r.finish,
      calendar: r.calendar || "",
      // término probabilístico; null quando ninguém estimou nada
      pert: r.pert || null,
      byId: new Map((r.tasks || []).map((t) => [t.id, t])),
    };
  } catch {
    /* ex.: calendário de dias úteis sem BusinessDays no servidor */
  }
}

/* Carga por responsável (workload). Só o motor sabe quais dias do
   intervalo são úteis — o navegador desconhece feriados —, por isso as
   faixas do painel de recursos vêm prontas do servidor. */
async function fetchWorkload() {
  state.resources = null;
  if (!state.current || !state.current.tasks.length) return;
  try {
    state.resources = await api(`/api/projects/${state.current.id}/workload`);
  } catch {
    /* mesmo caso do CPM acima */
  }
}

// CPM sempre; a carga só com o painel aberto — ninguém paga por um
// payload que não está olhando
async function fetchAnalytics() {
  await fetchCPM();
  if (state.resOpen) await fetchWorkload();
}

/* Salvamento: debounce do PUT do projeto inteiro */
let saveTimer = null;

function markDirty() {
  if (!state.current) return;
  _closeUndoEntry();     // fecha o par before/after da edição que acabou de rodar
  state.dirty = true;
  setSaveStatus("saving", "saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
}

async function saveNow() {
  if (!state.current || !state.dirty) return;
  try {
    await api(`/api/projects/${state.current.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Perth-Base": state.baseUpdatedAt || "",
      },
      body: JSON.stringify(state.current),
    }).then((saved) => {
      state.current.updated_at = saved.updated_at;
      noteBase();
    });
    state.dirty = false;
    state.knownRev = await fetchRev();
    await fetchAnalytics();
    renderTable();
    renderChart();
    renderStatus();
    renderResources();
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    setSaveStatus("saved", `saved ${hh}:${mm} ✓`);
  } catch (err) {
    if (err && err.status === 409) {
      // outra máquina salvou antes: recarrega em vez de sobrescrever
      setSaveStatus("error",
        window.PerthI18n
          ? PerthI18n.t("Project changed on another machine — reloaded")
          : "Project changed on another machine — reloaded");
      state.dirty = false;
      await loadProjects(state.current?.id ?? null);
      return;
    }
    setSaveStatus("error", `save failed: ${err.message} — retrying…`);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 3000);
  }
}

function setSaveStatus(cls, text) {
  el.statusSave.className = cls;
  el.statusSave.textContent = text;
}

/* ------------------------------------------------------------------ */
/* Caixa de caminho (estilo Pluto): espelha o projeto num .perth.jl     */
/* ------------------------------------------------------------------ */

function renderFilebox() {
  // Não sobrescreve o que o usuário está digitando (o polling pode
  // recarregar o projeto no meio da edição do caminho)
  if (document.activeElement !== el.savePath) {
    el.savePath.value = state.current?.file_path || "";
  }
  updateFileboxBtn();
}

function updateFileboxBtn() {
  const cur = state.current?.file_path || "";
  const val = el.savePath.value.trim();
  el.savePathBtn.hidden = !state.current || val === cur;
  // Desvincular (limpar o campo) tem semântica própria no botão
  el.savePathBtn.textContent = (val === "" && cur !== "") ? "Unlink" : "Save";
}

el.filebox.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!state.current) return;
  const path = el.savePath.value.trim();
  try {
    state.current = await api(`/api/projects/${state.current.id}/path`, {
      method: "PUT",
      body: JSON.stringify({ path }),
    });
    noteBase();
    state.knownRev = await fetchRev();
    el.savePath.blur();
    renderFilebox();
    setSaveStatus("saved", state.current.file_path
      ? `saved to ${state.current.file_path} ✓`
      : "file unlinked");
  } catch (err) {
    setSaveStatus("error", `save to file failed: ${err.message}`);
  }
});

/* Autocomplete de diretórios/arquivos .jl via <datalist> */
let completeTimer = null;
el.savePath.addEventListener("input", () => {
  updateFileboxBtn();
  clearTimeout(completeTimer);
  completeTimer = setTimeout(fillPathCompletions, 150);
});

async function fillPathCompletions() {
  const q = el.savePath.value;
  if (!q.trim()) { el.pathCompletions.innerHTML = ""; return; }
  try {
    const items = await api(`/api/fs/complete?q=${encodeURIComponent(q)}`);
    el.pathCompletions.innerHTML = "";
    for (const it of items) {
      const o = document.createElement("option");
      o.value = it;
      el.pathCompletions.appendChild(o);
    }
  } catch { /* autocompletar é melhor-esforço */ }
}

el.savePath.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    // Esc reverte para o caminho vinculado e sai do campo
    el.savePath.value = state.current?.file_path || "";
    updateFileboxBtn();
    el.savePath.blur();
    ev.stopPropagation();
  }
});

/* ------------------------------------------------------------------ */
/* Navegador de pastas (backend lista o filesystem; o diálogo nativo    */
/* do sistema não expõe caminhos reais a páginas web)                   */
/* ------------------------------------------------------------------ */

const browse = { dir: null, sep: "/" };   // estado do painel

async function openFbPanel() {
  if (!state.current) return;
  // Parte do diretório do vínculo atual; senão o servidor decide
  // (última pasta escolhida — persistida em settings.json — ou Home)
  const cur = state.current.file_path || "";
  const start = cur ? cur.slice(0, cur.lastIndexOf("/")) : "";
  const ok = await fbNavigate(start);
  if (!ok) return;
  el.fbPanel.hidden = false;
  el.fbBrowse.setAttribute("aria-expanded", "true");
}

function closeFbPanel() {
  el.fbPanel.hidden = true;
  el.fbBrowse.setAttribute("aria-expanded", "false");
}

async function fbNavigate(dir) {
  try {
    const r = await api(`/api/fs/list?dir=${encodeURIComponent(dir || "")}`);
    browse.dir = r.dir;
    browse.sep = r.sep || "/";
    renderFbPanel(r);
    return true;
  } catch (err) {
    setSaveStatus("error", `browse failed: ${err.message}`);
    return false;
  }
}

function renderFbPanel(r) {
  // Atalhos do sistema (Home, Documents, …) detectados pelo servidor
  el.fbPlaces.innerHTML = "";
  for (const pl of r.places || []) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = pl.label;
    b.classList.toggle("active", pl.path === r.dir);
    b.addEventListener("click", () => fbNavigate(pl.path));
    el.fbPlaces.appendChild(b);
  }

  el.fbCwdPath.textContent = r.dir;
  el.fbCwdPath.title = r.dir;
  el.fbUp.disabled = !r.parent;
  el.fbUp.onclick = () => r.parent && fbNavigate(r.parent);

  el.fbDirs.innerHTML = "";
  if (!r.dirs.length) {
    const empty = document.createElement("div");
    empty.className = "fb-empty";
    empty.textContent = T("no subfolders");
    el.fbDirs.appendChild(empty);
  }
  for (const name of r.dirs) {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
    b.appendChild(document.createTextNode(name));
    b.addEventListener("click", () => fbNavigate(r.dir + browse.sep + name));
    el.fbDirs.appendChild(b);
  }

  el.fbHint.textContent = r.is_default ? "current default folder" : "";
}

el.fbBrowse.addEventListener("click", (ev) => {
  ev.stopPropagation();
  el.fbPanel.hidden ? openFbPanel() : closeFbPanel();
});

/* Escolher a pasta atual: vincula já (o servidor deriva o nome do arquivo
 * do nome do projeto) e a memoriza como padrão para as próximas vezes */
el.fbChoose.addEventListener("click", async () => {
  if (!state.current || !browse.dir) return;
  closeFbPanel();
  el.savePath.value = browse.dir + browse.sep;
  updateFileboxBtn();
  el.filebox.requestSubmit
    ? el.filebox.requestSubmit()
    : el.filebox.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
});

/* Clique fora ou Esc fecham o painel */
document.addEventListener("click", (ev) => {
  if (!el.fbPanel.hidden && !el.fbPanel.contains(ev.target) && ev.target !== el.fbBrowse) {
    closeFbPanel();
  }
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !el.fbPanel.hidden) {
    closeFbPanel();
    ev.stopPropagation();
  }
}, true);  // capture: fecha o painel antes dos handlers globais de Esc

/* Polling: recarrega quando o REPL (ou outra aba) altera os dados */
async function poll() {
  if (state.dragging || state.dirty || !el.modal.hidden || !el.welcome.hidden) return;
  if (document.activeElement === el.savePath) return;  // digitando o caminho
  try {
    const rev = await fetchRev();
    if (rev !== state.knownRev) {
      state.knownRev = rev;
      await loadProjects(state.current?.id ?? null);
    }
  } catch {
    /* servidor pode estar reiniciando; tenta no próximo ciclo */
  }
}

// O ciclo periódico é só um fallback: com o WS de presença conectado, o
// servidor já empurra "rev" na hora (ver onRev abaixo) e este poll() vira
// puro round-trip redundante. Só roda de verdade enquanto o WS estiver
// caído/reconectando — mesma função poll(), sem duplicar a lógica.
function pollFallback() {
  if (window.PerthPresence && PerthPresence.isLive()) return;
  poll();
}

/* ------------------------------------------------------------------ */
/* Cálculo do intervalo visível                                         */
/* ------------------------------------------------------------------ */

function computeRange() {
  const today = todayUTC();
  let min = addDays(today, -7);
  let max = addDays(today, 30);
  for (const t of state.current?.tasks ?? []) {
    const s = parseDate(t.start);
    const e = taskEnd(t);
    if (s < min) min = s;
    if (e > max) max = e;
  }
  min = addDays(min, -7);
  max = addDays(max, 21);
  state.range = { start: min, days: diffDays(min, max) + 1 };
}

function xOf(date) {
  return diffDays(state.range.start, date) * PPD[state.zoom];
}

function dateAt(x) {
  return addDays(state.range.start, Math.round(x / PPD[state.zoom]));
}

/* ------------------------------------------------------------------ */
/* Renderização                                                         */
/* ------------------------------------------------------------------ */

/* Tudo que deriva de HOJE — a linha de hoje no gráfico, os destaques
   "past deadline", o deadlineSlip das bandeiras — é montado dentro de
   render*(), que roda quando a REVISÃO muda (pollFallback), não quando o
   relógio anda. Um gantt deixado aberto na parede durante a noite
   continuava desenhando a linha de ontem até alguém editar alguma coisa.
   Este timer redesenha logo depois da meia-noite e se reagenda. */
function renderAtMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1,
                        0, 0, 5);
  setTimeout(() => {
    renderAll();
    renderAtMidnight();
  }, next - now);
}

function renderAll() {
  if (!state.current) {
    el.taskRows.innerHTML = "";
    el.tlMonths.innerHTML = "";
    el.tlDays.innerHTML = "";
    el.chart.innerHTML = "";
    el.statusLeft.textContent = T("no project open");
    return;
  }
  computeRange();
  sortTasks();
  computeOverallocations();
  renderHighlightSelect();
  renderHeader();
  renderTable();
  renderChart();
  renderStatus();
  renderResources();
}

/* Pares de tarefas-folha do mesmo responsável com datas sobrepostas.
 * O(n²) nos pares com assignee — barato na escala de um Gantt. */
function computeOverallocations() {
  const leaves = state.current.tasks.filter(
    (t) => !state.wbs.summary.has(t.id) && (t.assignee || "").trim());
  const pairs = [];
  const ids = new Set();
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i], b = leaves[j];
      if (a.assignee.trim() !== b.assignee.trim()) continue;
      const from = a.start > b.start ? a.start : b.start;
      const ea = fmtISO(taskEnd(a)), eb = fmtISO(taskEnd(b));
      const to = ea < eb ? ea : eb;
      if (from <= to) {
        pairs.push({ assignee: a.assignee.trim(), a: a.id, b: b.id, from, to });
        ids.add(a.id);
        ids.add(b.id);
      }
    }
  }
  state.overalloc = { pairs, ids };
}

/* Reconstrói o seletor de destaque preservando a escolha atual.
 * Assignees vêm das próprias tarefas; se o escolhido sumiu, limpa. */
function renderHighlightSelect() {
  const sel = el.highlightSelect;
  const assignees = [...new Set(
    state.current.tasks.map((t) => (t.assignee || "").trim()).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  const cur = state.highlight ? `${state.highlight.kind}:${state.highlight.value}` : "";
  sel.innerHTML = "";
  const opt = (value, label) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  };
  sel.appendChild(opt("", "Highlight: none"));

  if (assignees.length) {
    const g = document.createElement("optgroup");
    g.label = "Assignee";
    for (const a of assignees) g.appendChild(opt(`assignee:${a}`, a));
    g.appendChild(opt("status:unassigned", "(unassigned)"));
    sel.appendChild(g);
  }
  const gs = document.createElement("optgroup");
  gs.label = "Status";
  gs.appendChild(opt("status:not-started", "Not started"));
  gs.appendChild(opt("status:in-progress", "In progress"));
  gs.appendChild(opt("status:done", "Done"));
  gs.appendChild(opt("status:overdue", "Overdue"));
  if (state.current.tasks.some((t) => t.baseline_start)) {
    gs.appendChild(opt("status:slipped", "Slipped (vs baseline)"));
  }
  if (state.current.tasks.some((t) => t.deadline)) {
    gs.appendChild(opt("status:past-deadline", "Past deadline"));
  }
  if (state.current.tasks.some((t) => t.pinned)) {
    gs.appendChild(opt("status:pinned", "Pinned start"));
  }
  if (state.overalloc.pairs.length) {
    gs.appendChild(opt("status:overallocated", "Overallocated"));
  }
  sel.appendChild(gs);
  const gt = document.createElement("optgroup");
  gt.label = "Type";
  gt.appendChild(opt("type:milestone", "Milestones"));
  sel.appendChild(gt);

  // varre as opções em vez de montar um seletor: o valor vem de nome de
  // responsável (texto livre do usuário), que num seletor precisaria de
  // CSS.escape — API que nem todo ambiente de teste tem, e desnecessária
  // para uma comparação de igualdade
  if (cur && [...sel.options].some((o) => o.value === cur)) {
    sel.value = cur;
  } else {
    sel.value = "";
    state.highlight = null;
  }
}

/* WBS: poda pais inválidos (espelha _prune_parents! do servidor),
 * materializa os resumos (rollup: start = menor início dos filhos,
 * duration = extensão, progress = média ponderada pela duração das
 * folhas) e reordena as tarefas hierarquicamente — filhos sob o pai,
 * irmãos por (start, nome). Obs.: o preview aqui usa dias corridos;
 * com calendário de dias úteis, o rollup autoritativo é o do servidor
 * a cada save. */
function sortTasks() {
  const tasks = state.current.tasks;
  const byId = new Map(tasks.map((t) => [t.id, t]));

  for (const t of tasks) {
    if (t.parent &&
        (!byId.has(t.parent) || t.parent === t.id || byId.get(t.parent).milestone)) {
      t.parent = "";
    }
  }
  for (const t of tasks) {              // quebra ciclos na cadeia de pais
    let cur = t, steps = 0;
    while (cur.parent && steps <= tasks.length) {
      cur = byId.get(cur.parent);
      steps++;
      if (cur === t) { t.parent = ""; break; }
    }
  }

  const kids = new Map();
  for (const t of tasks) {
    if (!t.parent) continue;
    if (!kids.has(t.parent)) kids.set(t.parent, []);
    kids.get(t.parent).push(t);
  }
  const summary = new Set(kids.keys());

  const roll = (t) => {                 // pós-ordem; devolve [start, end, prog, peso]
    const cs = kids.get(t.id);
    if (!cs) {
      const w = t.milestone ? 1 : Math.max(t.duration, 1);
      const prog = t.milestone ? (t.progress >= 100 ? 100 : 0) : t.progress;
      return [parseDate(t.start), taskEnd(t), prog, w];
    }
    let s = null, e = null, wsum = 0, psum = 0;
    for (const c of cs) {
      const [cs_, ce, cp, cw] = roll(c);
      if (s === null || cs_ < s) s = cs_;
      if (e === null || ce > e) e = ce;
      wsum += cw;
      psum += cp * cw;
    }
    t.milestone = false;                // resumo nunca é marco
    t.start = fmtISO(s);
    t.duration = diffDays(s, e) + 1;
    t.progress = wsum ? Math.round(psum / wsum) : 0;
    return [s, e, t.progress, wsum];
  };
  for (const id of summary) roll(byId.get(id));

  const roots = tasks.filter((t) => !t.parent);
  const depth = new Map();
  const out = [];
  const walk = (ts, d) => {
    ts.sort((a, b) =>
      a.start === b.start ? a.name.localeCompare(b.name) : (a.start < b.start ? -1 : 1));
    for (const t of ts) {
      out.push(t);
      depth.set(t.id, d);
      if (kids.has(t.id)) walk(kids.get(t.id), d + 1);
    }
  };
  walk(roots, 0);
  state.current.tasks = out;
  state.wbs = { kids, depth, summary };
}

function renderProjectSelect() {
  el.projectSelect.innerHTML = "";
  for (const p of state.projects) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    el.projectSelect.appendChild(opt);
  }
  // repopular não pode derrubar a seleção (chip da menubar ficaria vazio)
  if (state.current) el.projectSelect.value = state.current.id;
}

function renderStatus() {
  const ts = state.current.tasks;
  if (!ts.length) {
    el.statusLeft.textContent = `${state.current.name} · no tasks`;
    el.progressWrap.hidden = true;
    return;
  }
  const min = ts.reduce((m, t) => (t.start < m ? t.start : m), ts[0].start);
  const max = ts.reduce((m, t) => {
    const e = fmtISO(taskEnd(t));
    return e > m ? e : m;
  }, fmtISO(taskEnd(ts[0])));
  let text =
    `${state.current.name} · ${ts.length} task${ts.length > 1 ? "s" : ""} · ${min} → ${max}`;
  if (state.cpm?.cycle) text += " · ⚠ dependency cycle";
  else if (state.cpm?.finish) text += ` · finish ${state.cpm.finish}`;
  if (state.cpm?.calendar) text += ` · ${state.cpm.calendar} business days`;
  if (state.overalloc.pairs.length) {
    text += ` · ⚠ ${state.overalloc.pairs.length} overallocation${state.overalloc.pairs.length > 1 ? "s" : ""}`;
  }
  const late = ts.filter((t) => deadlineSlip(t) > 0).length;
  if (late) text += ` · ⚠ ${late} past deadline`;
  // Término probabilístico: só o P80, que é o número que se promete a
  // alguém. O resto (esperado, σ, quantas tarefas estimadas) fica no
  // tooltip — a barra de status não é lugar de tabela.
  const pert = state.cpm?.pert;
  if (pert && pert.p80) {
    text += ` · P80 ${pert.p80}`;
    el.statusLeft.title =
      `${T("PERT")}: ${T("expected")} ${pert.expected} · σ ` +
      `${Math.round(pert.sd_days * 10) / 10} d · ${pert.estimated} ` +
      T("estimated tasks on the critical path");
  } else {
    el.statusLeft.removeAttribute("title");
  }
  el.statusLeft.textContent = text;

  // Barra de progresso do projeto: só folhas (resumos são agregados delas)
  const leaves = ts.filter((t) => !state.wbs.summary.has(t.id));
  const base = leaves.length ? leaves : ts;
  const pct = Math.round(base.reduce((s, t) => s + (t.milestone ? (t.progress >= 100 ? 100 : 0) : t.progress), 0) / base.length);
  el.progressWrap.hidden = false;
  el.progressFill.style.width = pct + "px";
  el.progressPct.textContent = pct + "%";
}

/* Cabeçalho da timeline: linha de meses + linha de dias/semanas */
function renderHeader() {
  const ppd = PPD[state.zoom];
  const { start, days } = state.range;
  const totalW = days * ppd;
  el.tlMonths.style.width = totalW + "px";
  el.tlDays.style.width = totalW + "px";
  el.tlMonths.innerHTML = "";
  el.tlDays.innerHTML = "";

  // Meses
  let d = new Date(start.getTime());
  while (diffDays(start, d) < days) {
    const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const x0 = Math.max(xOf(monthStart), 0);
    const x1 = Math.min(xOf(next), totalW);
    const cell = document.createElement("div");
    cell.className = "tl-cell";
    cell.style.left = x0 + "px";
    cell.style.width = (x1 - x0) + "px";
    cell.textContent = `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    el.tlMonths.appendChild(cell);
    d = next;
  }

  // Dias (zoom dia) ou semanas (zoom semana/mês)
  const today = todayUTC();
  if (state.zoom === "day") {
    for (let i = 0; i < days; i++) {
      const dt = addDays(start, i);
      const cell = document.createElement("div");
      cell.className = "tl-cell";
      if (dt.getTime() === today.getTime()) cell.classList.add("today-cell");
      cell.style.left = i * ppd + "px";
      cell.style.width = ppd + "px";
      cell.textContent = `${WEEKDAYS[dt.getUTCDay()]} ${dt.getUTCDate()}`;
      el.tlDays.appendChild(cell);
    }
  } else {
    // Alinha nas segundas-feiras
    let w = new Date(start.getTime());
    while (w.getUTCDay() !== 1) w = addDays(w, 1);
    for (; diffDays(start, w) < days; w = addDays(w, 7)) {
      const cell = document.createElement("div");
      cell.className = "tl-cell";
      cell.style.left = xOf(w) + "px";
      cell.style.width = 7 * ppd + "px";
      cell.textContent = state.zoom === "week"
        ? fmtShort(fmtISO(w))
        : String(w.getUTCDate());
      el.tlDays.appendChild(cell);
    }
  }
}

function renderTable() {
  el.taskRows.innerHTML = "";
  for (const t of state.current.tasks) {
    const row = document.createElement("div");
    const info = state.cpm?.byId.get(t.id);
    const crit = state.showCritical && info?.critical;
    const depth = state.wbs?.depth.get(t.id) ?? 0;
    const isSum = state.wbs?.summary.has(t.id) ?? false;
    row.className = "tt-row" + (t.id === state.selected ? " selected" : "")
      + (crit ? " critical" : "")
      + (isSum ? " summary" : "")
      + (taskMatchesHighlight(t) ? "" : " dim");
    if (state.showCritical && info) row.title = `slack: ${info.slack_days}d`;
    row.dataset.id = t.id;
    row.innerHTML = `
      <span class="c-name" style="padding-left:${depth * 14}px">${isSum ? '<span class="sum-mark">▾</span>' : t.milestone ? '<span class="ms">◆</span>' : ""}${escapeHTML(t.name)}${(t.notes || "").trim() ? '<span class="note-mark" title="has notes"></span>' : ""}</span>
      <span class="c-date">${t.start}</span>
      <span class="c-num">${t.milestone ? "—" : t.duration + "d"}</span>
      <span class="c-num">${t.progress}</span>`;
    row.addEventListener("click", () => selectTask(t.id));
    row.addEventListener("dblclick", () => openModal(t.id));
    el.taskRows.appendChild(row);
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/* <title> de SVG: tooltip nativo do navegador (usado p/ notes da tarefa) */
function svgTitle(text) {
  const el = svg("title");
  el.textContent = text.trim();
  return el;
}

function renderChart() {
  const ppd = PPD[state.zoom];
  const { start, days } = state.range;
  const tasks = state.current.tasks;
  const totalW = days * ppd;
  const totalH = Math.max(tasks.length * ROW_H + 40, el.tlBody.clientHeight);

  const chart = el.chart;
  chart.innerHTML = "";
  chart.setAttribute("width", totalW);
  chart.setAttribute("height", totalH);

  // Fins de semana (só quando a escala permite enxergar)
  if (ppd >= 10 && ui.weekends) {
    for (let i = 0; i < days; i++) {
      const dt = addDays(start, i);
      const dow = dt.getUTCDay();
      if (dow === 0 || dow === 6) {
        chart.appendChild(svg("rect", {
          class: "weekend", x: i * ppd, y: 0, width: ppd, height: totalH,
        }));
      }
    }
  }

  // Grade vertical: dias (zoom dia) ou segundas-feiras
  if (state.zoom === "day") {
    for (let i = 0; i <= days; i++) {
      chart.appendChild(svg("line", {
        class: "grid-line", x1: i * ppd, y1: 0, x2: i * ppd, y2: totalH,
      }));
    }
  } else {
    let w = new Date(start.getTime());
    while (w.getUTCDay() !== 1) w = addDays(w, 1);
    for (; diffDays(start, w) <= days; w = addDays(w, 7)) {
      const x = xOf(w);
      chart.appendChild(svg("line", {
        class: "grid-line", x1: x, y1: 0, x2: x, y2: totalH,
      }));
    }
  }

  // Linhas horizontais das linhas de tarefa
  for (let r = 1; r <= tasks.length; r++) {
    chart.appendChild(svg("line", {
      class: "row-line", x1: 0, y1: r * ROW_H, x2: totalW, y2: r * ROW_H,
    }));
  }

  // Setas de dependência (desenhadas antes das barras para ficarem por baixo)
  const rowOf = new Map(tasks.map((t, i) => [t.id, i]));
  for (const t of tasks) {
    for (const depRef of t.dependencies || []) {
      const dep = depId(depRef);
      if (!rowOf.has(dep)) continue;
      const pred = tasks[rowOf.get(dep)];
      const x1 = xOf(addDays(taskEnd(pred), 1));
      const y1 = rowOf.get(dep) * ROW_H + ROW_H / 2;
      const x2 = xOf(parseDate(t.start));
      const y2 = rowOf.get(t.id) * ROW_H + ROW_H / 2;
      chart.appendChild(svg("path", { class: "dep", d: depPath(x1, y1, x2, y2) }));
      chart.appendChild(svg("polygon", {
        class: "dep-head",
        points: `${x2},${y2} ${x2 - 7},${y2 - 4} ${x2 - 7},${y2 + 4}`,
      }));
    }
  }

  // Barras e marcos
  tasks.forEach((t, i) => {
    const y = i * ROW_H + 6;
    const h = ROW_H - 12;
    const color = t.color || AUTO_COLORS[i % AUTO_COLORS.length];
    const x = xOf(parseDate(t.start));
    const dim = taskMatchesHighlight(t) ? "" : " dim";
    const hasNotes = (t.notes || "").trim().length > 0;
    const isSum = state.wbs?.summary.has(t.id) ?? false;
    const slip = !isSum && !t.milestone ? slipDays(t) : 0;

    // Barra-fantasma do baseline (plano original), rente à base da linha
    if (ui.baseline && t.baseline_start && !isSum && !t.milestone) {
      const bx = xOf(parseDate(t.baseline_start));
      const bw = Math.max(t.baseline_duration, 1) * ppd;
      chart.appendChild(svg("rect", {
        class: "baseline-ghost" + dim,
        x: bx, y: i * ROW_H + ROW_H - 9, width: bw, height: 4, rx: 2,
      }));
    }

    if (isSum) {
      // Colchete de resumo (estilo MS Project): barra fina + presilhas
      const w = Math.max(t.duration, 1) * ppd;
      const sy = i * ROW_H + 7;
      const g = svg("path", {
        class: "bar-summary" + dim,
        d: `M ${x} ${sy} H ${x + w} V ${sy + 10} L ${x + w - 7} ${sy + 4} H ${x + 7} L ${x} ${sy + 10} Z`,
        "data-id": t.id,
      });
      if (hasNotes) g.appendChild(svgTitle(t.notes));
      g.addEventListener("click", () => selectTask(t.id));
      g.addEventListener("dblclick", () => openModal(t.id));
      chart.appendChild(g);
      if (hasNotes) {
        chart.appendChild(svg("circle", {
          class: "note-dot" + dim, cx: x + w - 2, cy: sy - 1, r: 3.2,
        }));
      }
      if (ui.labels) {
        const label = svg("text", { class: "bar-label" + dim, x: x + w + 8, y: sy + 9 });
        label.textContent = t.name;
        chart.appendChild(label);
      }
      if (t.id === state.selected) {
        chart.appendChild(svg("rect", {
          class: "bar-sel", x: x - 3, y: sy - 4, width: w + 6, height: 18,
        }));
      }
      return;   // resumo não tem barra normal, progresso nem drag
    }

    if (t.milestone) {
      const cy = i * ROW_H + ROW_H / 2;
      const r = h / 2 + 2;
      const dia = svg("polygon", {
        class: "milestone" + dim,
        points: `${x},${cy - r} ${x + r},${cy} ${x},${cy + r} ${x - r},${cy}`,
        fill: color,
        "data-id": t.id,
      });
      if (hasNotes) dia.appendChild(svgTitle(t.notes));
      attachDrag(dia, t, "move");
      chart.appendChild(dia);
      if (hasNotes) {
        chart.appendChild(svg("circle", {
          class: "note-dot" + dim, cx: x + r, cy: cy - r, r: 3.2,
        }));
      }
      if (ui.labels) {
        const label = svg("text", { class: "bar-label" + dim, x: x + r + 6, y: cy + 4 });
        label.textContent = t.name;
        chart.appendChild(label);
      }
    } else {
      const info = state.cpm?.byId.get(t.id);
      let w = Math.max(t.duration, 1) * ppd;
      if (state.cpm?.calendar && info && info.early_finish >= t.start &&
          info.early_start === t.start) {
        // dias úteis: fim real vem do motor (pula fins de semana/feriados)
        w = (diffDays(parseDate(t.start), parseDate(info.early_finish)) + 1) * ppd;
      }
      const bar = svg("rect", {
        class: "bar" + dim, x, y, width: w, height: h,
        fill: color, opacity: 0.55, "data-id": t.id,
      });
      if (hasNotes) bar.appendChild(svgTitle(t.notes));
      attachDrag(bar, t, "move");
      chart.appendChild(bar);

      if (t.progress > 0) {
        chart.appendChild(svg("rect", {
          class: "bar-progress" + dim, x, y,
          width: (w * t.progress) / 100, height: h, fill: color,
        }));
      }

      if (hasNotes) {
        // Ponto vermelho no canto: a tarefa tem anotações (hover mostra)
        chart.appendChild(svg("circle", {
          class: "note-dot" + dim, cx: x + w - 5, cy: y + 5, r: 3.2,
        }));
      }

      const handle = svg("rect", {
        class: "bar-handle" + dim, x: x + w - 8, y, width: 8, height: h, "data-id": t.id,
      });
      attachDrag(handle, t, "resize");
      chart.appendChild(handle);

      if (ui.labels) {
        const label = svg("text", { class: "bar-label" + dim, x: x + w + 8, y: y + h - 5 });
        label.textContent = t.name;
        if (slip > 0) {
          const ts = svg("tspan", { class: "slip-label" });
          ts.textContent = `  +${slip}d`;
          label.appendChild(ts);
        }
        chart.appendChild(label);
      } else if (slip > 0) {
        const badge = svg("text", { class: "bar-label slip-label" + dim, x: x + w + 8, y: y + h - 5 });
        badge.textContent = `+${slip}d`;
        chart.appendChild(badge);
      }

      if (state.showCritical && info?.critical) {
        chart.appendChild(svg("rect", {
          class: "bar-crit", x, y, width: w, height: h,
        }));
      }
    }

    // Prazo: bandeira no fim do dia do compromisso, vermelha quando o fim
    // previsto passa dele. O prazo nunca move a barra — só denuncia.
    if (t.deadline) {
      const dx = xOf(addDays(parseDate(t.deadline), 1));
      const over = deadlineSlip(t);
      const cls = "deadline-mark" + (over > 0 ? " late" : "") + dim;
      chart.appendChild(svg("line", {
        class: cls, x1: dx, y1: y - 4, x2: dx, y2: y + h + 4, "data-id": t.id,
      }));
      const flag = svg("polygon", {
        class: cls + " flag", "data-id": t.id,
        points: `${dx},${y - 4} ${dx + 8},${y - 1} ${dx},${y + 2}`,
      });
      flag.appendChild(svgTitle(`${T("deadline")}: ${t.deadline}` +
        (over > 0 ? ` · +${over}d` : "")));
      chart.appendChild(flag);
    }

    // Data fixa: o auto-schedule não move esta barra. Âmbar quando o motor
    // já quer empurrá-la (early_start > start) — é assim que o conflito
    // aparece, já que a data não muda sozinha
    if (t.pinned) {
      const cinfo = state.cpm?.byId.get(t.id);
      const stuck = !!cinfo && cinfo.early_start > t.start;
      const pin = svg("polygon", {
        class: "pin-mark" + (stuck ? " stuck" : "") + dim, "data-id": t.id,
        points: `${x},${y - 1} ${x - 5},${y - 8} ${x + 5},${y - 8}`,
      });
      pin.appendChild(svgTitle(stuck
        ? `${T("pinned start")} · ${T("auto-schedule wants")} ${cinfo.early_start}`
        : T("pinned start")));
      chart.appendChild(pin);
    }

    if (t.id === state.selected) {
      const selW = t.milestone ? h + 8 : Math.max(t.duration, 1) * ppd + 6;
      const selX = t.milestone ? x - h / 2 - 4 : x - 3;
      chart.appendChild(svg("rect", {
        class: "bar-sel", x: selX, y: y - 3, width: selW, height: h + 6,
      }));
    }
  });

  // Linha de hoje
  const tx = xOf(todayUTC()) + ppd / 2;
  chart.appendChild(svg("line", {
    class: "today-line", x1: tx, y1: 0, x2: tx, y2: totalH,
  }));
}

/* Caminho em cotovelo entre fim da predecessora e início da sucessora */
function depPath(x1, y1, x2, y2) {
  if (x2 >= x1 + 18) {
    const xm = x2 - 9;
    return `M ${x1} ${y1} H ${xm} V ${y2} H ${x2}`;
  }
  // Sucessora começa antes do fim da predecessora: contorna por baixo/cima
  const ym = y1 + (y2 > y1 ? ROW_H / 2 : -ROW_H / 2);
  return `M ${x1} ${y1} H ${x1 + 9} V ${ym} H ${x2 - 9} V ${y2} H ${x2}`;
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/* ------------------------------------------------------------------ */
/* Interação: seleção, drag para mover, drag na borda para redimensionar */
/* ------------------------------------------------------------------ */

function selectTask(id) {
  state.selected = state.selected === id ? null : id;
  renderTable();
  renderChart();
}

function attachDrag(node, task, mode) {
  node.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    // Sem preventDefault aqui: cancelar o pointerdown suprime os eventos de
    // mouse de compatibilidade, e sem mousedown o Chrome nunca produz click
    // — logo, nunca produz dblclick. O listener de dblclick lá embaixo era
    // código morto, e abrir a tarefa pela barra não funcionava (na linha da
    // tabela funcionava, porque lá ninguém cancela nada). Quem impede a
    // seleção de texto durante o arrasto é user-select:none no #chart.
    pushUndo();
    // Listeners na window: o re-render durante o arrasto destrói o nó
    // original, então não dá para depender de pointer capture nele.
    const ppd = PPD[state.zoom];
    const startX = ev.clientX;
    const origStart = task.start;
    const origDur = task.duration;
    let moved = false;

    const onMove = (mv) => {
      const deltaDays = Math.round((mv.clientX - startX) / ppd);
      if (deltaDays === 0 && !moved) return;
      moved = true;
      state.dragging = true;
      if (mode === "move") {
        task.start = fmtISO(addDays(parseDate(origStart), deltaDays));
      } else {
        task.duration = Math.max(1, origDur + deltaDays);
      }
      requestAnimationFrame(() => {
        renderChart();
        renderTable();
      });
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      state.dragging = false;
      if (moved) {
        renderAll();
        markDirty();
      }
      // Clique parado NÃO é tratado aqui. pointerup roda antes do mouseup, e
      // selecionar aqui re-renderiza: o nó que recebeu o mousedown morre no
      // meio do caminho, o par mousedown/mouseup deixa de existir no mesmo
      // elemento e o Chrome não chega a formar o click — nem, portanto, o
      // dblclick. Era por isso que abrir a tarefa pela barra não funcionava.
      // No "click" abaixo o evento já existe; re-renderizar ali é seguro,
      // e o dblclick ainda é entregue ao nó antigo (já solto da árvore),
      // que é exatamente como a linha da tabela sempre funcionou.
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  // Sem guarda de "isto foi um arrasto": um gesto que moveu passa pelo
  // renderAll() acima, que destrói este nó — o click nem chega a se formar
  // nele. Só clique parado chega aqui.
  node.addEventListener("click", () => selectTask(task.id));
  node.addEventListener("dblclick", () => openModal(task.id));
}

/* Sincroniza scroll: cabeçalho segue X, tabela segue Y */
// Roda do mouse sobre a tabela rola a lista (o scroller real é a timeline,
// que mantém os dois painéis alinhados). Só o eixo vertical é encaminhado:
// pan horizontal pertence à timeline, onde há conteúdo horizontal
document.querySelector(".task-table").addEventListener("wheel", (ev) => {
  ev.preventDefault();
  el.tlBody.scrollTop += ev.deltaY;
}, { passive: false });

// Cabeçalho e tabela são contêineres overflow:hidden rolados
// programaticamente: o conteúdo fica clipado por construção
// Espelhar a rolagem tem que ser INSTANTÂNEO: .tl-body anda com
// scroll-behavior:smooth (para o "ir para hoje" deslizar), e uma
// atribuição animada faz cada painel perseguir a posição intermediária do
// outro — os dois travam perto do início em vez de acompanhar o dedo.
// Instantâneo o eco morre no primeiro salto, porque atribuir a posição que
// o elemento já tem não dispara evento nenhum.
const mirrorX = (target, left) => target.scrollTo({ left, behavior: "instant" });

el.tlBody.addEventListener("scroll", () => {
  el.tlHead.scrollLeft = el.tlBody.scrollLeft;
  el.ttBody.scrollTop = el.tlBody.scrollTop;
  if (state.resOpen) mirrorX(el.resBody, el.tlBody.scrollLeft);
});

// A recíproca: rolar dentro do painel de recursos leva o gantt junto — as
// duas escalas são a mesma, ficarem fora de fase seria mentira visual
el.resBody.addEventListener("scroll", () => {
  mirrorX(el.tlBody, el.resBody.scrollLeft);
  el.resNames.scrollTop = el.resBody.scrollTop;
});

function scrollToToday() {
  if (!state.range) return;  // sem projeto aberto, não há timeline
  const x = xOf(todayUTC());
  el.tlBody.scrollLeft = Math.max(0, x - el.tlBody.clientWidth / 3);
}

/* ------------------------------------------------------------------ */
/* Modal de edição                                                      */
/* ------------------------------------------------------------------ */

function taskById(id) {
  return state.current?.tasks.find((t) => t.id === id) ?? null;
}

function openModal(id) {
  const t = taskById(id);
  if (!t) return;
  state.selected = id;
  // T(): o título é reescrito a cada abertura, depois de PerthI18n já ter
  // varrido o DOM — sem traduzir aqui, o cabeçalho ficava em inglês no meio
  // de um modal inteiro traduzido
  $("#modal-title").textContent = T(state.editingNew ? "New task" : "Edit task");
  $("#f-name").value = t.name;
  $("#f-assignee").value = t.assignee || "";
  $("#f-start").value = t.start;
  $("#f-duration").value = t.duration;
  $("#f-progress").value = t.progress;
  $("#f-cost").value = t.cost || 0;
  $("#f-color").value = t.color || "";
  $("#f-milestone").checked = !!t.milestone;
  $("#f-deadline").value = t.deadline || "";
  $("#f-pinned").checked = !!t.pinned;
  $("#f-optimistic").value = t.optimistic || "";
  $("#f-most-likely").value = t.most_likely || "";
  $("#f-pessimistic").value = t.pessimistic || "";

  // Lista de dependências possíveis (todas as outras tarefas)
  const deps = $("#f-deps");
  deps.innerHTML = "";
  const others = state.current.tasks.filter((o) => o.id !== id);
  if (!others.length) {
    const none = document.createElement("span");
    none.className = "none";
    none.textContent = T("No other tasks in this project.");
    deps.appendChild(none);
  }
  const depRefs = new Map((t.dependencies || []).map((d) => {
    const pd = parseDep(d);
    return [pd.id, pd];
  }));
  for (const o of others) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = o.id;
    const ref = depRefs.get(o.id);
    cb.checked = !!ref;
    if (ref && ref.type !== "FS") cb.dataset.depType = ref.type;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + o.name +
      (ref && ref.type !== "FS" ? ` (${ref.type})` : "")));
    const lag = document.createElement("input");
    lag.type = "number";
    lag.className = "dep-lag";
    lag.step = "1";
    lag.value = ref ? ref.lag : 0;
    lag.title = (window.PerthI18n ? PerthI18n.t("lag") : "lag") + " (d)";
    // Só dependência marcada é gravada: um lag digitado na linha desmarcada
    // sumia no salvamento. Digitar um lag É dizer que a dependência existe,
    // então a marca acompanha — visível e reversível, ao contrário do
    // descarte silencioso. Zero é o default de toda linha, não uma intenção.
    lag.addEventListener("input", () => {
      if (parseInt(lag.value, 10)) cb.checked = true;
    });
    label.appendChild(lag);
    deps.appendChild(label);
  }

  // Parent (WBS): qualquer tarefa que não seja marco, a própria, ou
  // descendente dela (evita ciclo). Resumos têm datas/progresso derivados.
  const psel = $("#f-parent");
  // idem título: opção criada depois da varredura do PerthI18n
  psel.innerHTML = "";
  const top = document.createElement("option");
  top.value = "";
  top.textContent = T("(top level)");
  psel.appendChild(top);
  const blocked = new Set([id, ...collectDescendants(id).map((o) => o.id)]);
  for (const o of state.current.tasks) {
    if (blocked.has(o.id) || o.milestone) continue;
    const op = document.createElement("option");
    op.value = o.id;
    op.textContent = (state.wbs?.summary.has(o.id) ? "▾ " : "") + o.name;
    psel.appendChild(op);
  }
  psel.value = t.parent && !blocked.has(t.parent) ? t.parent : "";

  syncModalLocks();
  renderPertPreview();          // depois dos locks: o botão de aplicar lê
                                // f-duration.disabled

  $("#f-notes").value = t.notes || "";
  state.modalClean = modalSnapshot();
  el.modal.hidden = false;
  $("#f-name").focus();
  $("#f-name").select();
}

/* Campos que o modal mostra mas que a tarefa não usa.
 *
 * Resumo deriva as datas dos filhos: prazo, data fixa e estimativa de três
 * pontos não fazem sentido — quem estima é quem faz o trabalho.
 *
 * Marco ocupa o próprio dia: _effdur() (schedule.jl) conta 1 e a tabela já
 * mostra "—" na coluna de duração. O campo editável convidava a digitar um
 * número que não valia nada. O valor continua guardado (campo desabilitado
 * ainda é lido no submit), então desmarcar devolve a duração de antes.
 */
function syncModalLocks() {
  const isSum = state.wbs?.summary.has(state.selected) ?? false;
  for (const fid of ["f-start", "f-duration", "f-progress", "f-milestone",
                     "f-deadline", "f-pinned",
                     "f-optimistic", "f-most-likely", "f-pessimistic"]) {
    $("#" + fid).disabled = isSum;
  }
  $("#f-duration").disabled = isSum || $("#f-milestone").checked;
  $("#f-summary-hint").hidden = !isSum;
}
$("#f-milestone").addEventListener("change", syncModalLocks);

/* Instantâneo do formulário na abertura. Esc e clique no fundo jogam fora
 * tudo o que foi digitado, e num modal de quinze campos isso não é óbvio —
 * então esses dois perguntam antes, e só quando há mesmo o que perder. O
 * botão Cancelar não pergunta: ele diz o que faz, e é a saída de quem
 * quer descartar de propósito.
 */
function modalSnapshot() {
  const v = (id) => $("#" + id).value;
  return JSON.stringify([
    v("f-name"), v("f-assignee"), v("f-parent"), v("f-start"), v("f-duration"),
    v("f-deadline"), v("f-progress"), v("f-cost"), v("f-color"), v("f-notes"),
    v("f-optimistic"), v("f-most-likely"), v("f-pessimistic"),
    $("#f-milestone").checked, $("#f-pinned").checked,
    $$("#f-deps label").map((l) => {
      const cb = l.querySelector('input[type="checkbox"]');
      return (cb ? cb.checked : false) + ":" +
             (l.querySelector(".dep-lag")?.value ?? "");
    }),
  ]);
}

/* ---------------------------------------------------------------- PERT
 *
 * Prévia ao vivo da estimativa de três pontos. A coerção repetida aqui é
 * a MESMA de _normalize_estimate! (types.jl): sem ela a prévia mentiria,
 * porque o servidor normaliza no salvamento — o otimista é o piso, e o
 * que ficou em branco vem da duração atual. te é consequência dos três
 * números, não um quarto campo: por isso é texto, e só vira botão quando
 * difere da duração que o plano usa hoje.
 */
function pertRaw() {
  const n = (id) => Math.max(0, parseInt($("#" + id).value, 10) || 0);
  return { o: n("f-optimistic"), m: n("f-most-likely"), p: n("f-pessimistic") };
}

function pertPreview() {
  const raw = pertRaw();
  if (!raw.o && !raw.m && !raw.p) return null;          // sem estimativa
  const dur = Math.max(1, parseInt($("#f-duration").value, 10) || 1);
  let m = raw.m > 0 ? raw.m : dur;
  const o = raw.o > 0 ? raw.o : m;
  m = Math.max(m, o);
  const p = Math.max(raw.p > 0 ? raw.p : m, m);
  return { o, m, p, te: (o + 4 * m + p) / 6, sd: (p - o) / 6 };
}

function renderPertPreview() {
  const out = $("#f-pert-out");
  const btn = $("#f-pert-apply");
  const e = pertPreview();
  const round1 = (x) => String(Math.round(x * 10) / 10);
  if (!e) {
    out.textContent = T("no estimate");
    out.classList.add("none");
    btn.hidden = true;
    return;
  }
  const days = Math.max(1, Math.round(e.te));
  out.classList.remove("none");
  out.textContent = `${T("expected")} ${round1(e.te)} d · σ ${round1(e.sd)}`;
  btn.hidden = $("#f-duration").disabled ||
               $("#f-milestone").checked ||
               days === (parseInt($("#f-duration").value, 10) || 0);
  btn.dataset.days = String(days);
}

for (const id of ["f-optimistic", "f-most-likely", "f-pessimistic",
                  "f-duration", "f-milestone"]) {
  $("#" + id).addEventListener("input", renderPertPreview);
}
/* Aplicar te à duração fecha o laço que existia: campo em branco vem da
 * duração atual, então mudar a duração mudava o te, e cada clique empurrava
 * o número de novo (665 / — / 6666 subia a cada clique em vez de assentar).
 * Materializar os três números resolvidos antes de escrever a duração corta
 * a realimentação — e grava exatamente o que _normalize_estimate! (types.jl)
 * gravaria no salvamento, então nada muda de sentido. Com o te já fixo, o
 * segundo clique é no-op e o botão some sozinho. */
$("#f-pert-apply").addEventListener("click", () => {
  const e = pertPreview();
  if (!e) return;
  $("#f-optimistic").value = String(e.o);
  $("#f-most-likely").value = String(e.m);
  $("#f-pessimistic").value = String(e.p);
  $("#f-duration").value = $("#f-pert-apply").dataset.days;
  renderPertPreview();
  $("#f-duration").focus();
});

function closeModal(discardNew, ask) {
  if (ask && state.modalClean !== null && state.modalClean !== modalSnapshot() &&
      !confirm(T(state.editingNew ? "Discard this new task?"
                                  : "Discard the changes to this task?"))) {
    return;
  }
  state.modalClean = null;
  if (discardNew && state.editingNew && state.selected) {
    state.current.tasks = state.current.tasks.filter((t) => t.id !== state.selected);
    state.selected = null;
    renderAll();
  }
  state.editingNew = false;
  el.modal.hidden = true;
  // Devolve o foco ao documento: sem isso o guard de "digitando" seguraria
  // os atalhos de teclado até o próximo clique
  document.activeElement?.blur?.();
}

// Campo numérico que o navegador não consegue ler ("666+6", "1e", "--3")
// vale "" em .value, com validity.badInput ligado: o texto continua na tela,
// mas todo mundo aqui lê 0 e cai no default (duração 1, custo 0, estimativa
// em branco). Sem esta guarda o salvamento engolia o que foi digitado sem
// dizer nada — mesma armadilha que fazia a prévia do PERT usar a duração no
// lugar do "mais provável". Guarda igual à do nome vazio: devolve o foco ao
// campo culpado (que a essa altura já está com a borda vermelha do :invalid)
// e não salva.
function badNumberField() {
  return ["f-duration", "f-progress", "f-cost",
          "f-optimistic", "f-most-likely", "f-pessimistic"]
    .map((id) => $("#" + id))
    .find((f) => !f.disabled && f.validity && f.validity.badInput) || null;
}

function submitModal() {
  const t = taskById(state.selected);
  if (!t) return closeModal(false);
  const name = $("#f-name").value.trim();
  if (!name) {
    $("#f-name").focus();
    return;
  }
  const bad = badNumberField();
  if (bad) {
    bad.focus();
    bad.select();
    return;
  }
  pushUndo();
  t.name = name;
  t.assignee = $("#f-assignee").value.trim();
  t.parent = $("#f-parent").value;
  if (!(state.wbs?.summary.has(t.id) ?? false)) {   // resumo: datas derivam
    t.start = $("#f-start").value || t.start;
    t.duration = Math.max(1, parseInt($("#f-duration").value, 10) || 1);
    t.progress = Math.min(100, Math.max(0, parseInt($("#f-progress").value, 10) || 0));
    t.milestone = $("#f-milestone").checked;
    t.deadline = $("#f-deadline").value || null;
    t.pinned = $("#f-pinned").checked;
    // a estimativa é gravada como foi digitada; a coerção (otimista como
    // piso, branco vindo da duração) é do servidor, em _normalize_estimate!
    const est = pertRaw();
    t.optimistic = est.o;
    t.most_likely = est.m;
    t.pessimistic = est.p;
  }
  t.color = $("#f-color").value;
  t.cost = Math.max(0, parseFloat($("#f-cost").value) || 0);
  t.dependencies = $$("#f-deps input:checked").map((cb) => {
    const lag = parseInt(cb.parentElement.querySelector(".dep-lag")?.value, 10) || 0;
    const typ = cb.dataset.depType ? cb.dataset.depType + ":" : "";
    return typ + cb.value + (lag ? (lag > 0 ? "+" : "") + lag : "");
  });
  t.notes = $("#f-notes").value;
  state.modalClean = null;
  state.editingNew = false;
  el.modal.hidden = true;
  document.activeElement?.blur?.();
  renderAll();
  markDirty();
}

/* ------------------------------------------------------------------ */
/* Overlay genérico (Activity, S-curve) — mesmo visual do modal de form  */
/* ------------------------------------------------------------------ */

function showOverlay(title, bodyEl) {
  document.getElementById("perth-overlay")?.remove();
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  back.id = "perth-overlay";
  const box = document.createElement("div");
  box.className = "modal";
  const h = document.createElement("h2");
  h.textContent = window.PerthI18n ? PerthI18n.t(title) : title;
  box.append(h, bodyEl);
  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const sp = document.createElement("span");
  sp.className = "spacer";
  const close = document.createElement("button");
  close.textContent = window.PerthI18n ? PerthI18n.t("Cancel") : "Close";
  close.addEventListener("click", () => back.remove());
  actions.append(sp, close);
  box.append(actions);
  back.append(box);
  back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
  document.body.append(back);
}

const T = (k) => (window.PerthI18n ? PerthI18n.t(k) : k);

async function showActivity() {
  const body = document.createElement("div");
  body.className = "activity-list";
  try {
    const rows = await api("/api/activity");
    if (!rows.length) body.textContent = T("no activity yet");
    for (const r of rows) {
      const line = document.createElement("div");
      line.className = "activity-row";
      line.innerHTML =
        `<span class="act-at">${escapeHTML(r.at)}</span>` +
        `<span class="act-by">${escapeHTML(r.by)}</span>` +
        `<span class="act-text">${escapeHTML(r.text)}</span>`;
      body.append(line);
    }
  } catch (err) {
    body.textContent = err.message;
  }
  showOverlay("Activity", body);
}

/* ------------------------------------------------------------------ */
/* Transmitir (share): mesmo diálogo do kanban — links da rede, QR e a  */
/* chave de ligar/desligar a transmissão sem parar o servidor           */
/* ------------------------------------------------------------------ */

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
// aba — chega como mensagem "share" pelo WS, ver onShare)
let shareBody = null;

function showShare() {
  shareBody = document.createElement("div");
  const note = document.createElement("div");
  note.className = "empty-note";
  note.textContent = T("loading…");
  shareBody.append(note);
  showOverlay("Share this project", shareBody);
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
  api("/api/share").then(renderShareBtn).catch(() => {});
}

async function toggleShare() {
  const btn = $("#share-toggle");
  try {
    const next = await api("/api/share", {
      method: "POST",
      body: JSON.stringify({ on: !btn?.classList.contains("broadcasting") }),
    });
    renderShareBtn(next);
    if (shareBody && shareBody.isConnected) renderShare(shareBody, next);
  } catch (err) {
    alert(err.message);
  }
}

function refreshShare() {
  refreshShareBtn();
  const body = shareBody;
  if (!body || !body.isConnected) return;
  api("/api/share")
    .then((info) => renderShare(body, info))
    .catch(() => { body.textContent = T("could not load share info"); });
}

// Linha da chave de acesso no diálogo de Share (só o host a vê). Aplicar
// uma chave nova derruba quem está na rede — a chave antiga passou a ser a
// errada —, e cada um é reperguntado na tela em vez de ficar com uma
// página morta; daí o aviso ao lado, e não um confirm().
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

  const apply = async (key, btn) => {
    btn.disabled = true;
    try {
      const next = await api("/api/key", {
        method: "POST", body: JSON.stringify({ key }),
      });
      renderShare(body, next);   // links e QR mudam junto com a chave
    } catch (err) {
      btn.disabled = false;
      alert(err.message);
    }
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
    : T("Without a key, anyone on the network who knows the port can open and edit these projects.");
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
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const next = await api("/api/share", {
          method: "POST", body: JSON.stringify({ on: !info.shared }),
        });
        renderShare(body, next);
        renderShareBtn(next);          // o botão da menubar acompanha
      } catch (err) {
        btn.disabled = false;
        alert(err.message);
      }
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
      ? T("Nobody else can reach this server yet — start transmitting to hand out a link.")
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
    hint.textContent = T("Tip: run `using QRCoders` before Perth.run() to get a QR code here and in the terminal.");
    body.append(hint);
  }
}

// Servidor com chave (Perth.run(key = "…")) e navegador sem ela: em vez de
// morrer com um erro na barra de status, pede a chave e refaz a carga
// inicial. Vale para o link repassado sem o ?key=, o favorito e o PWA.
function showKeyGate(note) {
  // o 403 da API e a recusa do WS chegam quase juntos: um diálogo só
  if (!note && document.getElementById("keygate-note")) return;
  const body = document.createElement("div");
  const p = document.createElement("div");
  p.className = "empty-note";
  p.id = "keygate-note";
  p.textContent = note ||
    T("These projects require an access key. Ask whoever started the server.");
  const input = document.createElement("input");
  input.type = "password";
  input.className = "keygate-input";
  input.placeholder = T("access key");
  const btn = document.createElement("button");
  btn.className = "keygate-btn";
  btn.textContent = T("enter");
  const join = async () => {
    const v = input.value.trim();
    if (!v) return;
    setAccessKey(v);
    document.getElementById("perth-overlay")?.remove();
    try {
      await bootData();
      window.PerthPresence?.reconnect();
      refreshShareBtn();
      refreshBackground();
    } catch (err) {
      isKeyError(err) ? showKeyGate(T("wrong key — try again"))
                      : bootFailed(err);
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") join();
    e.stopPropagation();   // não deixa o atalho global comer a digitação
  });
  btn.addEventListener("click", join);
  body.append(p, input, btn);
  showOverlay("Access key", body);
  setTimeout(() => input.focus(), 0);
}

// Transmissão desligada pelo host: sem retry automático (o servidor recusa
// a conexão), mas com um botão para tentar de novo quando religarem
function showShareOff() {
  const body = document.createElement("div");
  const p = document.createElement("div");
  p.className = "empty-note";
  p.textContent = T("The machine running Perth stopped transmitting these projects.");
  const btn = document.createElement("button");
  btn.className = "primary";
  btn.textContent = T("try again");
  btn.addEventListener("click", () => {
    document.getElementById("perth-overlay")?.remove();
    window.PerthPresence?.reconnect();
    poll();
  });
  body.append(p, btn);
  showOverlay("Transmission off", body);
}

async function showSCurve() {
  if (!state.current) return;
  const body = document.createElement("div");
  try {
    const d = await api(`/api/projects/${state.current.id}/scurve`);
    if (!d.dates || !d.dates.length) {
      body.textContent = "—";
    } else {
      const W = 560, H = 220, PAD = 8;
      const n = d.dates.length;
      const max = Math.max(d.total, 1);
      const x = (i) => PAD + (i / Math.max(n - 1, 1)) * (W - 2 * PAD);
      const y = (v) => H - PAD - (v / max) * (H - 2 * PAD);
      const pts = (arr) => arr.map((v, i) => `${x(i)},${y(v)}`).join(" ");
      const ti = d.dates.indexOf(d.today);
      body.innerHTML =
        `<svg class="scurve" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">` +
        (ti >= 0 ? `<line x1="${x(ti)}" y1="${PAD}" x2="${x(ti)}" y2="${H - PAD}" class="sc-today"/>` : "") +
        `<polyline class="sc-planned" points="${pts(d.planned)}"/>` +
        `<polyline class="sc-actual" points="${pts(d.actual)}"/>` +
        `</svg>` +
        `<div class="sc-legend">` +
        `<span class="sc-key planned">${T("planned")}</span>` +
        `<span class="sc-key actual">${T("actual")}</span>` +
        `<span>${T("planned to date")}: <b>${d.planned_today.toFixed(1)}</b></span>` +
        `<span>${T("earned to date")}: <b>${d.earned_today.toFixed(1)}</b></span>` +
        `<span>${T("total")}: <b>${d.total.toFixed(1)}</b></span>` +
        `</div>`;
    }
  } catch (err) {
    body.textContent = err.message;
  }
  showOverlay("S-curve", body);
}

/* ------------------------------------------------------------------ */
/* Painel de recursos: carga diária por responsável                     */
/*                                                                      */
/* Docado sob o gantt (e não num modal como a curva-S) porque o valor    */
/* está no alinhamento: cada faixa usa a MESMA escala de tempo das       */
/* barras acima, e clicar numa pessoa destaca as tarefas dela lá em      */
/* cima. As faixas vêm prontas do servidor: dia útil é assunto do        */
/* calendário do projeto, que só o motor conhece.                        */
/* ------------------------------------------------------------------ */

// Altura da faixa de cada pessoa. Espelha --res-row do CSS: a coluna de
// nomes é HTML e as faixas são SVG, e elas só ficam na mesma linha se os
// dois valores forem iguais.
const RES_ROW = 26;

// Gente em ordem alfabética (o servidor já ordena); "sem responsável" por
// último — é lacuna de planejamento, não pessoa
function resPeople() {
  const ppl = state.resources?.people ?? [];
  return [...ppl.filter((e) => e.assignee), ...ppl.filter((e) => !e.assignee)];
}

const resLabel = (e) => e.assignee || T("(unassigned)");

// O destaque que a faixa liga é o mesmo do seletor da toolbar: pessoa vira
// highlight de assignee, "sem responsável" vira o status que já existia
const resFilter = (e) => e.assignee
  ? { kind: "assignee", value: e.assignee }
  : { kind: "status", value: "unassigned" };

function resIsOn(e) {
  const h = state.highlight, w = resFilter(e);
  return !!h && h.kind === w.kind && h.value === w.value;
}

function toggleResPerson(e) {
  state.highlight = resIsOn(e) ? null : resFilter(e);
  renderHighlightSelect();
  renderTable();
  renderChart();
  renderResources();
}

async function toggleResources() {
  state.resOpen = !state.resOpen;
  el.resPane.hidden = !state.resOpen;
  if (!state.resOpen) return;
  await fetchWorkload();
  renderResources();
  el.resBody.scrollLeft = el.tlBody.scrollLeft;   // entra alinhado com o gantt
}

function renderResources() {
  if (!state.resOpen) return;
  el.resNames.innerHTML = "";
  el.resChart.innerHTML = "";
  const d = state.resources;
  const people = resPeople();
  if (!d || !d.start || !people.length) {
    const note = document.createElement("div");
    note.className = "res-empty";
    note.textContent = T("no one assigned yet");
    el.resNames.append(note);
    el.resChart.setAttribute("width", 0);
    el.resChart.setAttribute("height", 0);
    return;
  }

  const ppd = PPD[state.zoom];
  const start = parseDate(d.start);
  el.resChart.setAttribute("width", state.range.days * ppd);
  el.resChart.setAttribute("height", people.length * RES_ROW);

  people.forEach((e, r) => {
    const row = document.createElement("div");
    row.className = "res-row" + (resIsOn(e) ? " on" : "") +
      (e.assignee ? "" : " unassigned");
    row.innerHTML =
      `<span class="res-who">${escapeHTML(resLabel(e))}</span>` +
      `<span class="res-stat">${e.busy_days}d` +
      (e.over_days ? ` · <b class="res-over">${e.over_days}</b>` : "") +
      `</span>`;
    row.title = `${resLabel(e)} · ${e.busy_days} ${T("busy days")} · ` +
      `${T("peak")} ${e.peak} · ${e.total_effort.toFixed(1)} ${T("person-days")}`;
    row.addEventListener("click", () => toggleResPerson(e));
    el.resNames.append(row);

    el.resChart.appendChild(svg("line", {
      class: "row-line", x1: 0, y1: (r + 1) * RES_ROW,
      x2: state.range.days * ppd, y2: (r + 1) * RES_ROW,
    }));

    // Dias vizinhos com a mesma carga viram um bloco só: menos nós no DOM
    // e, no zoom mês, uma barra contínua em vez de uma fileira de costuras
    for (let i = 0; i < e.load.length; ) {
      const v = e.load[i];
      if (!v) { i++; continue; }
      let j = i;
      while (j + 1 < e.load.length && e.load[j + 1] === v) j++;
      const from = addDays(start, i), to = addDays(start, j);
      const cell = svg("rect", {
        class: `res-cell l${Math.min(v, 3)}` + (resIsOn(e) ? " on" : ""),
        x: xOf(from), y: r * RES_ROW + 3,
        width: Math.max((j - i + 1) * ppd, 2), height: RES_ROW - 7, rx: 3,
      });
      cell.appendChild(svgTitle(resTitle(e, from, to, v)));
      cell.addEventListener("click", () => toggleResPerson(e));
      el.resChart.appendChild(cell);
      i = j + 1;
    }
  });
}

// Tooltip do bloco: quem, quando, quantas tarefas e quais — as que
// interceptam o trecho, já que a carga é igual em todo ele
function resTitle(e, from, to, v) {
  const when = fmtISO(from) === fmtISO(to)
    ? fmtISO(from) : `${fmtISO(from)} → ${fmtISO(to)}`;
  const names = (e.tasks || [])
    .filter((t) => t.from <= fmtISO(to) && t.to >= fmtISO(from))
    .map((t) => "· " + t.name);
  return `${resLabel(e)} · ${when} · ${v} ${v > 1 ? T("tasks") : T("task")}\n` +
    names.join("\n");
}

async function exportChart() {
  if (!state.current) return;
  try {
    const res = await fetch(withKey(`/api/projects/${state.current.id}/chart?fmt=png`));
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || `HTTP ${res.status}`);
      return;
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (state.current.name || "chart") + ".png";
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    alert(err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Ações (menus, toolbar, teclado)                                      */
/* ------------------------------------------------------------------ */

function shortId() {
  return Math.random().toString(16).slice(2, 10).padEnd(8, "0");
}

function newTask() {
  if (!state.current) return;
  pushUndo();
  const t = {
    id: shortId(),
    name: "New task",
    start: fmtISO(todayUTC()),
    duration: 5,
    progress: 0,
    dependencies: [],
    color: "",
    assignee: "",
    notes: "",
    milestone: false,
    cost: 0,
    parent: "",
    baseline_start: null,
    baseline_duration: 0,
  };
  state.current.tasks.push(t);
  state.selected = t.id;
  state.editingNew = true;
  renderAll();
  openModal(t.id);
}

function deleteSelectedTask() {
  const t = taskById(state.selected);
  if (!t) return;
  if (!confirm(`Delete task “${t.name}”?`)) return;
  pushUndo();
  state.current.tasks = state.current.tasks.filter((o) => o.id !== t.id);
  for (const o of state.current.tasks) {
    o.dependencies = (o.dependencies || []).filter((d) => d !== t.id);
    if (o.parent === t.id) o.parent = t.parent;   // promove os filhos
  }
  state.selected = null;
  renderAll();
  markDirty();
}

/* Duplica a tarefa: mesma data e nome + " (copy)", então o sort por
 * (start, nome) a mantém colada ao original. Copia as dependências da
 * original (mesmas predecessoras); dependentes não são tocados. */
function collectDescendants(id) {
  const byParent = new Map();
  for (const t of state.current?.tasks ?? []) {
    if (!t.parent) continue;
    if (!byParent.has(t.parent)) byParent.set(t.parent, []);
    byParent.get(t.parent).push(t);
  }
  const out = [];
  const stack = [id];
  while (stack.length) {
    for (const c of byParent.get(stack.pop()) || []) {
      out.push(c);
      stack.push(c.id);
    }
  }
  return out;
}

function duplicateTask(id = state.selected) {
  const t = taskById(id);
  if (!t) return;
  pushUndo();
  // Resumo duplica a subárvore inteira: ids novos, pais e dependências
  // internas remapeados; dependências externas preservadas
  const subtree = [t, ...collectDescendants(t.id)];
  const remap = new Map(subtree.map((o) => [o.id, shortId()]));
  const clones = subtree.map((o) => ({
    ...o,
    id: remap.get(o.id),
    name: o.id === t.id ? o.name + " (copy)" : o.name,
    dependencies: (o.dependencies || []).map((d) => remap.get(d) ?? d),
    parent: o.id === t.id ? t.parent : (remap.get(o.parent) ?? o.parent),
  }));
  const idx = state.current.tasks.findIndex((o) => o.id === t.id);
  state.current.tasks.splice(idx + 1, 0, ...clones);
  state.selected = clones[0].id;
  renderAll();
  markDirty();
}

function setBaselineUI() {
  if (!state.current || !state.current.tasks.length) return;
  pushUndo();
  for (const t of state.current.tasks) {
    t.baseline_start = t.start;
    t.baseline_duration = t.milestone ? 1 : Math.max(t.duration, 1);
  }
  // hora LOCAL, como o set_baseline! do Julia grava (Dates.now()):
  // toISOString é UTC, e o mesmo campo ficava com dois significados
  // conforme a linha de base tivesse sido tirada na UI ou no REPL
  state.current.baseline_at =
    new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
      .toISOString().slice(0, 19);
  renderAll();
  markDirty();
  setSaveStatus("saved", "baseline set ✓");
}

function clearBaselineUI() {
  if (!state.current) return;
  if (!state.current.tasks.some((t) => t.baseline_start)) return;
  if (!confirm("Remove the baseline snapshot from every task?")) return;
  pushUndo();
  for (const t of state.current.tasks) {
    t.baseline_start = null;
    t.baseline_duration = 0;
  }
  state.current.baseline_at = null;
  if (state.highlight?.value === "slipped") state.highlight = null;
  renderAll();
  markDirty();
}

async function newProject() {
  const name = prompt("New project name:");
  if (!name || !name.trim()) return;
  const p = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: name.trim() }),
  });
  state.knownRev = await fetchRev();
  await loadProjects(p.id);
}

async function renameProject() {
  if (!state.current) return;
  const name = prompt("Rename project to:", state.current.name);
  if (!name || !name.trim()) return;
  state.current.name = name.trim();
  renderAll();
  await saveNowAfterDirty();
  await loadProjects(state.current.id);
}

async function saveNowAfterDirty() {
  state.dirty = true;
  clearTimeout(saveTimer);
  await saveNow();
}

async function deleteProject() {
  if (!state.current) return;
  if (!confirm(`Delete project “${state.current.name}” and all of its tasks?`)) return;
  await api(`/api/projects/${state.current.id}`, { method: "DELETE" });
  state.current = null;
  state.knownRev = await fetchRev();
  await loadProjects();
}

function exportProject() {
  if (!state.current) return;
  const a = document.createElement("a");
  a.href = withKey(`/api/projects/${state.current.id}/export`);
  a.download = "";
  a.click();
}

function importProject() {
  el.importFile.value = "";
  el.importFile.click();
}

el.importFile.addEventListener("change", async () => {
  const file = el.importFile.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    if (!text.trim()) throw new Error("empty file");
    // .perth.jl ou JSON legado: o servidor detecta e valida (parser restrito)
    const p = await api("/api/import", { method: "POST", body: text });
    state.knownRev = await fetchRev();
    await loadProjects(p.id);
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
});

function setZoom(z) {
  state.zoom = z;
  $$(".zoom-group button").forEach((b) =>
    b.classList.toggle("active", b.dataset.zoom === z));
  renderAll();
  scrollToToday();
}

/* ------------------------------------------------------------------ */
/* Tela inicial (dashboard de boas-vindas)                              */
/* ------------------------------------------------------------------ */

function showWelcome() {
  renderRecent();
  // "Continuar" só faz sentido quando há um projeto por trás
  el.wContinue.hidden = !state.current;
  el.welcome.hidden = false;
}

function hideWelcome() {
  el.welcome.hidden = true;
}

function renderRecent() {
  const recent = state.projects.slice(0, 5); // já vêm ordenados por updated_at
  el.wRecentWrap.hidden = recent.length === 0;
  el.wRecent.innerHTML = "";
  recent.forEach((p, i) => {
    const btn = document.createElement("button");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = p.name;
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = (p.updated_at || "").slice(0, 10);
    const key = document.createElement("kbd");
    key.textContent = String(i + 1);
    btn.append(name, when, key);
    btn.addEventListener("click", () => openProject(p.id));
    el.wRecent.appendChild(btn);
  });
}

async function autoSchedule() {
  if (!state.current) return;
  pushUndo();
  await saveNow();                       // não perder edições pendentes
  try {
    state.current = await api(`/api/projects/${state.current.id}/schedule`, {
      method: "POST",
    });
    _closeUndoEntry();   // já persistido no servidor: não passa por markDirty()
    noteBase();
    state.knownRev = await fetchRev();
    await fetchAnalytics();
    renderAll();
  } catch (err) {
    alert(`Auto-schedule failed: ${err.message}`);
  }
}

// Aplica as estimativas de três pontos: duração = te, no motor (pert!).
// Mesmo caminho do auto-schedule — o servidor decide e devolve o projeto,
// o navegador não recalcula te por conta própria.
async function applyPert() {
  if (!state.current) return;
  pushUndo();
  await saveNow();
  try {
    state.current = await api(`/api/projects/${state.current.id}/pert`, {
      method: "POST",
    });
    _closeUndoEntry();
    noteBase();
    state.knownRev = await fetchRev();
    await fetchAnalytics();
    renderAll();
  } catch (err) {
    alert(`${T("Apply PERT estimates")}: ${err.message}`);
  }
}

function toggleCritical() {
  state.showCritical = !state.showCritical;
  renderTable();
  renderChart();
}

function toggleTheme() {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("perth-theme", root.dataset.theme);
}

/* Modo apresentação: some com menubar/toolbar/tabela de tarefas e pede
   tela cheia do navegador — sobra só a timeline do gráfico. */
function enterPresentation() {
  state.presenting = true;
  document.body.classList.add("presenting");
  document.documentElement.requestFullscreen?.().catch(() => {});
  state.current && renderChart();
}

function exitPresentation() {
  state.presenting = false;
  document.body.classList.remove("presenting");
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  state.current && renderChart();
}

function togglePresentation() {
  state.presenting ? exitPresentation() : enterPresentation();
}

// Esc nativo do navegador sai da tela cheia sem passar pelo nosso handler
// de teclado — sincroniza o estado quando isso acontece (F11, gesto do SO...)
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && state.presenting) exitPresentation();
});

const ACTIONS = {
  "welcome": showWelcome,
  "close-welcome": () => state.current && hideWelcome(),
  "new-project": newProject,
  "rename-project": renameProject,
  "delete-project": deleteProject,
  "import": importProject,
  "export": exportProject,
  "new-task": newTask,
  "edit-task": () => state.selected && openModal(state.selected),
  "delete-task": deleteSelectedTask,
  "duplicate-task": () => duplicateTask(),
  "set-baseline": setBaselineUI,
  "clear-baseline": clearBaselineUI,
  "undo": undo,
  "redo": redo,
  "zoom-day": () => setZoom("day"),
  "zoom-week": () => setZoom("week"),
  "zoom-month": () => setZoom("month"),
  "goto-today": scrollToToday,
  "activity": showActivity,
  "share": showShare,
  "share-toggle": toggleShare,
  "scurve": showSCurve,
  "resources": toggleResources,
  "export-csv": () => state.current &&
    window.open(withKey(`/api/projects/${state.current.id}/export.csv`)),
  "export-ics": () => state.current &&
    window.open(withKey(`/api/projects/${state.current.id}/export.ics`)),
  "export-chart": exportChart,
  "auto-schedule": autoSchedule,
  "apply-pert": applyPert,
  "toggle-critical": toggleCritical,
  "toggle-theme": toggleTheme,
  "presentation": togglePresentation,
  "shortcuts": () => alert(
    "Shortcuts:\n\n" +
    "N — new task\nEnter / double-click — edit task\nDel — delete selected task\n" +
    "Ctrl+D — duplicate selected task\n" +
    "Ctrl+Z — undo\nCtrl+Shift+Z / Ctrl+Y — redo\n" +
    "S — auto-schedule\nC — toggle critical path\nR — resource load\nD — toggle dark mode\n" +
    "P — presentation mode\n" +
    "1 / 2 / 3 — zoom day / week / month\nT — go to today\nEsc — close / deselect / exit presentation"),
  "about": () => alert(
    "Perth — Gantt charts with a Julia backend.\n" +
    "Data lives on the local server; edit from the REPL too:\n\n" +
    '  p = project("' + (state.current?.name ?? "my project") + '")\n' +
    '  add_task!(p, "Task"; start = today(), duration = 5)'),
};

/* Menus estilo JupyterLab: clique abre, clique fora fecha */
$$(".menu").forEach((menu) => {
  menu.querySelector(".menu-title").addEventListener("click", (ev) => {
    ev.stopPropagation();
    const was = menu.classList.contains("open");
    $$(".menu").forEach((m) => m.classList.remove("open"));
    if (!was) menu.classList.add("open");
  });
});
document.addEventListener("click", () => $$(".menu").forEach((m) => m.classList.remove("open")));

document.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-action]");
  if (!btn) return;
  $$(".menu").forEach((m) => m.classList.remove("open"));
  ACTIONS[btn.dataset.action]?.();
});

$("#btn-new-task").addEventListener("click", newTask);
$("#btn-today").addEventListener("click", scrollToToday);
$$(".zoom-group button").forEach((b) =>
  b.addEventListener("click", () => setZoom(b.dataset.zoom)));

el.highlightSelect.addEventListener("change", () => {
  const v = el.highlightSelect.value;
  const i = v.indexOf(":");
  state.highlight = v ? { kind: v.slice(0, i), value: v.slice(i + 1) } : null;
  renderTable();
  renderChart();
});

el.projectSelect.addEventListener("change", () => openProject(el.projectSelect.value));

$("#modal-save").addEventListener("click", submitModal);
$("#modal-cancel").addEventListener("click", () => closeModal(true));
$("#modal-delete").addEventListener("click", () => {
  closeModal(false);
  deleteSelectedTask();
});
el.modal.addEventListener("click", (ev) => {
  if (ev.target === el.modal) closeModal(true, true);
});
el.welcome.addEventListener("click", (ev) => {
  if (ev.target === el.welcome && state.current) hideWelcome();
});

document.addEventListener("keydown", (ev) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
  if (!el.welcome.hidden) {
    if (typing) return;
    const k = ev.key.toLowerCase();
    if (k === "n") newProject();
    else if (k === "i") importProject();
    else if (k === "escape" && state.current) hideWelcome();
    else if (/^[1-5]$/.test(k)) {
      const p = state.projects[Number(k) - 1];
      if (p) openProject(p.id);
    }
    return;
  }
  if (!el.modal.hidden) {
    if (ev.key === "Escape") closeModal(true, true);
    if (ev.key === "Enter" && document.activeElement?.tagName !== "TEXTAREA") submitModal();
    return;
  }
  if (typing) return;
  // Undo / Redo globais
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z" && !ev.shiftKey) {
    ev.preventDefault();
    undo();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === "y" || (ev.key.toLowerCase() === "z" && ev.shiftKey))) {
    ev.preventDefault();
    redo();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "d") {
    ev.preventDefault();
    duplicateTask();
    return;
  }
  switch (ev.key) {
    case "n": case "N": newTask(); break;
    case "Delete": case "Backspace": deleteSelectedTask(); break;
    case "Enter": if (state.selected) openModal(state.selected); break;
    case "t": case "T": scrollToToday(); break;
    case "s": case "S": autoSchedule(); break;
    case "c": case "C": toggleCritical(); break;
    case "r": case "R": toggleResources(); break;
    case "d": case "D": toggleTheme(); break;
    case "p": case "P": togglePresentation(); break;
    case "1": setZoom("day"); break;
    case "2": setZoom("week"); break;
    case "3": setZoom("month"); break;
    case "Escape":
      if (state.presenting) { exitPresentation(); break; }
      if (chatOpen) { closeChat(); break; }
      state.selected = null; renderTable(); renderChart();
      break;
  }
});

/* Lado direito da menubar: configurações, tema, GitHub */
$("#gh-link").href = REPO_URL;
$("#brand-link").href = REPO_URL;
$("#theme-switch").addEventListener("click", toggleTheme);
$("#settings-panel").addEventListener("click", (ev) => ev.stopPropagation());

$$("#set-density button").forEach((b) =>
  b.addEventListener("click", () => {
    ui.density = b.dataset.density;
    applyUI();
    saveUI();
    state.current && renderAll();
  }));
$("#set-tablew").addEventListener("input", () => {
  ui.tableWidth = Number($("#set-tablew").value);
  applyUI();
  saveUI();
});
$("#set-weekends").addEventListener("click", () => {
  ui.weekends = !ui.weekends;
  applyUI();
  saveUI();
  state.current && renderChart();
});
$("#set-labels").addEventListener("click", () => {
  ui.labels = !ui.labels;
  applyUI();
  saveUI();
  state.current && renderChart();
});
$("#set-baseline").addEventListener("click", () => {
  ui.baseline = !ui.baseline;
  applyUI();
  saveUI();
  state.current && renderChart();
});
$("#set-hide-cursors").addEventListener("click", () => {
  ui.hideCursors = !ui.hideCursors;
  applyUI();
  saveUI();
});
$("#set-hide-bg").addEventListener("click", () => {
  ui.hideBackground = !ui.hideBackground;
  applyUI();
  saveUI();
});

/* Salva pendências ao fechar a aba */
window.addEventListener("beforeunload", () => {
  if (state.dirty && state.current) {
    navigator.sendBeacon?.(
      withKey(`/api/projects/${state.current.id}`),
      new Blob([JSON.stringify(state.current)], { type: "application/json" }));
  }
});

window.addEventListener("resize", () => state.current && renderChart());

/* ------------------------------------------------------------------ */
/* Chat geral                                                            */
/*                                                                        */
/* Painel flutuante, não-modal (fica aberto durante drag/edição, ao       */
/* contrário do modal de tarefa). Mesmo desenho do kanban                */
/* (frontend/kanban/app.js), mas sobre o canal do PerthPresence — sem     */
/* WS próprio, sem eco otimista: a mensagem só aparece quando o servidor  */
/* rebroadcasta (ver onChat/onTyping no PerthPresence.connect() abaixo).  */
/* ------------------------------------------------------------------ */

let chatOpen = false;
let chatUnseen = 0;

// widget flutuante arrastável (ver frontend/shared/draggable.js); restaura
// a posição salva na hora — não precisa esperar a primeira abertura
const chatDrag = window.PerthDraggable
  ? PerthDraggable(el.chatPanel, el.chatPanel.querySelector(".chat-head"), "perth-chat-pos")
  : null;
chatDrag?.restore();

// "alguém está digitando": sinal efêmero (não entra no histórico). Cada
// peer some da lista sozinho se não reenviar em TYPING_TTL.
const TYPING_TTL = 4000;
const typingPeers = new Map();   // peer id -> timeout handle
let lastTypingSent = 0;

function renderTyping() {
  const peers = PerthPresence ? PerthPresence.peers() : [];
  const names = [...typingPeers.keys()]
    .map((id) => peers.find((p) => p.id === id))
    .filter(Boolean)
    .map((p) => PerthPresence.labelFor(p.ip));
  el.chatTyping.hidden = !names.length;
  el.chatTyping.textContent = names.length === 0 ? "" :
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

function clearTypingByIp(ip) {
  const p = PerthPresence.peers().find((p) => p.ip === ip);
  if (!p || !typingPeers.has(p.id)) return;
  clearTimeout(typingPeers.get(p.id));
  typingPeers.delete(p.id);
  renderTyping();
}

function updateChatBadge() {
  el.chatBadge.hidden = chatUnseen === 0;
  el.chatBadge.textContent = chatUnseen > 9 ? "9+" : String(chatUnseen);
}

function chatMsgEl(e) {
  const me = PerthPresence.me();
  const mine = me && e.ip === me.ip;
  const row = document.createElement("div");
  row.className = "chat-msg" + (mine ? " mine" : "");
  row.style.setProperty("--peer", PerthPresence.colorFor(e.ip));
  const meta = document.createElement("div");
  meta.className = "chat-meta";
  const who = document.createElement("span");
  who.className = "chat-who";
  who.textContent = PerthPresence.labelFor(e.ip);
  who.title = e.ip;
  meta.append(who, " " + e.at);
  const text = document.createElement("div");
  text.className = "chat-text";
  text.textContent = e.text;
  row.append(meta, text);
  return row;
}

function appendChatMsg(e) {
  const nearBottom = el.chatLog.scrollHeight - el.chatLog.scrollTop -
                     el.chatLog.clientHeight < 60;
  el.chatLog.append(chatMsgEl(e));
  if (nearBottom) el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

function renderChat() {
  el.chatLog.textContent = "";
  const chat = PerthPresence.chat();
  if (!chat.length) {
    const p = document.createElement("div");
    p.className = "empty-note";
    p.textContent = T("No messages yet — say hi.");
    el.chatLog.append(p);
  } else {
    for (const e of chat) el.chatLog.append(chatMsgEl(e));
  }
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

function openChat() {
  chatOpen = true;
  document.body.classList.add("chat-open");
  el.chatPanel.hidden = false;
  chatUnseen = 0;
  updateChatBadge();
  renderChat();
  el.chatInput.focus();
}

function closeChat() {
  chatOpen = false;
  document.body.classList.remove("chat-open");
  el.chatPanel.hidden = true;
  for (const id of typingPeers.keys()) clearTimeout(typingPeers.get(id));
  typingPeers.clear();
}

function submitChat() {
  const v = el.chatInput.value.trim();
  if (!v) return;
  PerthPresence.sendChat(v);
  el.chatInput.value = "";
  el.chatInput.style.height = "";
  lastTypingSent = 0;   // próxima letra já reavisa, sem esperar o throttle
}

// chamados pelo PerthPresence quando "chat"/"typing" chegam pelo WS —
// ver onChat/onTyping em PerthPresence.connect() logo abaixo
function handleChatEntry(entry) {
  clearTypingByIp(entry.ip);
  if (chatOpen) {
    appendChatMsg(entry);
  } else {
    chatUnseen += 1;
    updateChatBadge();
  }
}

function handleTyping(fromId) {
  if (chatOpen) markTyping(fromId);
}

$("#chat-toggle")?.addEventListener("click", () => (chatOpen ? closeChat() : openChat()));
$("#chat-close")?.addEventListener("click", closeChat);
$("#chat-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  submitChat();
});
el.chatInput?.addEventListener("input", () => {
  el.chatInput.style.height = "auto";
  el.chatInput.style.height = Math.min(el.chatInput.scrollHeight, 120) + "px";
  const now = Date.now();
  if (el.chatInput.value.trim() && now - lastTypingSent > 2000) {
    lastTypingSent = now;
    PerthPresence.sendTyping();
  }
});
el.chatInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitChat();
  } else if (e.key === "Escape") {
    closeChat();
  }
});

/* ------------------------------------------------------------------ */
/* Inicialização                                                        */
/* ------------------------------------------------------------------ */

// Carga inicial dos dados — separada do init porque o diálogo da chave a
// refaz depois que o usuário digita a chave certa (ver showKeyGate)
async function bootData() {
  state.knownRev = await fetchRev();
  await loadProjects();
  scrollToToday();
  // Homescreen só na primeira visita (ou sem projetos): com o botão de
  // troca gantt<->kanban, reabrir a cada navegação atrapalhava o fluxo.
  // File -> Home screen continua abrindo sob demanda.
  if (!state.projects.length || !localStorage.getItem("perth-welcome-seen")) {
    showWelcome();
  }
  localStorage.setItem("perth-welcome-seen", "1");
}

function bootFailed(err) {
  console.error(err);
  const net = err instanceof TypeError && /fetch/i.test(err.message);
  el.statusLeft.textContent = net
    ? "no connection to the server — is Perth.run() active?"
    : `startup error: ${err.message}`;
}

(async function init() {
  applyUI();
  try {
    await bootData();
  } catch (err) {
    isKeyError(err) ? showKeyGate() : bootFailed(err);
  }
  setInterval(pollFallback, POLL_MS);
  renderAtMidnight();  // a linha de hoje não pode envelhecer sozinha
  refreshShareBtn();   // estado inicial do botão de transmitir da menubar
  refreshBackground(); // fundo da UI, se o REPL tiver apontado uma imagem

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => null);
  }

  // Troca gantt -> kanban na MESMA aba; se o kanban não estiver de pé,
  // pede ao servidor (mesmo processo Julia) para subi-lo e navega.
  $("#app-switch")?.addEventListener("click", async () => {
    try {
      let info = await api("/api/apps");
      if (!info.kanban) {
        info = { kanban: (await api("/api/launch/kanban", { method: "POST" })).port };
      }
      // portas são origens distintas: leva tema/idioma/nome na URL
      const prefs = new URLSearchParams();
      for (const [param, key] of [["pref-theme", "perth-theme"],
                                  ["pref-lang", "perth-lang"],
                                  ["pref-name", "perth-name"]]) {
        const v = localStorage.getItem(key);
        v && prefs.set(param, v);
      }
      const qs = prefs.toString();
      location.href = `${location.protocol}//${location.hostname}:${info.kanban}/` +
        (qs ? "?" + qs : "");
    } catch (err) {
      alert(err.message);
    }
  });

  /* ------------------------------------------------------------------ */
  /* Presença (multiplayer): cursores/IPs em tempo real, como no kanban   */
  /* ------------------------------------------------------------------ */

  /* O cursor de cada peer é publicado como âncora: linha de tarefa,
   * área da timeline (com scroll compensado) ou fração da janela. Cada
   * janela resolve a âncora na sua própria geometria, então funciona
   * com zoom/tamanhos/scrolls diferentes — mesma mecânica do kanban. */
  const tlBody = document.getElementById("tl-body");

  function captureAnchor(e) {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const row = t?.closest?.(".tt-row");
    if (row && row.dataset.id) {
      const r = row.getBoundingClientRect();
      return { kind: "row", id: row.dataset.id,
               fx: (e.clientX - r.left) / r.width,
               fy: (e.clientY - r.top) / r.height };
    }
    if (tlBody && t && tlBody.contains(t)) {
      const r = tlBody.getBoundingClientRect();
      return { kind: "tl",
               fx: (tlBody.scrollLeft + e.clientX - r.left) /
                   Math.max(tlBody.scrollWidth, 1),
               fy: (tlBody.scrollTop + e.clientY - r.top) /
                   Math.max(tlBody.scrollHeight, 1) };
    }
    return { kind: "page",
             fx: e.clientX / Math.max(window.innerWidth, 1),
             fy: e.clientY / Math.max(window.innerHeight, 1) };
  }

  function resolveAnchor(a) {
    if (!a) return null;
    if (a.kind === "row") {
      const row = document.querySelector(`.tt-row[data-id="${a.id}"]`);
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { x: r.left + a.fx * r.width, y: r.top + a.fy * r.height };
    }
    if (a.kind === "tl" && tlBody) {
      const r = tlBody.getBoundingClientRect();
      return { x: r.left - tlBody.scrollLeft + a.fx * Math.max(tlBody.scrollWidth, 1),
               y: r.top - tlBody.scrollTop + a.fy * Math.max(tlBody.scrollHeight, 1) };
    }
    if (a.kind === "page")
      return { x: a.fx * window.innerWidth, y: a.fy * window.innerHeight };
    return null;
  }

  if (window.PerthPresence) {
    PerthPresence.connect({
      captureAnchor,
      resolveAnchor,
      // o servidor avisa "rev" na hora da mudança: recarrega sem esperar
      // o próximo ciclo de polling
      onRev: () => poll(),
      onChat: handleChatEntry,
      onTyping: handleTyping,
      // a transmissão mudou: o diálogo de Share, se aberto, se redesenha
      onShare: () => refreshShare(),
      // idem para a chave (trocada pelo REPL ou por outra aba desta máquina):
      // os links do diálogo mudam junto
      onKey: () => refreshShare(),
      // o REPL trocou a imagem de fundo: aplica sem reload
      onBackground: applyBackground,
      onDenied: (reason) =>
        reason === "share_off" ? showShareOff() : showKeyGate(),
    });
    // cursores são ancorados a elementos: reancorar em scroll/resize
    tlBody?.addEventListener("scroll", PerthPresence.refreshCursors,
                             { passive: true });
    document.querySelector(".tt-body")
      ?.addEventListener("scroll", PerthPresence.refreshCursors, { passive: true });
    window.addEventListener("resize", PerthPresence.refreshCursors);
  }
})();
