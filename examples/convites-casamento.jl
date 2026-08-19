# =============================================================================
# Perth.jl — ateliê de convites de casamento
#
# Um pedido inteiro, do briefing à entrega na mão dos noivos: criação,
# compra de papel, impressão, acabamento artesanal e caligrafia. O plano é
# um MODELO — `pedido_convite!` monta o mesmo cronograma para qualquer
# casal, qualquer data e qualquer tiragem, que é como um ateliê trabalha:
# o processo é sempre o mesmo, o que muda é a data do casamento.
#
#   julia> using Perth
#   julia> p = include("examples/convites-casamento.jl")
#   julia> Perth.run()
#
#   julia> q = pedido_convite!("Bia & Tom", Date(2027, 3, 20); convites = 180)
#
# A regra que rege tudo: o convite chega ao correio ~60 dias antes do
# casamento. Essa data é um PRAZO (deadline) — no Perth ela nunca empurra
# uma tarefa, ela transforma a folga em negativa e acende o aviso. É o
# jeito honesto de perguntar "ainda dá?".
# =============================================================================

using Perth
using Dates   # dayofweek, Period, format — o vocabulário que o Perth não reexporta

# -----------------------------------------------------------------------------
# O modelo do ateliê
# -----------------------------------------------------------------------------
"""
    pedido_convite!(noivos, casamento; convites = 300, inicio = today(),
                    entrega_antes = Day(60)) -> Project

Monta o cronograma completo de um pedido de convites. `casamento` é a data
da cerimônia; a entrega aos noivos vira um prazo `entrega_antes` dias antes
dela. As tarefas nascem todas em `inicio` — é o `schedule!` no fim que as
espalha pelas dependências.
"""
function pedido_convite!(noivos::AbstractString, casamento::Date;
                         convites::Integer = 300,
                         inicio::Date = today(),
                         entrega_antes::Period = Day(60))

    entrega = casamento - entrega_antes
    p = create_project("Convites — $noivos ($convites un.) · $(Dates.format(casamento, "dd/mm/yyyy"))")

    # Quem faz o quê. O `team` é o que dá as raias do gráfico (agrupar por
    # equipe em vez de pela WBS), então vale cadastrar em vez de só digitar
    # o nome no responsável.
    people!(p, [
        (name = "Dante",  role = "Atendimento",  team = "Ateliê"),
        (name = "Lívia",  role = "Designer",     team = "Criação"),
        (name = "Caio",   role = "Impressor",    team = "Produção"),
        (name = "Sofia",  role = "Acabamento",   team = "Produção"),
        (name = "Helena", role = "Calígrafa",    team = "Produção"),
        (name = "Marcos", role = "Compras",      team = "Ateliê"),
        (name = "Noivos", role = "Cliente",      team = "Cliente"),
    ])

    # Dias úteis, se BusinessDays estiver carregado. Sem ele o motor conta
    # dias corridos — e o ateliê não trabalha domingo, então vale a pena:
    #   julia> using BusinessDays, Perth
    if hasmethod(Perth._business_calendar, Tuple{String})
        set_calendar!(p, "Brazil")
    end

    # ------------------------------------------------------------------
    # 1. Briefing e conceito
    # ------------------------------------------------------------------
    f1 = add_task!(p, "1. Briefing e conceito"; start = inicio, duration = 1)

    briefing = add_task!(p, "Reunião de briefing com os noivos";
        start = inicio, duration = 1, assignee = "Dante", parent = f1.id,
        pinned = true, cost = 0,
        notes = """
        **Data contratada** — a reunião já foi marcada com o casal, então a
        tarefa está *fixa* (`pinned`): o auto-schedule não a move, e avisa se
        o resto do plano deixar de caber a partir dela.

        Sai daqui: estilo, paleta, tiragem, se haverá *save the date*, e
        quantos convites nominais.
        """)

    lista = add_task!(p, "Lista de convidados e textos oficiais";
        start = inicio, duration = 5, assignee = "Noivos", parent = f1.id,
        dependencies = [briefing.id], deadline = inicio + Day(10),
        notes = """
        **A tarefa que atrasa todo pedido.** Nomes completos, títulos e a
        grafia exata de cada convidado, mais os textos da cerimônia e da
        festa. É trabalho *do cliente*, e por isso tem prazo próprio.

        Sem ela não há personalização nem caligrafia — repare nas setas que
        saem daqui direto para a produção.
        """)

    moodboard = add_task!(p, "Moodboard e referências";
        start = inicio, duration = 2, assignee = "Lívia", parent = f1.id,
        dependencies = [briefing.id], cost = 350)

    conceito = add_task!(p, "Conceito aprovado";
        start = inicio, milestone = true, parent = f1.id,
        dependencies = [moodboard.id],
        notes = "**Marco.** O casal escolheu um caminho. A criação começa aqui.")

    # ------------------------------------------------------------------
    # 2. Criação
    # ------------------------------------------------------------------
    f2 = add_task!(p, "2. Criação"; start = inicio, duration = 1)

    layout = add_task!(p, "Layout do convite";
        start = inicio, duration = 4, assignee = "Lívia", parent = f2.id,
        dependencies = [conceito.id], cost = 1_800)

    monograma = add_task!(p, "Monograma e brasão do casal";
        start = inicio, duration = 3, assignee = "Lívia", parent = f2.id,
        dependencies = ["SS:$(layout.id)+1"], cost = 900,
        notes = """
        **Start-to-start com 1 dia de defasagem.** O monograma não espera o
        layout ficar pronto: começa um dia depois que ele começa, porque os
        dois se ajustam um ao outro enquanto nascem.

        Vai gravado em *hot stamping*, então precisa de traço fechado — nada
        mais fino que 0,4 pt sobrevive ao clichê.
        """)

    diagramacao = add_task!(p, "Diagramação dos textos";
        start = inicio, duration = 2, assignee = "Lívia", parent = f2.id,
        dependencies = [layout.id, lista.id], cost = 600)

    revisao = add_task!(p, "Revisão ortográfica";
        start = inicio, duration = 1, assignee = "Dante", parent = f2.id,
        dependencies = [diagramacao.id],
        notes = """
        Nome errado em convite impresso é reimpressão inteira. Confere-se
        aqui: nomes, títulos, datas por extenso, endereço e horário.
        """)

    prova_digital = add_task!(p, "Prova digital enviada";
        start = inicio, milestone = true, parent = f2.id,
        dependencies = [revisao.id, monograma.id])

    ajustes = add_task!(p, "Rodada de ajustes dos noivos";
        start = inicio, duration = 3, assignee = "Lívia", parent = f2.id,
        dependencies = [prova_digital.id], cost = 400,
        notes = """
        **A maior incerteza do pedido.** Pode voltar aprovado em um dia ou
        render duas semanas de "e se a fonte fosse outra?". Por isso ela tem
        estimativa de três pontos (PERT) em vez de um número só — veja
        `pert(p)` e `pert_simulate(p)`.
        """)

    arte_ok = add_task!(p, "Arte aprovada pelos noivos";
        start = inicio, milestone = true, parent = f2.id,
        dependencies = [ajustes.id],
        notes = """
        **Ponto de não-retorno.** Depois deste marco, mudança de arte é
        pedido novo: o papel já foi cortado e o clichê, gravado.
        """)

    # ------------------------------------------------------------------
    # 3. Materiais
    # ------------------------------------------------------------------
    f3 = add_task!(p, "3. Materiais"; start = inicio, duration = 1)

    cotacao = add_task!(p, "Cotação de papéis e envelopes";
        start = inicio, duration = 3, assignee = "Marcos", parent = f3.id,
        dependencies = [conceito.id])

    compra_papel = add_task!(p, "Compra do papel algodão 300 g e envelopes";
        start = inicio, duration = 1, assignee = "Marcos", parent = f3.id,
        dependencies = [cotacao.id], cost = round(convites * 6.40; digits = 2),
        notes = """
        **$(convites) convites + 12% de sobra** para perdas de corte, testes de
        registro e os inevitáveis "esqueci de uma tia".

        Papel algodão 300 g/m², envelope forrado do mesmo lote — cor de lote
        diferente aparece na mesa do casamento.
        """)

    lead_time = add_task!(p, "Lead time do fornecedor (papel importado)";
        start = inicio, duration = 10, parent = f3.id,
        dependencies = [compra_papel.id], color = "#999999",
        notes = """
        **Espera, não trabalho.** Ninguém do ateliê está ocupado aqui — é o
        papel atravessando a alfândega. Fica no plano porque atrasa tudo
        igual, e leva estimativa de três pontos: importado, 10 dias é o bom
        dia; 25 é a semana em que o contêiner parou no porto.
        """)

    materiais_ok = add_task!(p, "Papel e envelopes em estoque";
        start = inicio, milestone = true, parent = f3.id,
        dependencies = [lead_time.id])

    add_task!(p, "Compra de lacres de cera, fitas de seda e selos";
        start = inicio, duration = 2, assignee = "Marcos", parent = f3.id,
        dependencies = [cotacao.id], cost = round(convites * 2.10; digits = 2))

    # ------------------------------------------------------------------
    # 4. Produção
    # ------------------------------------------------------------------
    f4 = add_task!(p, "4. Produção"; start = inicio, duration = 1)

    prova_fisica = add_task!(p, "Prova de cor e boneco físico";
        start = inicio, duration = 2, assignee = "Caio", parent = f4.id,
        dependencies = [arte_ok.id, materiais_ok.id], cost = 280,
        notes = """
        Uma unidade completa, montada, para o casal ver e tocar. Cor na tela
        e cor no algodão 300 g são duas cores diferentes — sempre.
        """)

    prova_ok = add_task!(p, "Prova física aprovada";
        start = inicio, milestone = true, parent = f4.id,
        dependencies = [prova_fisica.id])

    letterpress = add_task!(p, "Impressão letterpress da folha principal";
        start = inicio, duration = 4, assignee = "Caio", parent = f4.id,
        dependencies = [prova_ok.id], cost = round(convites * 5.80; digits = 2))

    hotstamping = add_task!(p, "Hot stamping do monograma";
        start = inicio, duration = 2, assignee = "Caio", parent = f4.id,
        dependencies = [letterpress.id], cost = round(convites * 2.90; digits = 2))

    corte = add_task!(p, "Corte a laser das camadas e da faixa";
        start = inicio, duration = 3, assignee = "Caio", parent = f4.id,
        dependencies = [hotstamping.id], cost = round(convites * 1.70; digits = 2))

    nomes = add_task!(p, "Impressão dos nomes dos convidados";
        start = inicio, duration = 2, assignee = "Caio", parent = f4.id,
        dependencies = [prova_ok.id, lista.id],
        notes = "Personalização nominal: cada convite sai com um nome, e um só.")

    # ------------------------------------------------------------------
    # 5. Acabamento artesanal
    # ------------------------------------------------------------------
    f5 = add_task!(p, "5. Acabamento artesanal"; start = inicio, duration = 1)

    montagem = add_task!(p, "Montagem e colagem das camadas";
        start = inicio, duration = 5, assignee = "Sofia", parent = f5.id,
        dependencies = [corte.id], cost = round(convites * 3.50; digits = 2))

    lacre = add_task!(p, "Fita de seda e lacre de cera";
        start = inicio, duration = 4, assignee = "Sofia", parent = f5.id,
        dependencies = ["SS:$(montagem.id)+2"], cost = round(convites * 2.40; digits = 2),
        notes = """
        Começa dois dias depois da montagem, sobre o que já está pronto — é
        assim que a bancada trabalha de verdade, em fluxo, não em bloco.
        """)

    caligrafia = add_task!(p, "Caligrafia dos envelopes";
        start = inicio, duration = 6, assignee = "Helena", parent = f5.id,
        dependencies = [nomes.id], cost = round(convites * 4.00; digits = 2),
        notes = """
        **$(convites) envelopes à mão**, cerca de 60 por dia com a caneta
        pousando entre um e outro. Depende da lista, não da impressão do
        convite: é a razão de a lista de convidados ter prazo próprio lá em
        cima.
        """)

    qualidade = add_task!(p, "Conferência e controle de qualidade";
        start = inicio, duration = 2, assignee = "Dante", parent = f5.id,
        dependencies = [lacre.id, caligrafia.id],
        notes = "Um a um: nome certo, envelope certo, lacre inteiro, cera sem trinca.")

    # ------------------------------------------------------------------
    # 6. Entrega
    # ------------------------------------------------------------------
    f6 = add_task!(p, "6. Entrega"; start = inicio, duration = 1)

    embalagem = add_task!(p, "Embalagem e separação por lote";
        start = inicio, duration = 2, assignee = "Sofia", parent = f6.id,
        dependencies = [qualidade.id], cost = 320,
        notes = "Separados por quem entrega: correio, mão do casal, padrinhos.")

    add_task!(p, "Entrega aos noivos";
        start = inicio, milestone = true, parent = f6.id,
        dependencies = [embalagem.id], deadline = entrega,
        notes = """
        **O prazo que manda no pedido.** $(Dates.value(Day(entrega_antes))) dias
        antes do casamento, para o convite chegar às mãos dos convidados com
        tempo de responder.

        Um prazo no Perth nunca move a tarefa: ele torna a folga *negativa*
        e acende o aviso. Se este marco ficar vermelho, a conversa com o
        casal é hoje, não em cima da data.
        """)

    add_task!(p, "Save the date digital e RSVP online";
        start = inicio, duration = 2, assignee = "Lívia", parent = f6.id,
        dependencies = [conceito.id], cost = 450,
        notes = """
        Sai na frente do convite impresso: segura a data enquanto o papel
        ainda está sendo importado.
        """)

    # O casamento em si NÃO é tarefa deste plano — é um `add_marker!` lá
    # embaixo. Como marco ele viraria a última linha do CPM: o fim do
    # projeto passaria a ser a data da cerimônia, o caminho crítico seria
    # ele sozinho e o PERT devolveria σ = 0. O ateliê termina na entrega;
    # a cerimônia é a régua, desenhada por cima.

    # ------------------------------------------------------------------
    # Incerteza: onde um número só seria mentira
    # ------------------------------------------------------------------
    # `apply = false`: a estimativa NÃO reescreve a duração planejada — ela
    # diz o quanto aquele número pode estar errado. O otimista/provável/
    # pessimista de cada uma é a experiência do ateliê escrita no plano.
    set_estimate!(p, ajustes.id,      1, 3,  12; apply = false)  # o casal pode sumir uma semana
    set_estimate!(p, lead_time.id,    7, 10, 25; apply = false)  # papel importado, e o porto
    set_estimate!(p, prova_fisica.id, 1, 2,   5; apply = false)  # cor que não bate na primeira
    set_estimate!(p, letterpress.id,  3, 4,   9; apply = false)  # registro travando na máquina
    set_estimate!(p, montagem.id,     4, 5,   9; apply = false)  # cola, secagem, refazer
    set_estimate!(p, caligrafia.id,   5, 6,  10; apply = false)  # a mão da Helena cansa

    # ------------------------------------------------------------------
    # Anotação (nada disto entra no motor de CPM)
    # ------------------------------------------------------------------
    add_band!(p, "Alta temporada de casamentos", casamento - Day(120), casamento;
              color = "#f2c14e")
    add_marker!(p, "Casamento", casamento; color = "#cb3c33", label_at = 40)
    add_marker!(p, "Convites no correio", entrega; label_at = 70)
    add_month_mark!(p, casamento; name = "mês do casamento")

    schedule!(p)
    return p
end

# Acha a tarefa pelo nome — o suficiente para mexer no plano do REPL sem
# guardar id nenhum.
tarefa(p, nome) = p.tasks[findfirst(t -> startswith(t.name, nome), p.tasks)]

"""
    andamento!(p, "nome da tarefa" => 100, ...)

Marca progresso por nome. `update_task!` persiste e o navegador aberto
recarrega sozinho.
"""
function andamento!(p, pares::Pair...)
    for (nome, pct) in pares
        update_task!(p, tarefa(p, nome).id; progress = Int(pct))
    end
    return p
end

# -----------------------------------------------------------------------------
# Um pedido de verdade, em andamento
# -----------------------------------------------------------------------------
# O briefing foi há três semanas (segunda-feira) e o casamento é daqui a uns
# três meses — o casal chegou tarde, como quase sempre. Assim a linha de
# hoje cai no meio do pedido: coisa pronta atrás, coisa atrasada em cima,
# produção inteira pela frente, e uma margem que cabe no plano mas não cabe
# no azar. As datas são relativas a hoje: rodar isto em qualquer dia dá o
# mesmo pedido.
briefing_em = let d = today() - Day(21)
    d - Day(dayofweek(d) - 1)
end

p = pedido_convite!("Marina & Rafael", today() + Day(85);
                    convites = 300, inicio = briefing_em)

# A linha de base: o que foi prometido ao casal no dia do briefing. Congela
# ANTES do atraso — é a comparação que dá sentido às barras-fantasma.
set_baseline!(p)

# ...e então a vida acontece. O papel importado ficou parado no porto e o
# casal levou dez dias para devolver a prova digital com os ajustes.
update_task!(p, tarefa(p, "Lead time do fornecedor").id; duration = 18)
update_task!(p, tarefa(p, "Rodada de ajustes").id; duration = 8)

# O que já se sabe também muda a incerteza: com o contêiner parado, a faixa
# do papel não é mais 7–25 em torno de 10, e a rodada de ajustes que já
# comeu oito dias não volta a caber em três.
set_estimate!(p, tarefa(p, "Lead time do fornecedor").id, 14, 18, 30; apply = false)
set_estimate!(p, tarefa(p, "Rodada de ajustes").id, 6, 8, 14; apply = false)

schedule!(p)

andamento!(p,
    "Reunião de briefing"        => 100,
    "Moodboard"                  => 100,
    "Conceito aprovado"          => 100,
    "Layout do convite"          => 100,
    "Monograma"                  => 100,
    "Lista de convidados"        => 70,    # o prazo do casal já passou
    "Cotação de papéis"          => 100,
    "Compra do papel"            => 100,
    "Compra de lacres"           => 100,
    "Save the date digital"      => 100,
    "Diagramação dos textos"     => 60,
    "Lead time do fornecedor"    => 45,
)

# -----------------------------------------------------------------------------
# As perguntas que o ateliê faz na segunda de manhã
# -----------------------------------------------------------------------------
function resumo(p)
    nome(id) = (i = findfirst(t -> t.id == id, p.tasks); i === nothing ? id : p.tasks[i].name)
    money(x) = "R\$ " * replace(string(round(Int, x)), r"(?<=\d)(?=(\d{3})+$)" => ".")

    println("\n╭─ ", p.name)

    println("\n── Dá tempo? ─────────────────────────────────────────")
    entrega_t = tarefa(p, "Entrega aos noivos")
    fim, prazo = end_date(p, entrega_t), entrega_t.deadline
    margem = Dates.value(prazo - fim)
    println("    entrega prometida: ", prazo)
    println("    entrega calculada: ", fim,
            margem >= 0 ? "   →  $(margem) dias de margem" :
                          "   →  ATRASA $(-margem) dias")
    println("    último dia do ateliê: ", project_finish(p))
    slips = deadline_slip(p)
    if isempty(slips)
        println("    nenhum prazo estourado no plano de hoje")
    else
        for r in slips
            println("    ⚠ ", r.name, ": prometido ", r.deadline, ", termina ",
                    r.finish, " (", r.slip_days, " d)")
        end
    end

    println("\n── O que não pode escorregar um dia ──────────────────")
    for id in critical_path(p)
        println("    · ", nome(id))
    end

    println("\n── Quase crítico (1 a 3 dias de folga) ───────────────")
    for r in sort(slack(p), by = x -> x.slack_days)
        0 < r.slack_days <= 3 || continue
        println("    ", lpad(string(r.slack_days), 4), " d  ", r.name)
    end

    println("\n── O que escorregou desde o briefing ─────────────────")
    for r in slippage(p)
        r.slip_days > 0 && println("    +", r.slip_days, " d  ", r.name)
    end

    println("\n── Atrasado (o dia passou e não está em 100%) ────────")
    for (t, _) in ordered_tasks(p)
        (is_summary(p, t) || t.progress >= 100 || t.milestone) && continue
        end_date(p, t) < today() || continue
        println("    ", t.name, ": venceu ", end_date(p, t), " com ", t.progress, "%")
    end

    println("\n── Alguém em duas coisas ao mesmo tempo ──────────────")
    for r in overallocations(p)
        println("    ", r.assignee, ": \"", r.task1_name, "\" × \"", r.task2_name,
                "\"  ", r.from, " → ", r.to)
    end

    println("\n── Quem carrega o pedido, e quanto ele custa ─────────")
    total = sum(t.cost for t in p.tasks if !is_summary(p, t); init = 0.0)
    for r in sort(people_stats(p), by = x -> -x.busy_days)
        isempty(r.assignee) && continue
        println("    ", rpad(r.assignee, 8), lpad(string(r.busy_days), 4), " dias na agenda,",
                lpad(string(r.tasks), 3), r.tasks == 1 ? " tarefa" : " tarefas",
                r.over_days > 0 ? "  ($(r.over_days) d em cima de outra)" : "")
    end
    println("    ", rpad("total", 8), lpad(money(total), 12), " em materiais e mão de obra")

    println("\n── E se der azar? (PERT) ─────────────────────────────")
    f = pert_finish(p)
    println("    esperado (P50): ", f.expected, "   σ = ", round(f.sd_days, digits = 2), " d")
    println("    P80 analítico:  ", pert_date(p, 0.8))
    sim = pert_simulate(p; n = 4_000)
    println("    P80 simulado:   ", sim.p80, "   (o motor rodado 4.000 vezes)")
    pct = round(Int, 100 * finish_probability(p, prazo))
    println("    chance de fechar tudo até ", prazo, ": ", pct, "%")
    println("    (é a margem lá de cima relida pelo azar: dias de folga no")
    println("     plano viram probabilidade quando as durações têm faixa.)\n")
    return nothing
end

resumo(p)

@info """
Pedido montado: "$(p.name)"
  Perth.run()                               abrir no navegador
  resumo(p)                                 repetir o quadro acima
  pedido_convite!("Bia & Tom", Date(2027, 3, 20); convites = 180)
                                            o mesmo processo, outro casal
  andamento!(p, "Caligrafia" => 30)         atualizar o que já foi feito
  Perth.save(p, "convites-marina-rafael.perth.jl")   exportar
"""

p
