# Tipos centrais do domínio: tarefas e projetos Gantt.
# Convenção: identificadores exportados em inglês, comentários em português.

"""
    GanttTask(; name, start, kwargs...)

A single task (or milestone) on the Gantt chart.

# Fields
- `id::String`: short unique identifier (auto-generated).
- `name::String`: task label shown on the chart.
- `start::Date`: first day of the task.
- `duration::Int`: duration in calendar days (≥ 1). Milestones ignore this.
- `progress::Int`: completion percentage, `0`–`100`.
- `dependencies::Vector{String}`: predecessor references. Plain ids mean
  finish-to-start; `"id+3"`/`"id-2"` add lag/lead in days; `"SS:id"` and
  `"FF:id"` (optionally with lag) declare start-to-start / finish-to-finish.
- `cost::Float64`: planned cost (any unit). `0` = use duration (person-days)
  as the weight in S-curve analytics.
- `color::String`: hex color (e.g. `"#bd93f9"`); empty string means automatic.
- `assignee::String`: person or resource responsible.
- `notes::String`: free-form notes.
- `milestone::Bool`: render as a diamond marker instead of a bar.
- `parent::String`: id of the parent task (WBS). A task with children is a
  *summary*: its `start`, `duration` and `progress` are derived from its
  descendants on every save (see [`set_parent!`](@ref)).
- `baseline_start::Union{Nothing,Date}` / `baseline_duration::Int`:
  snapshot taken by [`set_baseline!`](@ref); `nothing`/`0` = no baseline.
"""
Base.@kwdef mutable struct GanttTask
    id::String = _short_id()
    name::String = ""
    start::Date = Dates.today()
    duration::Int = 1
    progress::Int = 0
    dependencies::Vector{String} = String[]
    color::String = ""
    assignee::String = ""
    notes::String = ""
    milestone::Bool = false
    cost::Float64 = 0.0
    parent::String = ""
    baseline_start::Union{Nothing,Date} = nothing
    baseline_duration::Int = 0
end

"""
    Project(; name, kwargs...)

A project: a named collection of [`GanttTask`](@ref)s.
"""
Base.@kwdef mutable struct Project
    id::String = _short_id()
    name::String = ""
    tasks::Vector{GanttTask} = GanttTask[]
    calendar::String = ""    # nome de calendário BusinessDays; vazio = dias corridos
    # Caminho de espelhamento em disco (estilo Pluto): quando não vazio, cada
    # salvamento também grava o .perth.jl neste caminho. Específico da máquina,
    # por isso NUNCA entra no formato de intercâmbio .perth.jl exportado.
    file_path::String = ""
    # Quando o baseline foi tirado (set_baseline!); nothing = sem baseline
    baseline_at::Union{Nothing,DateTime} = nothing
    created_at::DateTime = Dates.now()
    updated_at::DateTime = Dates.now()
end

# Serialização JSON via StructTypes (JSON3 cuida de Date/DateTime como ISO-8601)
StructTypes.StructType(::Type{GanttTask}) = StructTypes.Mutable()
StructTypes.StructType(::Type{Project}) = StructTypes.Mutable()

# Gera um id curto (8 hex) a partir de um UUID v4
_short_id() = string(UUIDs.uuid4())[1:8]

"""
    end_date(t::GanttTask) -> Date

Last day covered by the task. A task starting today with `duration = 1`
ends today; milestones start and end on the same day.
"""
end_date(t::GanttTask) =
    t.milestone ? t.start : t.start + Dates.Day(max(t.duration, 1) - 1)

"""
    span(p::Project) -> Tuple{Date,Date}

Earliest start and latest end among the project's tasks.
Falls back to `(today, today)` for empty projects.
"""
function span(p::Project)
    isempty(p.tasks) && return (Dates.today(), Dates.today())
    # end_date(p, t) é ciente do calendário (definido em schedule.jl;
    # resolvido em tempo de chamada)
    (minimum(t.start for t in p.tasks), maximum(end_date(p, t) for t in p.tasks))
end

# Valida e normaliza uma tarefa antes de persistir (limites de progresso etc.)
function _normalize!(t::GanttTask)
    t.duration = max(t.duration, 1)
    t.cost = max(t.cost, 0.0)
    t.progress = clamp(t.progress, 0, 100)
    unique!(t.dependencies)
    # Baseline coerente: com snapshot, duração ≥ 1; sem snapshot, zero
    if t.baseline_start === nothing
        t.baseline_duration = 0
    else
        t.baseline_duration = max(t.baseline_duration, 1)
    end
    return t
end

# Remove dependências que apontam para ids inexistentes ou para a própria tarefa
function _prune_dependencies!(p::Project)
    ids = Set(t.id for t in p.tasks)
    for t in p.tasks
        # _dep_id (schedule.jl) entende lag ("id+3") e tipo ("SS:id")
        filter!(d -> _dep_id(d) in ids && _dep_id(d) != t.id, t.dependencies)
    end
    return p
end
