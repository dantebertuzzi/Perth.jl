# =============================================================================
# Perth.jl — projeto de aprendizado
#
# Um plano pequeno e realista em que CADA termo do glossário (Help → "What the
# words mean") aparece pelo menos uma vez, ao vivo. A explicação de cada termo
# fica na `notes` da tarefa que o demonstra: no navegador, o pontinho vermelho
# abre a nota já renderizada em markdown. O plano se explica por dentro.
#
#   julia> using Perth
#   julia> p = include("examples/learning.jl")
#   julia> Perth.run()
#
# As datas são ancoradas em HOJE, não em datas fixas: a linha de hoje cai no
# meio da obra, "overdue" é de verdade e a curva-S tem os dois lados. Rodar
# este arquivo em qualquer dia produz o mesmo plano relativo.
# =============================================================================

using Perth
using Dates: dayofweek

# Segunda-feira quatro semanas atrás. Tudo no plano é medido a partir daqui.
anchor = let d = today() - Day(28)
    d - Day(dayofweek(d) - 1)
end
day(n) = anchor + Day(n)

p = create_project("Learning Perth — the neighbourhood library")

# -----------------------------------------------------------------------------
# Pessoas  →  LANES
# -----------------------------------------------------------------------------
# Lanes: agrupar as linhas por pessoa ou por equipe, em vez de pela WBS. É o
# `team` daqui que dá as raias — por isso vale cadastrar, e não só digitar o
# nome no responsável. (No app: o seletor de agrupamento na barra de cima.)
people!(p, [
    (name = "Ana",    role = "Architect",   team = "Design"),
    (name = "Bruno",  role = "Engineer",    team = "Design"),
    (name = "Carlos", role = "Foreman",     team = "Works"),
    (name = "Dani",   role = "Electrician", team = "Works"),
    (name = "Elisa",  role = "Librarian",   team = "Collection"),
    (name = "Fábio",  role = "Buyer",       team = "Works"),
])

# -----------------------------------------------------------------------------
# 1. Fase de projeto  →  SUMMARY, WBS, TASK, DURATION, DEPENDENCY, PROGRESS, COST
# -----------------------------------------------------------------------------
# Note que TODAS as tarefas nascem em day(0). Isso é de propósito: é o
# `schedule!` lá embaixo que as espalha. Ver AUTO-SCHEDULE.

design = add_task!(p, "Survey and design"; start = day(0), duration = 1,
    notes = """
    **Summary.** A task with subtasks. Its dates and its progress are *not*
    typed in — they are rolled up from its children on every save. Try
    changing a child's duration and watch this bar follow.

    **WBS.** The indentation in the table is the breakdown: which task is
    inside which. This row is a block; the three below are its sub-blocks.
    """)

survey = add_task!(p, "Topographic survey"; start = day(0), duration = 5,
    assignee = "Ana", progress = 100, cost = 4_000,
    notes = """
    **Task.** A piece of work with a start and a duration — a bar on the
    chart. The plainest thing in the plan, and the only one that actually
    carries work.

    **Duration.** Length in days: 5. With a business-day calendar set
    (`set_calendar!`), weekends and holidays would stop counting.

    **Cost.** The planned weight of the task, in whatever unit you use —
    4000 here. Left at zero, the duration in person-days is the weight in
    the S-curve.
    """)

report = add_task!(p, "Structural report"; start = day(0), duration = 4,
    assignee = "Bruno", progress = 100, cost = 6_500,
    dependencies = [survey.id],
    notes = """
    **Dependency.** "This only starts after that." A bare id is
    **finish-to-start**, the default: this begins the day after the survey
    ends. Double-click the arrow on the chart to remove it.
    """)

drawings = add_task!(p, "Architectural drawings"; start = day(0), duration = 10,
    assignee = "Ana", progress = 100, cost = 12_000,
    dependencies = [report.id * "+2"],
    notes = """
    **Dependency with lag.** `id+2` adds two days between the predecessor's
    finish and this start — the time to read the report before drawing.
    `id-2` removes days instead.

    **Progress.** How much is done, in percent. The summary above averages
    its children, weighted by duration — it is not typed in anywhere.
    """)

for t in (survey, report, drawings)
    set_parent!(p, t.id, design.id)
end

# -----------------------------------------------------------------------------
# 2. MILESTONE
# -----------------------------------------------------------------------------
approved = add_task!(p, "Design approved"; start = day(0), milestone = true,
    progress = 100, dependencies = [drawings.id],
    notes = """
    **Milestone.** A date with nothing lasting: a delivery, an approval, a
    signature. Drawn as a diamond and never has a duration — the `duration`
    field is ignored here, not hidden.
    """)

# -----------------------------------------------------------------------------
# 3. Obra  →  SS, FF, PINNED START, "starts before its dependencies allow"
# -----------------------------------------------------------------------------
works = add_task!(p, "Works"; start = day(0), duration = 1,
    notes = "**Summary.** A second WBS block, so the indentation has more than one shape to show.")

demolition = add_task!(p, "Demolition"; start = day(0), duration = 6,
    assignee = "Carlos", progress = 100, cost = 9_000,
    dependencies = [approved.id],
    notes = "A dependency on a **milestone** works like any other: nothing starts before the signature.")

electrical = add_task!(p, "Electrical rework"; start = day(0), duration = 8,
    assignee = "Dani", progress = 60, cost = 21_000,
    dependencies = ["SS:" * demolition.id * "+3"],
    notes = """
    **Start-to-start.** `SS:id+3` ties the two *starts*: the electricians
    come in three days after demolition begins, not after it ends. Use it
    when the work overlaps on purpose.
    """)

painting = add_task!(p, "Painting"; start = day(0), duration = 5,
    assignee = "Carlos", progress = 20, cost = 7_500,
    dependencies = ["FF:" * electrical.id],
    notes = """
    **Finish-to-finish.** `FF:id` ties the two *finishes*: the paint dries
    when the wiring is done, whatever day it had to start to get there.
    """)

shelving = add_task!(p, "Shelving install"; start = day(0), duration = 4,
    assignee = "Carlos", progress = 50, cost = 14_000,
    dependencies = [painting.id],
    notes = """
    **Pinned start.** A date fixed by hand — the delivery window the
    supplier gave us. Auto-schedule leaves it alone.

    ⚠ **starts before its dependencies allow.** And it says so: the arrow
    from *Painting* points backwards, because the pin no longer fits the
    plan. A dependency never moves anything on its own — `schedule!` is what
    puts a task where it can go, *unless* the start is pinned. This is the
    one warning auto-schedule will not clear for you.

    And pinning has a second cost, further down the page: Carlos is now on
    this *and* on *Demolition* on the same days. A date fixed by hand is a
    promise made to the calendar, not to the person.
    """)

for t in (demolition, electrical, painting, shelving)
    set_parent!(p, t.id, works.id)
end

# -----------------------------------------------------------------------------
# 4. Acervo  →  OVERDUE, OVERALLOCATION
# -----------------------------------------------------------------------------
collection = add_task!(p, "Collection"; start = day(0), duration = 1,
    notes = "**Summary.** Work that runs off-site, in parallel with the building.")

cataloguing = add_task!(p, "Cataloguing"; start = day(4), duration = 12,
    assignee = "Elisa", progress = 40, cost = 5_000,
    notes = """
    ⚠ **overdue.** The day has passed and the task is not at 100%. Nothing
    computed it into place — the calendar simply moved on and this bar did
    not. It is the cheapest warning in the app and the one people miss most.
    """)

digitising = add_task!(p, "Digitising the rare shelf"; start = day(4), duration = 10,
    assignee = "Elisa", progress = 100, cost = 8_000,
    dependencies = ["SS:" * cataloguing.id * "+2"],
    notes = """
    ⚠ **overallocation.** The same person on two tasks on the same day —
    Elisa is on this *and* on *Cataloguing* for nine days. The `SS` link put
    them on purpose in parallel; the workload panel is where it stops being
    an opinion.

    **Workload.** How much each person has on each day. It is what turns a
    plan into a question about people.
    """)

for t in (cataloguing, digitising)
    set_parent!(p, t.id, collection.id)
end

# -----------------------------------------------------------------------------
# 5. DEADLINE  →  aviso "past deadline", folga negativa
# -----------------------------------------------------------------------------
# Solta de propósito: sem dependências, o prazo estourado só torna NEGATIVA a
# folga dela mesma. Pendurada na cadeia principal, contaminaria o caminho
# crítico inteiro — o que é correto, e ruim para um exemplo.
signage = add_task!(p, "Signage manufacturing"; start = day(20), duration = 6,
    assignee = "Fábio", progress = 100, cost = 3_200,
    deadline = day(23),
    notes = """
    **Deadline.** A date the task must not finish after. It never moves
    anything: it turns the slack of this task — and of everything feeding it
    — negative.

    ⚠ **past deadline.** This one finishes two days after the date it had
    promised. Look at `slack(p)`: `slack_days` is negative, and by exactly
    that much. Negative slack is a promise already broken.
    """)

# -----------------------------------------------------------------------------
# 6. Reabertura + programação  →  segundo MILESTONE, PERT, P80
# -----------------------------------------------------------------------------
reopening = add_task!(p, "Library reopens"; start = day(0), milestone = true,
    dependencies = [painting.id, shelving.id, cataloguing.id, digitising.id],
    notes = "**Milestone.** Four arrows in, no duration: the day everything upstream has to be true.")

programme = add_task!(p, "Opening programme"; start = day(0), duration = 1,
    notes = "**Summary.** The part of the plan that has not happened yet — which is where the PERT estimates below earn their keep.")

training = add_task!(p, "Staff training"; start = day(0), duration = 5,
    assignee = "Elisa", cost = 4_000, dependencies = [reopening.id],
    notes = "**PERT.** Three estimates instead of one: 3 / 5 / 10 days. Expected = (o + 4m + p) / 6.")

events = add_task!(p, "Opening week events"; start = day(0), duration = 5,
    assignee = "Ana", cost = 11_000, dependencies = [training.id],
    notes = "**PERT.** 4 / 5 / 8 — a task we are fairly sure about. σ = (p − o)/6 is small.")

workshops = add_task!(p, "Community workshops"; start = day(0), duration = 8,
    assignee = "Bruno", cost = 6_000, dependencies = [events.id],
    notes = """
    **PERT.** 5 / 8 / 20 — the uncertain one, and the reason the P80 is not
    the expected date. Three estimates say how *uncertain* a task is, not
    only how long it is.

    **P80.** The finish date with an 80% chance of being met. The date to
    promise when the plan has uncertainty in it — `pert_date(p, 0.8)`.
    """)

for t in (training, events, workshops)
    set_parent!(p, t.id, programme.id)
end

# As estimativas NÃO movem nada sozinhas: `apply = false` grava a incerteza e
# deixa a duração como está. Quem escreve (o + 4m + p)/6 no plano é `pert!(p)`,
# do mesmo jeito que quem move datas é `schedule!`.
set_estimate!(p, training.id,   3, 5, 10; apply = false)
set_estimate!(p, events.id,     4, 5,  8; apply = false)
set_estimate!(p, workshops.id,  5, 8, 20; apply = false)

# -----------------------------------------------------------------------------
# AUTO-SCHEDULE
# -----------------------------------------------------------------------------
# Tudo nasceu em day(0), empilhado. Uma chamada e o grafo de dependências
# desenha o plano. Auto-schedule nunca inventa trabalho: só fecha as folgas
# que o plano não precisa.
#
# A sutileza que vale saber: a data da própria tarefa é um PISO
# (start-no-earlier-than). `schedule!` empurra para frente, nunca puxa para
# trás — foi por isso que começamos cedo demais, e não tarde demais.
schedule!(p)

# PINNED START, depois do schedule! para pegar a data que o motor calculou e
# fixar a tarefa ANTES dela. Daí o aviso "starts before its dependencies allow".
update_task!(p, shelving.id; start = shelving.start - Day(7), pinned = true)

# -----------------------------------------------------------------------------
# BASELINE  →  e, logo em seguida, o aviso "behind the baseline"
# -----------------------------------------------------------------------------
# Baseline: uma cópia congelada do plano — o que foi prometido. As barras
# fantasma no gráfico são o baseline; a diferença entre elas e as barras é o
# atraso.
set_baseline!(p)

# Agora o plano escorrega: a pintura atrasa quatro dias, e o schedule! empurra
# quem vem depois. É isso que as barras fantasma passam a mostrar.
update_task!(p, painting.id; start = painting.start + Day(4))
schedule!(p)

# -----------------------------------------------------------------------------
# SEQUENCE (#)
# -----------------------------------------------------------------------------
# A posição da linha. Onde alguém escolheu, a escolha vale; onde ninguém
# escolheu, as linhas vêm por data de início. Aqui a instalação das
# prateleiras sobe para o topo do grupo "Works" mesmo começando depois —
# é o equivalente a arrastar a linha para cima no navegador.
move_task!(p, shelving.id; position = 1)

# -----------------------------------------------------------------------------
# CALENDAR BAND, MARKED DAY, MARKED MONTH
# -----------------------------------------------------------------------------
# Anotação, sempre: nenhum dos três move uma tarefa nem entra no motor de CPM.
add_band!(p, "Rainy season", day(-10), day(20); color = "#6fa8dc")
add_band!(p, "Sprint 1", day(22), day(35))

add_marker!(p, "Fire inspection", day(30); label_at = 35)
add_marker!(p, "Press visit", day(38); color = "#cb3c33", label_at = 60)

add_month_mark!(p, anchor + Day(60); name = "school holidays")

# -----------------------------------------------------------------------------
# DEPENDENCY CYCLE — o único aviso que PARA o motor
# -----------------------------------------------------------------------------
# Por isso não vem montado no plano: com um ciclo, `schedule!` lança
# ArgumentError e nada mais é calculado. Chame para ver o aviso, e desfaça.
#
#   cycle_demo!(p)     # A espera B e B espera A
#   undo_cycle!(p)     # corta o laço
function cycle_demo!(p)
    d = p.tasks[findfirst(t -> t.name == "Demolition", p.tasks)]
    e = p.tasks[findfirst(t -> t.name == "Electrical rework", p.tasks)]
    update_task!(p, d.id; dependencies = [d.dependencies; e.id])
    @info "ciclo criado — has_cycle(p) = $(has_cycle(p)). schedule! agora lança."
    return p
end

function undo_cycle!(p)
    d = p.tasks[findfirst(t -> t.name == "Demolition", p.tasks)]
    e = p.tasks[findfirst(t -> t.name == "Electrical rework", p.tasks)]
    update_task!(p, d.id; dependencies = filter(!=(e.id), d.dependencies))
    @info "laço cortado — has_cycle(p) = $(has_cycle(p))."
    return p
end

# -----------------------------------------------------------------------------
# O que o motor calcula: FINISH, CRITICAL PATH, SLACK, S-CURVE, WORKLOAD, P80
# -----------------------------------------------------------------------------
function tour(p)
    nome(id) = (i = findfirst(t -> t.id == id, p.tasks); i === nothing ? id : p.tasks[i].name)

    println("\n── Finish ─────────────────────────────────────────────")
    println("  o fim do projeto como o motor o calcula, a partir das")
    println("  dependências e das durações: ", project_finish(p))

    println("\n── Critical path ──────────────────────────────────────")
    println("  a cadeia sem folga. Um dia perdido em qualquer uma delas")
    println("  é um dia perdido pelo projeto inteiro.")
    for id in critical_path(p)
        println("    · ", nome(id))
    end

    println("\n── Slack ──────────────────────────────────────────────")
    println("  quantos dias a tarefa pode escorregar antes de empurrar o")
    println("  fim. Zero = caminho crítico. Negativo = promessa já quebrada.")
    for r in sort(slack(p), by = x -> x.slack_days)
        r.slack_days <= 3 || continue
        println("    ", lpad(string(r.slack_days), 4), " d  ", r.name)
    end

    println("\n── Baseline ───────────────────────────────────────────")
    println("  a diferença entre o prometido e o plano de hoje:")
    for r in slippage(p)
        r.slip_days > 0 && println("    +", r.slip_days, " d  ", r.name)
    end

    println("\n── Deadline ───────────────────────────────────────────")
    for r in deadline_slip(p)
        println("    ", r.name, ": prometido ", r.deadline, ", termina ", r.finish,
                " (", r.slip_days, " d)")
    end

    println("\n── starts before its dependencies allow ───────────────")
    println("  as datas dizem uma coisa e as setas, outra:")
    for r in slack(p)
        i = findfirst(t -> t.id == r.id, p.tasks)
        i === nothing && continue
        t = p.tasks[i]
        r.early_start > t.start || continue
        println("    ", t.name, ": começa ", t.start, ", só pode em ", r.early_start,
                t.pinned ? "  (data fixa — auto-schedule não resolve)" : "")
    end

    println("\n── Overdue ────────────────────────────────────────────")
    println("  o dia passou e a tarefa não está em 100%:")
    for (t, _) in ordered_tasks(p)
        (is_summary(p, t) || t.progress >= 100) && continue
        end_date(p, t) < today() || continue
        println("    ", t.name, ": terminou ", end_date(p, t), " com ", t.progress, "%")
    end

    println("\n── Overallocation ─────────────────────────────────────")
    println("  a mesma pessoa em duas tarefas no mesmo dia:")
    for r in overallocations(p)
        println("    ", r.assignee, ": \"", r.task1_name, "\" × \"", r.task2_name,
                "\"  ", r.from, " → ", r.to)
    end

    println("\n── PERT e P80 ─────────────────────────────────────────")
    f = pert_finish(p)
    println("  esperado (P50): ", f.expected, "   σ = ", round(f.sd_days, digits = 2), " d")
    println("  P80:            ", pert_date(p, 0.8))
    println("  chance de cumprir o fim calculado: ",
            round(100 * finish_probability(p, project_finish(p))), "%")
    println("\n  (a curva-S e o workload por dia são painéis do app:")
    println("   Insights → S-curve / Workload. `workload(p)` dá as linhas.)\n")
    return nothing
end

tour(p)

@info """
Projeto de aprendizado pronto: "$(p.name)"
  Perth.run()          para abrir no navegador
  tour(p)              para repetir o resumo acima
  cycle_demo!(p)       para ver o único aviso que para o motor
  Perth.save(p, "learning.perth.jl")   para exportar
"""

p
