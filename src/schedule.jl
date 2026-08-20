# Motor de scheduling: é aqui que o Perth deixa de ser uma view e passa a
# ser um pacote de verdade. Ordenação topológica (Kahn), detecção de ciclos,
# CPM (Critical Path Method) com forward/backward pass sobre datas, folga
# (slack), reprogramação automática de sucessoras e nivelamento de recursos
# por capacidade. Tudo puro Julia, utilizável sem navegador.

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

function _cal(p::Project)
    isempty(p.calendar) && return CalendarDays()
    hasmethod(_business_calendar, Tuple{String}) ||
        error("Perth: project uses business-day calendar $(repr(p.calendar)). " *
              "Run `using BusinessDays` to enable it (weak dependency).")
    _business_calendar(p.calendar)
end

# Implementada pela extensão (método para (::String)); ver _cal acima para a
# mensagem de erro quando ela não está carregada. Sem nenhum método aqui de
# propósito: um fallback com a MESMA assinatura seria sobrescrito pela
# extensão, e sobrescrita de método é proibida durante pré-compilação —
# `using BusinessDays` falhava a pré-compilar (funcionava, mas com um
# ERROR assustador no console toda sessão, sem nunca cachear).
function _business_calendar end

_snap(::CalendarDays, d::Date) = d                                # próximo dia válido
_end_of(::CalendarDays, s::Date, dur::Int) = s + Dates.Day(dur - 1)
_start_of(::CalendarDays, e::Date, dur::Int) = e - Dates.Day(dur - 1)
_day_after(::CalendarDays, d::Date) = d + Dates.Day(1)
_day_before(::CalendarDays, d::Date) = d - Dates.Day(1)
_gap(::CalendarDays, a::Date, b::Date) = Dates.value(b - a)       # folga entre datas

# O dia é de trabalho neste calendário? _snap devolve o próximo dia válido,
# então um dia que já é válido é ponto fixo dela. Vale para as duas
# implementações sem a extensão precisar definir nada: em dias corridos
# _snap é a identidade e todo dia trabalha.
_workday(cal::AbstractCalendar, d::Date) = _snap(cal, d) == d

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

# Os dias em que NÃO se trabalha, dentro de uma janela. É o único primitivo
# do calendário que o navegador precisa receber: _end_of, _snap, _dur_between
# e _shift são todos derivados de _workday, e derivar quatro funções de um
# dado recebido não é duplicar uma decisão — é aplicar a resposta de quem
# sabe. A alternativa (mandar o fim de cada tarefa já calculado) fica velha no
# meio de um arrasto, que é justamente quando a geometria importa.
#
# Sem calendário devolve vazio: em dias corridos todo dia trabalha, e uma
# lista vazia diz isso sem custo nenhum no payload.
function _nonworking_days(p::Project, de::Date, ate::Date)
    cal = _cal(p)
    cal isa CalendarDays && return Date[]
    out = Date[]
    d = de
    while d <= ate && length(out) < 3660      # a mesma sanidade de _dur_between
        _workday(cal, d) || push!(out, d)
        d += Dates.Day(1)
    end
    return out
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
#
# `durations` substitui a duração de cada tarefa sem tocar no projeto: é
# por onde o PERT roda o mesmo motor com as durações esperadas (e a
# simulação de Monte Carlo, milhares de vezes com durações sorteadas) sem
# gravar nada e sem uma segunda implementação do CPM. Marcos continuam
# ocupando um dia, venha a duração de onde vier.
function _cpm(p::Project, durations::Union{Nothing,AbstractVector{<:Integer}} = nothing)
    order, succs = _toposort(p)
    cal = _cal(p)
    n = length(p.tasks)
    idx = Dict(t.id => i for (i, t) in enumerate(p.tasks))
    eff = durations === nothing ?
        [_effdur(t) for t in p.tasks] :
        [p.tasks[i].milestone ? 1 : max(Int(durations[i]), 1) for i in 1:n]

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
                        _shift(cal, ef[j], dep.lag), eff[i]))
            else                         # FS (+lag)
                s = max(s, _shift(cal, _day_after(cal, ef[j]), dep.lag))
            end
        end
        es[i] = _snap(cal, s)
        ef[i] = _end_of(cal, es[i], eff[i])
    end

    # `init` de maximum é a semente da redução, não um default para vetor
    # vazio: com `init = today()` o término do projeto virava
    # max(hoje, último fim) e todo projeto já concluído ganhava folga
    # fantasma — caminho crítico vazio, folga = dias desde o fim.
    finish = isempty(ef) ? Dates.today() : maximum(ef)
    # O prazo (deadline) entra aqui e em nenhum outro lugar: ele não move
    # nada, só baixa o late finish da tarefa. O backward pass abaixo já
    # propaga isso para os predecessores (lf[i] = min(lf[i], lim)), então a
    # cadeia inteira que alimenta um prazo estourado ganha folga NEGATIVA,
    # do tamanho exato do atraso. Prazo posterior ao término do projeto fica
    # inerte: lf já é limitado pelo término em todas as tarefas.
    lf = [t.deadline === nothing ? finish : min(finish, t.deadline)
          for t in p.tasks]
    ls = Vector{Date}(undef, n)
    for i in reverse(order)              # backward pass (ciente de tipo/lag)
        for (k, dep) in succ_edges[i]
            lim = if dep.type === :SS    # restrição no início: converte p/ fim
                _end_of(cal, _shift(cal, ls[k], -dep.lag), eff[i])
            elseif dep.type === :FF
                _shift(cal, lf[k], -dep.lag)
            else                         # FS
                _shift(cal, _day_before(cal, ls[k]), -dep.lag)
            end
            lf[i] = min(lf[i], lim)
        end
        ls[i] = _start_of(cal, lf[i], eff[i])
    end

    slack = [_gap(cal, ef[i], lf[i]) for i in 1:n]
    return (; es, ef, ls, lf, slack, finish)
end

"""
    schedule!(p::Project) -> Project

Reschedule the project so that no task starts before all of its
dependencies have finished. Each task's own start date acts as a
*start-no-earlier-than* constraint: tasks are only pushed forward,
never pulled back. Tasks marked `pinned` keep their start date — the
engine still computes where they would have to go, so a pin the plan
can no longer honour leaves [`slack`](@ref)'s `early_start` later than
the task's `start`, instead of the date silently moving. Persists the
result.

Throws `ArgumentError` if the dependency graph has a cycle.
"""
function schedule!(p::Project)
    lv = _leaf_view(p)                 # resumos derivam; só folhas movem
    cpm = _cpm(lv)
    for (i, t) in enumerate(lv.tasks)
        t.pinned && continue           # data fixa: o motor calcula, não grava
        t.start = cpm.es[i]
    end
    _with_state(st -> _save!(st, p))   # _save! refaz o rollup dos resumos
    return p
end

# ---------------------------------------------------------------------------
# Nivelamento de recursos (levelling).
#
# schedule! empurra sucessoras para o plano respeitar DEPENDÊNCIA. Aqui ele é
# empurrado para respeitar CAPACIDADE — o outro lado do mesmo motor, e a
# metade que faltava do "diagnosticar → agir": desde que `capacity` existe, o
# Perth sabia dizer com precisão que a terça da Ana tem 12h num dia de 8, e
# não sabia fazer nada a respeito.
#
# Nivelar é NP-difícil, então toda ferramenta escolhe uma heurística e vive
# com ela. A daqui é MENOR FOLGA PRIMEIRO: fica quem tem menos folga, cede
# quem tem mais. É a mais defensável das três candidatas usuais (menor folga,
# prazo mais próximo, tarefa mais longa) por três motivos que valem juntos:
# a folga já é calculada pelo CPM, então não há número novo a inventar nem a
# manter; quem está no caminho crítico não é adiado por causa de quem não
# está; e uma tarefa com prazo apertado já chega aqui com folga baixa ou
# negativa, porque o backward pass usa o `deadline` — prazo sai protegido de
# graça, sem uma segunda regra dizendo isso.
#
# Não é o ótimo, e não finge ser.
# ---------------------------------------------------------------------------

# Teto de sanidade do laço, na mesma família do 3660 de _dur_between. O laço
# termina sozinho (ver o comentário do alvo, mais abaixo); o teto existe para
# que um plano patológico não segure o servidor enquanto termina.
const _LEVEL_MAX_MOVES = 5_000

# Quanto a tarefa pesa em CADA dia que ocupa: a mesma divisão que
# _workload_rows faz para montar a carga do dia, feita para uma tarefa só.
function _daily_share(cal::AbstractCalendar, t::GanttTask)
    days = _task_days(cal, t)
    return isempty(days) ? 0.0 : _work_weight(t) / length(days)
end

# O que o nivelamento tem permissão para mover.
#
# `pinned` é uma data que alguém prometeu. Um marco não carrega trabalho para
# redistribuir — o peso que ele aparenta ter na carga é só o default de quem
# não declarou `effort` —, então movê-lo mudaria uma data que alguém lê sem
# aliviar nada. A terceira é a menos óbvia, e é ela que impede o laço de
# andar para sempre: uma tarefa que SOZINHA já estoura o dia da pessoa vai
# estourar qualquer dia em que caia, então empurrá-la só faz o problema
# passear pelo calendário. Ela fica, e o dia dela é relatado pelo que é — um
# dia que remanejamento nenhum conserta.
_levelable(cal::AbstractCalendar, t::GanttTask, cap::Float64) =
    !t.pinned && !t.milestone && !_over_day(1, _daily_share(cal, t), cap)

# A primeira data a partir de `de` em que a tarefa cabe INTEIRA no dia da
# pessoa: um trecho de _effdur(t) dias úteis seguidos em que o peso diário
# dela somado ao de todo o resto não estoura a capacidade. `sem` é a carga da
# pessoa sem esta tarefa, dia a dia.
#
# É aqui que mora a diferença entre nivelar e empurrar. Adiar um dia de cada
# vez parece o movimento mínimo e é o que não termina: três tarefas de três
# dias no mesmo dia continuam as três no dia seguinte, e o bloco marcha pelo
# calendário sem nunca se separar. Procurar o primeiro encaixe move a tarefa
# uma vez, para onde ela de fato cabe.
#
# A busca sempre acha: passado o último dia com carga da pessoa, o dia está
# vazio, e uma tarefa que não cabe sozinha nem no dia vazio já foi barrada
# por _levelable. `teto` é rede de segurança, não a resposta esperada.
function _first_fit(cal::AbstractCalendar, t::GanttTask, share::Float64,
                    cap::Float64, de::Date,
                    sem::Dict{Date,Tuple{Int,Float64}}, teto::Date)
    need = _effdur(t)
    d = _snap(cal, de)
    inicio, seguidos = d, 0
    while d <= teto
        n, e = get(sem, d, (0, 0.0))
        if _over_day(n + 1, e + share, cap)
            seguidos = 0
        else
            seguidos == 0 && (inicio = d)
            seguidos += 1
            seguidos >= need && return inicio
        end
        d = _day_after(cal, d)
    end
    return nothing
end

# Sucessoras diretas e indiretas (BFS). Só elas são reacomodadas depois de um
# empurrão: nivelar não é reprogramar o plano inteiro, e uma tarefa que não
# depende da que se moveu não tem por que mudar de lugar.
function _downstream(succs::Vector{Vector{Int}}, i::Int)
    out, seen, fila = Int[], Set{Int}(), copy(succs[i])
    while !isempty(fila)
        j = popfirst!(fila)
        j in seen && continue
        push!(seen, j)
        push!(out, j)
        append!(fila, succs[j])
    end
    return out
end

"""
    level!(p::Project) -> Project

Resource-level the plan: push work forward until nobody with a declared
`capacity` is left with an overloaded day. Dependencies still bind, and
successors follow what moves. Persists the result.

The priority rule is **least slack first**: the task with the least slack
keeps its place and the one with the most slack gives way. Levelling is
NP-hard, so this is a heuristic and not the optimum — it is the most
defensible one available here, because [`slack`](@ref) is a number the CPM
already computes, and because a `deadline` comes out protected without a
second rule: the backward pass already gives a task with a tight deadline
low (or negative) slack, so it is among the last to be asked to move.

Three things never move:

- tasks marked `pinned` — a date somebody promised;
- **milestones**, which carry no work to redistribute: moving one would
  only change a date somebody reads;
- a task whose own daily share is heavier than the assignee's whole
  `capacity`. It overloads any day it lands on, so pushing it would just
  walk the problem down the calendar.

Everything else is only ever pushed **later**, and to the first day where
it fits *whole* — never pulled back, never split in two. Tasks with no
assignee are never moved: there is nobody to overload.

**Levelling needs a declared capacity, and only touches people who have
one.** Without a capacity an "overloaded day" is just two tasks on the same
day (see [`workload`](@ref)), and levelling against that rule would
serialise the whole plan into single file — so people with no declared
capacity are left exactly where they are, and a plan where nobody declared
one throws `ArgumentError` instead of quietly rearranging itself.

**What is left over stays visible.** A plan with more work than capacity
*cannot* be levelled, and this does not pretend otherwise: when it returns,
any day still `over` in [`workload`](@ref) is a day whose remaining work
*cannot move* (the three cases above), or a day belonging to somebody who
never declared a capacity. A day that stays overloaded is still emptied of
everything that could leave it — the day is beyond help, the tasks that can
find room are not. Ask [`workload`](@ref) or
[`people_stats`](@ref) again afterwards; the overload that survives is the
answer, in the same numbers that reported it before.

Throws `ArgumentError` if the dependency graph has a cycle, or if no
assignee in the plan has a declared capacity.

# Example

```julia
add_person!(p, "Ana"; capacity = 8)      # 8 hours a day
update_task!(p, "t1"; assignee = "Ana", effort = 8)
update_task!(p, "t2"; assignee = "Ana", effort = 8)   # same day: 16 in an 8
level!(p)                                # t2 moves to the first day that fits
filter(r -> r.over, workload(p))         # what levelling could not solve
```
"""
function level!(p::Project)
    lv = _leaf_view(p)
    isempty(lv.tasks) && return p
    _, succs = _toposort(lv)          # ciclo: erra aqui, antes de mover nada
    cal = _cal(lv)
    idx = Dict(t.id => i for (i, t) in enumerate(lv.tasks))

    any(r -> r.capacity > 0, _workload_rows(p)) || throw(ArgumentError(
        "levelling needs a declared capacity, and nobody with work in this " *
        "plan has one (see `add_person!`). Without a capacity an overloaded " *
        "day is just two tasks on the same day, and levelling against that " *
        "would serialise the whole plan."))

    # Quantas tarefas esperam por esta (fan-out direto), para desempatar duas
    # folgas iguais: entre elas, cede a que trava menos gente.
    fan = zeros(Int, length(lv.tasks))
    for t in lv.tasks, d in t.dependencies
        j = get(idx, _parse_dep(d).id, 0)
        j == 0 || (fan[j] += 1)
    end

    travados = Set{Tuple{String,Date}}()   # dias que este motor não conserta
    for _ in 1:_LEVEL_MAX_MOVES
        # O dia sobrecarregado MAIS ANTIGO ainda em aberto. Atacar sempre o
        # mais antigo é o que faz o laço terminar: nada aqui move nada para
        # trás, então um dia já resolvido não pode estourar de novo, e o
        # ponteiro do "mais antigo em aberto" só anda para a frente.
        #
        # As linhas vêm de `p`, não de `lv`: a capacidade está no cadastro de
        # pessoas, e a visão de folhas não o carrega.
        rows = _workload_rows(p)
        alvo = nothing
        for r in rows
            (r.over && r.capacity > 0 &&
             !((r.assignee, r.date) in travados) &&
             (alvo === nothing || r.date < alvo.date)) && (alvo = r)
        end
        alvo === nothing && break

        movs = Int[]
        for id in alvo.task_ids
            i = get(idx, id, 0)
            i == 0 && continue
            _levelable(cal, lv.tasks[i], alvo.capacity) && push!(movs, i)
        end
        # Só o que não pode sair continua no dia: o dia é o que é, e nenhum
        # remanejamento o conserta. Marca e segue.
        #
        # Um dia insalvável NÃO é motivo para deixar quieto o que ainda pode
        # sair dele. Se uma tarefa de 40h sozinha estoura o dia de 8, o dia
        # está perdido de qualquer jeito — mas a pessoa também não faz as
        # outras três naquele dia, e mantê-las ali só porque a vizinha é
        # grande demais criaria uma descontinuidade sem defesa: a mesma
        # tarefa sai do dia quando divide com uma tarefa normal e fica
        # quando divide com uma monstruosa. O dia continua estourado no
        # relatório de qualquer maneira, e é lá que ele deve aparecer.
        if isempty(movs)
            push!(travados, (alvo.assignee, alvo.date))
            continue
        end

        cpm = _cpm(lv)
        # Menor folga primeiro: fica quem tem menos, cede quem tem mais.
        #
        # O prazo entra como PRIMEIRO desempate, e não como segunda regra: a
        # folga já protege quem tem prazo apertado (o backward pass baixa o
        # late finish), mas empate de folga é o caso comum — num plano de
        # tarefas paralelas todas têm a mesma —, e entre duas tarefas
        # igualmente folgadas quem carrega uma promessa cede por último. O
        # id fecha a lista para o resultado não depender da ordem em que as
        # tarefas foram criadas.
        i = argmax(k -> (cpm.slack[k], lv.tasks[k].deadline === nothing,
                         -fan[k], lv.tasks[k].start, lv.tasks[k].id), movs)

        # A carga da pessoa sem a tarefa que vai sair. O esforço é uma soma,
        # então tirar a parte dela é uma subtração — não há por que recontar
        # o dia inteiro, e a tolerância de _over_day já cobre o resíduo de
        # ponto flutuante que a subtração deixa.
        t = lv.tasks[i]
        share = _daily_share(cal, t)
        sem = Dict{Date,Tuple{Int,Float64}}()
        ultimo = alvo.date
        for r in rows
            r.assignee == alvo.assignee || continue
            n, e = r.tasks, r.effort
            t.id in r.task_ids && ((n, e) = (n - 1, e - share))
            sem[r.date] = (n, e)
            r.date > ultimo && (ultimo = r.date)
        end
        novo = _first_fit(cal, t, share, alvo.capacity, _day_after(cal, alvo.date),
                          sem, _shift(cal, ultimo, _effdur(t) + 1))
        if novo === nothing            # a rede de segurança de _first_fit
            push!(travados, (alvo.assignee, alvo.date))
            continue
        end
        t.start = novo

        # Dependência continua valendo: quem espera por ela vai junto. `es` é
        # sempre ≥ o start atual (a data da tarefa é um "não antes de" no
        # forward pass), então isto empurra para a frente e nunca puxa.
        pos = _cpm(lv)
        for j in _downstream(succs, i)
            lv.tasks[j].pinned || (lv.tasks[j].start = pos.es[j])
        end
    end
    _with_state(st -> _save!(st, p))   # _save! refaz o rollup dos resumos
    return p
end

"""
    critical_path(p::Project) -> Vector{String}

Ids of the tasks on the critical path (slack `≤ 0`), in topological
order. Delaying any of these delays the whole project.

Slack is only ever negative when a `deadline` is already missed, and
those tasks are *more* critical than the zero-slack ones — leaving them
out would hide exactly the chain that is late.
"""
function critical_path(p::Project)
    lv = _leaf_view(p)
    isempty(lv.tasks) && return String[]
    cpm = _cpm(lv)
    order, _ = _toposort(lv)
    return [lv.tasks[i].id for i in order if cpm.slack[i] <= 0]
end

"""
    slack(p::Project) -> Vector{NamedTuple}

Per-task CPM summary as Tables.jl-compatible rows: `id`, `name`,
`early_start`, `early_finish`, `slack_days`, `critical`, `dependents`,
`bottleneck`.

`slack_days` goes negative when a `deadline` cannot be met: the task
and everything feeding it are late by that many days. `critical` is
`slack_days ≤ 0`.

`dependents` counts how many *other leaf tasks* name this one as a
predecessor — the fan-out, not the whole downstream. `bottleneck` is
`critical && dependents ≥ 2`: a zero-slack task that more than one
thing is waiting on. A critical task with a single dependent is just a
link in the chain, which `critical` already says; the bottleneck is
where the chain becomes a funnel, and it is the task worth protecting
first.

Both are **derived**, never declared. A hand-typed "bottleneck" flag
would be wrong the moment somebody drags a bar, and nobody comes back
to fix it.
"""
function slack(p::Project)
    lv = _leaf_view(p)
    isempty(lv.tasks) && return NamedTuple[]
    cpm = _cpm(lv)
    order, _ = _toposort(lv)
    # dependentes diretos: quem cita esta como predecessora. _parse_dep
    # porque a referência pode vir como "id+3" ou "SS:id" — comparar a
    # string inteira contaria dependência de menos.
    fanout = Dict{String,Int}()
    for t in lv.tasks, d in t.dependencies
        k = _parse_dep(d).id
        fanout[k] = get(fanout, k, 0) + 1
    end
    return [begin
        crit = cpm.slack[i] <= 0
        deps = get(fanout, lv.tasks[i].id, 0)
        (id = lv.tasks[i].id, name = lv.tasks[i].name,
         early_start = cpm.es[i], early_finish = cpm.ef[i],
         slack_days = cpm.slack[i], critical = crit,
         dependents = deps, bottleneck = crit && deps >= 2)
    end for i in order]
end

"""
    deadline_slip(p::Project) -> Vector{NamedTuple}

The tasks whose planned finish is past their `deadline`, as Tables.jl
rows: `id`, `name`, `deadline`, `finish` (calendar-aware) and
`slip_days` — calendar days late, like [`slippage`](@ref), not the
business days the CPM slack is measured in.

Tasks without a deadline, and deadlines still being met, produce no
row; an empty result means every commitment in the plan holds.
"""
function deadline_slip(p::Project)
    out = NamedTuple[]
    for (t, _) in ordered_tasks(p)
        t.deadline === nothing && continue
        fin = end_date(p, t)
        fin <= t.deadline && continue
        push!(out, (id = t.id, name = t.name, deadline = t.deadline,
                    finish = fin, slip_days = Dates.value(fin - t.deadline)))
    end
    return out
end

"""
    project_finish(p::Project) -> Date

Earliest possible finish date of the whole project under the current
dependency structure (CPM forward pass).
"""
project_finish(p::Project) =
    isempty(_leaf_view(p).tasks) ? Dates.today() : _cpm(_leaf_view(p)).finish
