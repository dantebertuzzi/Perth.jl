# PERT — estimativa de três pontos sobre o motor CPM que já existe.
#
# A ideia do PERT (Program Evaluation and Review Technique, Marinha
# americana, 1958) é que ninguém sabe quanto uma tarefa demora, mas todo
# mundo sabe apostar em três números: otimista (o), mais provável (m) e
# pessimista (p). Deles saem a duração esperada e a incerteza:
#
#     te = (o + 4m + p) / 6            σ = (p − o) / 6
#
# A escolha de projeto aqui é uma só, e é o que faz isto caber em ~300
# linhas: **PERT alimenta `duration`, não bifurca o motor**. `pert!`
# escreve te na duração e, a partir daí, CPM, caminho crítico, folga,
# prazos, calendário de dias úteis e a UI inteira funcionam sem saber que
# PERT existe. As funções de análise não gravam nada — rodam o mesmo
# `_cpm` com um vetor de durações substituto (ver schedule.jl).
#
# Sobre honestidade estatística: `pert_finish` é a fórmula do livro, que
# soma variância só ao longo do caminho crítico e por isso SUBESTIMA o
# risco sempre que existem cadeias paralelas quase críticas (o "merge
# bias" — basta uma delas atrasar para o projeto atrasar, e a fórmula não
# vê isso). `pert_simulate` responde a mesma pergunta por Monte Carlo,
# sorteando as durações e refazendo o cronograma milhares de vezes, e é a
# resposta em que se deve acreditar quando as duas discordam. Rodar o CPM
# 10 mil vezes custa milissegundos aqui — é exatamente o tipo de coisa
# que justifica um pacote de Gantt em Julia.

# ---------------------------------------------------------------------------
# Estimativa por tarefa
# ---------------------------------------------------------------------------

"""
    has_estimate(t::GanttTask) -> Bool

Whether the task carries a PERT three-point estimate.
"""
has_estimate(t::GanttTask) =
    t.optimistic > 0 && t.most_likely > 0 && t.pessimistic > 0

"""
    expected_duration(t::GanttTask) -> Float64

The PERT expected duration `(o + 4m + p)/6`, in the same days as
`duration`. Falls back to the task's plain `duration` when it has no
estimate, so it is safe to call on any task.
"""
expected_duration(t::GanttTask) = has_estimate(t) ?
    (t.optimistic + 4 * t.most_likely + t.pessimistic) / 6 :
    Float64(_effdur(t))

# Desvio-padrão da tarefa: um sexto da amplitude entre os extremos. Vem da
# aproximação clássica "a faixa o..p cobre ~6 σ" — a mesma que dá o 4m/6 de te.
_task_sd(t::GanttTask) = has_estimate(t) ? (t.pessimistic - t.optimistic) / 6 : 0.0

# Duração inteira que vai para o motor (o CPM conta dias, não frações)
_expected_days(t::GanttTask) = max(round(Int, expected_duration(t)), 1)

"""
    set_estimate!(p::Project, id, optimistic, most_likely, pessimistic;
                  apply = true) -> GanttTask

Give a task its PERT three-point estimate, in the same days as
`duration`. With `apply = true` (the default) the task's `duration`
becomes the expected duration `(o + 4m + p)/6`, rounded — pass
`apply = false` to record the estimate without touching the plan.
Persists.

The three numbers are pushed into order rather than sorted: the
optimistic estimate is a floor and the pessimistic one a ceiling, so
`set_estimate!(p, id, 8, 5, 6)` records `8, 8, 8` instead of silently
swapping the fields you filled in. A partial estimate is allowed — pass
`0` for what you don't know and the current `duration` fills the gap.

```julia
set_estimate!(p, t.id, 4, 6, 14)   # duration becomes 7
pert(p)                            # the whole table, with σ per task
```
"""
function set_estimate!(p::Project, id::AbstractString,
                       optimistic::Integer, most_likely::Integer,
                       pessimistic::Integer; apply::Bool = true)
    i = findfirst(t -> t.id == id, p.tasks)
    i === nothing && throw(KeyError(String(id)))
    t = p.tasks[i]
    t.optimistic = Int(optimistic)
    t.most_likely = Int(most_likely)
    t.pessimistic = Int(pessimistic)
    _normalize_estimate!(t)
    apply && has_estimate(t) && !t.milestone && (t.duration = _expected_days(t))
    _with_state(st -> _save!(st, p))
    return t
end

"""
    clear_estimate!(p::Project, id) -> GanttTask

Drop a task's three-point estimate. The `duration` it produced stays —
removing the estimate is not a reason to move the plan. Persists.
"""
function clear_estimate!(p::Project, id::AbstractString)
    i = findfirst(t -> t.id == id, p.tasks)
    i === nothing && throw(KeyError(String(id)))
    t = p.tasks[i]
    t.optimistic = t.most_likely = t.pessimistic = 0
    _with_state(st -> _save!(st, p))
    return t
end

"""
    pert!(p::Project) -> Project

Apply every three-point estimate on the project: each estimated task's
`duration` becomes its expected duration `(o + 4m + p)/6`, rounded.
Milestones and tasks without an estimate are left alone; WBS summaries
derive their span from their children as always. Persists.

This is the only thing that turns estimates into a plan — deliberately,
like [`schedule!`](@ref) being the only thing that moves dates. Estimate
first, `pert!`, then `schedule!` to push the successors around the new
durations.
"""
function pert!(p::Project)
    for t in p.tasks
        (has_estimate(t) && !t.milestone) || continue
        t.duration = _expected_days(t)
    end
    _with_state(st -> _save!(st, p))
    return p
end

"""
    pert(p::Project) -> Vector{NamedTuple}

The project's three-point estimates as Tables.jl-compatible rows, in WBS
display order, one per estimated task: `id`, `name`, `optimistic`,
`most_likely`, `pessimistic`, `expected` (te, unrounded), `sd` (σ),
`variance` and `duration` (what the plan currently uses — it differs
from `expected` until [`pert!`](@ref) runs).

Tasks without an estimate produce no row, so an empty result means
nothing in the plan has been estimated yet.
"""
function pert(p::Project)
    out = NamedTuple[]
    for (t, _) in ordered_tasks(p)
        has_estimate(t) || continue
        sd = _task_sd(t)
        push!(out, (id = t.id, name = t.name,
                    optimistic = t.optimistic, most_likely = t.most_likely,
                    pessimistic = t.pessimistic,
                    expected = expected_duration(t), sd = sd,
                    variance = sd^2, duration = t.duration))
    end
    return out
end

# ---------------------------------------------------------------------------
# Distribuição normal, sem dependência
# ---------------------------------------------------------------------------

# Φ: CDF da normal padrão. Aproximação racional de Abramowitz & Stegun
# 26.2.17 (erro < 7.5e-8) — o suficiente com folga para uma probabilidade
# de término, e mais barato que arrastar SpecialFunctions/Distributions
# para o pacote inteiro por causa de uma função.
function _Φ(z::Real)
    x = abs(Float64(z))
    t = 1 / (1 + 0.2316419x)
    poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
           t * (-1.821255978 + t * 1.330274429))))
    y = 1 - exp(-x^2 / 2) / sqrt(2π) * poly
    return z >= 0 ? y : 1 - y
end

# Φ⁻¹ por bisseção sobre Φ. Sem tabela de constantes para conferir: a
# inversa é monótona e o intervalo [-8, 8] cobre qualquer probabilidade
# que faça sentido pedir; 100 passos passam da precisão de Float64.
function _Φinv(q::Real)
    target = clamp(Float64(q), 1e-12, 1 - 1e-12)
    lo, hi = -8.0, 8.0
    for _ in 1:100
        mid = (lo + hi) / 2
        _Φ(mid) < target ? (lo = mid) : (hi = mid)
    end
    return (lo + hi) / 2
end

# ---------------------------------------------------------------------------
# Término probabilístico (fórmula clássica)
# ---------------------------------------------------------------------------

# Vista de folhas + durações esperadas: é assim que toda análise abaixo
# roda o motor sem gravar nada no projeto.
_expected_view(p::Project) = (lv = _leaf_view(p);
                              (lv, [_expected_days(t) for t in lv.tasks]))

# Variância do término pela regra clássica: soma das variâncias das
# tarefas AO LONGO do caminho crítico. Quando vários caminhos empatam em
# folga zero — o normal em projetos com frentes paralelas — "o caminho
# crítico" é ambíguo, e somar todas as tarefas de folga ≤ 0 contaria
# frentes paralelas como se fossem uma cadeia só, inflando σ com o número
# de frentes. Aqui vale a cadeia crítica de MAIOR variância (a mais
# arriscada das empatadas), calculada numa programação dinâmica sobre a
# ordem topológica: V[i] = var(i) + maior V entre as predecessoras
# críticas.
function _critical_variance(lv::Project, cpm)
    n = length(lv.tasks)
    order, _ = _toposort(lv)
    idx = Dict(t.id => i for (i, t) in enumerate(lv.tasks))
    crit = [cpm.slack[i] <= 0 for i in 1:n]
    V = zeros(Float64, n)
    best = 0.0
    for i in order
        crit[i] || continue
        upstream = 0.0
        for d in lv.tasks[i].dependencies
            j = get(idx, _dep_id(d), 0)
            (j == 0 || !crit[j]) && continue
            upstream = max(upstream, V[j])
        end
        V[i] = upstream + _task_sd(lv.tasks[i])^2
        cpm.ef[i] == cpm.finish && (best = max(best, V[i]))
    end
    return best
end

"""
    pert_finish(p::Project) -> NamedTuple

The probabilistic finish of the project under its three-point estimates:
`expected` (the CPM finish computed with expected durations), `sd_days`
(σ of that finish), `variance`, `critical` (how many tasks are on the
critical path) and `estimated` (how many of those carry an estimate).

Nothing is written: the estimates feed the engine directly, so the
answer is the same whether or not [`pert!`](@ref) has run.

σ is the textbook one — the square root of the variance summed **along
the critical path** (the riskiest one, when several tie at zero slack).
It is an estimate of the spread, not a forecast of the date: parallel
chains that are nearly critical can become critical when they slip, and
this formula cannot see them, so its `expected` is optimistic whenever
the project has several fronts merging (the classic *merge bias*). When
that matters, ask [`pert_simulate`](@ref) instead, which reschedules the
whole project thousands of times and does see them.
"""
function pert_finish(p::Project)
    lv, dur = _expected_view(p)
    isempty(lv.tasks) && return (; expected = Dates.today(), sd_days = 0.0,
                                 variance = 0.0, critical = 0, estimated = 0)
    cpm = _cpm(lv, dur)
    crit = [t for (i, t) in enumerate(lv.tasks) if cpm.slack[i] <= 0]
    variance = _critical_variance(lv, cpm)
    return (; expected = cpm.finish, sd_days = sqrt(variance), variance,
            critical = length(crit), estimated = count(has_estimate, crit))
end

"""
    finish_probability(p::Project, date::Date) -> Float64

Probability (0–1) that the project finishes on or before `date`, from
the PERT estimates: `Φ((date − expected) / σ)`.

With no uncertainty on the critical path (σ = 0 — nothing estimated, or
every estimate a single point) the answer is the certainty of the plan
itself: `1.0` from the expected finish onwards, `0.0` before it.

See [`pert_finish`](@ref) for what σ does and does not cover.
"""
function finish_probability(p::Project, date::Date)
    f = pert_finish(p)
    f.sd_days <= 0 && return date >= f.expected ? 1.0 : 0.0
    return _Φ(Dates.value(date - f.expected) / f.sd_days)
end

"""
    pert_date(p::Project, probability::Real) -> Date

The date the project finishes by with the given confidence — the P80 a
sponsor asks for when the expected finish (P50) is not a promise anyone
wants to make.

Inverse of [`finish_probability`](@ref): `expected + z·σ`, rounded to
whole days and shifted through the project's calendar, so under a
business-day calendar the buffer is counted in working days too.
"""
function pert_date(p::Project, probability::Real)
    q = clamp(Float64(probability), 0.0, 1.0)
    f = pert_finish(p)
    f.sd_days <= 0 && return f.expected
    return _shift(_cal(p), f.expected, round(Int, _Φinv(q) * f.sd_days))
end

# ---------------------------------------------------------------------------
# Monte Carlo (a resposta honesta)
# ---------------------------------------------------------------------------

# Gamma(k, 1) por Marsaglia–Tsang (2000): rejeição com uma normal e uma
# uniforme por tentativa, aceitação ~98%. Só existe aqui para compor a Beta.
function _rand_gamma(rng, k::Float64)
    k < 1 && return _rand_gamma(rng, k + 1) * rand(rng)^(1 / k)
    d = k - 1 / 3
    c = 1 / sqrt(9d)
    while true
        x = randn(rng)
        v = (1 + c * x)^3
        v <= 0 && continue
        u = rand(rng)
        log(u) < 0.5x^2 + d - d * v + d * log(v) && return d * v
    end
end

_rand_beta(rng, a::Float64, b::Float64) =
    (g = _rand_gamma(rng, a); g / (g + _rand_gamma(rng, b)))

# Sorteia uma duração da Beta-PERT da tarefa. É a distribuição de que a
# fórmula te = (o + 4m + p)/6 é exatamente a média (λ = 4), então a
# simulação e a fórmula respondem sobre a MESMA distribuição — se elas
# discordarem, a diferença é merge bias, não escolha de sampler. (Uma
# triangular, o atalho comum, teria média (o+m+p)/3 e a discordância
# viraria ruído.)
function _sample_duration(rng, t::GanttTask)
    (has_estimate(t) && !t.milestone) || return _effdur(t)
    o, m, q = Float64(t.optimistic), Float64(t.most_likely), Float64(t.pessimistic)
    q <= o && return max(round(Int, o), 1)            # degenerada: sem incerteza
    α = 1 + 4 * (m - o) / (q - o)
    β = 1 + 4 * (q - m) / (q - o)
    return max(round(Int, o + (q - o) * _rand_beta(rng, α, β)), 1)
end

"""
    pert_simulate(p::Project; n = 10_000, rng = Random.default_rng()) -> NamedTuple

Monte Carlo over the project's three-point estimates: draw a duration
for every estimated task from its Beta-PERT distribution, re-run the CPM
forward pass, and repeat `n` times. Returns `runs`, `mean_days` and
`sd_days` (spread of the simulated finishes, in days around the mean),
`expected` (the mean finish as a date) and the `p10`, `p50`, `p80` and
`p90` finish dates.

This is [`pert_finish`](@ref) without its blind spot. The formula only
propagates variance along today's critical path; here every path is
sampled, so a parallel chain with one day of slack and a wide estimate
shows up as the risk it is. Expect `p50` at or later than the formula's
expected finish, and the gap to grow with the number of near-critical
chains — that gap *is* the merge bias, made visible.

Pass a seeded `rng` (`Random.MersenneTwister(1)`) for a reproducible
run. Cost is one CPM pass per draw: a few hundred tasks × 10 000 draws
is a fraction of a second.
"""
function pert_simulate(p::Project; n::Integer = 10_000,
                       rng = Random.default_rng())
    n = max(Int(n), 1)
    lv = _leaf_view(p)
    isempty(lv.tasks) && return (; runs = 0, mean_days = 0.0, sd_days = 0.0,
                                 expected = Dates.today(), p10 = Dates.today(),
                                 p50 = Dates.today(), p80 = Dates.today(),
                                 p90 = Dates.today())
    # sem estimativa nenhuma não há o que sortear: uma passada basta, e
    # evita 10 mil execuções idênticas do motor
    any(has_estimate, lv.tasks) || (n = 1)
    dur = Vector{Int}(undef, length(lv.tasks))
    finishes = Vector{Date}(undef, n)
    for k in 1:n
        for (i, t) in enumerate(lv.tasks)
            dur[i] = _sample_duration(rng, t)
        end
        finishes[k] = _cpm(lv, dur).finish
    end
    sort!(finishes)
    base = finishes[1]
    days = [Float64(Dates.value(d - base)) for d in finishes]
    mean_days = sum(days) / n
    # variância populacional: a amostra É a distribuição simulada, não uma
    # amostra dela (n = 1 daria divisão por zero em n-1)
    sd_days = sqrt(sum((d - mean_days)^2 for d in days) / n)
    quant(q) = finishes[clamp(ceil(Int, q * n), 1, n)]
    return (; runs = n, mean_days, sd_days,
            expected = base + Dates.Day(round(Int, mean_days)),
            p10 = quant(0.10), p50 = quant(0.50),
            p80 = quant(0.80), p90 = quant(0.90))
end
