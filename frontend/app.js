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
// pixels por dia. "fit" não é um passo fixo: é recalculado a cada render para
// o projeto inteiro caber na largura disponível — dia/semana/mês são passos
// escolhidos a dedo, e nenhum deles serve para um plano de dois anos.
const PPD = { day: 36, week: 14, month: 5, fit: 5 };
const PPD_FIT_MIN = 0.6;   // abaixo disto o gráfico vira um traço
const PPD_FIT_MAX = 36;    // e acima, "caber" viraria zoom de dia
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
  groupBy: "",          // "" | "assignee" | "team" — raias na tabela e no gráfico
  lanesClosed: new Set(),  // chaves de raia recolhidas
  wbsClosed: new Set(),    // ids de resumo com a subárvore recolhida
  search: "",           // busca por nome de tarefa (ver matchesSearch)
  searchAt: 0,          // ocorrência atual, percorrida com Enter
  warnings: [],         // problemas do plano, vindos do servidor
  wbs: null,            // {kids: Map, depth: Map, summary: Set} — computado a cada render
  overalloc: { pairs: [], ids: new Set() },
  resources: null,      // carga por responsável vinda do servidor (workload)
  resOpen: false,       // painel de recursos docado sob o gantt
  undoStack: [],       // snapshots para Ctrl+Z
  redoStack: [],       // snapshots para Ctrl+Y / Ctrl+Shift+Z
  presenting: false,   // modo apresentação: menubar/toolbar/tabela escondidos + fullscreen
  readOnly: false,     // entrou pelo link somente-leitura (ver applyReadOnly)
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
  groupSelect: $("#group-select"),
  taskSearch: $("#task-search"),
  warningsChip: $("#warnings-chip"),
  taskSearchCount: $("#task-search-count"),
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
/* Busca sem acento e sem caixa: quem procura "escavacao" tem que achar
   "Escavação" — num projeto de 141 tarefas, exigir o acento certo é exigir
   que a pessoa já saiba onde está o que ela procura. */
const _semAcento = (s) => (s || "").normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").toLowerCase();

function matchesSearch(t) {
  if (!state.search) return true;
  return _semAcento(t.name).includes(state.search);
}

/* Uma função só decide quem fica aceso — tabela, barras e painel de recursos
   já consultam esta. Busca e destaque se somam em vez de se anular: dá para
   filtrar as tarefas da Ana E procurar "laudo" dentro delas. */
function taskMatchesHighlight(t) {
  if (!matchesSearch(t)) return false;
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
  // o que está recolhido é sobre AQUELE projeto: "Ana" fechada aqui não quer
  // dizer "Ana" fechada no projeto seguinte — e é lembrado por projeto
  restauraDobras(state.current);
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
/* Avisos do plano: ciclo de dependência, prazo estourado, tarefa vencida,
   sobrecarga e atraso contra o baseline. Nada é calculado aqui — o motor já
   sabia de tudo, só estava espalhado (o ciclo virava exceção ao reprogramar,
   o prazo virava um "+8d" na barra, a sobrecarga acendia no painel de
   recursos). O servidor reúne; aqui a gente só mostra. */
async function fetchWarnings() {
  state.warnings = [];
  if (!state.current) return;
  try {
    const r = await api(`/api/projects/${state.current.id}/warnings`);
    state.warnings = r.warnings || [];
  } catch {
    /* sem avisos é melhor que uma tela quebrada */
  }
  renderWarningsChip();
}

async function fetchAnalytics() {
  await fetchCPM();
  await fetchWarnings();
  if (state.resOpen) await fetchWorkload();
}

/* Salvamento: debounce do PUT do projeto inteiro */
let saveTimer = null;

function markDirty() {
  if (!state.current || state.readOnly) return;
  _closeUndoEntry();     // fecha o par before/after da edição que acabou de rodar
  state.dirty = true;
  setSaveStatus("saving", "saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
}

async function saveNow() {
  if (!state.current || !state.dirty) return;
  try {
    // guarda a resposta: é o projeto DEPOIS das normalizações do servidor
    // (grafia de nome, ordem das faixas, ponta invertida virada), e quem
    // editou precisa ver o que ficou gravado, não o que digitou
    const salvo = await api(`/api/projects/${state.current.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Perth-Base": state.baseUpdatedAt || "",
      },
      body: JSON.stringify(state.current),
    });
    state.current.updated_at = salvo.updated_at;
    noteBase();
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
    return salvo;
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
/* Somente-leitura                                                      */
/* ------------------------------------------------------------------ */

/* Link somente-leitura (Perth.view_key!): quem entra por ele lê tudo —
 * gráfico, tabela, análises, exports — e o servidor recusa qualquer
 * escrita com 403, inclusive a que tentasse passar pelo WebSocket. Nada
 * aqui é a autoridade: esta parte só evita oferecer o que vai falhar,
 * porque um botão que só dá erro é pior do que um botão ausente.
 *
 * A lista de ações é isso dito para o menu; canEdit() é isso dito para o
 * teclado; state.readOnly em markDirty() é a última rede — se algum gesto
 * escapar dos dois, a mudança morre no navegador em vez de virar um 403 e
 * uma tela mentindo sobre o que está gravado. */
const WRITE_ACTIONS = new Set([
  "new-project", "rename-project", "delete-project", "import",
  "people", "bands", "markers",
  "new-task", "delete-task", "duplicate-task",
  "set-baseline", "clear-baseline", "undo", "redo",
  "auto-schedule", "apply-pert",
]);

// Tentativa de edição de quem só pode olhar: recusa dizendo por quê — o
// silêncio pareceria a página travada
function canEdit() {
  if (!state.readOnly) return true;
  PerthToast.info(T("Read-only link — ask for an editing link to change anything."));
  return false;
}

function applyReadOnly(on) {
  state.readOnly = !!on;
  document.body.classList.toggle("readonly", state.readOnly);
  for (const b of $$("[data-action]")) {
    if (WRITE_ACTIONS.has(b.dataset.action)) b.hidden = state.readOnly;
  }
  $("#btn-new-task").hidden = state.readOnly;
  // o modal continua abrindo (os detalhes da tarefa são leitura, e são o que
  // não cabe na barra) — mas trancado, então o item do menu não pode seguir
  // dizendo "editar"
  const abrir = $('[data-action="edit-task"]');
  if (abrir) {
    abrir.firstChild.textContent =
      T(state.readOnly ? "View selected task" : "Edit selected task") + " ";
  }
  // o chat também é escrita (persiste e chega a todo mundo): o histórico
  // continua legível, o campo de escrever é que sai
  $("#chat-form").hidden = state.readOnly;
  // menu que ficou sem nenhum item visível não pode seguir clicável: o
  // Edit inteiro é edição, e abriria uma caixa vazia
  for (const m of $$(".menu[data-menu]")) {
    const drop = m.querySelector(".menu-drop");
    if (drop) m.hidden = state.readOnly && !drop.querySelector("button:not([hidden])");
  }
  // não há o que salvar: o lugar do "saved 14:03 ✓" diz o que esta aba é
  if (state.readOnly) setSaveStatus("readonly", T("read-only"));
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
  // o passo do "caber" depende da janela, então é aqui — depois de saber
  // quantos dias existem e antes de qualquer coisa medir a tela
  const largura = el.tlBody?.clientWidth || 0;
  if (largura > 0) {
    PPD.fit = Math.min(PPD_FIT_MAX,
                       Math.max(PPD_FIT_MIN, largura / state.range.days));
  }
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
/* Irmãos na ordem em que aparecem: primeiro os que alguém posicionou à mão
 * (order 1, 2, 3, …), depois o resto pela data e pelo nome. É a MESMA regra
 * do servidor (ordered_tasks, em wbs.jl); as duas discordarem seria a lista
 * mudar de ordem sozinha no primeiro F5. order 0/ausente = sem posição, e
 * "sem posição" vai para o fim — na frente, toda tarefa nova entraria
 * furando a fila de um grupo já arrumado. */
function cmpIrmaos(a, b) {
  const oa = a.order || Infinity;
  const ob = b.order || Infinity;
  if (oa !== ob) return oa - ob;
  if (a.start !== b.start) return a.start < b.start ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/* Renumera o grupo de irmãos de `t` (1, 2, 3, …) com `t` na posição pedida
 * (null = por último). Espelha _reorder_siblings! do servidor: numeração
 * fechada, sem buracos, e nunca meio grupo à mão e meio pela data. */
function reorderSiblings(t, position) {
  const pai = t.parent || "";
  const irmaos = state.current.tasks
    .filter((o) => (o.parent || "") === pai)
    .sort(cmpIrmaos)
    .filter((o) => o.id !== t.id);
  const pos = position == null ? irmaos.length + 1
                               : Math.min(Math.max(position, 1), irmaos.length + 1);
  irmaos.splice(pos - 1, 0, t);
  irmaos.forEach((o, k) => { o.order = k + 1; });
}

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
    ts.sort(cmpIrmaos);
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

  // Dias ou semanas — pelo espaço que existe, não pelo nome do zoom: no
  // "caber" o passo é calculado, e uma régua de dias com 2px por dia é uma
  // faixa preta
  const today = todayUTC();
  if (ppd >= 20) {
    for (let i = 0; i < days; i++) {
      const dt = addDays(start, i);
      const cell = document.createElement("div");
      cell.className = "tl-cell";
      // a coluna diz que dia ela é: régua auto-descritiva, e o duplo clique
      // que marca o dia não precisa ser conferido por aritmética de pixel
      cell.dataset.date = fmtISO(dt);
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
      cell.dataset.date = fmtISO(w);   // primeiro dia da semana da coluna
      cell.style.left = xOf(w) + "px";
      cell.style.width = 7 * ppd + "px";
      // data curta quando cabe; só o número do dia quando não cabe
      cell.textContent = ppd >= 8 ? fmtShort(fmtISO(w)) : String(w.getUTCDate());
      el.tlDays.appendChild(cell);
    }
  }
}

/* A ficha cadastrada de um nome de responsável (ou null). */
function personOf(nome) {
  const k = (nome || "").trim().toLowerCase();
  if (!k) return null;
  return (state.current?.people || [])
    .find((pe) => pe.name.toLowerCase() === k) || null;
}

function laneKeyOf(t) {
  if (state.groupBy === "team") return (personOf(t.assignee)?.team || "").trim();
  return (t.assignee || "").trim();
}

const laneLabel = (chave) => chave ||
  T(state.groupBy === "team" ? "(no team)" : "(unassigned)");

/* As linhas da tela. A tabela e o gráfico percorrem ESTA lista, na mesma
   ordem — as duas metades são um só desenho, e um índice fora de sincronia
   desalinha o nome da barra.

   Sem agrupamento, é a ordem do projeto e nada mais. Com raias, resumos de
   WBS ficam de fora: um resumo é o colchete de filhos que podem ser de gente
   diferente, e pendurá-lo na raia de alguém diria que aquela pessoa é dona do
   bloco inteiro. O motor de CPM já os trata assim — agenda folhas, resumos
   são recipientes. */
/* Um resumo recolhido esconde a subárvore inteira, não só os filhos diretos:
   recolher "Estrutura" e continuar vendo os netos seria recolher pela
   metade. O colchete dele no gráfico já resume o período dos filhos, então o
   que sobra na tela continua dizendo quando o bloco acontece. */
function hiddenByCollapse(t, byId) {
  let pai = t.parent;
  while (pai) {
    if (state.wbsClosed.has(pai)) return true;
    pai = byId.get(pai)?.parent || "";
  }
  return false;
}

function displayRows() {
  const tasks = state.current?.tasks || [];
  if (!state.groupBy) {
    if (!state.wbsClosed.size) return tasks.map((task) => ({ kind: "task", task }));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return tasks.filter((t) => !hiddenByCollapse(t, byId))
                .map((task) => ({ kind: "task", task }));
  }

  const raias = new Map();
  for (const t of tasks) {
    if (state.wbs?.summary.has(t.id)) continue;
    const k = laneKeyOf(t);
    if (!raias.has(k)) raias.set(k, []);
    raias.get(k).push(t);
  }
  // sem dono por último: é uma pendência, não uma pessoa — mesmo motivo de
  // ela ficar no pé do painel de recursos
  const chaves = [...raias.keys()].sort((a, b) =>
    !a ? 1 : !b ? -1 : a.localeCompare(b));

  const rows = [];
  for (const key of chaves) {
    const tarefas = raias.get(key);
    const closed = state.lanesClosed.has(key);
    rows.push({ kind: "lane", key, tasks: tarefas, closed });
    if (!closed) for (const task of tarefas) rows.push({ kind: "task", task });
  }
  return rows;
}

function toggleLane(key) {
  state.lanesClosed.has(key) ? state.lanesClosed.delete(key)
                             : state.lanesClosed.add(key);
  gravaDobras();
  renderTable();
  renderChart();
}

function renderTable() {
  el.taskRows.innerHTML = "";
  let n = 0;
  for (const row of displayRows()) {
    el.taskRows.appendChild(row.kind === "lane" ? laneRow(row)
                                                : taskRow(row.task, ++n));
  }
}

/* Cabeçalho de raia: quem é, o que faz, quantas tarefas. A linha inteira
   recolhe a raia — o alvo é o nome, não uma seta de 10px. */
function laneRow(row) {
  const div = document.createElement("div");
  div.className = "tt-lane" + (row.closed ? " closed" : "");
  div.dataset.lane = row.key;
  const pe = state.groupBy === "assignee" ? personOf(row.key) : null;
  const legenda = pe ? [pe.role, pe.team].filter(Boolean).join(" · ") : "";
  div.innerHTML = `
    <span class="lane-mark">${row.closed ? "▸" : "▾"}</span>
    <span class="lane-name">${escapeHTML(laneLabel(row.key))}</span>
    <span class="lane-role">${escapeHTML(legenda)}</span>
    <span class="lane-count">${row.tasks.length}</span>`;
  div.addEventListener("click", () => toggleLane(row.key));
  return div;
}

function taskRow(t, seq) {
  const row = document.createElement("div");
  const info = state.cpm?.byId.get(t.id);
  const crit = state.showCritical && info?.critical;
  // dentro de uma raia a hierarquia não vale: o pai pode estar em outra
  // raia, e o recuo apontaria para uma linha que não está ali
  const depth = state.groupBy ? 0 : (state.wbs?.depth.get(t.id) ?? 0);
  const isSum = state.wbs?.summary.has(t.id) ?? false;
  const fechado = state.wbsClosed.has(t.id);
  row.className = "tt-row" + (t.id === state.selected ? " selected" : "")
    + (crit ? " critical" : "")
    + (isSum ? " summary" : "")
    + (taskMatchesHighlight(t) ? "" : " dim");
  if (state.showCritical && info) row.title = `slack: ${info.slack_days}d`;
  row.dataset.id = t.id;
  row.innerHTML = `
    <span class="c-seq" title="id: ${escapeHTML(t.id)}">${seq}</span>
    <span class="c-name" style="padding-left:${depth * 14}px">${isSum ? `<button type="button" class="sum-mark" title="${T(fechado ? "Expand" : "Collapse")}">${fechado ? "▸" : "▾"}</button>` : t.milestone ? '<span class="ms">◆</span>' : ""}${escapeHTML(t.name)}${(t.notes || "").trim() ? '<span class="note-mark" title="has notes"></span>' : ""}</span>
    <span class="c-date">${t.start}</span>
    <span class="c-num">${t.milestone ? "—" : t.duration + "d"}</span>
    <span class="c-num">${t.progress}</span>`;
  row.addEventListener("click", () => selectTask(t.id));
  row.addEventListener("dblclick", () => openModal(t.id));
  attachRowDrag(row, t);
  // o ▾ recolhe a subárvore e NÃO seleciona: clique na seta é sobre a
  // árvore, clique na linha é sobre a tarefa
  const marca = row.querySelector(".note-mark");
  if (marca) {
    marca.addEventListener("pointerenter", () => abreNota(t, marca));
    marca.addEventListener("pointerleave", fechaNotaDepois);
    marca.addEventListener("click", (ev) => {
      ev.stopPropagation();
      abreNota(t, marca, { fixo: true });
    });
  }
  row.querySelector(".sum-mark")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleSummary(t.id);
  });
  return row;
}

/* ------------------------------------------------------------------ */
/* Arrastar a linha: a ordem que a mão escolhe                          */
/* ------------------------------------------------------------------ */

/* A ordem das linhas sempre foi derivada — filhos sob o pai, irmãos pela
 * data — e é uma boa ordem até o dia em que três tarefas começam no mesmo
 * dia e a sequência da obra não é a ordem alfabética. `order` é o que a mão
 * diz; quem nunca arrastou nada segue vendo o plano pela data (ver
 * cmpIrmaos e ordered_tasks, no servidor).
 *
 * Um gesto, dois destinos, decididos por ONDE se solta:
 *   - no vão entre duas linhas  -> nova posição, no nível da linha de cima
 *   - em cima de uma linha      -> vira subtarefa dela (WBS)
 * É a convenção de qualquer árvore de arquivos, e poupa um segundo gesto
 * para o que, na cabeça de quem arrasta, já é um só: "põe isto ali".
 *
 * O arrasto começa depois de alguns pixels: sem essa folga, todo clique de
 * seleção seria um arrasto de zero pixel e a lista tremeria a cada toque. */
const ROW_DRAG_MIN = 4;

function attachRowDrag(row, t) {
  row.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || state.readOnly) return;
    if (ev.target.closest(".sum-mark")) return;   // a seta é sobre a árvore
    const y0 = ev.clientY;
    let vivo = false;
    let alvo = null;

    const fim = () => {
      window.removeEventListener("pointermove", mover);
      window.removeEventListener("pointerup", soltar);
      state.dragging = false;
      row.classList.remove("row-dragging");
      document.body.classList.remove("row-dragging");
      limpaAlvo();
    };

    const mover = (mv) => {
      if (!vivo) {
        if (Math.abs(mv.clientY - y0) < ROW_DRAG_MIN) return;
        // Em raias, o vão entre duas linhas não tem nível: a de cima pode
        // ser de outro ramo da WBS, e "põe isto ali" passaria a significar
        // um pai que ninguém apontou. Melhor recusar dizendo por quê.
        if (state.groupBy) {
          PerthToast.info(T("Turn lanes off to reorder tasks by hand."));
          fim();
          return;
        }
        vivo = true;
        state.dragging = true;
        row.classList.add("row-dragging");
        document.body.classList.add("row-dragging");
      }
      alvo = alvoDoArrasto(t, mv.clientY);
      pintaAlvo(alvo);
      rolaNaBorda(mv.clientY);
    };

    const soltar = () => {
      const destino = vivo ? alvo : null;
      fim();
      destino && aplicaArrasto(t, destino);
    };

    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", soltar);
  });
}

// Tarefas visíveis, na ordem da tela — a mesma lista que virou linhas
const linhasVisiveis = () =>
  displayRows().filter((r) => r.kind === "task").map((r) => r.task);

/* Onde o ponteiro está querendo soltar. Terço do meio de uma linha = dentro
 * dela; o resto = o vão de cima ou o de baixo. Alvo proibido (a própria
 * tarefa, um descendente dela, um marco) não vira destino: o gesto fica sem
 * marca nenhuma, que é a forma de dizer "aqui não" antes de soltar. */
function alvoDoArrasto(t, clientY) {
  const nos = [...el.taskRows.querySelectorAll(".tt-row")];
  if (!nos.length) return null;
  let i = nos.findIndex((n) => clientY < n.getBoundingClientRect().bottom);
  if (i === -1) i = nos.length - 1;
  const no = nos[i];
  const r = no.getBoundingClientRect();
  const frac = (clientY - r.top) / r.height;
  const id = no.dataset.id;
  const proibidos = idsProibidos(t);

  if (frac > 0.3 && frac < 0.7) {
    const alvo = taskById(id);
    if (alvo && !alvo.milestone && !proibidos.has(id)) {
      return { modo: "dentro", parent: id, position: null, no };
    }
  }
  const depois = frac >= 0.5;
  const vao = vaoDoArrasto(t, i + (depois ? 1 : 0), proibidos);
  return vao && { ...vao, no, depois };
}

// A própria tarefa e sua subárvore: nenhuma das duas pode receber o que
// está sendo arrastado (seria a tarefa dentro de si mesma)
function idsProibidos(t) {
  return new Set([t.id, ...collectDescendants(t.id).map((o) => o.id)]);
}

/* Vão nº `indice` (antes da linha visível de mesmo índice) -> pai e posição.
 * O nível é o da linha de CIMA: soltar logo abaixo de um resumo aberto põe
 * a tarefa como primeira filha dele; abaixo de qualquer outra linha, como
 * irmã dela. É o que o olho já lê na indentação. */
function vaoDoArrasto(t, indice, proibidos) {
  const vis = linhasVisiveis();
  const acima = vis[indice - 1] || null;
  let parent;
  if (!acima) {
    parent = vis.length ? (vis[0].parent || "") : "";
  } else if (state.wbs?.summary.has(acima.id) && !state.wbsClosed.has(acima.id)) {
    parent = acima.id;              // resumo aberto: o vão logo abaixo é dentro dele
  } else {
    parent = acima.parent || "";
  }
  if (proibidos.has(parent)) return null;
  const paiT = parent ? taskById(parent) : null;
  if (parent && (!paiT || paiT.milestone)) return null;

  let position = 1;
  for (let k = 0; k < indice; k++) {
    const o = vis[k];
    if (o.id === t.id) continue;
    if ((o.parent || "") === parent) position++;
  }
  return { modo: "vao", parent, position };
}

function pintaAlvo(alvo) {
  limpaAlvo();
  if (!alvo) return;
  if (alvo.modo === "dentro") {
    alvo.no.classList.add("drop-inside");
    return;
  }
  const marca = document.createElement("div");
  marca.className = "row-drop";
  marca.style.top = (alvo.no.offsetTop + (alvo.depois ? alvo.no.offsetHeight : 0)) + "px";
  el.taskRows.appendChild(marca);
}

function limpaAlvo() {
  el.taskRows.querySelector(".row-drop")?.remove();
  el.taskRows.querySelector(".drop-inside")?.classList.remove("drop-inside");
}

// Arrastar até a beirada rola a lista: num plano de cem tarefas, subir uma
// linha do fim para o começo não pode exigir soltar no meio do caminho.
// O scroller de verdade é a timeline; a tabela segue por espelho.
function rolaNaBorda(clientY) {
  const r = el.taskRows.getBoundingClientRect();
  const margem = 26;
  if (clientY < r.top + margem) el.tlBody.scrollTop -= 12;
  else if (clientY > r.bottom - margem) el.tlBody.scrollTop += 12;
}

function aplicaArrasto(t, destino) {
  const paiAntes = t.parent || "";
  const irmaosAntes = state.current.tasks
    .filter((o) => (o.parent || "") === paiAntes).sort(cmpIrmaos);
  const posAntes = irmaosAntes.findIndex((o) => o.id === t.id) + 1;
  // soltar no mesmo lugar não é uma edição: sem isto, todo arrasto que
  // desiste no meio do caminho gravaria o projeto e queimaria um desfazer
  if (destino.parent === paiAntes &&
      (destino.position === null ? posAntes === irmaosAntes.length
                                 : destino.position === posAntes)) return;
  pushUndo();
  t.parent = destino.parent;
  reorderSiblings(t, destino.position);
  // selecionada depois de solta: a linha andou, e o olho precisa achá-la
  // de novo (selectTask alterna, e aqui a intenção é sempre selecionar)
  state.selected = t.id;
  renderAll();
  markDirty();
}

function toggleSummary(id) {
  state.wbsClosed.has(id) ? state.wbsClosed.delete(id) : state.wbsClosed.add(id);
  gravaDobras();
  renderTable();
  renderChart();
}

/* ------------------------------------------------------------------ */
/* A nota da tarefa                                                     */
/* ------------------------------------------------------------------ */

/* O pontinho vermelho dizia "esta tarefa tem anotação" e o texto vinha num
 * tooltip nativo do navegador: sem formatação, sem quebra de linha decente,
 * e some se o ponteiro tremer. Agora o ponto ABRE a nota, num balão de HTML
 * — que é o que permite escrever `*urgente*`, `` `NBR 6118` `` ou um link e
 * ver isso renderizado (mesmo subconjunto do card do kanban, ver
 * shared/inline.js).
 *
 * A nota é PROSA de quem escreveu, e é o único campo de texto do Perth que
 * não viaja como identificador: o nome da tarefa ordena, é buscado e sai em
 * CSV, iCalendar e .perth.jl, e markdown ali vazaria como pontuação em todos
 * esses lugares. Por isso a formatação para aqui. */
function pontoDeNota(chart, t, dim, cx, cy) {
  const ponto = svg("circle", { class: "note-dot" + dim, cx, cy, r: 3.2 });
  ponto.addEventListener("pointerenter", () => abreNota(t, ponto));
  ponto.addEventListener("pointerleave", fechaNotaDepois);
  ponto.addEventListener("click", (ev) => {
    ev.stopPropagation();          // ver a nota não é selecionar a tarefa
    abreNota(t, ponto, { fixo: true });
  });
  chart.appendChild(ponto);
  return ponto;
}

let notaAberta = null;
let notaTimer = null;

function abreNota(t, alvo, { fixo = false } = {}) {
  clearTimeout(notaTimer);
  fechaNota();
  const balao = document.createElement("div");
  balao.className = "note-pop";
  balao.id = "note-pop";
  const titulo = document.createElement("div");
  titulo.className = "note-pop-task";
  titulo.textContent = t.name;
  const corpo = document.createElement("div");
  corpo.className = "note-pop-text";
  PerthInline.render(corpo, t.notes, { linkClass: "note-link" });
  balao.append(titulo, corpo);
  // o balão vive fora do SVG: HTML dentro de <svg> só com <foreignObject>,
  // que traz mais problema (recorte, foco, impressão) do que resolve
  document.body.append(balao);
  balao.addEventListener("pointerenter", () => clearTimeout(notaTimer));
  balao.addEventListener("pointerleave", fechaNotaDepois);

  const r = alvo.getBoundingClientRect();
  const larg = balao.offsetWidth;
  const alt = balao.offsetHeight;
  // encosta na borda da janela em vez de sair dela: nota que só se lê rolando
  // a página não é nota
  const left = Math.min(Math.max(8, r.left + r.width / 2 - larg / 2),
                        window.innerWidth - larg - 8);
  const acima = r.top - alt - 8;
  balao.style.left = left + "px";
  balao.style.top = (acima > 8 ? acima : r.bottom + 8) + "px";
  balao.classList.toggle("abaixo", acima <= 8);
  notaAberta = { fixo };
}

function fechaNota() {
  document.getElementById("note-pop")?.remove();
  notaAberta = null;
}

// some com folga: sair do ponto e entrar no balão passa por um vão de pixels,
// e fechar nesse vão tornaria o link de dentro impossível de clicar
function fechaNotaDepois() {
  clearTimeout(notaTimer);
  notaTimer = setTimeout(() => {
    if (!notaAberta?.fixo) fechaNota();
  }, 220);
}

/* ------------------------------------------------------------------ */
/* Andar pelo plano com o teclado                                       */
/* ------------------------------------------------------------------ */

/* A seleção já existia — clique, busca, aviso —, mas só o mouse a movia. E
 * mover a seleção é a coisa que mais se faz num plano grande.
 *
 * As setas seguem a convenção de árvore de arquivos, que é o que o olho já
 * espera de uma lista com triângulos: ↑/↓ andam nas linhas VISÍVEIS (uma fase
 * recolhida conta como uma linha, não como as vinte que ela esconde), ← fecha
 * o resumo — e, numa folha, sobe para o pai — e → abre. Home/End vão às
 * pontas; PageUp/PageDown andam uma tela.
 *
 * Quem rola até a linha é revealTask: ele já abre o que está fechado no
 * caminho e só mexe no eixo horizontal quando a barra saiu de vista. Navegar
 * não é editar, então isto vale igual no link somente-leitura. */
function navegarComTeclado(ev) {
  if (!state.current || ev.ctrlKey || ev.metaKey || ev.altKey) return false;
  const linhas = displayRows().filter((r) => r.kind === "task").map((r) => r.task);
  if (!linhas.length) return false;
  const i = linhas.findIndex((t) => t.id === state.selected);
  const porTela = Math.max(1, Math.floor(el.tlBody.clientHeight / ROW_H) - 1);
  const ir = (k) => {
    const alvo = linhas[Math.min(Math.max(k, 0), linhas.length - 1)];
    if (!alvo) return false;
    revealTask(alvo.id);
    return true;
  };
  const atual = i < 0 ? null : linhas[i];
  const eResumo = (t) => !state.groupBy && (state.wbs?.summary.has(t.id) ?? false);

  switch (ev.key) {
    // sem nada selecionado, ↓ começa do topo e ↑ do fim — a tecla diz de que
    // lado da lista se está entrando
    case "ArrowDown":  return ir(i < 0 ? 0 : i + 1);
    case "ArrowUp":    return ir(i < 0 ? linhas.length - 1 : i - 1);
    case "PageDown":   return ir(i < 0 ? 0 : i + porTela);
    case "PageUp":     return ir(i < 0 ? linhas.length - 1 : i - porTela);
    case "Home":       return ir(0);
    case "End":        return ir(linhas.length - 1);
    case "ArrowRight":
      if (!atual || !eResumo(atual) || !state.wbsClosed.has(atual.id)) return false;
      toggleSummary(atual.id);
      return true;
    case "ArrowLeft":
      if (!atual) return false;
      if (eResumo(atual) && !state.wbsClosed.has(atual.id)) {
        toggleSummary(atual.id);
        return true;
      }
      // folha (ou resumo já fechado): sobe um nível, como em qualquer árvore
      if (!state.groupBy && atual.parent) {
        revealTask(atual.parent);
        return true;
      }
      return false;
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ */
/* O que está dobrado é lembrado                                        */
/* ------------------------------------------------------------------ */

/* Recolher as fases É o modo de trabalhar num plano de cento e poucas
 * tarefas — e isso se perdia a cada F5, a cada ida ao kanban e volta, a cada
 * troca de projeto. Vai para o localStorage como o zoom, o tema e as raias:
 * é preferência de quem olha, não dado do plano, e por isso não entra no
 * projeto nem viaja para as outras máquinas.
 *
 * Uma chave por projeto: "Ana" fechada aqui não quer dizer "Ana" fechada no
 * projeto seguinte. */
const chaveDobras = (id) => "perth-folds-" + id;

function gravaDobras() {
  if (!state.current) return;
  const dados = { wbs: [...state.wbsClosed], lanes: [...state.lanesClosed] };
  try {
    if (!dados.wbs.length && !dados.lanes.length) {
      localStorage.removeItem(chaveDobras(state.current.id));
    } else {
      localStorage.setItem(chaveDobras(state.current.id), JSON.stringify(dados));
    }
  } catch {
    /* cota cheia ou armazenamento bloqueado: dobrar continua funcionando,
       só não sobrevive ao reload — não é motivo para derrubar a tela */
  }
}

function restauraDobras(p) {
  state.wbsClosed.clear();
  state.lanesClosed.clear();
  if (!p) return;
  let dados = null;
  try {
    dados = JSON.parse(localStorage.getItem(chaveDobras(p.id)) || "null");
  } catch {
    dados = null;
  }
  if (!dados) return;
  // id que não existe mais é descartado: um resumo apagado não pode continuar
  // dobrando nada, e sem a poda a chave cresceria para sempre
  const ids = new Set(p.tasks.map((t) => t.id));
  for (const id of dados.wbs || []) if (ids.has(id)) state.wbsClosed.add(id);
  for (const k of dados.lanes || []) state.lanesClosed.add(k);
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
  const rows = displayRows();
  // cor por posição no PROJETO, não na tela: agrupar em raias não pode
  // repintar as barras, senão a mesma tarefa muda de cor ao ligar a raia
  const corDe = new Map(state.current.tasks.map((t, i) => [t.id, i]));
  const totalW = days * ppd;
  const totalH = Math.max(rows.length * ROW_H + 40, el.tlBody.clientHeight);

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

  /* Faixas nomeadas do calendário (sprint, parada, chuvas). Vêm antes da
     grade e das barras porque são fundo: sombrear é dizer "este trecho é
     diferente", não competir com o trabalho desenhado em cima. */
  const faixasVisiveis = [];
  (state.current.bands || []).forEach((f, i) => {
    const x0 = Math.max(xOf(parseDate(f.from)), 0);
    const x1 = Math.min(xOf(parseDate(f.to)) + ppd, totalW);
    if (x1 <= x0) return;   // faixa inteira fora da janela desenhada
    const cor = f.color || AUTO_COLORS[i % AUTO_COLORS.length];
    chart.appendChild(svg("rect", {
      class: "cal-band", x: x0, y: 0, width: x1 - x0, height: totalH,
      fill: cor,
    }));
    faixasVisiveis.push({ nome: f.name, x0, cor });
  });
  /* A borda e o nome deitado da faixa saem daqui: os dois precisam saber
     onde os rótulos das tarefas ficaram, e isso só se sabe depois de
     desenhá-los. A camada entra agora, no lugar certo da pilha (fundo), e é
     preenchida lá embaixo. */
  const camadaFaixas = svg("g", { class: "band-layer" });
  chart.appendChild(camadaFaixas);

  // Grade vertical: dias quando cabem, senão segundas-feiras
  if (ppd >= 20) {
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
  for (let r = 1; r <= rows.length; r++) {
    chart.appendChild(svg("line", {
      class: "row-line", x1: 0, y1: r * ROW_H, x2: totalW, y2: r * ROW_H,
    }));
  }

  /* Setas de dependência: a camada entra aqui, por baixo das barras, mas é
     PREENCHIDA depois delas (ver mais abaixo). A ordem no documento é o que
     decide o que fica por cima no SVG; o conteúdo pode chegar quando quiser,
     e o desenho da seta precisa saber onde os rótulos das barras ficaram
     para desviar deles. */
  const camadaDeps = svg("g", { class: "dep-layer" });
  chart.appendChild(camadaDeps);
  // Retângulos que os nomes das barras ocupam — preenchido no laço das
  // barras, consumido pelas setas e pelas linhas verticais
  const caixasRotulo = [];
  // e os que o DESENHO ocupa (barra, marco, colchete, fantasma): as linhas
  // podem cruzar isto — atravessar uma barra é o que uma linha de referência
  // faz —, mas um nome deitado não pode pousar em cima
  const caixasForma = [];

  // Barras e marcos
  rows.forEach((row, i) => {
    if (row.kind === "lane") { drawLane(chart, row, i, totalW, ppd); return; }
    const t = row.task;
    const y = i * ROW_H + 6;
    const h = ROW_H - 12;
    const color = t.color || AUTO_COLORS[corDe.get(t.id) % AUTO_COLORS.length];
    const x = xOf(parseDate(t.start));
    const dim = taskMatchesHighlight(t) ? "" : " dim";
    const hasNotes = (t.notes || "").trim().length > 0;
    const isSum = state.wbs?.summary.has(t.id) ?? false;
    const slip = !isSum && !t.milestone ? slipDays(t) : 0;
    const escolhida = t.id === state.selected;
    // afastamento do nome: cede lugar ao ponto de ligar quando ele existe
    const folga = escolhida ? ESPACO_PONTO : 0;

    /* Barra-fantasma do baseline (plano original), rente à base da linha.
     *
     * De quem é este fantasma? Ele mora na linha da tarefa, mas quando ela
     * andou muito ele aparece longe da barra — e aí "mesma linha" vira
     * palpite, ainda mais com as linhas vizinhas cheias. Duas respostas, cada
     * uma no momento em que a pergunta aparece, e nenhuma delas desenhando
     * nada a mais no estado de repouso: o mouse em cima diz o nome e as datas
     * prometidas; selecionar a tarefa acende o fantasma e liga os dois com um
     * tracinho, que de quebra é a derrapagem desenhada em tamanho real.
     */
    if (ui.baseline && t.baseline_start && !isSum && !t.milestone) {
      const bx = xOf(parseDate(t.baseline_start));
      const bw = Math.max(t.baseline_duration, 1) * ppd;
      const gy = i * ROW_H + ROW_H - 9;
      caixasForma.push({ x0: bx, x1: bx + bw, y0: gy, y1: gy + 4 });
      chart.appendChild(svg("rect", {
        class: "baseline-ghost" + dim + (escolhida ? " sel" : ""),
        x: bx, y: gy, width: bw, height: 4, rx: 2,
      }));
      // Alvo de mouse próprio, como o das setas: 4px de altura não se acerta.
      // Vai ANTES da barra, que é desenhada depois e fica por cima — onde os
      // dois se sobrepõem quem manda é a barra, com o arrasto dela intacto.
      const alvo = svg("rect", {
        class: "baseline-hit", x: bx, y: gy, width: bw, height: 9,
      });
      alvo.appendChild(svgTitle(
        `${T("Baseline")} · ${t.name}\n` +
        `${t.baseline_start} → ${fmtISO(baselineEnd(t))}` +
        (slip > 0 ? `\n${slip} d · ${T("behind the baseline")}` : "")));
      chart.appendChild(alvo);
      if (escolhida && Math.abs(bx - x) > 1) {
        chart.appendChild(svg("line", {
          class: "baseline-link",
          x1: Math.min(bx, x), y1: gy + 2, x2: Math.max(bx, x), y2: gy + 2,
        }));
      }
    }

    if (isSum) {
      /* Colchete de resumo: trilho arredondado + presilhas nas pontas.
         Antes era um polígono chapado na cor do texto, e um bloco preto no
         meio de barras pastel puxava o olho para o recipiente em vez do
         trabalho. Agora o traço é neutro e fino — e o pedaço cheio é o
         progresso que já sobe dos filhos, que estava sendo jogado fora: o
         resumo tem esse número e não o mostrava em lugar nenhum do gráfico. */
      const w = Math.max(t.duration, 1) * ppd;
      const alt = 6;
      const sy = i * ROW_H + ROW_H / 2 - alt / 2 - 2;
      caixasForma.push({ x0: x, x1: x + w, y0: sy - 4, y1: sy + alt + 4 });
      const g = svg("g", { class: "bar-summary" + dim, "data-id": t.id });
      g.appendChild(svg("rect", {
        class: "sum-track", x, y: sy, width: w, height: alt, rx: alt / 2,
      }));
      if (t.progress > 0) {
        g.appendChild(svg("rect", {
          class: "sum-fill", x, y: sy, width: (w * t.progress) / 100,
          height: alt, rx: alt / 2,
        }));
      }
      // presilhas: é o que faz o traço ler como colchete, e não como barra
      const capa = (bx, dir) => svg("path", {
        class: "sum-cap",
        d: `M ${bx} ${sy} L ${bx + dir * 7} ${sy} L ${bx} ${sy + alt + 5} Z`,
      });
      g.appendChild(capa(x, 1));
      g.appendChild(capa(x + w, -1));

      g.addEventListener("click", () => selectTask(t.id));
      g.addEventListener("dblclick", () => openModal(t.id));
      chart.appendChild(g);
      if (hasNotes) pontoDeNota(chart, t, dim, x + w - 2, sy - 1);
      if (ui.labels) rotuloDaBarra(chart, t, dim, x + w + 8 + folga, sy + alt + 4, caixasRotulo);
      if (t.id === state.selected) {
        chart.appendChild(svg("rect", {
          class: "bar-sel", x: x - 3, y: sy - 3, width: w + 6, height: alt + 11,
        }));
        // um resumo pode ser predecessor (o fim dele é o fim do bloco), mas
        // não sucessor: o motor agenda folhas. Ver linkTasks().
        drawLinkDots(chart, t, i, x, x + w);
      }
      return;   // resumo não tem barra normal nem drag
    }

    if (t.milestone) {
      const cy = i * ROW_H + ROW_H / 2;
      const r = h / 2 + 2;
      caixasForma.push({ x0: x - r, x1: x + r, y0: cy - r, y1: cy + r });
      const dia = svg("polygon", {
        class: "milestone" + dim,
        points: `${x},${cy - r} ${x + r},${cy} ${x},${cy + r} ${x - r},${cy}`,
        fill: color,
        "data-id": t.id,
      });

      attachDrag(dia, t, "move");
      chart.appendChild(dia);
      if (hasNotes) pontoDeNota(chart, t, dim, x + r, cy - r);
      if (ui.labels) rotuloDaBarra(chart, t, dim, x + r + 6 + folga, cy + 4, caixasRotulo);
    } else {
      const info = state.cpm?.byId.get(t.id);
      let w = Math.max(t.duration, 1) * ppd;
      if (state.cpm?.calendar && info && info.early_finish >= t.start &&
          info.early_start === t.start) {
        // dias úteis: fim real vem do motor (pula fins de semana/feriados)
        w = (diffDays(parseDate(t.start), parseDate(info.early_finish)) + 1) * ppd;
      }
      caixasForma.push({ x0: x, x1: x + w, y0: y, y1: y + h });
      const bar = svg("rect", {
        class: "bar" + dim, x, y, width: w, height: h,
        fill: color, opacity: 0.55, "data-id": t.id,
      });

      attachDrag(bar, t, "move");
      chart.appendChild(bar);

      if (t.progress > 0) {
        chart.appendChild(svg("rect", {
          class: "bar-progress" + dim, x, y,
          width: (w * t.progress) / 100, height: h, fill: color,
        }));
      }

      // acima da barra, não dentro dela: o ponto passou a receber o mouse
      // (é ele que abre a nota) e no canto de dentro ele engoliria a alça de
      // redimensionar, que mora nos últimos 8px
      if (hasNotes) pontoDeNota(chart, t, dim, x + w - 5, y - 3.5);

      const handle = svg("rect", {
        class: "bar-handle" + dim, x: x + w - 8, y, width: 8, height: h, "data-id": t.id,
      });
      attachDrag(handle, t, "resize");
      chart.appendChild(handle);

      if (ui.labels) {
        rotuloDaBarra(chart, t, dim, x + w + 8 + folga, y + h - 5, caixasRotulo, (label) => {
          if (slip <= 0) return;
          const ts = svg("tspan", { class: "slip-label" });
          ts.textContent = `  +${slip}d`;
          label.appendChild(ts);
        });
      } else if (slip > 0) {
        const badge = svg("text", {
          class: "bar-label slip-label" + dim, x: x + w + 8 + folga, y: y + h - 5,
        });
        badge.textContent = `+${slip}d`;
        chart.appendChild(badge);
        anotaCaixa(badge, x + w + 8 + folga, y + h - 5, caixasRotulo);
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
      drawLinkDots(chart, t, i, selX, selX + selW);
    }
  });

  /* Setas de dependência (na camada criada lá em cima, por baixo das barras).
     Só entre linhas visíveis: numa raia fechada a tarefa não tem linha, e uma
     seta apontando para o vazio é pior do que seta nenhuma.

     O traço abre um vão onde cruza o nome de uma barra. A saída da seta é a
     ponta da barra, que é exatamente onde o nome começa — então a linha
     riscava a palavra ao meio em toda ligação para a direita. O alvo de
     clique continua inteiro: quem some é o traço, não a área sensível. */
  const rowOf = new Map();
  const byId = new Map();
  rows.forEach((r, i) => {
    if (r.kind !== "task") return;
    rowOf.set(r.task.id, i);
    byId.set(r.task.id, r.task);
  });
  for (const t of byId.values()) {
    for (const depRef of t.dependencies || []) {
      const dep = depId(depRef);
      if (!rowOf.has(dep)) continue;
      const pred = byId.get(dep);
      const x1 = xOf(addDays(taskEnd(pred), 1));
      const y1 = rowOf.get(dep) * ROW_H + ROW_H / 2;
      const x2 = xOf(parseDate(t.start));
      const y2 = rowOf.get(t.id) * ROW_H + ROW_H / 2;
      const caminho = depPath(x1, y1, x2, y2);
      camadaDeps.appendChild(svg("path", {
        class: "dep", d: depPathDesviando(x1, y1, x2, y2, caixasRotulo),
      }));
      camadaDeps.appendChild(svg("polygon", {
        class: "dep-head",
        points: `${x2},${y2} ${x2 - 7},${y2 - 4} ${x2 - 7},${y2 + 4}`,
      }));
      // Alvo de clique por cima da seta: 1px de traço não se acerta com o
      // mouse. Criar ligação com a mão e ter que abrir o modal para desfazer
      // seria dar a ida sem a volta. Aqui o caminho é o inteiro, sem os vãos:
      // o buraco é para o olho, e um buraco no alvo seria um trecho de seta
      // que não responde ao clique.
      const alvo = svg("path", { class: "dep-hit", d: caminho });
      alvo.appendChild(svgTitle(`${pred.name} → ${t.name}\n${T("Double-click to remove")}`));
      alvo.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        canEdit() && unlinkTasks(t, depRef);
      });
      camadaDeps.appendChild(alvo);
    }
  }

  /* Anotações verticais — faixas, dias marcados e a linha de hoje.
   *
   * Em duas fases, e a ordem é o que faz funcionar: primeiro TODOS os nomes
   * deitados acham onde caber (cada um enxergando os que já se acomodaram),
   * depois TODAS as linhas são traçadas abrindo vão em todos eles. Fazer
   * nome-linha, nome-linha por anotação — que foi a primeira tentativa —
   * deixa a linha da primeira cortada só pelo que existia até ela, e o nome
   * da segunda pousa em cima dela.
   *
   * As bordas de faixa entram na camada de fundo (por baixo das barras) e as
   * linhas de dia marcado no topo: uma faixa é fundo, um dia marcado é
   * referência, e referência que passa por trás de uma barra deixa de ser
   * referência. */
  for (const f of faixasVisiveis) {
    nomeDeitado(camadaFaixas, "cal-label", f.nome, f.x0 + 13, null,
                totalH, caixasRotulo, caixasForma);
  }
  const marcados = [];
  (state.current.markers || []).forEach((m, i) => {
    const mx = xOf(parseDate(m.date)) + ppd / 2;
    if (mx < 0 || mx > totalW) return;
    const cor = m.color || AUTO_COLORS[i % AUTO_COLORS.length];
    /* `label_at` (0–100% da altura) é a escolha da pessoa, no cursor do
       diálogo de dias marcados, e ganha do automático. Sem escolha, o nome
       procura altura livre: deitado no topo, que era o padrão antigo, ele cai
       justo nas primeiras linhas do plano — onde quase todo gráfico tem
       barra. */
    const pct = Math.min(Math.max(m.label_at || 0, 0), 100);
    const yFixo = pct > 0 ? 10 + Math.max(0, totalH - 30) * (pct / 100) : null;
    nomeDeitado(chart, "marker-label", m.name, mx - 5, cor, totalH,
                caixasRotulo, caixasForma, yFixo);
    marcados.push({ mx, cor });
  });

  for (const f of faixasVisiveis) {
    linhaVertical(camadaFaixas, "cal-edge", f.x0, totalH, caixasRotulo,
                  { stroke: f.cor });
  }
  for (const m of marcados) {
    linhaVertical(chart, "marker-line", m.mx, totalH, caixasRotulo, { stroke: m.cor });
  }
  // Linha de hoje: a referência mais usada do gráfico, e a que mais cruza
  // rótulo — todo projeto vivo tem trabalho em volta de hoje
  linhaVertical(chart, "today-line", xOf(todayUTC()) + ppd / 2, totalH, caixasRotulo);
}

/* Duplo clique na régua de dias marca aquele dia. É o gesto mais curto para
   a pergunta "o que acontece nesta data?": o dia já está debaixo do cursor,
   e digitar a data num formulário seria repetir para o computador uma coisa
   que ele acabou de ver. */
el.tlDays.addEventListener("dblclick", (ev) => {
  if (!state.current || !canEdit()) return;
  const r = el.tlDays.getBoundingClientRect();
  const x = ev.clientX - r.left;
  // floor, não round: o dia é o que está SOB o cursor, não o mais próximo
  const dia = addDays(state.range.start, Math.floor(x / PPD[state.zoom]));
  showMarkers(fmtISO(dia));
});

/* A faixa da raia no gráfico. Fechada, ela vira uma barra só, do começo do
   primeiro trabalho ao fim do último: recolher a raia esconde as tarefas,
   não a pessoa — quem fecha quer ver menos detalhe, não perder a informação
   de que ela está ocupada de março a maio. */
function drawLane(chart, row, i, totalW, ppd) {
  chart.appendChild(svg("rect", {
    class: "lane-band", x: 0, y: i * ROW_H, width: totalW, height: ROW_H,
  }));
  if (!row.closed) return;
  const x0 = Math.min(...row.tasks.map((t) => xOf(parseDate(t.start))));
  const x1 = Math.max(...row.tasks.map((t) => xOf(taskEnd(t)) + ppd));
  const roll = svg("rect", {
    class: "lane-roll", x: x0, y: i * ROW_H + ROW_H / 2 - 4,
    width: Math.max(x1 - x0, 3), height: 8, rx: 4,
  });
  roll.appendChild(svgTitle(`${laneLabel(row.key)} — ${row.tasks.length}`));
  chart.appendChild(roll);
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

/* Nome da barra, e a caixa que ele ocupa — as setas desviam dela (ver
 * depPathDesviando). Um só lugar desenhando os três casos (barra, marco e
 * resumo) é o que garante que os três sejam desviados: um rótulo desenhado
 * por fora daqui simplesmente não seria contornado, e o defeito só apareceria
 * no dia em que alguém ligasse justo aquela tarefa. */
function rotuloDaBarra(chart, t, dim, x, y, caixas, extra = null) {
  const label = svg("text", { class: "bar-label" + dim, x, y });
  label.textContent = t.name;
  extra && extra(label);
  chart.appendChild(label);
  anotaCaixa(label, x, y, caixas);
  return label;
}

/* A caixa é medida depois de inserido — é a única hora em que o navegador
 * sabe onde o texto ficou. getBBox() e não uma estimativa a partir da linha
 * de base: a primeira versão chutou "9px acima da base", o texto sobe 13, e
 * os quatro pixels de diferença eram exatamente o tanto que a linha vertical
 * ainda comia do topo das letras. Também é o que faz o `+4d` da derrapagem
 * (um tspan dentro do rótulo) entrar na conta de graça. */
function anotaCaixa(node, x, y, caixas) {
  try {
    const b = node.getBBox();
    if (b.width > 0) {
      caixas.push({ x0: b.x, x1: b.x + b.width, y0: b.y, y1: b.y + b.height });
      return;
    }
  } catch {
    /* fora do documento ou sem layout: cai na estimativa abaixo */
  }
  const largura = (node.textContent || "").length * 6.3;
  caixas.push({ x0: x, x1: x + largura, y0: y - 13, y1: y + 4 });
}

/* ------------------------------------------------------------------ */
/* Anotações verticais: linhas e nomes deitados que atravessam o plano   */
/* ------------------------------------------------------------------ */

/* Linha de hoje, linha de dia marcado e borda de faixa sobem do topo ao pé
 * do gráfico, e no caminho passam por cima do nome das tarefas. É o mesmo
 * problema das setas, resolvido do mesmo jeito: o traço abre um vão onde
 * cruza um rótulo. Trecho de menos de 2px não é desenhado — um pixel de
 * traço entre dois vãos é sujeira, não referência.
 *
 * `caixas` são as caixas dos rótulos já desenhados (ver caixasRotulo); por
 * isso tudo o que usa esta função é desenhado DEPOIS das barras. */
function trechosVerticais(x, y0, y1, caixas, folga = 3) {
  let pedacos = [[y0, y1]];
  for (const c of caixas) {
    if (x < c.x0 - folga || x > c.x1 + folga) continue;
    const [a0, a1] = [c.y0 - folga, c.y1 + folga];
    const proximos = [];
    for (const [p0, p1] of pedacos) {
      if (a1 <= p0 || a0 >= p1) { proximos.push([p0, p1]); continue; }
      if (a0 > p0) proximos.push([p0, a0]);
      if (a1 < p1) proximos.push([a1, p1]);
    }
    pedacos = proximos;
  }
  return pedacos.filter(([p0, p1]) => p1 - p0 >= 2);
}

function linhaVertical(chart, classe, x, totalH, caixas, extra = {}) {
  for (const [y1, y2] of trechosVerticais(x, 0, totalH, caixas)) {
    chart.appendChild(svg("line", { class: classe, x1: x, y1, x2: x, y2, ...extra }));
  }
}

/* Onde pôr um nome deitado (faixa, dia marcado) para ele não cair em cima
 * de nada. Letra sobre letra não tem vão que resolva — o que resolve é o
 * nome procurar altura livre.
 *
 * Desce em passos de meia linha e fica na primeira altura sem colisão;
 * não havendo nenhuma, fica na de menor estrago. Empate resolve pelo topo,
 * que é onde o nome sempre esteve — quem não tem conflito não vê mudança. */
/* Caixa que um nome deitado ocupa. Girado 90°, o texto desce a partir da
 * âncora e os glifos ficam à DIREITA dela — medido na tela, de `x-3` a
 * `x+11`, e não simétrico em volta do x como a intuição sugere. Errar isso
 * por seis pixels foi o que fez a linha do dia marcado deixar de abrir vão
 * no próprio nome. */
function caixaDeitada(x, y, comprimento) {
  return { x0: x - 3, x1: x + 11, y0: y, y1: y + comprimento };
}

function alturaLivre(x, comprimento, totalH, caixas, inicio = 10) {
  const limite = Math.max(inicio, totalH - comprimento - 10);
  const passo = Math.max(8, Math.round(ROW_H / 2));
  let melhorY = inicio, melhorN = Infinity;
  for (let y = inicio; y <= limite; y += passo) {
    const alvo = caixaDeitada(x, y, comprimento);
    let n = 0;
    for (const c of caixas) {
      if (c.x1 < alvo.x0 || c.x0 > alvo.x1) continue;
      if (c.y1 < alvo.y0 || c.y0 > alvo.y1) continue;
      n++;
    }
    if (n === 0) return y;
    if (n < melhorN) { melhorN = n; melhorY = y; }
  }
  return melhorY;
}

/* Nome deitado + a caixa que ele passa a ocupar (para os próximos desviarem
 * dele também). `yFixo` vem de quem escolheu a dedo — o cursor do diálogo de
 * dias marcados —, e escolha de gente ganha do automático. */
function nomeDeitado(chart, classe, texto, x, cor, totalH, caixas,
                     formas = [], yFixo = null) {
  // sem cor o fill fica com o CSS (é o caso da faixa, que herda a cor da classe)
  const attrs = { class: classe, x, y: 10, transform: `rotate(90 ${x} 10)` };
  if (cor) attrs.fill = cor;
  const t = svg("text", attrs);
  t.textContent = texto;
  chart.appendChild(t);
  let comprimento = 0;
  try {
    comprimento = t.getComputedTextLength();
  } catch {
    comprimento = 0;
  }
  if (!comprimento) comprimento = (texto || "").length * 6.3;
  // procura altura livre contra TUDO que ocupa lugar — texto e desenho. Só
  // contra texto ele descia direto para cima de uma barra, que foi o que a
  // primeira versão fez: trocou letra sobre letra por letra sobre barra.
  const y = yFixo !== null ? yFixo
                           : alturaLivre(x, comprimento, totalH, [...caixas, ...formas]);
  if (y !== 10) {
    t.setAttribute("y", y);
    t.setAttribute("transform", `rotate(90 ${x} ${y})`);
  }
  const caixa = caixaDeitada(x, y, comprimento);
  caixas.push(caixa);
  return caixa;
}

/* O mesmo cotovelo de depPath, em vértices — para poder ser recortado. */
function depVertices(x1, y1, x2, y2) {
  if (x2 >= x1 + 18) {
    const xm = x2 - 9;
    return [[x1, y1], [xm, y1], [xm, y2], [x2, y2]];
  }
  const ym = y1 + (y2 > y1 ? ROW_H / 2 : -ROW_H / 2);
  return [[x1, y1], [x1 + 9, y1], [x1 + 9, ym], [x2 - 9, ym], [x2 - 9, y2], [x2, y2]];
}

/* Caminho da seta com um vão onde ela cruza o nome de uma barra.
 *
 * A seta sai da ponta da barra, que é exatamente onde o nome começa: toda
 * ligação para a direita riscava a palavra ao meio. Empurrar o nome o soltaria
 * da barra que ele nomeia (o mesmo motivo do dia marcado), então quem abre o
 * vão é a linha.
 *
 * Todo trecho é horizontal ou vertical, então recortar é subtrair intervalos
 * numa reta: para cada trecho, tiram-se as faixas das caixas que ele
 * atravessa. Um trecho que sobra menor que 2px não é desenhado — traço de um
 * pixel entre dois vãos é sujeira, não informação.
 */
const _DEP_FOLGA = 4;   // respiro entre o fim do traço e a letra

function depPathDesviando(x1, y1, x2, y2, caixas) {
  const partes = [];
  const pontos = depVertices(x1, y1, x2, y2);
  for (let i = 0; i + 1 < pontos.length; i++) {
    const [ax, ay] = pontos[i];
    const [bx, by] = pontos[i + 1];
    const horizontal = ay === by;
    // faixas a remover, em coordenada do próprio trecho
    const cortes = [];
    for (const c of caixas) {
      if (horizontal) {
        if (ay < c.y0 - _DEP_FOLGA || ay > c.y1 + _DEP_FOLGA) continue;
        cortes.push([c.x0 - _DEP_FOLGA, c.x1 + _DEP_FOLGA]);
      } else {
        if (ax < c.x0 - _DEP_FOLGA || ax > c.x1 + _DEP_FOLGA) continue;
        cortes.push([c.y0 - _DEP_FOLGA, c.y1 + _DEP_FOLGA]);
      }
    }
    const de = horizontal ? Math.min(ax, bx) : Math.min(ay, by);
    const ate = horizontal ? Math.max(ax, bx) : Math.max(ay, by);
    let pedacos = [[de, ate]];
    for (const [c0, c1] of cortes) {
      const proximos = [];
      for (const [p0, p1] of pedacos) {
        if (c1 <= p0 || c0 >= p1) { proximos.push([p0, p1]); continue; }
        if (c0 > p0) proximos.push([p0, c0]);
        if (c1 < p1) proximos.push([c1, p1]);
      }
      pedacos = proximos;
    }
    for (const [p0, p1] of pedacos) {
      if (p1 - p0 < 2) continue;
      partes.push(horizontal
        ? `M ${p0} ${ay} H ${p1}`
        : `M ${ax} ${p0} V ${p1}`);
    }
  }
  return partes.join(" ");
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

/* Ligar tarefas com a mão.

   A dependência era a única relação DESENHADA no gráfico que só dava para
   declarar por formulário. Agora a barra selecionada mostra dois pontos nas
   pontas e arrastar de um deles até outra barra cria a ligação.

   Só na barra selecionada, e não em toda barra sob o cursor: um ponto que
   aparece ao passar o mouse compete com o arrasto da própria barra e com o
   punho de redimensionar, que moram nos mesmos pixels. Selecionar já é o
   gesto que diz "é desta aqui que estou falando".

   Ponta direita = "esta alimenta a próxima"; ponta esquerda = "esta é
   alimentada por". As duas criam a MESMA ligação término→início — o que muda
   é de que lado da cadeia você está montando. SS/FF e folga continuam no
   modal: são a exceção, e exceção não precisa de gesto. */
/* Espaço que o nome da barra cede ao ponto de ligar da direita — diâmetro
 * mais um respiro. Só na barra selecionada, que é a única que tem pontos: o
 * ponto nasce exatamente onde o nome começa e comia a primeira letra.
 *
 * Subir o ponto era a outra saída, e resolve no cozy; no compact a linha é
 * mais baixa, o nome fica mais alto, e o ponto voltaria a encostar nele. E o
 * ponto na altura do meio da barra é o que diz "arraste a partir do FIM
 * dela". Afastar o nome de toda barra, por causa de um ponto que só existe na
 * selecionada, seria pagar na tela inteira por um problema de uma linha. */
const ESPACO_PONTO = 13;

function drawLinkDots(chart, t, i, xEsq, xDir) {
  if (state.readOnly) return;   // ponta de arrasto que não arrasta é convite falso
  const cy = i * ROW_H + ROW_H / 2;
  for (const [lado, cx] of [["left", xEsq - 9], ["right", xDir + 9]]) {
    const dot = svg("circle", { class: "link-dot", cx, cy, r: 4.5,
                                "data-side": lado });
    dot.appendChild(svgTitle(T(lado === "right" ? "Drag to the task that follows"
                                                : "Drag to the task that comes before")));
    attachLink(dot, t, lado);
    chart.appendChild(dot);
  }
}

/* A forma de tarefa sob o ponteiro. elementFromPoint devolve só a do topo, e
   sobre a barra moram contornos que NÃO carregam data-id: a moldura do
   caminho crítico e a da seleção. Ambas têm fill:none, então só o traço é
   clicável — mas é justamente na borda da barra que se solta o arrasto.
   (O preenchimento do progresso não entra na conta: tem pointer-events:none.)
   Aqui a pilha inteira é percorrida até achar uma tarefa, com
   elementFromPoint como reserva para ambiente sem a versão plural. */
function formaSobOPonteiro(x, y) {
  const pilha = document.elementsFromPoint
    ? document.elementsFromPoint(x, y)
    : [document.elementFromPoint(x, y)];
  for (const n of pilha) {
    const id = n?.dataset?.id;
    if (id && taskById(id)) return n;
  }
  return null;
}

function attachLink(node, task, lado) {
  node.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || state.readOnly) return;
    ev.stopPropagation();          // não é arrastar a barra
    const caixa = el.chart.getBoundingClientRect();
    const x0 = Number(node.getAttribute("cx"));
    const y0 = Number(node.getAttribute("cy"));
    const elastico = svg("line", { class: "link-rubber", x1: x0, y1: y0, x2: x0, y2: y0 });
    el.chart.appendChild(elastico);
    state.dragging = true;
    let aceso = null;

    const onMove = (mv) => {
      elastico.setAttribute("x2", mv.clientX - caixa.left);
      elastico.setAttribute("y2", mv.clientY - caixa.top);
      // realce do alvo: dizer ANTES do clique o que vai acontecer é metade
      // do gesto — soltar em cima de nada não pode ser uma surpresa
      const sob = formaSobOPonteiro(mv.clientX, mv.clientY);
      const id = sob?.dataset?.id;
      const novo = id && id !== task.id ? id : null;
      if (novo === aceso) return;
      el.chart.querySelectorAll(".link-target")
        .forEach((n) => n.classList.remove("link-target"));
      aceso = novo;
      if (aceso) sob.classList.add("link-target");
    };

    const onUp = (up) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      state.dragging = false;
      elastico.remove();
      el.chart.querySelectorAll(".link-target")
        .forEach((n) => n.classList.remove("link-target"));
      const sob = formaSobOPonteiro(up.clientX, up.clientY);
      const outra = taskById(sob?.dataset?.id || "");
      if (!outra || outra.id === task.id) return;
      lado === "right" ? linkTasks(task, outra) : linkTasks(outra, task);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

/* Descendentes de uma tarefa, pela WBS. Serve às duas recusas de baixo. */
function descendentes(id, byId) {
  const out = new Set();
  const filhos = new Map();
  for (const t of byId.values()) {
    if (!t.parent) continue;
    if (!filhos.has(t.parent)) filhos.set(t.parent, []);
    filhos.get(t.parent).push(t.id);
  }
  const anda = (x) => (filhos.get(x) || []).forEach((f) => {
    if (out.has(f)) return;
    out.add(f); anda(f);
  });
  anda(id);
  return out;
}

/* A ligação fecharia um ciclo? Caminha das predecessoras de `antes` para
   trás procurando `depois`. O motor recusa plano cíclico DEPOIS de gravado —
   o aviso aparece e o cronograma para de agendar. Recusar o gesto é melhor
   do que gravar e explicar. */
function fechariaCiclo(antes, depois, byId) {
  const pilha = [antes.id];
  const visto = new Set();
  while (pilha.length) {
    const id = pilha.pop();
    if (id === depois.id) return true;
    if (visto.has(id)) continue;
    visto.add(id);
    for (const d of byId.get(id)?.dependencies || []) pilha.push(depId(d));
  }
  return false;
}

/* Cria `depois` depende de `antes` (término→início, sem folga). */
function linkTasks(antes, depois) {
  const byId = new Map(state.current.tasks.map((t) => [t.id, t]));
  const jaTem = (depois.dependencies || []).some((d) => depId(d) === antes.id);
  if (jaTem) return PerthToast.info(T("Already linked"));
  // Resumo é recipiente: o motor agenda as folhas, então uma dependência
  // APONTANDO para um resumo não moveria nada — prometeria o que não cumpre.
  if (state.wbs?.summary.has(depois.id)) {
    return PerthToast.info(T("A summary is scheduled by its subtasks — link one of them"));
  }
  // dentro do próprio bloco: um resumo já espera pelos filhos por definição
  if (descendentes(antes.id, byId).has(depois.id) ||
      descendentes(depois.id, byId).has(antes.id)) {
    return PerthToast.info(T("A task and its own block are already tied"));
  }
  if (fechariaCiclo(antes, depois, byId)) {
    return PerthToast.info(T("That would close a loop"));
  }
  pushUndo();
  depois.dependencies = [...(depois.dependencies || []), antes.id];
  state.selected = depois.id;
  renderAll();
  markDirty();
}

function unlinkTasks(depois, depRef) {
  pushUndo();
  depois.dependencies = (depois.dependencies || []).filter((d) => d !== depRef);
  renderAll();
  markDirty();
}

function attachDrag(node, task, mode) {
  node.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || state.readOnly) return;   // selecionar e abrir seguem valendo
    // Sem preventDefault aqui: cancelar o pointerdown suprime os eventos de
    // mouse de compatibilidade, e sem mousedown o Chrome nunca produz click
    // — logo, nunca produz dblclick. O listener de dblclick lá embaixo era
    // código morto, e abrir a tarefa pela barra não funcionava (na linha da
    // tabela funcionava, porque lá ninguém cancela nada). Quem impede a
    // seleção de texto durante o arrasto é user-select:none no #chart.
    //
    // pushUndo() NÃO entra aqui: encostar numa barra não é uma edição. Ele
    // zera a pilha de refazer e empilha um "antes" sem "depois" (markDirty,
    // que fecha o par, só roda em edição de verdade) — três cliques de
    // seleção davam três entradas de nada e matavam o refazer de uma edição
    // anterior. Vai no primeiro movimento, que é quando a edição começa.
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
      if (!moved) {
        pushUndo();        // aqui o "antes" ainda é o original: nada mutou
        moved = true;
      }
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

/* Ctrl+roda aproxima e afasta, mantendo parada a data sob o ponteiro — o
 * gesto que todo mundo tenta antes de procurar o botão. O passo anda entre as
 * três escalas nomeadas (mês → semana → dia); vindo do "caber", entra pela
 * mais parecida com a escala que ele calculou, senão o primeiro giro daria um
 * salto sem relação com o que está na tela. */
el.tlBody.addEventListener("wheel", (ev) => {
  if (!ev.ctrlKey || !state.current) return;
  ev.preventDefault();
  const escadas = ["month", "week", "day"];
  let base = escadas.indexOf(state.zoom);
  if (base < 0) {   // "caber": acha o degrau de escala mais próxima
    let melhor = 0, dist = Infinity;
    escadas.forEach((z, i) => {
      const d = Math.abs(PPD[z] - PPD.fit);
      if (d < dist) { dist = d; melhor = i; }
    });
    base = melhor;
  }
  const alvo = escadas[Math.min(Math.max(base + (ev.deltaY < 0 ? 1 : -1), 0),
                                escadas.length - 1)];
  if (alvo !== state.zoom) setZoom(alvo, { ancoraX: ev.clientX });
}, { passive: false });

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
  rolaTimeline(xOf(todayUTC()) - el.tlBody.clientWidth / 3);
}

/* Rolagem horizontal por código, num lugar só.
 *
 * scrollTo instantâneo porque a timeline rola com scroll-behavior:smooth, e
 * atribuir scrollLeft ali dispara uma ANIMAÇÃO — que o próximo redesenho
 * engole (é a pedra em que revealTask já tinha tropeçado).
 *
 * E a régua é espelhada na mão, sem esperar o evento de scroll: ele chega
 * DEPOIS, e até lá cabeçalho e gráfico discordam — quem clicasse na régua
 * nesse intervalo marcaria um dia que não é o que está sob o dedo. */
function rolaTimeline(left) {
  const alvo = Math.max(0, left);
  el.tlBody.scrollTo({ left: alvo, behavior: "instant" });
  el.tlHead.scrollLeft = el.tlBody.scrollLeft;
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
  $("#modal-title").textContent =
    T(state.readOnly ? "Task" : state.editingNew ? "New task" : "Edit task");
  $("#f-name").value = t.name;
  $("#f-assignee").value = t.assignee || "";
  fillPeopleList();
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
  // Somente-leitura abre o modal do mesmo jeito — os detalhes da tarefa são
  // leitura, e são justamente o que não cabe na barra — mas trancado: campo
  // editável cujo salvamento o servidor vai recusar promete o que não tem.
  if (state.readOnly) {
    for (const f of el.modal.querySelectorAll("input, select, textarea"))
      f.disabled = true;
    $("#modal-save").hidden = true;
    $("#modal-delete").hidden = true;
    $("#f-summary-hint").hidden = true;
    return;
  }
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

/* Vocabulário de pessoas do projeto: o cadastro MAIS quem já aparece em
   alguma tarefa. Oferecer só o cadastro esconderia nomes que já existem e
   convidaria a redigitá-los — e é redigitar que fragmenta. */
function peopleOptions() {
  const usados = (state.current?.tasks || [])
    .map((t) => (t.assignee || "").trim()).filter(Boolean);
  const cadastrados = (state.current?.people || []).map((pe) => pe.name);
  const vistos = new Map();   // minúscula => grafia (a cadastrada ganha)
  for (const n of [...cadastrados, ...usados]) {
    const k = n.toLowerCase();
    if (!vistos.has(k)) vistos.set(k, n);
  }
  return [...vistos.values()].sort((a, b) => a.localeCompare(b));
}

function fillPeopleList() {
  const dl = $("#people-list");
  if (!dl) return;
  dl.textContent = "";
  const ficha = new Map((state.current?.people || [])
    .map((pe) => [pe.name.toLowerCase(), pe]));
  for (const nome of peopleOptions()) {
    const o = document.createElement("option");
    o.value = nome;
    // o navegador mostra a legenda ao lado do nome na lista suspensa:
    // é onde cargo e setor pagam por si mesmos, na hora de escolher
    const pe = ficha.get(nome.toLowerCase());
    const legenda = pe && [pe.role, pe.team].filter(Boolean).join(" · ");
    if (legenda) o.label = legenda;
    dl.append(o);
  }
}

/* Cadastro de colaboradores: nome, cargo, setor, e-mail, observações. A
   lista é conveniência, não cerca — o campo responsável continua aceitando
   texto livre, e tirar alguém do cadastro NÃO tira o nome das tarefas dele:
   some da lista, não do trabalho. */
const PEOPLE_FIELDS = [["role", "Role"], ["team", "Team"],
                       ["email", "Email"], ["notes", "Notes"]];

function showPeople() {
  if (!state.current) return;
  const body = document.createElement("div");
  body.className = "people-box";

  const form = document.createElement("form");
  form.className = "people-add";
  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.placeholder = T("Name");
  const add = document.createElement("button");
  add.type = "submit";
  add.className = "primary";
  add.textContent = T("Add");
  form.append(input, add);

  const lista = document.createElement("div");
  lista.className = "people-list";
  const rodape = document.createElement("div");
  rodape.className = "people-loose";
  let aberto = "";   // nome da ficha expandida (uma por vez)

  const contar = (nome) => (state.current.tasks || [])
    .filter((t) => (t.assignee || "").toLowerCase() === nome.toLowerCase()).length;

  async function gravar(pessoas) {
    state.current.people = pessoas;
    // adota a resposta do servidor, que é quem arruma grafia, ordem e
    // repetição. Recarregar o projeto INTEIRO aqui era pior do que parecia:
    // uma segunda edição feita durante o recarregamento era engolida quando
    // a resposta antiga chegava e trocava state.current debaixo dela.
    const salvo = await saveNowAfterDirty();
    if (salvo) state.current.people = salvo.people;
    fillPeopleList();
    renderTable();
    renderChart();
    desenhar();
  }

  function desenhar() {
    const cadastrados = state.current.people || [];
    lista.textContent = "";
    if (!cadastrados.length) {
      const vazio = document.createElement("p");
      vazio.className = "muted";
      vazio.textContent = T("No collaborators registered yet.");
      lista.append(vazio);
    }
    for (const pe of cadastrados) {
      const bloco = document.createElement("div");
      bloco.className = "people-item";
      const linha = document.createElement("div");
      linha.className = "people-row";
      const n = document.createElement("span");
      n.className = "people-name";
      n.textContent = pe.name;
      const cargo = document.createElement("span");
      cargo.className = "people-role";
      cargo.textContent = [pe.role, pe.team].filter(Boolean).join(" · ");
      const c = document.createElement("span");
      c.className = "people-count";
      const q = contar(pe.name);
      c.textContent = q ? `${q} ${T(q === 1 ? "task" : "tasks")}` : "—";
      const x = document.createElement("button");
      x.className = "icon-btn";
      x.type = "button";
      x.textContent = "✕";
      x.title = T("Remove from list (tasks keep the name)");
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        gravar(cadastrados.filter((o) => o !== pe));
      });
      linha.append(n, cargo, c, x);
      // a linha inteira abre a ficha: o alvo de clique é o nome, não um
      // lápis de 12px que ninguém acha
      linha.addEventListener("click", () => {
        aberto = aberto === pe.name ? "" : pe.name;
        desenhar();
      });
      bloco.append(linha);
      if (aberto === pe.name) bloco.append(fichaDe(pe, cadastrados));
      lista.append(bloco);
    }

    // Nomes que já trabalham no projeto mas não estão no cadastro: é
    // exatamente aqui que a fragmentação aparece, então mostrar é o ponto
    const nomes = cadastrados.map((pe) => pe.name.toLowerCase());
    const soltos = peopleOptions().filter((n) => !nomes.includes(n.toLowerCase()));
    rodape.textContent = "";
    if (soltos.length) {
      const txt = document.createElement("span");
      txt.textContent = `${T("Also assigned in this project")}: ${soltos.join(", ")}`;
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = T("Register these");
      b.addEventListener("click", () =>
        gravar([...cadastrados, ...soltos.map((name) => ({ name }))]));
      rodape.append(txt, b);
    }
  }

  /* A ficha: o que a pessoa é, além do nome. Grava ao sair do campo (blur)
     em vez de a cada tecla — salvar por tecla mandaria um PUT por letra. */
  function fichaDe(pe, cadastrados) {
    const ficha = document.createElement("div");
    ficha.className = "people-form";
    for (const [campo, rotulo] of PEOPLE_FIELDS) {
      const lab = document.createElement("label");
      lab.textContent = T(rotulo);
      const ip = document.createElement("input");
      ip.type = "text";
      ip.autocomplete = "off";
      ip.dataset.field = campo;
      ip.value = pe[campo] || "";
      ip.addEventListener("change", () => {
        if ((pe[campo] || "") === ip.value.trim()) return;
        pe[campo] = ip.value.trim();
        gravar(cadastrados);
      });
      lab.append(ip);
      ficha.append(lab);
    }
    return ficha;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const nome = input.value.trim();
    if (!nome) return;
    const cadastrados = state.current.people || [];
    // Digitar um nome que já existe com outra caixa é o gesto de CORRIGIR a
    // grafia: a digitada substitui a cadastrada (e o resto da ficha fica
    // como estava), e o servidor reescreve as tarefas dela. Não fazer nada
    // seria o pior dos mundos — o usuário digita a correção, aperta
    // Adicionar, e a tela fica igual.
    const igual = (pe) => pe.name.toLowerCase() === nome.toLowerCase();
    const antigo = cadastrados.find(igual);
    if (antigo) antigo.name = nome;
    aberto = nome;   // abre a ficha do recém-cadastrado: é o convite a preenchê-la
    gravar(antigo ? cadastrados : [...cadastrados, { name: nome }]);
    input.value = "";
    input.focus();
  });

  desenhar();
  body.append(form, lista, rodape);
  showOverlay("Collaborators", body);
  input.focus();
}

/* Estatísticas por pessoa e por setor. O gantt já sabia tudo isto e não
   somava em lugar nenhum: quanto cada um carrega, quanto disso está feito,
   quantos dias de sobrecarga, quantas tarefas passaram do prazo. A conta sai
   do servidor, do mesmo motor que desenha a curva-S — duas telas contando
   histórias diferentes sobre o mesmo trabalho seria pior do que nenhuma. */
const STATS_COLS = [
  ["tasks", "tasks"], ["effort", "effort"], ["progress", "done"],
  ["busy_days", "days"], ["over_days", "over"], ["late", "late"],
];

async function showStats() {
  if (!state.current) return;
  const body = document.createElement("div");
  body.className = "stats-box";
  const abas = document.createElement("div");
  abas.className = "seg stats-tabs";
  const tabela = document.createElement("div");
  tabela.className = "stats-table";
  body.append(abas, tabela);
  showOverlay("Statistics", body);

  let dados;
  try {
    dados = await api(`/api/projects/${state.current.id}/stats`);
  } catch (err) {
    tabela.textContent = `${T("Could not load statistics")}: ${err.message}`;
    return;
  }

  let aba = "people";
  for (const [chave, rotulo] of [["people", "People"], ["teams", "Teams"]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = T(rotulo);
    b.dataset.tab = chave;
    b.addEventListener("click", () => { aba = chave; desenhar(); });
    abas.append(b);
  }

  function desenhar() {
    for (const b of abas.children) b.classList.toggle("active", b.dataset.tab === aba);
    const linhas = dados[aba] || [];
    tabela.textContent = "";
    if (!linhas.length) {
      const vazio = document.createElement("p");
      vazio.className = "muted";
      vazio.textContent = T("Nothing assigned yet.");
      tabela.append(vazio);
      return;
    }

    const head = document.createElement("div");
    head.className = "stats-row head";
    head.append(celula(T(aba === "people" ? "Person" : "Team"), "who"));
    for (const [, rotulo] of STATS_COLS) head.append(celula(T(rotulo), "num"));
    tabela.append(head);

    for (const r of linhas) {
      const linha = document.createElement("div");
      linha.className = "stats-row";
      const nome = aba === "people"
        ? (r.assignee || T("(unassigned)"))
        : (r.team || T("(no team)"));
      const detalhe = aba === "people"
        ? [r.role, r.team].filter(Boolean).join(" · ")
        : r.people.join(", ");
      const quem = celula("", "who");
      const n = document.createElement("span");
      n.className = "stats-name";
      n.textContent = nome;
      const d = document.createElement("span");
      d.className = "stats-sub";
      d.textContent = detalhe;
      d.title = `${r.first} → ${r.last}`;
      quem.append(n, d);
      linha.append(quem);

      for (const [campo] of STATS_COLS) {
        const c = celula("", "num");
        if (campo === "progress") {
          // barra e número juntos: 83% sem barra some no meio de outros
          // números, e barra sem número não dá para comparar duas pessoas
          const barra = document.createElement("span");
          barra.className = "stats-bar";
          const dentro = document.createElement("span");
          dentro.style.width = `${Math.max(0, Math.min(100, r.progress))}%`;
          barra.append(dentro);
          const txt = document.createElement("span");
          txt.textContent = `${r.progress}%`;
          c.append(barra, txt);
        } else {
          const v = r[campo];
          c.textContent = campo === "effort" ? numeroCurto(v) : String(v);
          // zero é o normal em "over" e "late": só o diferente de zero
          // merece cor, senão a tabela inteira fica gritando
          if ((campo === "over_days" || campo === "late") && v > 0) {
            c.classList.add("bad");
          }
        }
        linha.append(c);
      }
      tabela.append(linha);
    }
  }

  desenhar();
}

function celula(texto, cls) {
  const c = document.createElement("span");
  c.className = `stats-cell ${cls}`;
  if (texto) c.textContent = texto;
  return c;
}

/* 12.0 vira "12"; 12.53 vira "12.5". Pessoa-dias com três casas decimais é
   precisão que o plano não tem. */
const numeroCurto = (v) => (Math.round(v * 10) / 10).toString();

const corAutomatica = (i) => AUTO_COLORS[i % AUTO_COLORS.length];

/* Editor de faixas do calendário. Faixa sem nome não entra: um trecho
   sombreado que não diz por quê é ruído, não informação. */
function showBands() {
  if (!state.current) return;
  const body = document.createElement("div");
  body.className = "people-box cal-box";

  const form = document.createElement("form");
  form.className = "cal-add";
  const nome = document.createElement("input");
  nome.type = "text";
  nome.autocomplete = "off";
  nome.placeholder = T("Name");
  const de = document.createElement("input");
  de.type = "date";
  const ate = document.createElement("input");
  ate.type = "date";
  // o seletor já vem na cor que a faixa teria de graça: quem não liga para
  // cor não precisa escolher nenhuma, e quem liga muda uma que já existe
  const cor = document.createElement("input");
  cor.type = "color";
  cor.className = "cal-pick";
  cor.title = T("Colour");
  cor.value = corAutomatica((state.current.bands || []).length);
  const add = document.createElement("button");
  add.type = "submit";
  add.className = "primary";
  add.textContent = T("Add");
  form.append(nome, de, ate, cor, add);

  const lista = document.createElement("div");
  lista.className = "people-list";

  async function gravar(faixas) {
    state.current.bands = faixas;
    // ver o comentário do gravar() dos colaboradores: a resposta do PUT já
    // é o estado normalizado, e recarregar o projeto abriria uma janela em
    // que a edição seguinte se perde
    const salvo = await saveNowAfterDirty();
    if (salvo) state.current.bands = salvo.bands;
    renderChart();
    desenhar();
  }

  function desenhar() {
    const faixas = state.current.bands || [];
    lista.textContent = "";
    if (!faixas.length) {
      const vazio = document.createElement("p");
      vazio.className = "muted";
      vazio.textContent = T("No bands yet.");
      lista.append(vazio);
    }
    faixas.forEach((f, i) => {
      const linha = document.createElement("div");
      linha.className = "people-row cal-row";
      // a bolinha É o seletor: mostrar a cor e obrigar a abrir outro lugar
      // para trocá-la seria duas coisas onde cabe uma
      const cor = document.createElement("input");
      cor.type = "color";
      cor.className = "cal-dot";
      cor.title = T("Colour");
      cor.value = f.color || corAutomatica(i);
      cor.addEventListener("change", () => {
        f.color = cor.value;
        gravar(faixas);
      });
      const n = document.createElement("span");
      n.className = "people-name";
      n.textContent = f.name;
      const quando = document.createElement("span");
      quando.className = "people-count";
      quando.textContent = `${f.from} → ${f.to}`;
      const x = document.createElement("button");
      x.className = "icon-btn";
      x.type = "button";
      x.textContent = "✕";
      x.title = T("Remove");
      x.addEventListener("click", () => gravar(faixas.filter((o) => o !== f)));
      linha.append(cor, n, quando, x);
      lista.append(linha);
    });
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const texto = nome.value.trim();
    if (!texto || !de.value || !ate.value) return;
    const escolhida = cor.value;
    // mesma regra do REPL: nome repetido MOVE a faixa em vez de duplicar,
    // e ponta invertida é engano de digitação, não plano
    const [from, to] = de.value <= ate.value ? [de.value, ate.value]
                                             : [ate.value, de.value];
    const resto = (state.current.bands || [])
      .filter((f) => f.name.toLowerCase() !== texto.toLowerCase());
    gravar([...resto, { name: texto, from, to, color: escolhida }]);
    // próxima faixa já vem com a próxima cor da paleta, para duas seguidas
    // não saírem iguais sem ninguém pedir
    cor.value = corAutomatica(resto.length + 1);
    nome.value = "";
    nome.focus();
  });

  desenhar();
  body.append(form, lista);
  showOverlay("Calendar bands", body);
  nome.focus();
}

/* Editor de dias marcados. `preencher` chega do duplo clique na régua: o
   painel abre com a data já posta e o cursor no nome, que é o único campo
   que o computador não tem como adivinhar. */
function showMarkers(preencher = "") {
  if (!state.current) return;
  const body = document.createElement("div");
  body.className = "people-box cal-box";

  const form = document.createElement("form");
  form.className = "cal-add";
  const nome = document.createElement("input");
  nome.type = "text";
  nome.autocomplete = "off";
  nome.placeholder = T("Name");
  const quando = document.createElement("input");
  quando.type = "date";
  quando.value = preencher || fmtISO(todayUTC());
  const cor = document.createElement("input");
  cor.type = "color";
  cor.className = "cal-pick";
  cor.title = T("Colour");
  cor.value = corAutomatica((state.current.markers || []).length);
  const add = document.createElement("button");
  add.type = "submit";
  add.className = "primary";
  add.textContent = T("Add");
  form.append(nome, quando, cor, add);

  const lista = document.createElement("div");
  lista.className = "people-list";

  async function gravar(marcos) {
    state.current.markers = marcos;
    const salvo = await saveNowAfterDirty();
    if (salvo) state.current.markers = salvo.markers;
    renderChart();
    desenhar();
  }

  function desenhar() {
    const marcos = state.current.markers || [];
    lista.textContent = "";
    if (!marcos.length) {
      const vazio = document.createElement("p");
      vazio.className = "muted";
      vazio.textContent = T("No marked days yet.");
      lista.append(vazio);
    }
    marcos.forEach((m, i) => {
      const linha = document.createElement("div");
      linha.className = "people-row cal-row";
      const c = document.createElement("input");
      c.type = "color";
      c.className = "cal-dot";
      c.title = T("Colour");
      c.value = m.color || corAutomatica(i);
      c.addEventListener("change", () => { m.color = c.value; gravar(marcos); });
      const n = document.createElement("span");
      n.className = "people-name";
      n.textContent = m.name;
      const dia = document.createElement("span");
      dia.className = "people-count";
      dia.textContent = m.date;
      // Onde o nome fica na vertical. Arrastar redesenha na hora e não
      // grava; gravar só ao soltar — um PUT por pixel de cursor seria uma
      // enxurrada de salvamentos, e o que importa é onde ele parou.
      const pos = document.createElement("input");
      pos.type = "range";
      pos.className = "cal-pos";
      pos.min = "0";
      pos.max = "100";
      pos.step = "5";
      pos.value = String(m.label_at || 0);
      pos.title = T("Label position");
      pos.setAttribute("aria-label", T("Label position"));
      pos.addEventListener("input", () => {
        m.label_at = Number(pos.value);
        renderChart();
      });
      pos.addEventListener("change", () => gravar(marcos));
      const x = document.createElement("button");
      x.className = "icon-btn";
      x.type = "button";
      x.textContent = "✕";
      x.title = T("Remove");
      x.addEventListener("click", () => gravar(marcos.filter((o) => o !== m)));
      linha.append(c, n, dia, pos, x);
      lista.append(linha);
    });
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const texto = nome.value.trim();
    if (!texto || !quando.value) return;
    // mesma regra do REPL: nome repetido MOVE o marco de data
    const resto = (state.current.markers || [])
      .filter((m) => m.name.toLowerCase() !== texto.toLowerCase());
    gravar([...resto, { name: texto, date: quando.value, color: cor.value }]);
    nome.value = "";
    cor.value = corAutomatica(resto.length + 1);
    nome.focus();
  });

  desenhar();
  body.append(form, lista);
  showOverlay("Marked days", body);
  nome.focus();
}

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
  close.textContent = window.PerthI18n ? PerthI18n.t("Close") : "Close";
  close.addEventListener("click", () => back.remove());
  actions.append(sp, close);
  box.append(actions);
  back.append(box);
  back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
  document.body.append(back);
}

const T = (k) => (window.PerthI18n ? PerthI18n.t(k) : k);

/* Ficha de avisos na barra: só existe quando há o que avisar. Um contador
   permanente marcando zero vira decoração; aparecendo, ele é a informação. */
function renderWarningsChip() {
  const n = state.warnings.length;
  el.warningsChip.hidden = n === 0;
  if (!n) return;
  const grave = state.warnings.some((w) => w.severity === "error");
  el.warningsChip.classList.toggle("error", grave);
  // símbolo em elemento próprio: como glifo ele lê menor que letra no mesmo
  // tamanho, e é ele que tem que chamar o olho antes do número
  el.warningsChip.textContent = "";
  const ico = document.createElement("span");
  ico.className = "warn-ico";
  ico.textContent = "⚠";
  const num = document.createElement("span");
  num.textContent = String(n);
  el.warningsChip.append(ico, num);
  el.warningsChip.title = grave
    ? T("Problems that stop the plan from being scheduled")
    : T("Problems found in this plan");
}

const _WARN_LABEL = {
  cycle: "dependency cycle",
  deadline: "past the deadline",
  overdue: "overdue",
  overallocation: "overallocated",
  slippage: "behind the baseline",
  too_early: "starts before its dependencies allow",
};

/* A frase é montada aqui, não no servidor: quem sabe o idioma de quem lê é
   esta ponta. Texto pronto vindo do Julia sairia em inglês no meio de uma
   tela traduzida — exatamente o defeito que a varredura de i18n impede do
   outro lado. A etiqueta já diz o TIPO, então a frase só carrega os dados e
   uma palavra ou outra. */
function warningText(w) {
  const d = (n) => `${n} d`;
  switch (w.kind) {
    case "cycle":
      return T("the plan cannot be scheduled while it exists");
    case "deadline":
      return `${w.task} · ${d(w.days)} · ${T("deadline")} ${w.at}`;
    case "overdue":
      return `${w.task} · ${T("ended")} ${w.at}`;
    case "overallocation":
      return `${w.who} · "${w.task}" × "${w.other}" · ${w.from} → ${w.to}`;
    case "slippage":
      return `${w.task} · ${d(w.days)}`;
    case "too_early":
      // data fixa é o caso em que o auto-schedule NÃO resolve: a tarefa está
      // presa de propósito, e quem lê precisa saber que o conserto é outro
      return `${w.task} · ${d(w.days)} · ${T("can start on")} ${w.at}` +
             (w.pinned ? ` · ${T("pinned start")}` : "");
    default:
      return w.task || "";
  }
}

function showWarnings() {
  const body = document.createElement("div");
  body.className = "warn-list";
  if (!state.warnings.length) {
    body.textContent = T("nothing wrong with this plan");
    body.classList.add("none");
    showOverlay("Warnings", body);
    return;
  }
  for (const w of state.warnings) {
    const linha = document.createElement("button");
    linha.className = "warn-row " + (w.severity === "error" ? "error" : "warning");
    const tipo = document.createElement("span");
    tipo.className = "warn-kind";
    tipo.textContent = T(_WARN_LABEL[w.kind] || w.kind);
    const texto = document.createElement("span");
    texto.className = "warn-text";
    texto.textContent = warningText(w);
    linha.append(tipo, texto);
    // clicar leva ao problema: nomear sem levar até lá é meia ajuda
    if (w.task_id) {
      linha.addEventListener("click", () => {
        document.getElementById("perth-overlay")?.remove();
        revealTask(w.task_id);
      });
    } else {
      linha.disabled = true;          // ciclo não é de uma tarefa só
    }
    body.append(linha);
  }
  showOverlay("Warnings", body);
}

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
  // /api/share é onde o servidor diz quem é quem: além do host, se esta
  // aba entrou pelo link somente-leitura (ver _gantt_share_payload)
  applyReadOnly(!!(info && info.viewing));
  // Espelho em disco e navegador de pastas são só do host — o servidor recusa
  // com 403 (ver _gantt_host_only). Num convidado a caixa inteira some, em vez
  // de ficar ali para falhar: ela também mostraria um caminho da máquina
  // anfitriã, que é a mesma informação que /api/fs deixou de entregar.
  el.filebox.hidden = !(info && info.host);

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
  return api("/api/share").then(renderShareBtn).catch(() => {});
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
    PerthToast.error(err.message);
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
      PerthToast.error(err.message);
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

/* Link somente-leitura no diálogo de Share (só o host o vê e o troca).
 * Irmã de shareKeyRow: mesma caixa, mesma aplicação, outro significado —
 * esta chave abre os projetos e recusa mudá-los. Trocar ou tirar derruba
 * quem estava olhando por ela, e só essas máquinas: o link que elas têm
 * na mão deixou de existir. */
function shareViewRow(body, info) {
  const wrap = document.createElement("div");
  const row = document.createElement("div");
  row.className = "share-key";
  const label = document.createElement("span");
  label.textContent = T(info.view_keyed ? "Read-only link on" : "No read-only link");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "share-key-input";
  input.placeholder = T(info.view_keyed ? "new read-only key" : "read-only key");

  const apply = async (key, btn) => {
    btn.disabled = true;
    try {
      const next = await api("/api/view_key", {
        method: "POST", body: JSON.stringify({ key }),
      });
      renderShare(body, next);
    } catch (err) {
      btn.disabled = false;
      PerthToast.error(err.message);
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

  if (info.view_keyed) {
    const drop = document.createElement("button");
    drop.className = "danger";
    drop.textContent = T("remove");
    drop.addEventListener("click", () => apply("", drop));
    row.append(drop);
  }

  const hint = document.createElement("div");
  hint.className = "alias-hint";
  hint.textContent = info.view_keyed
    ? T("Whoever opens the link below sees the projects and cannot change them — not even through the chat. This machine always edits, so the link starts at your network address.")
    : T("A second link that opens the projects and refuses to change them — for a client, a director, the whole site.");
  wrap.append(row, hint);

  // payload sem o campo (servidor de uma versão anterior, ou um stub) não
  // pode derrubar o diálogo inteiro: sem lista, não há link a mostrar
  for (const u of info.view_urls || []) {
    const line = document.createElement("div");
    line.className = "share-url view";
    const code = document.createElement("code");
    code.textContent = u;
    const btn = document.createElement("button");
    btn.textContent = T("copy");
    btn.addEventListener("click", () => {
      navigator.clipboard?.writeText(u);
      btn.textContent = T("copied!");
      setTimeout(() => (btn.textContent = T("copy")), 1400);
    });
    line.append(code, btn);
    wrap.append(line);
  }
  if (info.view_keyed && !(info.view_urls || []).length) {
    const off = document.createElement("div");
    off.className = "alias-hint";
    off.textContent = T("Start transmitting to get the read-only link.");
    wrap.append(off);
  }
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
        PerthToast.error(err.message);
      }
    });
    row.append(label, btn);
    body.append(row);
  }

  // Chave de acesso: só o host troca. Fora do `can_share` de propósito —
  // com o alcance preso no socket (host fixo) a chave continua valendo.
  if (info.host) body.append(shareKeyRow(body, info));
  if (info.host) body.append(shareViewRow(body, info));

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
      PerthToast.error(b.error || `HTTP ${res.status}`);
      return;
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (state.current.name || "chart") + ".png";
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    PerthToast.error(err.message);
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
  // grupo com ordem manual: a cópia fica ao lado do original, não no fim
  // (mesma regra do duplicate_task! do servidor)
  if (t.order) reorderSiblings(clones[0], t.order + 1);
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
  return saveNow();
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
    PerthToast.error(`${T("Import failed")}: ${err.message}`);
  }
});

/* Trocar o zoom guardava o lugar de ninguém: terminava sempre em
 * scrollToToday(). Você rolava até novembro, aproximava para ver o detalhe —
 * e voltava para hoje. Agora a DATA que estava sob os olhos (o meio da tela,
 * ou o ponteiro quando o zoom vem da roda) fica parada no mesmo ponto da
 * tela, que é o que qualquer mapa faz. Guardar pixel não serviria: o zoom
 * muda justamente quantos pixels vale um dia.
 *
 * Voltar para hoje continua a um toque de distância — é o botão Hoje e o `T`,
 * que existem exatamente para isso. */
function setZoom(z, { ancoraX = null } = {}) {
  const antes = state.range ? pontoDeVista(ancoraX) : null;
  state.zoom = z;
  localStorage.setItem("perth-zoom", z);
  $$(".zoom-group button").forEach((b) =>
    b.classList.toggle("active", b.dataset.zoom === z));
  renderAll();
  // no "caber" o projeto inteiro já está na tela: rolar seria desfazer o que
  // o botão acabou de fazer
  if (z === "fit") return;
  antes ? voltaAoPontoDeVista(antes) : scrollToToday();
}

// Onde o olho está, em data + distância da borda esquerda da janela
function pontoDeVista(ancoraX = null) {
  const caixa = el.tlBody.getBoundingClientRect();
  const dx = ancoraX === null ? el.tlBody.clientWidth / 2
                              : Math.min(Math.max(ancoraX - caixa.left, 0), caixa.width);
  return { data: dateAt(el.tlBody.scrollLeft + dx), dx };
}

function voltaAoPontoDeVista({ data, dx }) {
  rolaTimeline(xOf(data) - dx);
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
    PerthToast.error(`${T("Auto-schedule failed")}: ${err.message}`);
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
    PerthToast.error(`${T("Apply PERT estimates")}: ${err.message}`);
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
  "people": showPeople,
  "bands": showBands,
  "markers": () => showMarkers(),
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
  "zoom-fit": () => setZoom("fit"),
  "goto-today": scrollToToday,
  "activity": showActivity,
  "share": showShare,
  "share-toggle": toggleShare,
  "scurve": showSCurve,
  "resources": toggleResources,
  "stats": showStats,
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
  "shortcuts": showShortcuts,
  "glossary": showGlossary,
  "about": showAbout,
};

/* Atalhos e Sobre eram alert(): sem formatação, sem tradução e travando a
 * página. Viraram o mesmo overlay da Atividade e da curva-S. A lista em si
 * é desenhada por shared/shortcuts.js, que o kanban também usa. */
function showShortcuts() {
  showOverlay("Keyboard shortcuts", PerthShortcuts.list([
    ["↑ / ↓", "move the selection"],
    ["← / →", "collapse / expand a summary"],
    ["Home / End", "first / last task"],
    ["N", "new task"],
    ["Enter / duplo clique", "edit task"],
    ["Del", "delete selected task"],
    ["Ctrl+D", "duplicate selected task"],
    ["Ctrl+Z", "undo"],
    ["Ctrl+Shift+Z / Ctrl+Y", "redo"],
    ["S", "auto-schedule"],
    ["C", "toggle critical path"],
    ["R", "resource load"],
    ["D", "toggle dark mode"],
    ["P", "presentation mode"],
    ["1 / 2 / 3 / 4", "zoom day / week / month / fit"],
    ["Ctrl+roda", "zoom keeping the date under the pointer"],
    ["T", "go to today"],
    ["Esc", "close / deselect / exit presentation"],
  ]));
}

/* ------------------------------------------------------------------ */
/* Glossário                                                            */
/* ------------------------------------------------------------------ */

/* "⚠ 4 overallocations · ⚠ 1 past deadline" só é um aviso para quem já sabe
 * o que as palavras querem dizer. O vocabulário de um gantt — folga,
 * caminho crítico, baseline, PERT — é preciso e é aprendido; a barra de
 * status, a coluna de avisos e o modal usam todos ele, e até aqui o único
 * lugar onde estava explicado era a documentação do pacote, que quem abre o
 * navegador não lê.
 *
 * A ordem é a de quem está aprendendo, não a alfabética: primeiro as peças
 * do plano, depois o tempo, depois o que o motor calcula, e por fim os
 * avisos — que são justamente as palavras que aparecem quando algo dá
 * errado, ou seja, quando menos se quer abrir um manual. */
const GLOSSARY = [
  ["The plan", [
    ["Task", "A piece of work with a start and a duration — a bar on the chart."],
    ["Milestone", "A date with nothing lasting: a delivery, an approval, a signature. Drawn as a diamond and never has a duration."],
    ["Summary", "A task with subtasks. Its dates and its progress are not typed in — they are rolled up from its children."],
    ["WBS", "The breakdown of the plan into blocks and sub-blocks: which task is inside which. The indentation in the table is the WBS."],
    ["Sequence (#)", "The position of the row. Drag a row up or down to choose it; where nobody chose, rows come by start date."],
    ["Progress", "How much of the task is done, in percent. A summary averages its children, weighted by duration."],
  ]],
  ["Time", [
    ["Duration", "Length of the task in days. With a business-day calendar set, weekends and holidays do not count."],
    ["Dependency", "\"This only starts after that.\" Finish-to-start is the default; start-to-start and finish-to-finish tie the two starts or the two finishes; lag adds or removes days."],
    ["Auto-schedule", "Moves every task to the earliest date its dependencies allow. It never invents work — it only closes the gaps the plan does not need."],
    ["Pinned start", "A date fixed by hand — a contract, a delivery window. Auto-schedule leaves it alone, and says so when the plan no longer fits it."],
    ["Deadline", "A date the task must not finish after. It never moves anything: it turns the slack of this task, and of everything feeding it, negative."],
    ["Finish", "The end of the project as the engine computes it, from the dependencies and the durations."],
  ]],
  ["What the engine computes", [
    ["Critical path", "The chain of tasks with no slack. A day lost in any of them is a day lost by the whole project — which is why it is worth looking at first."],
    ["Slack", "How many days a task can slip before it starts pushing the finish. Zero slack is the critical path; negative slack is a promise already broken."],
    ["Baseline", "A frozen copy of the plan — what was promised. The ghost bars are the baseline; the difference between them and the bars is the slippage."],
    ["S-curve", "How much of the work was planned to be done by each date, drawn against how much is done. The gap between the two curves is the delay, in work rather than in days."],
    ["Workload", "How much each person has on each day. It is what turns a plan into a question about people."],
    ["PERT", "Three estimates instead of one — optimistic, most likely, pessimistic — worth (o + 4m + p) / 6 as the expected duration. It says how uncertain a task is, not only how long it is."],
    ["P80", "The finish date with an 80% chance of being met, from the PERT estimates. The date to promise when the plan has uncertainty in it."],
  ]],
  ["Warnings", [
    ["dependency cycle", "A waits for B and B waits for A. Nothing can be scheduled until the loop is cut — this is the one warning that stops the engine."],
    ["past deadline", "The task finishes after the date it had promised."],
    ["overdue", "The day has passed and the task is not at 100%."],
    ["overallocation", "The same person on two tasks on the same day."],
    ["behind the baseline", "The task is later than it was in the frozen plan."],
    ["starts before its dependencies allow", "The dates say one thing and the arrows say another: the task begins earlier than its predecessors let it. A dependency never moves anything on its own — auto-schedule (S) is what puts it where it can go, unless the start is pinned."],
  ]],
  ["On the chart", [
    ["Lanes", "Group the rows by person or by team, instead of by the WBS."],
    ["Calendar band", "A named stretch of calendar shaded behind the chart: a sprint, a shutdown, the rainy season. Annotation — it never moves a task."],
    ["Marked day", "A named vertical line across the chart, like the today line: an inspection, a hand-over, a holiday."],
    ["Cost", "The planned weight of the task, in whatever unit you use. Left at zero, the duration in person-days is the weight in the S-curve."],
  ]],
];

function showGlossary() {
  const body = document.createElement("div");
  body.className = "glossary";
  for (const [secao, itens] of GLOSSARY) {
    const h = document.createElement("h3");
    h.className = "gl-section";
    h.textContent = T(secao);
    body.append(h);
    for (const [termo, texto] of itens) {
      const row = document.createElement("div");
      row.className = "gl-row";
      const dt = document.createElement("span");
      dt.className = "gl-term";
      dt.textContent = T(termo);
      const dd = document.createElement("span");
      dd.className = "gl-desc";
      dd.textContent = T(texto);
      row.append(dt, dd);
      body.append(row);
    }
  }
  showOverlay("What the words mean", body);
}

function showAbout() {
  const body = document.createElement("div");
  body.className = "about-box";
  const p1 = document.createElement("p");
  p1.textContent = T("Gantt charts with a Julia backend.");
  const p2 = document.createElement("p");
  p2.textContent = T("Data lives on the local server; edit from the REPL too:");
  // Código Julia de exemplo, não texto de tela: só o nome do projeto e o
  // nome da tarefa de exemplo são traduzíveis
  const pre = document.createElement("pre");
  pre.className = "about-code";
  const projeto = state.current?.name ?? T("my project");
  pre.textContent = `p = project("${projeto}")\n` +
    `add_task!(p, "${T("Task")}"; start = today(), duration = 5)`;
  body.append(p1, p2, pre);
  showOverlay("About Perth", body);
}

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
// nota presa com clique fecha no clique de fora, como qualquer balão
document.addEventListener("click", (ev) => {
  if (!notaAberta?.fixo) return;
  if (ev.target.closest("#note-pop, .note-dot, .note-mark")) return;
  fechaNota();
});

document.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-action]");
  if (!btn) return;
  $$(".menu").forEach((m) => m.classList.remove("open"));
  if (WRITE_ACTIONS.has(btn.dataset.action) && !canEdit()) return;
  ACTIONS[btn.dataset.action]?.();
});

$("#btn-new-task").addEventListener("click", newTask);
$("#btn-today").addEventListener("click", scrollToToday);
el.warningsChip.addEventListener("click", showWarnings);
$$(".zoom-group button").forEach((b) =>
  b.addEventListener("click", () => setZoom(b.dataset.zoom)));

/* Busca de tarefa.
 *
 * Apagar quem não casa reaproveita o destaque inteiro (uma linha em
 * taskMatchesHighlight). O que a busca acrescenta é chegar lá: num projeto de
 * 141 tarefas, ver a linha acesa não adianta se ela está a 80 linhas de
 * distância — então a primeira que casa é rolada para a vista, e a contagem
 * diz se vale continuar digitando.
 */
/* Índices (na ordem da TELA, que o sortTasks define) das tarefas que casam.
   Recalculado a cada passo em vez de guardado: o projeto pode ter mudado por
   fora — outra máquina, o REPL, o arquivo espelhado — entre uma tecla e a
   seguinte, e um índice guardado apontaria para a tarefa errada. */
function searchHits() {
  if (!state.current || !state.search) return [];
  // ids, não índices: a tarefa pode estar numa raia fechada (revealTask
  // abre) ou ser um resumo que o agrupamento esconde — e aí ela não pode
  // contar, porque a contagem promete que dá para chegar em todas
  return state.current.tasks
    .filter((t) => matchesSearch(t) &&
                   !(state.groupBy && state.wbs?.summary.has(t.id)))
    .map((t) => t.id);
}

/* Leva à k-ésima ocorrência, dando a volta nas duas pontas. Seleciona a
   tarefa, e não só rola até ela: numa tela de 141 linhas, "está no meio da
   tela" ainda deixa procurar com o olho — a linha marcada não. */
function goToHit(k) {
  const hits = searchHits();
  if (!hits.length) return;
  const n = hits.length;
  state.searchAt = ((k % n) + n) % n;              // volta nas duas direções
  state.selected = hits[state.searchAt];
  revealTask(state.selected);
  el.taskSearchCount.textContent = `${state.searchAt + 1}/${n}`;
}

/* Traz a tarefa para a vista: seleciona, rola a lista até a linha e a linha
   do tempo até a barra. Usado pela busca e pelo painel de avisos — clicar num
   aviso tem que levar ao problema, não só nomeá-lo. */
function revealTask(id) {
  if (!state.current) return;
  const t = state.current.tasks.find((x) => x.id === id);
  if (!t) return;
  state.selected = id;
  // numa raia fechada — ou dentro de um resumo recolhido — é preciso ABRIR:
  // apontar para uma linha que não está na tela é pior do que não apontar
  if (state.groupBy) state.lanesClosed.delete(laneKeyOf(t));
  const byId = new Map(state.current.tasks.map((x) => [x.id, x]));
  for (let pai = t.parent; pai; pai = byId.get(pai)?.parent || "") {
    state.wbsClosed.delete(pai);
  }
  gravaDobras();   // abrir para revelar também é uma dobra a menos
  renderTable();
  renderChart();
  const linha = displayRows()
    .findIndex((r) => r.kind === "task" && r.task.id === id);
  if (linha < 0) return;   // resumo, escondido enquanto há raias
  // Rolar só na vertical não basta: a linha acende na tabela e a BARRA fica
  // fora da vista, porque ela está no tempo, não na lista. Num projeto de um
  // ano há meses de distância entre uma tarefa e a seguinte.
  //
  // Só mexe na horizontal quando a barra não está visível: percorrer com
  // Enter ocorrências vizinhas não pode ficar sacudindo a linha do tempo.
  const ppd = PPD[state.zoom];
  const x0 = xOf(parseDate(t.start));
  const x1 = xOf(taskEnd(t)) + ppd;                 // fim inclusive; marco = 1 dia
  const vis0 = el.tlBody.scrollLeft;
  const vis1 = vis0 + el.tlBody.clientWidth;
  const margem = 40;
  const alvoX = (x0 < vis0 + margem || x1 > vis1 - margem)
    ? Math.max(0, x0 - el.tlBody.clientWidth / 3)
    : vis0;

  // Um scrollTo só, e instantâneo. Atribuir scrollTop e scrollLeft em
  // sequência com scroll-behavior:smooth ligado faz uma animação cancelar a
  // outra — segurando Enter, o eixo horizontal simplesmente não saía do
  // lugar. Mesma razão do mirrorX ali em cima.
  el.tlBody.scrollTo({
    top: Math.max(0, linha * ROW_H - el.tlBody.clientHeight / 3),
    left: alvoX,
    behavior: "instant",
  });
}

function applySearch() {
  const bruto = el.taskSearch.value.trim();
  state.search = _semAcento(bruto);
  state.searchAt = 0;
  renderAll();
  if (!state.current) return;
  const hits = searchHits();
  el.taskSearchCount.hidden = !bruto;
  el.taskSearch.classList.toggle("empty-hit", !!bruto && !hits.length);
  if (!bruto) return;
  if (!hits.length) { el.taskSearchCount.textContent = `0/0`; return; }
  goToHit(0);
}

el.taskSearch.addEventListener("input", applySearch);
el.taskSearch.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    ev.stopPropagation();          // Esc aqui limpa a busca, não fecha nada
    el.taskSearch.value = "";
    applySearch();
    el.taskSearch.blur();
    return;
  }
  // Enter percorre as ocorrências, uma por vez, dando a volta no fim.
  // Shift+Enter volta — quem passou do ponto não precisa dar a volta inteira.
  if (ev.key === "Enter") {
    ev.preventDefault();           // não deixa virar submit de formulário
    ev.stopPropagation();          // nem abrir o modal pelo atalho global
    goToHit(state.searchAt + (ev.shiftKey ? -1 : 1));
  }
});

/* Raias ficam guardadas por navegador, como o zoom e o tema: é preferência
   de quem olha, não dado do projeto — cada um vê o mesmo plano do seu jeito. */
el.groupSelect.addEventListener("change", () => {
  state.groupBy = el.groupSelect.value;
  state.lanesClosed.clear();
  gravaDobras();
  localStorage.setItem("perth-lanes", state.groupBy);
  renderTable();
  renderChart();
});

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
  if (navegarComTeclado(ev)) { ev.preventDefault(); return; }
  // Undo / Redo globais
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z" && !ev.shiftKey) {
    ev.preventDefault();
    canEdit() && undo();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === "y" || (ev.key.toLowerCase() === "z" && ev.shiftKey))) {
    ev.preventDefault();
    canEdit() && redo();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "d") {
    ev.preventDefault();
    canEdit() && duplicateTask();
    return;
  }
  switch (ev.key) {
    // mesma tecla do kanban: quem alterna entre os dois não reaprende
    case "/": ev.preventDefault(); el.taskSearch.focus(); el.taskSearch.select(); break;
    case "n": case "N": canEdit() && newTask(); break;
    case "Delete": case "Backspace": canEdit() && deleteSelectedTask(); break;
    case "Enter": if (state.selected) openModal(state.selected); break;
    case "t": case "T": scrollToToday(); break;
    case "s": case "S": canEdit() && autoSchedule(); break;
    case "c": case "C": toggleCritical(); break;
    case "r": case "R": toggleResources(); break;
    case "d": case "D": toggleTheme(); break;
    case "p": case "P": togglePresentation(); break;
    case "1": setZoom("day"); break;
    case "2": setZoom("week"); break;
    case "3": setZoom("month"); break;
    case "4": setZoom("fit"); break;
    case "Escape":
      if (document.getElementById("note-pop")) { fechaNota(); break; }
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
/* Arrastar a divisa entre a tabela e o gráfico. A régua de largura já
   existia nas configurações; o que faltava era o gesto — ninguém abre um
   painel de preferências para ver um nome de tarefa que está cortado.

   Os limites saem da PRÓPRIA régua (min/max/step do input), não de números
   repetidos aqui: dois lugares com o mesmo limite escrito à mão é um lugar
   que vai ficar para trás. Arrastar também move a régua, e o passo é o dela
   — largura fora do passo faria o input arredondar em silêncio e os dois
   passariam a discordar em alguns pixels. */
const faixaTabela = () => {
  const reg = $("#set-tablew");
  return { min: Number(reg.min) || 260, max: Number(reg.max) || 560,
           passo: Number(reg.step) || 1 };
};

function setTableWidth(w, { gravar = true } = {}) {
  const { min, max, passo } = faixaTabela();
  const alvo = Math.min(Math.max(Math.round(w / passo) * passo, min), max);
  ui.tableWidth = alvo;
  document.documentElement.style.setProperty("--table-w", alvo + "px");
  $("#set-tablew").value = alvo;
  if (gravar) {
    saveUI();
    state.current && renderChart();
  }
  return alvo;
}

(function arrastarDivisa() {
  const alca = $("#tt-resizer");
  if (!alca) return;
  let x0 = 0, w0 = 0;

  // durante o arrasto só a variável CSS e a régua andam; redesenhar o SVG a
  // cada pixel deixaria o gesto pesado
  const mover = (ev) => setTableWidth(w0 + ev.clientX - x0, { gravar: false });
  const soltar = (ev) => {
    alca.releasePointerCapture?.(ev.pointerId);
    alca.classList.remove("dragging");
    document.body.classList.remove("resizing");
    alca.removeEventListener("pointermove", mover);
    alca.removeEventListener("pointerup", soltar);
    setTableWidth(ui.tableWidth);
  };

  alca.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    x0 = ev.clientX;
    w0 = ui.tableWidth;
    alca.setPointerCapture?.(ev.pointerId);
    alca.classList.add("dragging");
    document.body.classList.add("resizing");
    alca.addEventListener("pointermove", mover);
    alca.addEventListener("pointerup", soltar);
  });

  // duplo clique volta ao padrão: desfazer um arrasto infeliz sem ter de
  // acertar o pixel de onde ele começou
  alca.addEventListener("dblclick", () => setTableWidth(UI_DEFAULTS.tableWidth));

  // a divisa tem foco, então as setas também movem
  alca.addEventListener("keydown", (ev) => {
    const { passo } = faixaTabela();
    const d = ev.key === "ArrowLeft" ? -passo : ev.key === "ArrowRight" ? passo : 0;
    if (!d) return;
    ev.preventDefault();
    setTableWidth(ui.tableWidth + d);
  });
})();

$("#set-tablew").addEventListener("input", () => {
  setTableWidth(Number($("#set-tablew").value));
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
  // o papel antes dos dados: a primeira tela já sai sem os botões que
  // este link não pode usar, em vez de perdê-los um instante depois
  await refreshShareBtn();
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
  // o zoom é preferência de quem olha, como o tema: volta como estava
  const zoomGuardado = localStorage.getItem("perth-zoom");
  if (zoomGuardado && PPD[zoomGuardado] !== undefined) {
    state.zoom = zoomGuardado;
    $$(".zoom-group button").forEach((b) =>
      b.classList.toggle("active", b.dataset.zoom === zoomGuardado));
  }
  state.groupBy = localStorage.getItem("perth-lanes") || "";
  el.groupSelect.value = state.groupBy;
  // um valor guardado de uma versão futura/antiga não pode deixar o seletor
  // dizendo uma coisa e a tela mostrando outra
  if (el.groupSelect.value !== state.groupBy) state.groupBy = "";
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
      PerthToast.error(err.message);
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
