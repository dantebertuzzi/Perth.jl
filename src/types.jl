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
- `deadline::Union{Nothing,Date}`: a date the task must not finish after.
  It never moves the task — it caps the *late finish* in the CPM
  backward pass, so busting it turns the slack of this task and of
  everything feeding it negative. `nothing` = no commitment.
- `pinned::Bool`: the start date is fixed (a contract date, a delivery
  window). [`schedule!`](@ref) leaves it where it is; the engine still
  computes where it *would* go, so a pin the plan can no longer honour
  shows up as an `early_start` later than `start` in [`slack`](@ref)
  instead of the task silently moving.
- `optimistic::Int` / `most_likely::Int` / `pessimistic::Int`: the PERT
  three-point estimate, in the same days as `duration`. All three `0`
  (the default) means *no estimate*; see [`set_estimate!`](@ref) and
  [`pert`](@ref). They never move the task on their own — the expected
  duration `(o + 4m + p)/6` only reaches `duration` through
  [`pert!`](@ref), the same way [`schedule!`](@ref) is what moves dates.
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
    deadline::Union{Nothing,Date} = nothing
    pinned::Bool = false
    # Estimativa de três pontos (PERT); os três zerados = sem estimativa
    optimistic::Int = 0
    most_likely::Int = 0
    pessimistic::Int = 0
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

# Teto de tamanho pra texto livre vindo de fora (REST, WS, REPL): sem isso,
# um campo gigante — de um cliente malicioso, ou só um paste acidental —
# infla o projeto/board no disco pra sempre, sem cap de retenção como o
# log/chat do kanban têm. Mesmo valor no pacote inteiro (gantt e kanban).
const _TEXT_CAP = 2000
_cap_text(s::AbstractString) = length(s) > _TEXT_CAP ? first(s, _TEXT_CAP) : String(s)

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
    t.name = _cap_text(t.name)
    t.assignee = _cap_text(t.assignee)
    t.notes = _cap_text(t.notes)
    unique!(t.dependencies)
    # Baseline coerente: com snapshot, duração ≥ 1; sem snapshot, zero
    if t.baseline_start === nothing
        t.baseline_duration = 0
    else
        t.baseline_duration = max(t.baseline_duration, 1)
    end
    _normalize_estimate!(t)
    return t
end

# Estimativa de três pontos coerente (definida aqui porque _normalize! roda
# em todo salvamento; a análise em si vive em pert.jl).
#
# Estimativa parcial não é erro: quem preencheu só o pessimista está dizendo
# "pode ir até aí", e o resto vem da duração atual. A ordem é imposta
# empurrando para cima — o otimista é o piso, nunca o meio — em vez de
# ordenar os três, que trocaria valores de campo silenciosamente.
function _normalize_estimate!(t::GanttTask)
    if t.optimistic <= 0 && t.most_likely <= 0 && t.pessimistic <= 0
        t.optimistic = t.most_likely = t.pessimistic = 0   # sem estimativa
        return t
    end
    t.most_likely = t.most_likely > 0 ? t.most_likely : max(t.duration, 1)
    t.optimistic = t.optimistic > 0 ? t.optimistic : t.most_likely
    t.pessimistic = t.pessimistic > 0 ? t.pessimistic : t.most_likely
    t.most_likely = max(t.most_likely, t.optimistic)
    t.pessimistic = max(t.pessimistic, t.most_likely)
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
