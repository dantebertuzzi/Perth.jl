using Test
using Dates
using Perth
import JSON3

# Estado isolado num diretório temporário, sem tocar em ~/.perth
tmp = mktempdir()
Perth._init_state!(tmp)

@testset "Perth.jl" begin

    @testset "tipos" begin
        t = GanttTask(name = "Levantamento", start = Date(2026, 8, 3), duration = 5)
        @test length(t.id) == 8
        @test end_date(t) == Date(2026, 8, 7)

        m = GanttTask(name = "Entrega", start = Date(2026, 9, 1), milestone = true,
                      duration = 10)
        @test end_date(m) == Date(2026, 9, 1)  # marcos ignoram duração
    end

    @testset "normalização" begin
        t = GanttTask(name = "x", start = Date(2026, 1, 1), duration = -3,
                      progress = 250)
        Perth._normalize!(t)
        @test t.duration == 1
        @test t.progress == 100
    end

    @testset "projetos e tarefas via REPL" begin
        p = create_project("Obra do cartório")
        @test project("obra do cartório").id == p.id  # busca por nome, case-insensitive

        t1 = add_task!(p, "Digitalização"; start = Date(2026, 8, 1), duration = 15)
        t2 = add_task!(p, "Indexação"; start = Date(2026, 8, 16), duration = 10,
                       dependencies = [t1.id])
        @test length(p.tasks) == 2
        @test span(p) == (Date(2026, 8, 1), Date(2026, 8, 25))

        rows = tasks(p)
        @test rows isa Vector{<:NamedTuple}          # Tables.jl-compatible
        @test rows[1].name == "Digitalização"
        @test rows[2].finish == Date(2026, 8, 25)

        update_task!(p, t2.id; progress = 40, name = "Indexação do acervo")
        @test project(p.id).tasks[2].progress == 40

        remove_task!(p, t1.id)
        @test length(p.tasks) == 1
        @test isempty(p.tasks[1].dependencies)       # referência podada

        @test any(r -> r.id == p.id, projects())
    end

    @testset "persistência (roundtrip JSON em disco)" begin
        p = create_project("Roundtrip")
        add_task!(p, "α"; start = Date(2026, 7, 20), duration = 3, color = "#8be9fd",
                  assignee = "Dante", notes = "acentuação e unicode: ção ◆")

        file = joinpath(tmp, "$(p.id).json")
        @test isfile(file)
        q = JSON3.read(read(file, String), Perth.Project)
        @test q.name == "Roundtrip"
        @test q.tasks[1].start == Date(2026, 7, 20)
        @test q.tasks[1].notes == "acentuação e unicode: ção ◆"

        @test delete_project(p.id)
        @test !isfile(file)
        @test !delete_project("inexistente")
    end

    @testset "scheduling (CPM)" begin
        p = create_project("CPM")
        # Diamante: A -> B (5d), A -> C (2d), {B,C} -> D
        a = add_task!(p, "A"; start = Date(2026, 8, 3), duration = 3)
        b = add_task!(p, "B"; start = Date(2026, 8, 3), duration = 5,
                      dependencies = [a.id])
        c = add_task!(p, "C"; start = Date(2026, 8, 3), duration = 2,
                      dependencies = [a.id])
        d = add_task!(p, "D"; start = Date(2026, 8, 3), duration = 4,
                      dependencies = [b.id, c.id])

        @test !has_cycle(p)
        schedule!(p)
        @test b.start == Date(2026, 8, 6)          # empurrada para apos A
        @test d.start == Date(2026, 8, 11)         # apos B (ramo mais longo)
        @test project_finish(p) == Date(2026, 8, 14)

        cp = critical_path(p)
        @test cp == [a.id, b.id, d.id]             # C tem folga, fica de fora
        rows = slack(p)
        @test rows isa Vector{<:NamedTuple}
        sl = Dict(r.id => r.slack_days for r in rows)
        @test sl[c.id] == 3 && sl[b.id] == 0
        @test all(r.critical == (r.slack_days == 0) for r in rows)

        # Datas manuais sao restricao "nao antes de": schedule! nunca puxa para tras
        update_task!(p, d.id; start = Date(2026, 9, 1))
        schedule!(p)
        @test project(p.id).tasks[4].start == Date(2026, 9, 1)

        # Ciclo: A depende de D fecha o circuito
        update_task!(p, a.id; dependencies = [d.id])
        @test has_cycle(p)
        @test_throws ArgumentError schedule!(p)
        delete_project(p.id)
    end

    @testset "renderizacao nativa" begin
        p = create_project("Show")
        t1 = add_task!(p, "Base"; start = Date(2026, 8, 3), duration = 5, progress = 40)
        add_task!(p, "Entrega"; start = Date(2026, 8, 10), milestone = true,
                  dependencies = [t1.id])

        txt = sprint(show, MIME("text/plain"), p)
        @test occursin("Show", txt) && occursin("\u25c6", txt) && occursin("\u2588", txt)

        html = sprint(show, MIME("text/html"), p)
        @test startswith(html, "<svg") && occursin("Entrega", html)

        @test sprint(show, p) == "Project(\"Show\", 2 tasks)"  # forma compacta
        delete_project(p.id)
    end

    @testset "formato .perth.jl" begin
        p = create_project("Formato Julia")
        t1 = add_task!(p, "Digitaliza\u00e7\u00e3o \u25c6"; start = Date(2026, 7, 20),
                       duration = 3, color = "#9558b2",
                       notes = "aspas \" e barra \\ e \$interp")
        add_task!(p, "Marco"; start = Date(2026, 8, 1), milestone = true,
                  dependencies = [t1.id])

        path = joinpath(tmp, "x.perth.jl")
        Perth.save(p, path)
        src = read(path, String)
        @test occursin("Project(", src) && occursin("GanttTask(", src)
        @test Meta.parseall(src) isa Expr        # e codigo Julia valido

        q = Perth.load(path; register = false)
        @test q.id == p.id && q.name == p.name
        @test q.tasks[1].notes == p.tasks[1].notes   # escaping sobreviveu
        @test q.tasks[2].milestone && q.tasks[2].dependencies == [t1.id]

        # register = true substitui o projeto de mesmo id no store
        update_task!(p, t1.id; progress = 90)
        Perth.load(path)                             # arquivo tem progress = 0
        @test project(p.id).tasks[1].progress == 0

        # Seguranca: o parser restrito rejeita codigo arbitrario sem executa-lo
        @test_throws ArgumentError Perth._parse_project_source("run(`ls`)")
        @test_throws ArgumentError Perth._parse_project_source(
            "Project(name = readline())")
        @test_throws ArgumentError Perth._parse_project_source(
            "x = 1; Project(name = \"a\")")
        delete_project(p.id)
    end

    @testset "espelhamento em arquivo (set_file_path!)" begin
        p = create_project("Espelho")
        add_task!(p, "Tarefa"; start = Date(2026, 7, 20), duration = 2)

        # Resolução de caminho: diretório -> slug do nome; sem .jl -> anexa
        dir = mktempdir()
        @test Perth._resolve_save_path(p, dir) == joinpath(dir, "espelho.perth.jl")
        @test Perth._resolve_save_path(p, joinpath(dir, "plano")) ==
              joinpath(dir, "plano.perth.jl")
        @test_throws ArgumentError Perth._resolve_save_path(
            p, joinpath(dir, "nao-existe", "x.perth.jl"))

        # Vincular escreve o arquivo na hora…
        path = set_file_path!(p, joinpath(dir, "plano.perth.jl"))
        @test isfile(path) && p.file_path == path

        # …e cada salvamento subsequente re-escreve o espelho
        add_task!(p, "Nova"; start = Date(2026, 7, 25), duration = 1)
        @test occursin("Nova", read(path, String))
        q = Perth.load(path; register = false)
        @test length(q.tasks) == 2

        # file_path é local à máquina: nunca vaza para o .perth.jl exportado
        @test !occursin("file_path", read(path, String))
        @test isempty(q.file_path)

        # Desvincular para de espelhar
        @test set_file_path!(p, nothing) == ""
        rm(path)
        add_task!(p, "Depois"; start = Date(2026, 7, 26), duration = 1)
        @test !isfile(path)
        delete_project(p.id)
    end

    @testset "duplicar tarefa" begin
        p = create_project("Dup")
        a = add_task!(p, "Base"; start = Date(2026, 8, 3), duration = 4,
                      progress = 40, assignee = "Dante", notes = "obs",
                      color = "#bd93f9")
        b = add_task!(p, "Sucessora"; start = Date(2026, 8, 10),
                      dependencies = [a.id])
        dup = duplicate_task!(p, a.id)

        # Cópia fiel, id novo, nome com sufixo, inserida após a original
        @test dup.id != a.id
        @test dup.name == "Base (copy)"
        @test (dup.start, dup.duration, dup.progress) == (a.start, a.duration, a.progress)
        @test (dup.assignee, dup.notes, dup.color) == (a.assignee, a.notes, a.color)
        @test findfirst(t -> t.id == dup.id, p.tasks) ==
              findfirst(t -> t.id == a.id, p.tasks) + 1

        # Dependências: copia as predecessoras, sem virar dependente de si
        c = add_task!(p, "Com dep"; start = Date(2026, 8, 12),
                      dependencies = [a.id])
        d = duplicate_task!(p, c.id)
        @test d.dependencies == [a.id]
        @test d.dependencies !== c.dependencies      # vetor próprio, não alias
        # Dependentes da original não são tocados
        @test b.dependencies == [a.id]

        @test_throws KeyError duplicate_task!(p, "nao-existe")
        delete_project(p.id)
    end

    @testset "WBS: hierarquia e rollup" begin
        p = create_project("Obra WBS")
        fase = add_task!(p, "Fase 1"; start = Date(2026, 9, 1), duration = 1)
        a = add_task!(p, "Fundação"; start = Date(2026, 9, 1), duration = 5,
                      progress = 100, parent = fase.id)
        b = add_task!(p, "Alvenaria"; start = Date(2026, 9, 10), duration = 5,
                      progress = 40, parent = fase.id)
        solo = add_task!(p, "Licenças"; start = Date(2026, 8, 25), duration = 3)

        # add_task! persistiu -> rollup já materializado no resumo
        @test is_summary(p, fase)
        @test !is_summary(p, a)
        @test fase.start == Date(2026, 9, 1)
        @test fase.duration == 14                       # 1/9 → 14/9
        @test fase.progress == 70                       # média ponderada (5d cada)
        @test Set(t.id for t in subtasks(p, fase.id)) == Set([a.id, b.id])

        # ordered_tasks: filhos sob o pai, com profundidade
        ord = ordered_tasks(p)
        names = [t.name for (t, _) in ord]
        depths = Dict(t.name => d for (t, d) in ord)
        @test names == ["Licenças", "Fase 1", "Fundação", "Alvenaria"]
        @test depths["Fase 1"] == 0 && depths["Fundação"] == 1

        # CPM opera só nas folhas: o resumo nunca entra no caminho crítico
        @test fase.id ∉ critical_path(p)
        @test all(r -> r.id != fase.id, slack(p))

        # set_parent!: validações de ciclo e de marco
        @test_throws ArgumentError set_parent!(p, fase.id, a.id)   # descendente
        @test_throws ArgumentError set_parent!(p, a.id, a.id)      # si mesma
        m = add_task!(p, "Marco"; start = Date(2026, 9, 20), milestone = true)
        @test_throws ArgumentError set_parent!(p, solo.id, m.id)   # pai marco
        set_parent!(p, solo.id, fase.id)
        @test fase.start == Date(2026, 8, 25)           # rollup engoliu Licenças
        set_parent!(p, solo.id, nothing)
        @test fase.start == Date(2026, 9, 1)

        # Ciclo plantado à força é podado no save
        fase.parent = a.id                              # a é filho de fase: ciclo
        Perth._with_state(st -> Perth._save!(st, p))
        @test isempty(fase.parent) || fase.parent != a.id
        @test !Perth.has_cycle(p)

        # remover o resumo promove os filhos
        remove_task!(p, fase.id)
        @test a.parent == "" && b.parent == ""
        delete_project(p.id)
    end

    @testset "baseline e derrapagem" begin
        p = create_project("Baseline")
        a = add_task!(p, "Tarefa"; start = Date(2026, 9, 1), duration = 5)
        set_baseline!(p)
        @test has_baseline(a)
        @test a.baseline_start == Date(2026, 9, 1) && a.baseline_duration == 5
        @test p.baseline_at !== nothing

        # sem mudança: derrapagem zero
        @test slippage(p, a.id) == 0

        # atrasa 3 dias -> slip 3 (dias corridos)
        update_task!(p, a.id; start = Date(2026, 9, 4))
        @test slippage(p, a.id) == 3
        rows = slippage(p)
        @test length(rows) == 1 && rows[1].slip_days == 3
        @test rows[1].baseline_finish == Date(2026, 9, 5)

        # roundtrip .perth.jl preserva baseline e parent
        b = add_task!(p, "Filha"; start = Date(2026, 9, 10), parent = a.id)
        dir = mktempdir()
        path = Perth.save(p, joinpath(dir, "x.perth.jl"))
        q = Perth.load(path; register = false)
        qa = only(filter(t -> t.name == "Tarefa", q.tasks))
        qb = only(filter(t -> t.name == "Filha", q.tasks))
        @test qa.baseline_start == Date(2026, 9, 1) && qa.baseline_duration == 5
        @test qb.parent == qa.id
        @test q.baseline_at !== nothing
        @test is_summary(q, qa)                        # rollup rodou no load

        clear_baseline!(p)
        @test !has_baseline(a) && p.baseline_at === nothing
        @test_throws ArgumentError slippage(p, a.id)
        delete_project(p.id)
    end

    @testset "Tables.jl: tasktable e add_tasks!" begin
        p = create_project("Tabelas")
        a = add_task!(p, "Pai"; start = Date(2026, 10, 1), duration = 1)
        add_task!(p, "Filha"; start = Date(2026, 10, 1), duration = 4,
                  progress = 50, assignee = "Dante", parent = a.id)

        rows = tasktable(p)
        @test length(rows) == 2
        @test rows[1].name == "Pai" && rows[1].summary === true
        @test rows[1].wbs_depth == 0 && rows[2].wbs_depth == 1
        @test rows[2].finish == Date(2026, 10, 4)
        @test rows[1].slip_days === missing            # sem baseline
        # Vector{NamedTuple} é uma tabela Tables.jl válida
        @test Perth.Tables.istable(rows)

        # importa de uma "tabela" (vetor de NamedTuples), com deps em string
        add_tasks!(p, [
            (name = "Nova A", start = "2026-10-10", duration = 3, assignee = "Ana"),
            (name = "Nova B", start = Date(2026, 10, 15), dependencies = "$(a.id); inexistente"),
        ])
        na = only(filter(t -> t.name == "Nova A", p.tasks))
        nb = only(filter(t -> t.name == "Nova B", p.tasks))
        @test na.start == Date(2026, 10, 10) && na.assignee == "Ana"
        @test nb.dependencies == [a.id]                # ref órfã podada no save
        @test_throws ArgumentError add_tasks!(p, [(start = Date(2026, 1, 1),)])
        delete_project(p.id)
    end

    @testset "superalocação de responsáveis" begin
        p = create_project("Aloc")
        pai = add_task!(p, "Grupo"; start = Date(2026, 11, 2), duration = 1)
        add_task!(p, "A"; start = Date(2026, 11, 2), duration = 5,
                  assignee = "Dante", parent = pai.id)
        add_task!(p, "B"; start = Date(2026, 11, 4), duration = 5,
                  assignee = "Dante")                   # sobrepõe 4–6/11
        add_task!(p, "C"; start = Date(2026, 11, 20), duration = 5,
                  assignee = "Dante")                   # disjunta
        add_task!(p, "D"; start = Date(2026, 11, 4), duration = 2,
                  assignee = "Ana")                     # outra pessoa

        ov = overallocations(p)
        @test length(ov) == 1
        @test ov[1].assignee == "Dante"
        @test ov[1].from == Date(2026, 11, 4) && ov[1].to == Date(2026, 11, 6)
        @test Set([ov[1].task1_name, ov[1].task2_name]) == Set(["A", "B"])
        # o resumo "Grupo" cobre tudo mas não conta: contêiner, não trabalho
        @test all(r -> r.task1_name != "Grupo" && r.task2_name != "Grupo", ov)
        delete_project(p.id)
    end

    @testset "duplicar subárvore WBS" begin
        p = create_project("DupWBS")
        pai = add_task!(p, "Bloco"; start = Date(2026, 12, 1), duration = 1)
        f1 = add_task!(p, "Etapa 1"; start = Date(2026, 12, 1), duration = 3,
                       parent = pai.id)
        f2 = add_task!(p, "Etapa 2"; start = Date(2026, 12, 5), duration = 3,
                       parent = pai.id, dependencies = [f1.id])
        fora = add_task!(p, "Externa"; start = Date(2026, 11, 25), duration = 2)
        update_task!(p, f1.id; dependencies = [fora.id])

        dup = duplicate_task!(p, pai.id)
        @test dup.name == "Bloco (copy)"
        filhos = subtasks(p, dup.id)
        @test length(filhos) == 2                       # subárvore clonada
        c1 = only(filter(t -> t.name == "Etapa 1", filhos))
        c2 = only(filter(t -> t.name == "Etapa 2", filhos))
        @test c1.id != f1.id && c2.id != f2.id
        @test c2.dependencies == [c1.id]                # dep interna remapeada
        @test c1.dependencies == [fora.id]              # dep externa preservada
        @test f2.dependencies == [f1.id]                # original intacta
        delete_project(p.id)
    end

    @testset "pasta padrão do navegador de arquivos" begin
        # Atalhos do sistema: Home sempre existe e vem primeiro
        places = Perth._system_places()
        @test places[1].label == "Home" && places[1].path == homedir()
        @test all(pl -> isdir(pl.path), places)

        # Vincular memoriza o diretório em settings.json…
        p = create_project("Padrão")
        dir = mktempdir()
        set_file_path!(p, joinpath(dir, "a.perth.jl"))
        st = Perth._state()
        @test st.settings["default_save_dir"] == dir
        @test isfile(joinpath(st.data_dir, "settings.json"))

        # …e a preferência sobrevive a um restart do estado
        Perth._init_state!(st.data_dir)
        @test Perth._state().settings["default_save_dir"] == dir
        # settings.json não é confundido com um arquivo de projeto
        @test haskey(Perth._state().projects, p.id)
        delete_project(p.id)
    end

    @testset "business-day calendar" begin
        p = create_project("Calendar")
        t = add_task!(p, "Work"; start = Date(2026, 8, 3), duration = 5)

        # Sem calendario: dias corridos, end_date(p, t) == end_date(t)
        @test p.calendar == ""
        @test end_date(p, t) == end_date(t) == Date(2026, 8, 7)

        # set_calendar! persiste e passa pelo roundtrip .jl
        set_calendar!(p, "Brazil")
        @test project(p.id).calendar == "Brazil"
        path = joinpath(tmp, "cal.perth.jl")
        Perth.save(p, path)
        @test occursin("calendar = \"Brazil\"", read(path, String))
        @test Perth.load(path; register = false).calendar == "Brazil"

        # Sem BusinessDays carregado, o motor falha com mensagem clara
        # (os testes nao declaram BusinessDays de proposito: valida o fallback)
        @test_throws ErrorException critical_path(p)
        @test_throws ErrorException end_date(p, t)

        set_calendar!(p, "")                     # reverte para dias corridos
        @test critical_path(p) == [t.id]
        delete_project(p.id)
    end

    @testset "kanban" begin
        ktmp = mktempdir()
        Perth._init_kanban!(ktmp)

        # board default: três colunas vazias
        cols = kanban_columns()
        @test [c.name for c in cols] == ["backlog", "doing", "done"]
        @test all(c.cards == 0 for c in cols)

        # REPL API: adiciona, move (por nome, case-insensitive) e remove
        id = kanban_add_card!("Backlog", "Ship v0.3")
        @test length(id) == 8
        @test kanban_cards() == [(column = "backlog", id = id, text = "Ship v0.3")]

        @test kanban_move_card!(id, "doing")
        @test kanban_cards()[1].column == "doing"

        id2 = kanban_add_card!("doing", "Second")
        @test kanban_move_card!(id2, "doing"; index = 1)   # índice do REPL é base 1
        @test [k.text for k in kanban_cards()] == ["Second", "Ship v0.3"]

        # coluna inexistente é erro; op sobre card inexistente só retorna false
        @test_throws ArgumentError kanban_add_card!("nope", "x")
        @test !kanban_remove_card!("00000000")
        @test kanban_remove_card!(id2)

        # ops do protocolo (base 0) direto no estado
        st = Perth._kanban_state()
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "addCol", "id" => "c9", "name" => "review"))
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "moveCard", "id" => id, "toCol" => "c9", "toIndex" => 0))
        @test kanban_cards() == [(column = "review", id = id, text = "Ship v0.3")]
        @test !Perth._kanban_apply!(st, Dict{String,Any}("type" => "bogus"))

        # persistência: reabrir o mesmo diretório recarrega o board
        Perth._kanban_persist(st)
        Perth._init_kanban!(ktmp)
        @test kanban_cards() == [(column = "review", id = id, text = "Ship v0.3")]

        # concluído / arquivo: arquivar exige card concluído
        st = Perth._kanban_state()
        @test !Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "archiveCard", "id" => id))
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "setDone", "id" => id, "done" => true))
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "archiveCard", "id" => id))
        @test isempty(kanban_cards())
        @test length(st.board["archive"]) == 1
        @test st.board["archive"][1]["col"] == "review"

        # restaurar volta para a coluna de origem, ainda concluído
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "restoreCard", "id" => id))
        @test kanban_cards()[1].column == "review"
        @test Perth._kfindcard(st, id)[1]["cards"][1]["done"] === true

        # addCard com posição (protocolo do undo, base 0)
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "addCard", "col" => "c9", "id" => "zzzzzzzz",
            "text" => "First", "index" => 0, "by" => "repl"))
        @test [k.text for k in kanban_cards()] == ["First", "Ship v0.3"]
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "delCard", "id" => "zzzzzzzz"))

        # aliases do host: define, lê e remove
        @test kanban_alias!("192.168.0.23", "Paulo")
        @test kanban_aliases()["192.168.0.23"] == "Paulo"
        @test kanban_alias!("192.168.0.23", "")
        @test !haskey(kanban_aliases(), "192.168.0.23")

        # limite de WIP (sinalização; 0 remove)
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "setWip", "id" => "c9", "wip" => 2))
        @test Perth._kcols(st)[Perth._kfindcol(st, "c9")]["wip"] == 2
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "setWip", "id" => "c9", "wip" => 0))
        @test !haskey(Perth._kcols(st)[Perth._kfindcol(st, "c9")], "wip")

        # prazo: addCard com due, ordenação estável (sem prazo vai ao fim)
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "addCard", "col" => "c9", "id" => "dueB",
            "text" => "B", "due" => "2026-08-10"))
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "addCard", "col" => "c9", "id" => "dueA",
            "text" => "A", "due" => "2026-07-20"))
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "sortCol", "id" => "c9"))
        @test [k.text for k in kanban_cards() if k.column == "review"] ==
              ["A", "B", "Ship v0.3"]
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "setDue", "id" => "dueA", "due" => ""))
        f = Perth._kfindcard(st, "dueA")
        @test !haskey(f[1]["cards"][f[2]], "due")

        # log de atividades: commit descreve, marca notify e persiste
        nlog = length(st.log)
        id3 = kanban_add_card!("backlog", "Notify me")
        @test length(st.log) == nlog + 1
        @test st.log[end]["notify"] === true
        @test occursin("added", st.log[end]["text"])
        rows = kanban_log(limit = 1)
        @test rows[1].by == "repl" && occursin("Notify me", rows[1].text)
        @test kanban_move_card!(id3, "doing")
        @test st.log[end]["notify"] === false     # mover não notifica
        @test kanban_remove_card!(id3)
        @test st.log[end]["notify"] === true      # excluir notifica
        @test occursin("deleted", st.log[end]["text"])
        @test isfile(st.logfile)
    end

end
