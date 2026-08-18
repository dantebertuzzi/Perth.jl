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
(calendar-aware), `deadline`, `deadline_slip` (calendar days past it;
`missing` without a deadline), `pinned`, `progress`, `assignee`,
`dependencies`, `color`, `notes`, `milestone`, `baseline_start`,
`baseline_finish`, `slip_days` (`missing` without a baseline),
`optimistic`, `most_likely`, `pessimistic` and `expected` — the PERT
three-point estimate and the duration it implies (all `missing` on a
task without an estimate).
"""
function tasktable(p::Project)
    rows = NamedTuple[]
    for (t, d) in ordered_tasks(p)
        bfin = has_baseline(t) ? _baseline_end(p, t) : missing
        push!(rows, (
            id = t.id, name = t.name, wbs_depth = d, parent = t.parent,
            summary = is_summary(p, t),
            start = t.start, duration = t.duration, finish = end_date(p, t),
            deadline = something(t.deadline, missing),
            deadline_slip = t.deadline === nothing ? missing :
                            Dates.value(end_date(p, t) - t.deadline),
            pinned = t.pinned,
            progress = t.progress, assignee = t.assignee,
            dependencies = copy(t.dependencies), color = t.color,
            notes = t.notes, milestone = t.milestone,
            baseline_start = something(t.baseline_start, missing),
            baseline_finish = bfin,
            slip_days = bfin === missing ? missing :
                        Dates.value(end_date(p, t) - bfin),
            optimistic = has_estimate(t) ? t.optimistic : missing,
            most_likely = has_estimate(t) ? t.most_likely : missing,
            pessimistic = has_estimate(t) ? t.pessimistic : missing,
            expected = has_estimate(t) ? expected_duration(t) : missing,
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
# Prazo é opcional: coluna ausente, vazia ou missing = sem compromisso
_as_deadline(::Nothing) = nothing
_as_deadline(v::AbstractString) = isempty(strip(v)) ? nothing : Date(String(strip(v)))
_as_deadline(v) = _as_date(v)
_as_deps(v::AbstractVector) = String.(v)
_as_deps(v::AbstractString) =
    [String(strip(s)) for s in split(v, r"[;,]") if !isempty(strip(s))]

"""
    add_tasks!(p::Project, table) -> Project

Append tasks to `p` from any Tables.jl source (`DataFrame`, `CSV.File`,
a vector of `NamedTuple`s, …). Required column: `name`. Optional
columns: `start` (`Date` or ISO string), `duration`, `progress`,
`assignee`, `notes`, `color`, `milestone`, `deadline`, `pinned`,
`optimistic`, `most_likely`, `pessimistic` (the PERT three-point
estimate), `parent` and `dependencies` (a vector of ids, or a
`";"`/`","`-separated string). Persists once at the end — invalid
parents and dependency references are pruned on save.

The estimate is recorded, not applied: `duration` stays whatever the
table says until [`pert!`](@ref) runs.
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
            deadline = _as_deadline(_cell(row, :deadline, nothing)),
            pinned = Bool(_cell(row, :pinned, false)),
            optimistic = Int(_cell(row, :optimistic, 0)),
            most_likely = Int(_cell(row, :most_likely, 0)),
            pessimistic = Int(_cell(row, :pessimistic, 0)),
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

Pairs of *leaf* tasks assigned to the same person that share at least one
**overloaded day** — Tables.jl-compatible rows with `assignee`, `task1`,
`task1_name`, `task2`, `task2_name`, `from` and `to` (the first and last
overloaded day the two share). Summaries are containers, not work, so they
are ignored.

What counts as overloaded is the one definition the whole package uses (see
[`workload`](@ref)): with a `capacity` declared for the person, a day whose
work exceeds it; without one, a day carrying two or more tasks. So declaring
`capacity = 8` and two one-hour tasks makes the pair *stop* being reported —
which is the entire point of declaring it.

Only working days count. Under a business-day calendar
([`set_calendar!`](@ref)) two tasks that merely touch across a weekend never
share a day of work, and are not a conflict.
"""
function overallocations(p::Project)
    # Os dias sobrecarregados de cada pessoa vêm de _workload_rows: uma
    # definição só, e por construção este par a par não pode discordar do
    # painel de recursos, das estatísticas nem do aviso na tela. Antes eram
    # duas contas independentes que só por sorte davam a mesma resposta.
    dias = Dict{String,Vector{Date}}()
    tarefas = Dict{Tuple{String,Date},Vector{String}}()
    for r in _workload_rows(p)
        r.over || continue
        push!(get!(dias, r.assignee, Date[]), r.date)
        tarefas[(r.assignee, r.date)] = r.task_ids
    end
    isempty(dias) && return NamedTuple[]

    nomes = Dict(t.id => t.name for t in p.tasks)
    out = NamedTuple[]
    for who in sort!(collect(keys(dias)); by = lowercase)
        # (par de tarefas) -> dias sobrecarregados em que as duas correm
        juntos = Dict{Tuple{String,String},Vector{Date}}()
        for d in dias[who]
            ids = sort!(copy(tarefas[(who, d)]))
            for i in 1:length(ids)-1, j in i+1:length(ids)
                push!(get!(juntos, (ids[i], ids[j]), Date[]), d)
            end
        end
        # Um dia sobrecarregado com UMA tarefa só (possível com capacidade:
        # uma tarefa pesada sozinha já estoura o dia) não forma par — quem o
        # denuncia é o painel de recursos e o `over_days` das estatísticas.
        for (par, ds) in sort!(collect(juntos); by = kv -> (kv[1][1], kv[1][2]))
            push!(out, (assignee = who,
                        task1 = par[1], task1_name = get(nomes, par[1], ""),
                        task2 = par[2], task2_name = get(nomes, par[2], ""),
                        from = minimum(ds), to = maximum(ds)))
        end
    end
    return out
end

# ---------------------------------------------------------------------------
# Carga diária por responsável.
#
# Diferente de overallocations (que responde "quais tarefas colidem?"), aqui
# a pergunta é "quanto cada pessoa tem em cada dia?" — a matéria-prima do
# painel de recursos. O cálculo é ciente do calendário: uma tarefa de 2 dias
# úteis começando na sexta carrega sexta e segunda, e não o fim de semana no
# meio. É por isso que ele vive aqui, e não no navegador: só o motor conhece
# os feriados.
# ---------------------------------------------------------------------------

# Dias de trabalho efetivamente ocupados pela tarefa. São _effdur(t) dias,
# espalhados pelos dias corridos entre o início (snapado) e o fim do
# calendário. O teto de 3660 é a mesma sanidade de _dur_between: uma tarefa
# de década não trava o servidor.
function _task_days(cal::AbstractCalendar, t::GanttTask)
    s = _snap(cal, t.start)
    t.milestone && return [s]
    fin = _end_of(cal, s, _effdur(t))
    days = Date[]
    d = s
    while d <= fin && length(days) < 3660
        _workday(cal, d) && push!(days, d)
        d += Dates.Day(1)
    end
    return days
end

# Linhas cruas da carga. `unassigned = true` inclui as tarefas-folha sem
# responsável sob a chave "" — o painel as mostra como uma faixa própria,
# mas a API pública (workload) fica só com gente de verdade.
# Quanto TRABALHO a tarefa é, para efeito de carga. `effort` quando dito;
# senão `cost`, que sempre serviu de peso na falta de coisa melhor; senão a
# duração em pessoa-dias. A ordem importa: sem `effort` em lugar nenhum, a
# conta é exatamente a de antes, e nenhum plano existente muda de resposta.
#
# A curva-S NÃO passa por aqui, e agora é de propósito. Ela pergunta quanto
# VALOR foi entregue (dinheiro, quando há dinheiro); esta pergunta quanto
# trabalho cabe num dia. Enquanto só um dos dois campos estiver preenchido as
# duas continuam contando a mesma história sobre a mesma tarefa — separá-las
# só muda algo para quem disser as duas coisas, que é justamente quem precisa
# que elas sejam diferentes.
_work_weight(t::GanttTask) =
    t.effort > 0 ? t.effort : (t.cost > 0 ? t.cost : Float64(_effdur(t)))

# Capacidade declarada da pessoa (0 = não declarada). Nome solto — alguém que
# aparece só no `assignee` de uma tarefa, sem cadastro — não tem capacidade,
# e cai na regra antiga.
function _capacity_of(p::Project, who::AbstractString)
    pe = person(p, who)
    return pe === nothing ? 0.0 : pe.capacity
end

# Sobrecarga do dia, DEFINIÇÃO ÚNICA — todo mundo (avisos, painel de recursos,
# estatísticas, o par a par de overallocations) pergunta a esta função.
#
# Com capacidade declarada é uma comparação de trabalho contra o que o dia
# aguenta; sem ela, a regra antiga e crua: duas tarefas no mesmo dia. Duas
# tarefas de uma hora não são sobrecarga, e era exatamente isso que não havia
# como dizer — mas dizer exige um número contra o qual comparar, e enquanto
# ninguém o der, contar tarefas é a melhor resposta disponível.
#
# A folga de 1e-9 é aritmética de ponto flutuante, não generosidade: oito
# tarefas de uma hora somam 7.999999999999999 num dia de 8.
_over_day(tasks::Int, effort::Float64, capacity::Float64) =
    capacity > 0 ? effort > capacity + 1e-9 : tasks >= 2

function _workload_rows(p::Project; unassigned::Bool = false)
    cal = _cal(p)
    leaves = [t for t in p.tasks
              if !_has_children(p, t.id) &&
                 (unassigned || !isempty(strip(t.assignee)))]
    ids = Dict{Tuple{String,Date},Vector{String}}()
    eff = Dict{Tuple{String,Date},Float64}()
    for t in leaves
        who = String(strip(t.assignee))
        days = _task_days(cal, t)
        isempty(days) && continue
        per = _work_weight(t) / length(days)
        for d in days
            k = (who, d)
            push!(get!(ids, k, String[]), t.id)
            eff[k] = get(eff, k, 0.0) + per
        end
    end
    caps = Dict{String,Float64}()
    keys_sorted = sort!(collect(keys(ids)); by = k -> (lowercase(k[1]), k[2]))
    out = NamedTuple[]
    for k in keys_sorted
        cap = get!(caps, k[1]) do; _capacity_of(p, k[1]); end
        n = length(ids[k])
        push!(out, (assignee = k[1], date = k[2], tasks = n, effort = eff[k],
                    capacity = cap, over = _over_day(n, eff[k], cap),
                    task_ids = ids[k]))
    end
    return out
end

"""
    workload(p::Project) -> Vector{NamedTuple}

Daily load per person: one Tables.jl-compatible row for each
(`assignee`, `date`) pair that has work on it, with `tasks` (how many
run that day), `effort` (the day's share of the tasks' weight — `cost`
when set, otherwise person-days, as in the S-curve) and `task_ids`.
Rows are sorted by person, then date.

Only *leaf* tasks with an assignee count — summaries are containers,
not work — and only working days: under a business-day calendar
(`set_calendar!`) a holiday carries no load. Days with no work produce
no row, so the result stays small on long projects.

`tasks ≥ 2` is the same overlap [`overallocations`](@ref) reports as a
pair, seen day by day instead of pair by pair.
"""
workload(p::Project) = _workload_rows(p)

# Payload do painel de recursos: a mesma carga, densificada numa janela
# contígua de dias (a do projeto inteiro, que é a que o gantt desenha),
# para o SVG indexar por deslocamento em vez de procurar data por data.
function _workload_payload(p::Project)
    empty = (; start = nothing, days = 0, calendar = p.calendar,
              people = NamedTuple[])
    isempty(p.tasks) && return empty
    d0, d1 = span(p)
    ndays = Dates.value(d1 - d0) + 1
    ndays > 3660 && return (; error = "span too large")   # sanidade: 10 anos

    rows = _workload_rows(p; unassigned = true)
    isempty(rows) && return empty
    at(d) = Dates.value(d - d0) + 1

    # Uma entrada por pessoa, na ordem alfabética que _workload_rows já deu
    people = NamedTuple[]
    for who in unique(r.assignee for r in rows)
        mine = [r for r in rows if r.assignee == who]
        load = zeros(Int, ndays)
        effort = zeros(Float64, ndays)
        over = falses(ndays)
        for r in mine
            i = at(r.date)
            1 <= i <= ndays || continue
            load[i] = r.tasks
            effort[i] = r.effort
            over[i] = r.over
        end
        seen = String[]
        for r in mine, id in r.task_ids
            id in seen || push!(seen, id)
        end
        ts = NamedTuple[]
        for id in seen
            t = p.tasks[findfirst(t -> t.id == id, p.tasks)]
            push!(ts, (id = t.id, name = t.name,
                       from = _snap(_cal(p), t.start), to = end_date(p, t)))
        end
        # `over` vai pronto: quem decide se o dia estourou é _over_day, uma
        # vez só, e o navegador só escolhe a cor. Era daqui que saía a
        # segunda implementação da regra do outro lado do fio.
        push!(people, (assignee = who, load = load, effort = effort, over = over,
                       capacity = isempty(mine) ? 0.0 : first(mine).capacity,
                       peak = maximum(load), busy_days = count(>(0), load),
                       over_days = count(over),
                       total_effort = sum(effort), tasks = ts))
    end
    return (; start = d0, days = ndays, calendar = p.calendar, people = people)
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

# ---------------------------------------------------------------------------
# Estatísticas por pessoa e por setor
# ---------------------------------------------------------------------------

# Setor de quem assina a tarefa, tirado do cadastro. Quem não está cadastrado
# não tem setor — e cai numa faixa própria em vez de sumir da conta.
function _team_of(p::Project, nome::AbstractString)
    pe = person(p, nome)
    return pe === nothing ? "" : pe.team
end

# Núcleo das duas tabelas: agrupa as tarefas-FOLHA por uma chave e resume.
# Resumos de WBS ficam de fora pelo mesmo motivo de sempre — são recipientes,
# e contá-los somaria o trabalho dos filhos duas vezes.
function _stats_group(p::Project, chave)
    cal = _cal(p)
    atrasadas = Set(r.id for r in deadline_slip(p))
    peso(t) = t.cost > 0 ? t.cost : Float64(_effdur(t))

    grupos = Dict{String,Vector{GanttTask}}()
    dias = Dict{String,Set{Date}}()
    for t in p.tasks
        _has_children(p, t.id) && continue
        k = chave(t)
        push!(get!(grupos, k, GanttTask[]), t)
        union!(get!(dias, k, Set{Date}()), _task_days(cal, t))
    end

    # Dias de sobrecarga são por PESSOA: duas pessoas do mesmo setor no mesmo
    # dia é o normal, não um conflito. Por isso a conta vem da carga diária
    # de cada uma, e a linha do setor só soma as das suas.
    sobrecarga = Dict{String,Int}()
    for r in _workload_rows(p; unassigned = true)
        r.over && (sobrecarga[r.assignee] = get(sobrecarga, r.assignee, 0) + 1)
    end

    return (grupos = grupos, dias = dias, atrasadas = atrasadas,
            peso = peso, sobrecarga = sobrecarga)
end

"""
    people_stats(p::Project) -> Vector{NamedTuple}

One Tables.jl-compatible row per person with work in the project: how much
they carry, how far along it is, and where it hurts.

# Columns
- `assignee`, `role`, `team`: the name as the tasks spell it, plus the
  registry's answer for who they are (empty when not registered — see
  [`add_person!`](@ref)).
- `tasks`, `milestones`: leaf tasks assigned to them. Summaries are
  containers, not work, so they are never counted.
- `effort`, `done`, `progress`: total weight (`cost` when set, otherwise
  person-days — the same weight the S-curve uses), how much of it is
  reported complete, and the percentage.
- `first`, `last`: first and last working day they are occupied.
- `busy_days`: distinct days with work. Under a business-day calendar
  (`set_calendar!`) holidays carry none.
- `capacity`: the work they absorb per working day, from the registry
  ([`add_person!`](@ref)); `0` when not declared.
- `over_days`: days that carry more work than they hold — over `capacity`
  when it is declared, two or more of *their own* tasks when it is not. Same
  definition [`overallocations`](@ref) reports pair by pair and the resource
  panel paints.
- `late`: their tasks finishing after their deadline (see
  [`deadline_slip`](@ref)).

People with no assigned task do not appear, registered or not: this is a
table about work, not a staff list. Tasks with no assignee are grouped under
the empty name, because unowned work is a fact about the plan, not a gap to
hide.
"""
function people_stats(p::Project)
    g = _stats_group(p, t -> String(strip(t.assignee)))
    out = NamedTuple[]
    for who in sort!(collect(keys(g.grupos)); by = w -> (isempty(w), lowercase(w)))
        ts = g.grupos[who]
        pe = person(p, who)
        esforco = sum(g.peso, ts)
        feito = sum(t -> g.peso(t) * clamp(t.progress, 0, 100) / 100, ts)
        ds = sort!(collect(g.dias[who]))
        push!(out, (assignee = who,
                    role = pe === nothing ? "" : pe.role,
                    team = pe === nothing ? "" : pe.team,
                    capacity = pe === nothing ? 0.0 : pe.capacity,
                    tasks = length(ts),
                    milestones = count(t -> t.milestone, ts),
                    effort = esforco,
                    done = feito,
                    progress = esforco > 0 ? round(Int, 100 * feito / esforco) : 0,
                    first = first(ds), last = last(ds),
                    busy_days = length(ds),
                    over_days = get(g.sobrecarga, who, 0),
                    late = count(t -> t.id in g.atrasadas, ts)))
    end
    return out
end

"""
    team_stats(p::Project) -> Vector{NamedTuple}

The same accounting as [`people_stats`](@ref), rolled up by the `team` field
of the collaborator registry: one row per team, plus `members` (how many
distinct people) and `people` (their names).

A team only exists because somebody was registered into it
([`add_person!`](@ref)); tasks whose assignee has no team — or no
registration at all — land in the row with the empty team name.

`busy_days` counts days on which *anything* in the team was running, so it is
occupancy of the calendar, not the sum of the members' days. `over_days` is
the sum of the members' overloaded days: two people from the same team
working the same day is normal, and only an individual can be double-booked.
"""
function team_stats(p::Project)
    g = _stats_group(p, t -> _team_of(p, t.assignee))
    out = NamedTuple[]
    for time in sort!(collect(keys(g.grupos)); by = w -> (isempty(w), lowercase(w)))
        ts = g.grupos[time]
        esforco = sum(g.peso, ts)
        feito = sum(t -> g.peso(t) * clamp(t.progress, 0, 100) / 100, ts)
        ds = sort!(collect(g.dias[time]))
        nomes = sort!(unique!([String(strip(t.assignee)) for t in ts if !isempty(strip(t.assignee))]);
                      by = lowercase)
        push!(out, (team = time,
                    members = length(nomes), people = nomes,
                    tasks = length(ts),
                    milestones = count(t -> t.milestone, ts),
                    effort = esforco,
                    done = feito,
                    progress = esforco > 0 ? round(Int, 100 * feito / esforco) : 0,
                    first = first(ds), last = last(ds),
                    busy_days = length(ds),
                    over_days = sum(n -> get(g.sobrecarga, n, 0), nomes; init = 0),
                    late = count(t -> t.id in g.atrasadas, ts)))
    end
    return out
end
