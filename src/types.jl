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
- `order::Int`: position among its siblings, `1`-based. `0` (the default)
  means *no manual position*: the task falls back to the date ordering,
  after the ones that were placed by hand. Set by dragging a row in the
  UI or by [`move_task!`](@ref) — see [`ordered_tasks`](@ref).
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
    order::Int = 0                # posição manual entre irmãos; 0 = pela data
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
    Person(; name, role = "", team = "", email = "", notes = "")

A registered collaborator. `name` is the only field that matters to the
schedule — it is what a task's `assignee` holds. The rest is the address
book around it: who they are, so a name in a plan does not need a side
channel to be understood.

# Fields
- `name::String`: as it appears in `assignee`. Registering a name is what
  fixes its spelling everywhere (see [`people!`](@ref)).
- `role::String`: job title ("Arquiteta", "Eletricista").
- `team::String`: department, squad, company — whatever the org divides by.
- `email::String`: free text; nothing sends mail on its own.
- `notes::String`: anything else (phone, shift, holidays).
"""
Base.@kwdef mutable struct Person
    name::String = ""
    role::String = ""
    team::String = ""
    email::String = ""
    notes::String = ""
end

"""
    Band(; name, from, to, color = "")

A named stretch of calendar shaded behind the chart: a sprint, a shutdown, a
rainy season, the two weeks when the crane is on site. It is *annotation*,
not scheduling — a period never moves a task, constrains a date or enters the
CPM engine. It answers "why is this stretch different?", which until now had
to live in someone's head or in a note nobody opens.

# Fields
- `name::String`: written along the band, on its left edge.
- `from::Date` / `to::Date`: inclusive on both ends — a period of one day has
  `from == to`. Inverted ranges are swapped on save, the way a negative
  duration is clamped: it is a typo, not a plan.
- `color::String`: hex tint (e.g. `"#7cc4a4"`); empty picks one automatically.

Bands may overlap — a crunch week inside a sprint is a real thing to say.
"""
Base.@kwdef mutable struct Band
    name::String = ""
    from::Date = Dates.today()
    to::Date = Dates.today()
    color::String = ""
end

"""
    Marker(; name, date, color = "")

A named day, drawn as a vertical line across the chart — the way the *today*
line is drawn, and for the same reason: some dates matter to every task at
once. A delivery, an audit, the day the scaffolding comes down.

Like [`Band`](@ref) it is annotation: a marker never moves a task and never
enters the CPM engine. When a date must actually *bind* a task, that is a
`deadline` on the task, which does change its slack.

# Fields
- `name::String`: written along the line.
- `date::Date`: the day the line falls on.
- `color::String`: hex tint; empty picks one automatically.
- `label_at::Int`: how far down the chart the name is written, `0`–`100`
  percent of the chart height (`0`, the default, is the top). The name lies
  along the line, so wherever it sits it may land on top of a bar — this is
  what moves it out of the way. A percentage rather than pixels: the chart
  grows with the plan, and "a third of the way down" should stay a third of
  the way down.
"""
Base.@kwdef mutable struct Marker
    name::String = ""
    date::Date = Dates.today()
    color::String = ""
    label_at::Int = 0
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
    # Colaboradores cadastrados: alimenta o autocompletar do responsável e
    # dá nome (e cargo, setor…) a quem ainda não tem tarefa. Texto livre
    # continua valendo — a lista é conveniência e vocabulário, não cerca.
    people::Vector{Person} = Person[]

    # Faixas nomeadas do calendário (sprints, paradas, período de chuva).
    # São anotação: não movem tarefa nem entram no motor de CPM.
    bands::Vector{Band} = Band[]
    # Dias nomeados, desenhados como linha vertical (igual à linha de hoje)
    markers::Vector{Marker} = Marker[]
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
StructTypes.StructType(::Type{Person}) = StructTypes.Mutable()
StructTypes.StructType(::Type{Band}) = StructTypes.Mutable()
StructTypes.StructType(::Type{Marker}) = StructTypes.Mutable()
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

# Nome de pessoa, arrumado: sem espaço sobrando nas pontas nem no meio.
# Texto livre num campo de responsável fragmenta em silêncio — "Ana",
# "Ana " e "Ana  Paula" viram três pessoas para a carga, para a sobrecarga
# e para o destaque, e ninguém vê o motivo.
_clean_person(s::AbstractString) = _cap_text(replace(strip(s), r"\s+" => " "))

# Unifica grafias que só diferem em caixa. Ganha a PRIMEIRA que o projeto
# já conhece — cadastro antes das tarefas, tarefas na ordem do projeto.
#
# "A mais frequente" seria mais esperto e não funciona: a unificação roda a
# cada gravação, então quando a segunda grafia chega a primeira já é a única
# que existe e vence sozinha. Contar frequência daria a ilusão de uma regra
# que na prática é sempre "a primeira" — melhor dizer isso e ser previsível.
#
# Como o cadastro vem antes, ele é o jeito explícito de CORRIGIR uma grafia:
# people!(p, ["Ana Paula"]) reescreve os "ana paula" das tarefas. Digitar um
# nome numa tarefa nunca reescreve as tarefas dos outros.
#
# Acento NÃO é unificado de propósito: "Ana" e "Âna" podem ser duas pessoas,
# e o computador não tem como saber que não são.
function _unify_assignees!(p::Project)
    for t in p.tasks
        t.assignee = _clean_person(t.assignee)
    end
    p.people = _clean_people(p.people)

    canonico = Dict{String,String}()
    for nome in Iterators.flatten(((pe.name for pe in p.people),
                                   (t.assignee for t in p.tasks)))
        isempty(nome) && continue
        get!(canonico, lowercase(nome), nome)
    end
    for t in p.tasks
        isempty(t.assignee) && continue
        t.assignee = canonico[lowercase(t.assignee)]
    end
    return p
end

# Aceita o que for razoável escrever no REPL: "Ana", Person(...), ou uma
# NamedTuple/Dict com os campos. Um cadastro de pessoas que só aceitasse o
# construtor completo faria digitar Person(name = "Ana") para o caso comum.
_as_person(x::Person) = x
_as_person(s::AbstractString) = Person(; name = String(s))
_as_person(nt::NamedTuple) = Person(; nt...)
_as_person(d::AbstractDict) = Person(; (Symbol(k) => v for (k, v) in d)...)
_as_person(x) = throw(ArgumentError("cannot register $(repr(x)) as a person — " *
                                    "pass a name, a Person, or (; name, role, …)"))

# A lista de cadastrados: sem anônimos, sem repetição (nem de caixa),
# ordenada por nome — quem cadastra quer achar, e a ordem de digitação não
# ajuda. Repetido: fica o PRIMEIRO, que é quem tem os campos preenchidos
# quando o segundo veio só como nome solto.
function _clean_people(pessoas)
    out = Person[]
    vistos = Set{String}()
    for x in pessoas
        pe = _as_person(x)
        pe.name  = _clean_person(pe.name)
        pe.role  = _cap_text(strip(pe.role))
        pe.team  = _cap_text(strip(pe.team))
        pe.email = _cap_text(strip(pe.email))
        pe.notes = _cap_text(pe.notes)
        isempty(pe.name) && continue
        k = lowercase(pe.name)
        k in vistos && continue
        push!(vistos, k); push!(out, pe)
    end
    return sort!(out; by = pe -> lowercase(pe.name))
end

# Faixas arrumadas: sem nome vazio, ponta invertida virada, ordenadas por
# início. A ordem importa na tela — desenhar na ordem de digitação faria a
# faixa mais nova cobrir a mais antiga sem motivo.
function _clean_bands(faixas)
    out = Band[]
    for x in faixas
        f = x isa Band ? x : Band(; (Symbol(k) => v for (k, v) in pairs(x))...)
        f.name = _cap_text(replace(strip(f.name), r"\s+" => " "))
        f.color = strip(f.color)
        isempty(f.name) && continue
        f.from > f.to && ((f.from, f.to) = (f.to, f.from))
        push!(out, f)
    end
    return sort!(out; by = f -> (f.from, f.to, lowercase(f.name)))
end

# Marcos de calendário arrumados: sem nome vazio (uma linha que não diz o que
# marca é só um risco na tela), ordenados por data.
function _clean_markers(marcos)
    out = Marker[]
    for x in marcos
        m = x isa Marker ? x : Marker(; (Symbol(k) => v for (k, v) in pairs(x))...)
        m.name = _cap_text(replace(strip(m.name), r"\s+" => " "))
        m.color = strip(m.color)
        m.label_at = clamp(m.label_at, 0, 100)   # é porcentagem, não pixel
        isempty(m.name) && continue
        push!(out, m)
    end
    return sort!(out; by = m -> (m.date, lowercase(m.name)))
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
