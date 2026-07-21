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
  cpm: null,           // análise CPM do servidor {cycle, finish, byId: Map}
  showCritical: false,
  highlight: null,      // {kind: "assignee"|"status"|"type", value} ou null
  wbs: null,            // {kids: Map, depth: Map, summary: Set} — computado a cada render
  overalloc: { pairs: [], ids: new Set() },
  undoStack: [],       // snapshots para Ctrl+Z
  redoStack: [],       // snapshots para Ctrl+Y / Ctrl+Shift+Z
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

function pushUndo() {
  if (!state.current) return;
  const snap = _snapshot();
  if (!snap) return;
  state.undoStack.push(snap);
  state.redoStack = [];
}

function undo() {
  if (!state.undoStack.length) return;
  state.redoStack.push(_snapshot());
  _restore(state.undoStack.pop());
  renderAll();
  markDirty();
}

function redo() {
  if (!state.redoStack.length) return;
  state.undoStack.push(_snapshot());
  _restore(state.redoStack.pop());
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
};

/* ------------------------------------------------------------------ */
/* Configurações de interface (painel estilo VitePress na menubar)      */
/* ------------------------------------------------------------------ */

const UI_DEFAULTS = { density: "cozy", tableWidth: 380, weekends: true, labels: true, baseline: true };
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
    if (h.value === "overallocated") return state.overalloc.ids.has(t.id);
  }
  if (h.kind === "type") return !!t.milestone;
  return true;
}

/* ------------------------------------------------------------------ */
/* API                                                                  */
/* ------------------------------------------------------------------ */

// Chave de acesso do share (Perth.run(share=true, key=...)): vem na URL
// e é reenviada em toda chamada de API — mesmo modelo do kanban.
const ACCESS_KEY = new URLSearchParams(location.search).get("key") || "";
function withKey(path) {
  if (!ACCESS_KEY) return path;
  return path + (path.includes("?") ? "&" : "?") +
    "key=" + encodeURIComponent(ACCESS_KEY);
}

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
  await fetchCPM();
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
      byId: new Map((r.tasks || []).map((t) => [t.id, t])),
    };
  } catch {
    /* ex.: calendário de dias úteis sem BusinessDays no servidor */
  }
}

/* Salvamento: debounce do PUT do projeto inteiro */
let saveTimer = null;

function markDirty() {
  if (!state.current) return;
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
    await fetchCPM();
    renderTable();
    renderChart();
    renderStatus();
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
    empty.textContent = "no subfolders";
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

function renderAll() {
  if (!state.current) {
    el.taskRows.innerHTML = "";
    el.tlMonths.innerHTML = "";
    el.tlDays.innerHTML = "";
    el.chart.innerHTML = "";
    el.statusLeft.textContent = "no project open";
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
  if (state.overalloc.pairs.length) {
    gs.appendChild(opt("status:overallocated", "Overallocated"));
  }
  sel.appendChild(gs);
  const gt = document.createElement("optgroup");
  gt.label = "Type";
  gt.appendChild(opt("type:milestone", "Milestones"));
  sel.appendChild(gt);

  if (cur && sel.querySelector(`option[value="${CSS.escape(cur)}"]`)) {
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
    ev.preventDefault();
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
      } else {
        selectTask(task.id);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

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
el.tlBody.addEventListener("scroll", () => {
  el.tlHead.scrollLeft = el.tlBody.scrollLeft;
  el.ttBody.scrollTop = el.tlBody.scrollTop;
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
  $("#modal-title").textContent = state.editingNew ? "New task" : "Edit task";
  $("#f-name").value = t.name;
  $("#f-assignee").value = t.assignee || "";
  $("#f-start").value = t.start;
  $("#f-duration").value = t.duration;
  $("#f-progress").value = t.progress;
  $("#f-cost").value = t.cost || 0;
  $("#f-color").value = t.color || "";
  $("#f-milestone").checked = !!t.milestone;

  // Lista de dependências possíveis (todas as outras tarefas)
  const deps = $("#f-deps");
  deps.innerHTML = "";
  const others = state.current.tasks.filter((o) => o.id !== id);
  if (!others.length) {
    deps.innerHTML = '<span class="none">No other tasks in this project.</span>';
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
    label.appendChild(lag);
    deps.appendChild(label);
  }

  // Parent (WBS): qualquer tarefa que não seja marco, a própria, ou
  // descendente dela (evita ciclo). Resumos têm datas/progresso derivados.
  const psel = $("#f-parent");
  psel.innerHTML = '<option value="">(top level)</option>';
  const blocked = new Set([id, ...collectDescendants(id).map((o) => o.id)]);
  for (const o of state.current.tasks) {
    if (blocked.has(o.id) || o.milestone) continue;
    const op = document.createElement("option");
    op.value = o.id;
    op.textContent = (state.wbs?.summary.has(o.id) ? "▾ " : "") + o.name;
    psel.appendChild(op);
  }
  psel.value = t.parent && !blocked.has(t.parent) ? t.parent : "";

  const isSum = state.wbs?.summary.has(id) ?? false;
  for (const fid of ["f-start", "f-duration", "f-progress", "f-milestone"]) {
    $("#" + fid).disabled = isSum;
  }
  $("#f-summary-hint").hidden = !isSum;

  $("#f-notes").value = t.notes || "";
  el.modal.hidden = false;
  $("#f-name").focus();
  $("#f-name").select();
}

function closeModal(discardNew) {
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

function submitModal() {
  const t = taskById(state.selected);
  if (!t) return closeModal(false);
  const name = $("#f-name").value.trim();
  if (!name) {
    $("#f-name").focus();
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
  }
  t.color = $("#f-color").value;
  t.cost = Math.max(0, parseFloat($("#f-cost").value) || 0);
  t.dependencies = $$("#f-deps input:checked").map((cb) => {
    const lag = parseInt(cb.parentElement.querySelector(".dep-lag")?.value, 10) || 0;
    const typ = cb.dataset.depType ? cb.dataset.depType + ":" : "";
    return typ + cb.value + (lag ? (lag > 0 ? "+" : "") + lag : "");
  });
  t.notes = $("#f-notes").value;
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
  state.current.baseline_at = new Date().toISOString().slice(0, 19);
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
    noteBase();
    state.knownRev = await fetchRev();
    await fetchCPM();
    renderAll();
  } catch (err) {
    alert(`Auto-schedule failed: ${err.message}`);
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
  "scurve": showSCurve,
  "export-csv": () => state.current &&
    window.open(withKey(`/api/projects/${state.current.id}/export.csv`)),
  "export-chart": exportChart,
  "auto-schedule": autoSchedule,
  "toggle-critical": toggleCritical,
  "toggle-theme": toggleTheme,
  "shortcuts": () => alert(
    "Shortcuts:\n\n" +
    "N — new task\nEnter / double-click — edit task\nDel — delete selected task\n" +
    "Ctrl+D — duplicate selected task\n" +
    "Ctrl+Z — undo\nCtrl+Shift+Z / Ctrl+Y — redo\n" +
    "S — auto-schedule\nC — toggle critical path\nD — toggle dark mode\n" +
    "1 / 2 / 3 — zoom day / week / month\nT — go to today\nEsc — close / deselect"),
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
  if (ev.target === el.modal) closeModal(true);
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
    if (ev.key === "Escape") closeModal(true);
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
    case "d": case "D": toggleTheme(); break;
    case "1": setZoom("day"); break;
    case "2": setZoom("week"); break;
    case "3": setZoom("month"); break;
    case "Escape": state.selected = null; renderTable(); renderChart(); break;
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
/* Inicialização                                                        */
/* ------------------------------------------------------------------ */

(async function init() {
  applyUI();
  try {
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
  } catch (err) {
    console.error(err);
    const net = err instanceof TypeError && /fetch/i.test(err.message);
    el.statusLeft.textContent = net
      ? "no connection to the server — is Perth.run() active?"
      : `startup error: ${err.message}`;
  }
  setInterval(poll, POLL_MS);

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
    });
    // cursores são ancorados a elementos: reancorar em scroll/resize
    tlBody?.addEventListener("scroll", PerthPresence.refreshCursors,
                             { passive: true });
    document.querySelector(".tt-body")
      ?.addEventListener("scroll", PerthPresence.refreshCursors, { passive: true });
    window.addEventListener("resize", PerthPresence.refreshCursors);
  }
})();
