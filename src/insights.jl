# Camada analítica: baseline (plano original vs. atual), interface
# Tables.jl (as tarefas como linhas prontas para DataFrame/CSV, e a via
# inversa: construir tarefas a partir de qualquer tabela) e detecção de
# superalocação de responsáveis. Tudo Tables.jl-friendly, no espírito do
# resto do ecossistema.

# ---------------------------------------------------------------------------
# Baseline
# ---------------------------------------------------------------------------

"""
    set_baseline!(p::Project) -> Project

Snapshot the current plan: every task's `start`/`duration` is copied to
its `baseline_start`/`baseline_duration`, and `p.baseline_at` records
when. The web UI then draws the baseline as ghost bars and flags
*slipped* tasks; [`slippage`](@ref) reports the deviation. Persists.
"""
function set_baseline!(p::Project)
    for t in p.tasks
        t.baseline_start = t.start
        t.baseline_duration = _effdur(t)
    end
    p.baseline_at = Dates.now()
    _with_state(st -> _save!(st, p))
    return p
end

"""
    clear_baseline!(p::Project) -> Project

Remove the baseline snapshot from every task and from the project.
Persists.
"""
function clear_baseline!(p::Project)
    for t in p.tasks
        t.baseline_start = nothing
        t.baseline_duration = 0
    end
    p.baseline_at = nothing
    _with_state(st -> _save!(st, p))
    return p
end

"""
    has_baseline(t::GanttTask) -> Bool

Whether the task carries a baseline snapshot.
"""
has_baseline(t::GanttTask) = t.baseline_start !== nothing

# Fim planejado no baseline, ciente do calendário do projeto
_baseline_end(p::Project, t::GanttTask) =
    _end_of(_cal(p), _snap(_cal(p), t.baseline_start),
            max(t.baseline_duration, 1))

"""
    slippage(p::Project) -> Vector{NamedTuple}

Tables.jl-compatible rows comparing the current plan against the
baseline, for every task that has one: `id`, `name`, `baseline_start`,
`baseline_finish`, `start`, `finish` and `slip_days` (positive = the
task now ends later than planned; calendar days).
"""
function slippage(p::Project)
    out = NamedTuple[]
    for (t, _) in ordered_tasks(p)
        has_baseline(t) || continue
        bfin = _baseline_end(p, t)
        fin = end_date(p, t)
        push!(out, (id = t.id, name = t.name,
                    baseline_start = t.baseline_start, baseline_finish = bfin,
                    start = t.start, finish = fin,
                    slip_days = Dates.value(fin - bfin)))
    end
    return out
end

"""
    slippage(p::Project, id::AbstractString) -> Int

Slip of one task in calendar days (positive = later than the baseline).
Throws if the task has no baseline.
"""
function slippage(p::Project, id::AbstractString)
    i = findfirst(t -> t.id == id, p.tasks)
    i === nothing && throw(KeyError(String(id)))
    t = p.tasks[i]
    has_baseline(t) ||
        throw(ArgumentError("task $(repr(t.name)) has no baseline — call set_baseline!(p)"))
    return Dates.value(end_date(p, t) - _baseline_end(p, t))
end

# ---------------------------------------------------------------------------
# Tables.jl: exportar e importar tarefas como tabelas
# ---------------------------------------------------------------------------

"""
    tasktable(p::Project) -> Vector{NamedTuple}

The project's tasks as Tables.jl-compatible rows in WBS display order —
ready for `DataFrame(tasktable(p))`, `CSV.write`, etc. Columns: `id`,
`name`, `wbs_depth`, `parent`, `summary`, `start`, `duration`, `finish`
(calendar-aware), `progress`, `assignee`, `dependencies`, `color`,
`notes`, `milestone`, `baseline_start`, `baseline_finish`, `slip_days`
(`missing` without a baseline).
"""
function tasktable(p::Project)
    rows = NamedTuple[]
    for (t, d) in ordered_tasks(p)
        bfin = has_baseline(t) ? _baseline_end(p, t) : missing
        push!(rows, (
            id = t.id, name = t.name, wbs_depth = d, parent = t.parent,
            summary = is_summary(p, t),
            start = t.start, duration = t.duration, finish = end_date(p, t),
            progress = t.progress, assignee = t.assignee,
            dependencies = copy(t.dependencies), color = t.color,
            notes = t.notes, milestone = t.milestone,
            baseline_start = something(t.baseline_start, missing),
            baseline_finish = bfin,
            slip_days = bfin === missing ? missing :
                        Dates.value(end_date(p, t) - bfin),
        ))
    end
    return rows
end

# Leitura tolerante de uma célula da tabela: coluna ausente ou missing
# vira o default
function _cell(row, name::Symbol, default)
    name in Tables.columnnames(row) || return default
    v = Tables.getcolumn(row, name)
    return v === missing ? default : v
end

_as_date(v::Date) = v
_as_date(v) = Date(String(v))
_as_deps(v::AbstractVector) = String.(v)
_as_deps(v::AbstractString) =
    [String(strip(s)) for s in split(v, r"[;,]") if !isempty(strip(s))]

"""
    add_tasks!(p::Project, table) -> Project

Append tasks to `p` from any Tables.jl source (`DataFrame`, `CSV.File`,
a vector of `NamedTuple`s, …). Required column: `name`. Optional
columns: `start` (`Date` or ISO string), `duration`, `progress`,
`assignee`, `notes`, `color`, `milestone`, `parent` and `dependencies`
(a vector of ids, or a `";"`/`","`-separated string). Persists once at
the end — invalid parents and dependency references are pruned on save.
"""
function add_tasks!(p::Project, table)
    Tables.istable(table) ||
        throw(ArgumentError("add_tasks!: argument is not a Tables.jl table"))
    for row in Tables.rows(table)
        name = _cell(row, :name, nothing)
        (name === nothing || isempty(strip(String(name)))) &&
            throw(ArgumentError("add_tasks!: every row needs a non-empty `name`"))
        t = GanttTask(;
            name = String(name),
            start = _as_date(_cell(row, :start, Dates.today())),
            duration = Int(_cell(row, :duration, 1)),
            progress = Int(_cell(row, :progress, 0)),
            dependencies = _as_deps(_cell(row, :dependencies, String[])),
            color = String(_cell(row, :color, "")),
            assignee = String(_cell(row, :assignee, "")),
            notes = String(_cell(row, :notes, "")),
            milestone = Bool(_cell(row, :milestone, false)),
            parent = String(_cell(row, :parent, "")),
        )
        _normalize!(t)
        push!(p.tasks, t)
    end
    _with_state(st -> _save!(st, p))
    return p
end

# ---------------------------------------------------------------------------
# Superalocação de responsáveis
# ---------------------------------------------------------------------------

"""
    overallocations(p::Project) -> Vector{NamedTuple}

Pairs of *leaf* tasks assigned to the same person whose date ranges
overlap — Tables.jl-compatible rows with `assignee`, `task1`,
`task1_name`, `task2`, `task2_name`, `from` and `to` (the overlapping
interval, calendar-aware ends). Summaries are containers, not work, so
they are ignored.
"""
function overallocations(p::Project)
    leaves = [t for t in p.tasks
              if !_has_children(p, t.id) && !isempty(strip(t.assignee))]
    sort!(leaves; by = t -> (lowercase(strip(t.assignee)), t.start, t.name))
    out = NamedTuple[]
    for i in 1:length(leaves)-1, j in i+1:length(leaves)
        a, b = leaves[i], leaves[j]
        strip(a.assignee) == strip(b.assignee) || continue
        from = max(a.start, b.start)
        to = min(end_date(p, a), end_date(p, b))
        from <= to && push!(out, (
            assignee = String(strip(a.assignee)),
            task1 = a.id, task1_name = a.name,
            task2 = b.id, task2_name = b.name,
            from = from, to = to))
    end
    return out
end


# ---------------------------------------------------------------------------
# Curva S: custo/trabalho planejado acumulado ao longo do tempo.
# Peso de cada tarefa = cost (se > 0) ou duração em dias (pessoa-dias).
# "planned" usa o baseline quando existe (senão o plano atual), distribuído
# uniformemente pela duração; "actual" acumula o valor agregado (peso ×
# progresso) distribuído pelo trecho já decorrido de cada tarefa.
# ---------------------------------------------------------------------------

function _scurve(p::Project)
    leaves = [t for t in _leaf_view(p).tasks if !t.milestone]
    isempty(leaves) && return (; dates = String[], planned = Float64[],
                                actual = Float64[], today = string(Dates.today()),
                                total = 0.0, planned_today = 0.0, earned_today = 0.0)
    w(t) = t.cost > 0 ? t.cost : Float64(_effdur(t))
    pstart(t) = t.baseline_start === nothing ? t.start : t.baseline_start
    pdur(t) = t.baseline_start === nothing ? _effdur(t) : max(t.baseline_duration, 1)
    today = Dates.today()
    d0 = min(minimum(pstart.(leaves)), minimum(t.start for t in leaves))
    d1 = max(maximum(pstart(t) + Dates.Day(pdur(t) - 1) for t in leaves),
             maximum(end_date(p, t) for t in leaves), today)
    ndays = Dates.value(d1 - d0) + 1
    ndays > 3660 && return (; error = "span too large")   # sanidade: 10 anos
    planned = zeros(Float64, ndays)
    actual = zeros(Float64, ndays)
    at(d) = Dates.value(d - d0) + 1
    for t in leaves
        # planejado: peso uniforme por dia da janela do baseline/plano
        per = w(t) / pdur(t)
        for k in 0:(pdur(t) - 1)
            planned[clamp(at(pstart(t)) + k, 1, ndays)] += per
        end
        # realizado: valor agregado espalhado pelos dias já decorridos
        earned = w(t) * clamp(t.progress, 0, 100) / 100
        first_d = at(t.start)
        last_d = min(at(min(end_date(p, t), today)), ndays)
        span_d = max(last_d - first_d + 1, 1)
        if earned > 0 && first_d <= ndays
            per = earned / span_d
            for k in 0:(span_d - 1)
                idx = first_d + k
                1 <= idx <= ndays && (actual[idx] += per)
            end
        end
    end
    cumsum!(planned, planned)
    cumsum!(actual, actual)
    ti = clamp(at(today), 1, ndays)
    return (; dates = [string(d0 + Dates.Day(k)) for k in 0:(ndays - 1)],
            planned, actual = actual[1:ti],
            today = string(today), total = planned[end],
            planned_today = planned[ti], earned_today = actual[ti])
end
