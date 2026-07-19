# Motor de scheduling: é aqui que o Perth deixa de ser uma view e passa a
# ser um pacote de verdade. Ordenação topológica (Kahn), detecção de ciclos,
# CPM (Critical Path Method) com forward/backward pass sobre datas, folga
# (slack) e reprogramação automática de sucessoras. Tudo puro Julia,
# utilizável sem navegador.

# Duração efetiva em dias (marcos ocupam o próprio dia)
_effdur(t::GanttTask) = t.milestone ? 1 : max(t.duration, 1)

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
        j = get(idx, d, 0)
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

    es = Vector{Date}(undef, n)
    ef = Vector{Date}(undef, n)
    for i in order                       # forward pass
        t = p.tasks[i]
        s = t.start
        for d in t.dependencies
            j = get(idx, d, 0)
            j == 0 && continue
            s = max(s, _day_after(cal, ef[j]))
        end
        es[i] = _snap(cal, s)
        ef[i] = _end_of(cal, es[i], _effdur(t))
    end

    finish = maximum(ef; init = Dates.today())
    lf = fill(finish, n)
    ls = Vector{Date}(undef, n)
    for i in reverse(order)              # backward pass
        if !isempty(succs[i])
            lf[i] = minimum(_day_before(cal, ls[j]) for j in succs[i])
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
