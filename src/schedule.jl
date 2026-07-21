# Motor de scheduling: é aqui que o Perth deixa de ser uma view e passa a
# ser um pacote de verdade. Ordenação topológica (Kahn), detecção de ciclos,
# CPM (Critical Path Method) com forward/backward pass sobre datas, folga
# (slack) e reprogramação automática de sucessoras. Tudo puro Julia,
# utilizável sem navegador.

# Duração efetiva em dias (marcos ocupam o próprio dia)
_effdur(t::GanttTask) = t.milestone ? 1 : max(t.duration, 1)

# ---------------------------------------------------------------------------
# Referências de dependência. Formato retrocompatível baseado em String:
#   "id"        finish-to-start (default)
#   "id+3"      FS com lag de 3 dias      "id-2"   FS com lead de 2 dias
#   "SS:id+1"   start-to-start (+lag)     "FF:id"  finish-to-finish (+lag)
# O lag respeita o calendário do projeto (dias úteis com BusinessDays).
# ---------------------------------------------------------------------------

function _parse_dep(d::AbstractString)
    s = String(d)
    typ = :FS
    if startswith(s, "SS:")
        typ = :SS; s = s[4:end]
    elseif startswith(s, "FF:")
        typ = :FF; s = s[4:end]
    end
    m = match(r"^(.+?)([+-]\d+)$", s)
    m === nothing && return (id = s, type = typ, lag = 0)
    return (id = String(m.captures[1]), type = typ,
            lag = parse(Int, m.captures[2]))
end

_dep_id(d::AbstractString) = _parse_dep(d).id

# ---------------------------------------------------------------------------
# Abstração de calendário. O fallback é dias corridos; a extensão
# PerthBusinessDaysExt fornece a implementação em dias úteis quando
# BusinessDays.jl está carregado (weakdep).
# ---------------------------------------------------------------------------

abstract type AbstractCalendar end
struct CalendarDays <: AbstractCalendar end

_cal(p::Project) = isempty(p.calendar) ? CalendarDays() : _business_calendar(p.calendar)

# Sobrescrita pela extensão; sem ela, calendário nomeado é um erro claro
_business_calendar(name::String) = error(
    "Perth: project uses business-day calendar $(repr(name)). " *
    "Run `using BusinessDays` to enable it (weak dependency).")

_snap(::CalendarDays, d::Date) = d                                # próximo dia válido
_end_of(::CalendarDays, s::Date, dur::Int) = s + Dates.Day(dur - 1)
_start_of(::CalendarDays, e::Date, dur::Int) = e - Dates.Day(dur - 1)
_day_after(::CalendarDays, d::Date) = d + Dates.Day(1)
_day_before(::CalendarDays, d::Date) = d - Dates.Day(1)
_gap(::CalendarDays, a::Date, b::Date) = Dates.value(b - a)       # folga entre datas

# Desloca uma data n dias válidos no calendário (n pode ser negativo).
# Definida aqui, após _day_after/_day_before, e usada pelo CPM com lag.
function _shift(cal::AbstractCalendar, d::Date, n::Int)
    while n > 0; d = _day_after(cal, d); n -= 1; end
    while n < 0; d = _day_before(cal, d); n += 1; end
    return d
end

# Duração (em dias válidos do calendário) de start até due, inclusive.
# É a inversa de _end_of: _end_of(cal, snap(s), _dur_between(cal, s, e)) == e.
# Usada pela ponte kanban->gantt (prazo do card -> duração da tarefa).
function _dur_between(cal::AbstractCalendar, s::Date, e::Date)
    d = _snap(cal, s)
    e <= d && return 1
    n = 1
    while d < e && n < 3660     # sanidade: 10 anos
        d = _day_after(cal, d)
        n += 1
    end
    return n
end

"""
    set_calendar!(p::Project, name::AbstractString) -> Project

Set the project's working-day calendar (a BusinessDays.jl calendar name,
e.g. `"Brazil"`, `"BRSettlement"`, `"USSettlement"`, `"WeekendsOnly"`).
Durations are then interpreted as *business days* by the scheduling
engine. Pass `""` to revert to calendar days. Requires `using
BusinessDays` for scheduling to run. Persists the change.
"""
function set_calendar!(p::Project, name::AbstractString)
    p.calendar = String(name)
    _with_state(st -> _save!(st, p))
    return p
end

"""
    end_date(p::Project, t::GanttTask) -> Date

Calendar-aware task end: with a business-day calendar set on `p`, a
5-day task starting Thursday ends on the following Wednesday.
"""
end_date(p::Project, t::GanttTask) =
    t.milestone ? t.start : _end_of(_cal(p), _snap(_cal(p), t.start), _effdur(t))

# Visão de folhas: resumos WBS são contêineres, não trabalho — o motor
# CPM opera só nas tarefas sem filhos. As referências são compartilhadas,
# então schedule! mutando a visão muta o projeto real; dependências que
# apontam para resumos viram órfãs na visão e são ignoradas pelo motor.
function _leaf_view(p::Project)
    any(t -> !isempty(t.parent), p.tasks) || return p
    leaves = [t for t in p.tasks if !_has_children(p, t.id)]
    return Project(id = p.id, name = p.name, tasks = leaves,
                   calendar = p.calendar)
end

# Ordenação topológica de p.tasks via Kahn. Retorna (ordem de índices,
# lista de sucessores por índice). Lança ArgumentError se houver ciclo.
function _toposort(p::Project)
    n = length(p.tasks)
    idx = Dict(t.id => i for (i, t) in enumerate(p.tasks))
    indeg = zeros(Int, n)
    succs = [Int[] for _ in 1:n]
    for (i, t) in enumerate(p.tasks), d in t.dependencies
        j = get(idx, _dep_id(d), 0)
        j == 0 && continue          # referência órfã: ignorada (poda salva depois)
        push!(succs[j], i)
        indeg[i] += 1
    end
    queue = [i for i in 1:n if indeg[i] == 0]
    order = Int[]
    while !isempty(queue)
        i = popfirst!(queue)
        push!(order, i)
        for j in succs[i]
            indeg[j] -= 1
            indeg[j] == 0 && push!(queue, j)
        end
    end
    if length(order) != n
        stuck = [p.tasks[i].name for i in 1:n if indeg[i] > 0]
        throw(ArgumentError("dependency cycle involving: " * join(stuck, ", ")))
    end
    return order, succs
end

"""
    has_cycle(p::Project) -> Bool

Whether the project's dependency graph contains a cycle.
"""
function has_cycle(p::Project)
    try
        _toposort(_leaf_view(p))
        return false
    catch err
        err isa ArgumentError && return true
        rethrow()
    end
end

# CPM completo. Retorna NamedTuple de vetores alinhados a p.tasks:
# es/ef (early start/finish), ls/lf (late start/finish), slack em dias.
# Datas manuais funcionam como restrição "não antes de" (start-no-earlier-than).
function _cpm(p::Project)
    order, succs = _toposort(p)
    cal = _cal(p)
    n = length(p.tasks)
    idx = Dict(t.id => i for (i, t) in enumerate(p.tasks))

    # arestas tipadas por PREDECESSOR: succ_edges[j] = [(i, dep), ...]
    succ_edges = [Tuple{Int,NamedTuple}[] for _ in 1:n]
    for (i, t) in enumerate(p.tasks), d in t.dependencies
        dep = _parse_dep(d)
        j = get(idx, dep.id, 0)
        j == 0 && continue
        push!(succ_edges[j], (i, dep))
    end

    es = Vector{Date}(undef, n)
    ef = Vector{Date}(undef, n)
    for i in order                       # forward pass
        t = p.tasks[i]
        s = t.start
        for d in t.dependencies
            dep = _parse_dep(d)
            j = get(idx, dep.id, 0)
            j == 0 && continue
            if dep.type === :SS          # começa junto com o predecessor (+lag)
                s = max(s, _shift(cal, es[j], dep.lag))
            elseif dep.type === :FF      # termina junto (+lag): recua ao início
                s = max(s, _start_of(cal,
                        _shift(cal, ef[j], dep.lag), _effdur(t)))
            else                         # FS (+lag)
                s = max(s, _shift(cal, _day_after(cal, ef[j]), dep.lag))
            end
        end
        es[i] = _snap(cal, s)
        ef[i] = _end_of(cal, es[i], _effdur(t))
    end

    finish = maximum(ef; init = Dates.today())
    lf = fill(finish, n)
    ls = Vector{Date}(undef, n)
    for i in reverse(order)              # backward pass (ciente de tipo/lag)
        for (k, dep) in succ_edges[i]
            lim = if dep.type === :SS    # restrição no início: converte p/ fim
                _end_of(cal, _shift(cal, ls[k], -dep.lag), _effdur(p.tasks[i]))
            elseif dep.type === :FF
                _shift(cal, lf[k], -dep.lag)
            else                         # FS
                _shift(cal, _day_before(cal, ls[k]), -dep.lag)
            end
            lf[i] = min(lf[i], lim)
        end
        ls[i] = _start_of(cal, lf[i], _effdur(p.tasks[i]))
    end

    slack = [_gap(cal, ef[i], lf[i]) for i in 1:n]
    return (; es, ef, ls, lf, slack, finish)
end

"""
    schedule!(p::Project) -> Project

Reschedule the project so that no task starts before all of its
dependencies have finished. Each task's own start date acts as a
*start-no-earlier-than* constraint: tasks are only pushed forward,
never pulled back. Persists the result.

Throws `ArgumentError` if the dependency graph has a cycle.
"""
function schedule!(p::Project)
    lv = _leaf_view(p)                 # resumos derivam; só folhas movem
    cpm = _cpm(lv)
    for (i, t) in enumerate(lv.tasks)
        t.start = cpm.es[i]
    end
    _with_state(st -> _save!(st, p))   # _save! refaz o rollup dos resumos
    return p
end

"""
    critical_path(p::Project) -> Vector{String}

Ids of the tasks on the critical path (zero slack), in topological
order. Delaying any of these delays the whole project.
"""
function critical_path(p::Project)
    lv = _leaf_view(p)
    isempty(lv.tasks) && return String[]
    cpm = _cpm(lv)
    order, _ = _toposort(lv)
    return [lv.tasks[i].id for i in order if cpm.slack[i] == 0]
end

"""
    slack(p::Project) -> Vector{NamedTuple}

Per-task CPM summary as Tables.jl-compatible rows: `id`, `name`,
`early_start`, `early_finish`, `slack_days`, `critical`.
"""
function slack(p::Project)
    lv = _leaf_view(p)
    isempty(lv.tasks) && return NamedTuple[]
    cpm = _cpm(lv)
    order, _ = _toposort(lv)
    return [(id = lv.tasks[i].id, name = lv.tasks[i].name,
             early_start = cpm.es[i], early_finish = cpm.ef[i],
             slack_days = cpm.slack[i], critical = cpm.slack[i] == 0)
            for i in order]
end

"""
    project_finish(p::Project) -> Date

Earliest possible finish date of the whole project under the current
dependency structure (CPM forward pass).
"""
project_finish(p::Project) =
    isempty(_leaf_view(p).tasks) ? Dates.today() : _cpm(_leaf_view(p)).finish
