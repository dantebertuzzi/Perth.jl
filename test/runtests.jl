using Test
using Dates
using Logging          # ← acrescente (para NullLogger / with_logger)
using Perth
import JSON3
import HTTP
import Sockets
import BusinessDays    # ativa PerthBusinessDaysExt: ver "business-day calendar"
import QRCoders        # ativa PerthQRCodersExt: ver "QR code (extensão QRCoders)"

# Estado isolado num diretório temporário, sem tocar em ~/.perth
tmp = mktempdir()
Perth._init_state!(tmp)

# Harness mínimo pra testar o dispatch de WS do kanban de verdade
# (autorização, ações só-host, resync) sem duplicar o handler HTTP de
# produção. Numa conexão loopback o IP "de origem" é sempre 127.0.0.1 —
# não dá pra fingir de verdade — por isso ele é passado por fora via
# Ref, em vez de lido da conexão TCP como em produção (_peer_ip).
function _kanban_test_server(ipref::Ref{String}; keyok::Bool = true)
    handler = function (http::HTTP.Stream)
        if HTTP.WebSockets.isupgrade(http.message)
            HTTP.WebSockets.upgrade(ws -> Perth._kanban_ws(ws, ipref[], keyok), http)
        else
            HTTP.setstatus(http, 404); HTTP.startwrite(http)
        end
        return nothing
    end
    server = Perth._quiet() do             # engole os @info de listen!/close do HTTP.jl
        HTTP.listen!(handler, "127.0.0.1", 0; verbose = false)
    end
    port = Int(Sockets.getsockname(server.listener.server)[2])
    return server, port
end

# Mesma técnica de _kanban_test_server, pro _presence_ws genérico (gantt).
# `hub` isolado (não o GANTT_HUB global) pra não vazar estado entre testes.
function _presence_test_server(hub::Perth.PresenceHub, ipref::Ref{String}; keyok::Bool = true)
    handler = function (http::HTTP.Stream)
        if HTTP.WebSockets.isupgrade(http.message)
            HTTP.WebSockets.upgrade(ws -> Perth._presence_ws(hub, ws, ipref[], keyok), http)
        else
            HTTP.setstatus(http, 404); HTTP.startwrite(http)
        end
        return nothing
    end
    server = Perth._quiet() do
        HTTP.listen!(handler, "127.0.0.1", 0; verbose = false)
    end
    port = Int(Sockets.getsockname(server.listener.server)[2])
    return server, port
end

# Registro de cliente no hub é assíncrono (o handshake do WS roda em outra
# tarefa): espera o hub chegar ao tamanho esperado em vez de cravar um sleep.
# Teto generoso porque runner de CI sob carga demora — quem manda no tempo do
# teste é a condição, não o relógio.
function _await_clients(hub::Perth.PresenceHub, n::Int; timeout = 30.0)
    deadline = time() + timeout
    while length(hub.clients) != n && time() < deadline
        sleep(0.05)
    end
    return length(hub.clients)
end

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

    @testset "teto de texto livre (name/assignee/notes/project)" begin
        blob = "x"^3000   # acima do teto de 2000 (Perth._TEXT_CAP)
        @test length(Perth._cap_text(blob)) == Perth._TEXT_CAP
        @test Perth._cap_text("curto") == "curto"    # abaixo do teto: intacto

        # _normalize! (chamado em todo save!, REPL e REST) corta os três campos
        t = GanttTask(name = blob, start = Date(2026, 1, 1),
                      assignee = blob, notes = blob)
        Perth._normalize!(t)
        @test length(t.name) == Perth._TEXT_CAP
        @test length(t.assignee) == Perth._TEXT_CAP
        @test length(t.notes) == Perth._TEXT_CAP

        # nome do projeto: cortado em _save! (create_project, PUT, add_task! etc.)
        p = create_project(blob)
        @test length(p.name) == Perth._TEXT_CAP
        @test length(project(p.id).name) == Perth._TEXT_CAP   # persistiu cortado
        delete_project(p.id)
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

        # com BusinessDays carregado (import no topo do arquivo), a extensão
        # resolve de verdade — não é só o fallback. "Work" (seg 03/08 a sex
        # 07/08) não cruza fim de semana, então dias úteis == dias corridos
        # aqui; critical_path funciona normalmente com o calendário nomeado
        @test end_date(p, t) == Date(2026, 8, 7)
        @test critical_path(p) == [t.id]

        # tarefa que cruza um fim de semana: dias úteis empurram o fim pra
        # frente (qui 06/08 + 5 dias úteis = qua 12/08, pulando sáb/dom),
        # contra seg 10/08 em dias corridos — prova que o cálculo é real
        t2 = add_task!(p, "Weekend"; start = Date(2026, 8, 6), duration = 5)
        @test end_date(p, t2) == Date(2026, 8, 12)
        @test end_date(t2) == Date(2026, 8, 10)          # dias corridos, sem calendário

        # nome de calendário inexistente ainda dá um erro claro (não krash
        # genérico), mesmo com a extensão carregada
        set_calendar!(p, "NaoExiste123")
        err = try
            end_date(p, t)
            nothing
        catch e
            e
        end
        @test err isa ErrorException
        @test occursin("NaoExiste123", err.msg) && occursin("BusinessDays", err.msg)

        set_calendar!(p, "")                     # reverte para dias corridos
        @test critical_path(p) == [t2.id]        # t2 termina depois (10/08); t tem folga
        delete_project(p.id)
    end

    @testset "presença compartilhada (gantt+kanban)" begin
        # host: só as duas formas de loopback contam
        @test Perth._presence_is_host("127.0.0.1")
        @test Perth._presence_is_host("::1")
        @test !Perth._presence_is_host("192.168.0.50")
        @test !Perth._presence_is_host("")

        # cor por IP: estável (memoizada) e sem colisão até esgotar a paleta
        assigned = Dict{String,Int}()
        c1 = Perth._color_for_ip(assigned, "192.168.0.10")
        @test Perth._color_for_ip(assigned, "192.168.0.10") == c1   # mesma máquina, mesma cor
        @test 0 <= c1 < Perth._PRESENCE_NCOLORS

        assigned2 = Dict{String,Int}()
        ips = ["192.168.0.$(i)" for i in 1:Perth._PRESENCE_NCOLORS]
        cols = [Perth._color_for_ip(assigned2, ip) for ip in ips]
        @test length(unique(cols)) == Perth._PRESENCE_NCOLORS   # 8 IPs, 8 cores, sem repetir

        # a nona máquina força reuso (só existem 8 cores), mas continua num valor válido
        extra = Perth._color_for_ip(assigned2, "192.168.0.99")
        @test 0 <= extra < Perth._PRESENCE_NCOLORS
        @test extra in cols

        # desconexão abrupta (aba fechada, rede caiu) é o fim normal de uma
        # conexão; outros erros não podem ser silenciados como se fossem
        @test Perth._ws_disconnect(EOFError())
        @test Perth._ws_disconnect(Base.IOError("connection reset", -104))
        @test !Perth._ws_disconnect(ArgumentError("boom"))

        # _plain: converte a leitura preguiçosa do JSON3 (Object/Array) em
        # Dict/Vector nativos e mutáveis, recursivamente
        raw = JSON3.read("""{"type":"op","op":{"id":"a1","tags":["x","y"]},"n":3}""")
        plain = Perth._plain(raw)
        @test plain isa Dict{String,Any}
        @test plain["type"] == "op"
        @test plain["op"] isa Dict{String,Any}
        @test plain["op"]["tags"] isa Vector{Any}
        @test plain["op"]["tags"] == ["x", "y"]
        plain["op"]["tags"][1] = "z"              # mutável de verdade (JSON3.Array não é)
        @test plain["op"]["tags"][1] == "z"
        @test plain["n"] == 3
        @test Perth._plain(5) === 5               # passthrough para valores já nativos

        # _print_qr: meio-blocos Unicode, duas linhas da matriz por linha de
        # terminal
        m = BitMatrix([true false; false true])
        io = IOBuffer()
        Perth._print_qr(io, m; pad = 0)
        lines = split(String(take!(io)), '\n'; keepempty = false)
        @test length(lines) == cld(2, 2)          # 2 linhas de matriz -> 1 linha de terminal
        @test all(l -> all(ch -> ch in "  ▀▄█", l), lines)
    end

    @testset "transmissão (share) ao vivo" begin
        # O socket sobe sempre em 0.0.0.0 e quem filtra é o porteiro, que lê
        # a flag a cada conexão — é isso que permite ligar/desligar sem
        # derrubar o servidor. Aqui as flags são mexidas na mão (sem subir
        # servidor de verdade) e o porteiro é exercitado pelas duas pontas.
        gantt_was, gantt_can = Perth.GANTT_SHARED[], Perth.GANTT_CAN_SHARE[]
        kanban_was, kanban_can = Perth.KANBAN_SHARED[], Perth.KANBAN_CAN_SHARE[]
        try
            other = "192.168.0.60"
            for shared in (false, true)
                Perth.GANTT_SHARED[] = shared
                Perth.KANBAN_SHARED[] = shared
                # o host entra sempre, transmitindo ou não
                @test Perth._gantt_share_ok("127.0.0.1")
                @test Perth._kanban_share_ok("::1")
                # as demais máquinas, só enquanto a transmissão estiver ligada
                @test Perth._gantt_share_ok(other) == shared
                @test Perth._kanban_share_ok(other) == shared
            end

            # requisição de verdade pelo handler estático do kanban: com a
            # transmissão desligada a porta responde 403 pra quem é de fora,
            # inclusive nos arquivos da página (não só na API)
            ktmp = mktempdir(); Perth._init_kanban!(ktmp)
            Perth.KANBAN_PORT[] = 8150
            Perth.KANBAN_CAN_SHARE[] = true
            Perth.KANBAN_SHARED[] = false
            Perth.GANTT_SHARED[] = false
            # o toggle exige board no ar: um listener de mentira no loopback
            # basta (o que importa é KANBAN_SERVER[] não ser `nothing`)
            dummy = Perth._quiet() do
                HTTP.listen!(http -> nothing, "127.0.0.1", 0; verbose = false)
            end
            Perth.KANBAN_SERVER[] = dummy
            @test Perth._kanban_static(HTTP.Request("GET", "/"), other).status == 403
            @test Perth._kanban_static(HTTP.Request("GET", "/api/share"), other).status == 403
            @test Perth._kanban_static(HTTP.Request("GET", "/"), "127.0.0.1").status == 200

            # payload de /api/share: sem transmissão, só o link de localhost
            info = JSON3.read(Perth._kanban_static(
                HTTP.Request("GET", "/api/share"), "127.0.0.1").body)
            @test info["shared"] == false
            @test info["can_share"] == true
            @test info["host"] == true
            @test length(info["urls"]) == 1
            @test occursin("localhost", info["urls"][1])

            # só o host alterna: de fora, 403 e nada muda
            denied = Perth._kanban_static(
                HTTP.Request("POST", "/api/share", ["Content-Type" => "application/json"],
                             """{"on":true}"""), other)
            @test denied.status == 403
            @test Perth.KANBAN_SHARED[] == false

            # do host: liga, e a partir daí a máquina de fora passa
            on = Perth._kanban_static(
                HTTP.Request("POST", "/api/share", ["Content-Type" => "application/json"],
                             """{"on":true}"""), "127.0.0.1")
            @test on.status == 200
            @test Perth.KANBAN_SHARED[] == true
            @test JSON3.read(on.body)["shared"] == true
            @test Perth._kanban_static(HTTP.Request("GET", "/"), other).status == 200
            @test length(Perth._kanban_urls()) >= 1   # + IPs de LAN, se houver

            # e desliga de volta (o toggle é simétrico)
            off = Perth._kanban_static(
                HTTP.Request("POST", "/api/share", ["Content-Type" => "application/json"],
                             """{"on":false}"""), "127.0.0.1")
            @test off.status == 200
            @test Perth.KANBAN_SHARED[] == false
            @test Perth._kanban_static(HTTP.Request("GET", "/"), other).status == 403

            # a alternância entra no log de atividades do board
            @test any(e -> e["type"] == "share", Perth._kanban_state().log)

            # com `host` fixo no socket o alcance não é do porteiro: o toggle
            # é recusado em vez de mentir que ligou
            Perth.KANBAN_CAN_SHARE[] = false
            @test_throws ArgumentError Perth.kanban_share!(true)
            conflict = Perth._kanban_static(
                HTTP.Request("POST", "/api/share", ["Content-Type" => "application/json"],
                             """{"on":true}"""), "127.0.0.1")
            @test conflict.status == 409

            # gantt: sem servidor no ar não há o que transmitir
            @test Perth.SERVER[] === nothing
            @test_throws ArgumentError Perth.share!(true)
            @test Perth.GANTT_SHARED[] == false
        finally
            Perth.GANTT_SHARED[], Perth.GANTT_CAN_SHARE[] = gantt_was, gantt_can
            Perth.KANBAN_SHARED[], Perth.KANBAN_CAN_SHARE[] = kanban_was, kanban_can
            if Perth.KANBAN_SERVER[] !== nothing
                Perth._quiet(() -> close(Perth.KANBAN_SERVER[]))
                Perth.KANBAN_SERVER[] = nothing
            end
        end

        # desligar a transmissão derruba quem já estava conectado de fora —
        # o porteiro sozinho só barra conexões novas
        hub = Perth.PresenceHub()
        ipref = Ref("192.168.0.77")
        server, port = _presence_test_server(hub, ipref)
        try
            reason = Ref{Any}(nothing)
            t = @async HTTP.WebSockets.open("ws://127.0.0.1:$port") do ws
                HTTP.WebSockets.receive(ws)          # init
                msg = JSON3.read(HTTP.WebSockets.receive(ws))
                reason[] = (msg["type"], get(msg, "reason", nothing))
            end
            @test _await_clients(hub, 1) == 1
            @test Perth._hub_drop_remote!(hub) == 1
            wait(t)
            @test reason[] == ("denied", "share_off")
            @test isempty(hub.clients)

            # a conexão do host sobrevive ao desligamento. O cliente fica
            # parado no take! até o teste liberar: com um sleep, uma pausa do
            # scheduler podia derrubá-lo antes da verificação (foi o que
            # deixou este bloco instável no CI)
            ipref[] = "127.0.0.1"
            release = Channel{Bool}(1)
            alive = @async HTTP.WebSockets.open("ws://127.0.0.1:$port") do ws
                HTTP.WebSockets.receive(ws)          # init
                take!(release)
            end
            @test _await_clients(hub, 1) == 1
            @test Perth._hub_drop_remote!(hub) == 0
            @test length(hub.clients) == 1
            put!(release, true)
            wait(alive)
        finally
            Perth._quiet(() -> close(server))
        end
    end

    @testset "QR code (extensão QRCoders)" begin
        # QRCoders importado no topo do arquivo ativa PerthQRCodersExt de
        # verdade — _qr_matrix não é mais o stub `nothing` do pacote base
        m = Perth._qr_matrix("http://192.168.0.10:8150")
        @test m isa BitMatrix
        @test size(m, 1) == size(m, 2) > 0        # QR é sempre quadrado
        @test any(m)                              # não é uma matriz vazia/toda falsa

        # a matriz real passa pelo mesmo render em meio-blocos já testado
        # acima com uma matriz sintética — aqui é ponta a ponta de verdade
        io = IOBuffer()
        Perth._print_qr(io, m)
        out = String(take!(io))
        @test !isempty(out)
        @test occursin("█", out) || occursin("▀", out) || occursin("▄", out)
    end

    @testset "arquivos estáticos compartilhados (gantt + kanban)" begin
        # regressão: /shared/draggable.js foi adicionado ao disco mas
        # esquecido nas duas whitelists de rota (gantt e kanban usam
        # mecanismos diferentes) — 404 silencioso, só visível testando
        # a requisição de verdade. Cobre todo o /shared/ pra não repetir.
        # Importante: despacha pelo ROUTER construído por _build_router(),
        # não chama _static(...) direto — senão o teste não pega esquecer
        # o HTTP.register!, que foi exatamente o bug original.
        shared_files = ("ui.css", "presence.js", "i18n.js", "draggable.js")
        router = Perth._build_router()

        for f in shared_files
            resp = router(HTTP.Request("GET", "/shared/$f"))
            @test resp.status == 200
            @test !isempty(resp.body)
        end

        for f in shared_files
            path = "/shared/$f"
            @test haskey(Perth._KANBAN_FILES, path)
            @test Perth._KANBAN_FILES[path][1] == "shared/$f"
        end
    end

    @testset "gantt: chat geral" begin
        # unidade: _hub_chat_commit! num hub isolado (não o GANTT_HUB global)
        hub = Perth.PresenceHub()
        @test isempty(hub.chat)
        @test Perth._hub_chat_commit!(hub, "oi"; actor = "192.168.0.5")
        @test length(hub.chat) == 1
        @test hub.chat[1]["text"] == "oi"
        @test hub.chat[1]["ip"] == "192.168.0.5"
        @test haskey(hub.chat[1], "at")

        # texto vazio (ou só espaço) é no-op
        @test !Perth._hub_chat_commit!(hub, "")
        @test !Perth._hub_chat_commit!(hub, "   ")
        @test length(hub.chat) == 1

        # teto de tamanho: mesmo _cap_text usado no resto do pacote
        @test Perth._hub_chat_commit!(hub, "x"^3000)
        @test length(hub.chat[end]["text"]) == Perth._TEXT_CAP

        # cap em memória
        empty!(hub.chat)
        for i in 1:(Perth._HUB_CHAT_CAP + 5)
            Perth._hub_chat_commit!(hub, "msg $i")
        end
        @test length(hub.chat) == Perth._HUB_CHAT_CAP
        @test hub.chat[end]["text"] == "msg $(Perth._HUB_CHAT_CAP + 5)"

        # persistência: grava em chatfile e recarrega via _load_capped_jsonl
        chattmp = mktempdir()
        hub2 = Perth.PresenceHub()
        hub2.chatfile = joinpath(chattmp, "chat.jsonl")
        Perth._hub_chat_commit!(hub2, "primeira"; actor = "repl")
        Perth._hub_chat_commit!(hub2, "segunda"; actor = "repl")
        @test isfile(hub2.chatfile)
        reloaded = Perth._load_capped_jsonl(hub2.chatfile, Perth._HUB_CHAT_CAP, Perth._HUB_CHAT_KEEP)
        @test length(reloaded) == 2
        @test reloaded[1]["text"] == "primeira" && reloaded[2]["text"] == "segunda"

        # API REPL: Perth.chat!/Perth.chat_log usam o GANTT_HUB global
        Perth.GANTT_HUB.chat = Any[]
        Perth.GANTT_HUB.chatfile = ""
        @test Perth.chat!("mensagem do repl")
        rows = Perth.chat_log()
        @test length(rows) == 1
        @test rows[1].text == "mensagem do repl" && rows[1].by == "repl"
        Perth.chat!("segunda mensagem")
        @test Perth.chat_log()[1].text == "segunda mensagem"   # mais recente primeiro
        @test length(Perth.chat_log(limit = 1)) == 1

        # WS de verdade: init traz o histórico, "chat" flui pelo socket e persiste
        wshub = Perth.PresenceHub()
        Perth._hub_chat_commit!(wshub, "histórico antigo"; actor = "10.0.0.1")
        ipref = Ref("192.168.0.9")
        server, port = _presence_test_server(wshub, ipref)
        try
            HTTP.WebSockets.open("ws://127.0.0.1:$port") do ws
                init = JSON3.read(HTTP.WebSockets.receive(ws))
                @test length(init["chat"]) == 1
                @test init["chat"][1]["text"] == "histórico antigo"

                HTTP.WebSockets.send(ws, JSON3.write(Dict("type" => "chat", "text" => "oi de novo")))
                m = JSON3.read(HTTP.WebSockets.receive(ws))
                @test m["type"] == "chat"
                @test m["entry"]["text"] == "oi de novo"
                @test m["entry"]["ip"] == "192.168.0.9"
            end
            @test length(wshub.chat) == 2

            # "typing" é retransmitido pra quem já estava conectado (não pra
            # quem mandou) — um cliente fica escutando enquanto outro digita
            ipref[] = "192.168.0.10"
            got = Ref{Any}(nothing)   # HTTP.WebSockets.open não propaga o valor do bloco
            t = @async HTTP.WebSockets.open("ws://127.0.0.1:$port") do wsB
                HTTP.WebSockets.receive(wsB)   # init
                HTTP.WebSockets.receive(wsB)   # "join" (quando o outro cliente conecta)
                got[] = JSON3.read(HTTP.WebSockets.receive(wsB))["type"]
            end
            sleep(0.3)   # garante que wsB já está conectado e recebendo
            ipref[] = "192.168.0.11"
            HTTP.WebSockets.open("ws://127.0.0.1:$port") do wsA
                HTTP.WebSockets.receive(wsA)   # init
                HTTP.WebSockets.send(wsA, JSON3.write(Dict("type" => "typing")))
                sleep(0.3)
            end
            wait(t)
            @test got[] == "typing"
        finally
            Perth._quiet(() -> close(server))
        end
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

    @testset "kanban: teto de texto livre" begin
        ktmp = mktempdir()
        Perth._init_kanban!(ktmp)
        st = Perth._kanban_state()

        blob = "x"^3000   # acima do teto de 2000 (_KANBAN_TEXT_CAP)
        @test length(Perth._cap_text(blob)) == Perth._TEXT_CAP
        @test Perth._cap_text("curto") == "curto"    # abaixo do teto: intacto

        # addCard: texto do card e due
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "addCard", "col" => "c1", "id" => "bigcard1",
            "text" => blob, "due" => blob))
        card = Perth._kfindcard(st, "bigcard1")[1]["cards"][1]
        @test length(card["text"]) == Perth._TEXT_CAP
        @test length(card["due"]) == Perth._TEXT_CAP

        # editCard
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "editCard", "id" => "bigcard1", "text" => blob))
        @test length(Perth._kfindcard(st, "bigcard1")[1]["cards"][1]["text"]) ==
              Perth._TEXT_CAP

        # addCol / renameCol: nome da coluna
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "addCol", "id" => "bigcol", "name" => blob))
        @test length(Perth._kcols(st)[Perth._kfindcol(st, "bigcol")]["name"]) ==
              Perth._TEXT_CAP
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "renameCol", "id" => "bigcol", "name" => blob))
        @test length(Perth._kcols(st)[Perth._kfindcol(st, "bigcol")]["name"]) ==
              Perth._TEXT_CAP

        # setAssignee / setDue
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "setAssignee", "id" => "bigcard1", "name" => blob))
        @test length(Perth._kfindcard(st, "bigcard1")[1]["cards"][1]["assignee"]) ==
              Perth._TEXT_CAP
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "setDue", "id" => "bigcard1", "due" => blob))
        @test length(Perth._kfindcard(st, "bigcard1")[1]["cards"][1]["due"]) ==
              Perth._TEXT_CAP

        # addCheck: texto do item de checklist
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "addCheck", "card" => "bigcard1", "id" => "chk1", "text" => blob))
        f = Perth._kfindcard(st, "bigcard1")
        @test length(f[1]["cards"][f[2]]["checklist"][1]["text"]) == Perth._TEXT_CAP

        # setAlias: nome da máquina
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "setAlias", "ip" => "192.168.0.80", "name" => blob))
        @test length(Perth._kaliases(st)["192.168.0.80"]) == Perth._TEXT_CAP
    end

    @testset "kanban: matriz de permissões" begin
        ktmp = mktempdir()
        Perth._init_kanban!(ktmp)
        st = Perth._kanban_state()

        host = "127.0.0.1"
        other = "192.168.0.50"

        # fail-open: sem matriz, sem entrada pro IP, ou ação não listada -> permitido
        @test Perth._kanban_permitted(st, other, "addCard")
        @test Perth._kanban_permitted(st, other, "delCol")

        # host nunca é restringido, mesmo com uma entrada bloqueando explicitamente
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "setPermissions", "changes" => Any[
                Dict{String,Any}("ip" => host, "action" => "addCard", "allowed" => false)]))
        @test Perth._kanban_permitted(st, host, "addCard")

        # restringe uma ação pontual pra um IP: só ela fica bloqueada
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "setPermissions", "changes" => Any[
                Dict{String,Any}("ip" => other, "action" => "delCard", "allowed" => false)]))
        @test !Perth._kanban_permitted(st, other, "delCard")
        @test Perth._kanban_permitted(st, other, "addCard")      # outras ações seguem liberadas
        @test Perth._kanban_permitted(st, "192.168.0.99", "delCard")  # outro IP não é afetado

        # reverter (allowed = true) libera de novo
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "setPermissions", "changes" => Any[
                Dict{String,Any}("ip" => other, "action" => "delCard", "allowed" => true)]))
        @test Perth._kanban_permitted(st, other, "delCard")

        # ação em lote: várias mudanças num único op (linha inteira do modal)
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "setPermissions", "changes" => Any[
                Dict{String,Any}("ip" => other, "action" => "addCard", "allowed" => false),
                Dict{String,Any}("ip" => other, "action" => "editCard", "allowed" => false),
                Dict{String,Any}("ip" => other, "action" => "moveCard", "allowed" => false)]))
        @test !Perth._kanban_permitted(st, other, "addCard")
        @test !Perth._kanban_permitted(st, other, "editCard")
        @test !Perth._kanban_permitted(st, other, "moveCard")

        # ação fora de _KANBAN_GATED_ACTIONS é ignorada: não dá pra restringir
        # ações de admin do board (resetBoard etc.) por essa via — e como
        # nada muda de fato, o op não deve gerar log/persistência/broadcast
        @test !Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "setPermissions", "changes" => Any[
                Dict{String,Any}("ip" => other, "action" => "resetBoard", "allowed" => false)]))
        @test !haskey(get(Perth._kperms(st), other, Dict()), "resetBoard")

        # op sem changes (lista vazia) não altera nada
        @test !Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "setPermissions", "changes" => Any[]))

        # sobrevive a resetBoard (config de máquina, não conteúdo do board)
        @test Perth._kanban_apply!(st, Dict{String,Any}("type" => "resetBoard"))
        @test !Perth._kanban_permitted(st, other, "editCard")
        @test !Perth._kanban_permitted(st, other, "moveCard")

        # sobrevive a persistência + reload, como aliases
        Perth._kanban_persist(st)
        Perth._init_kanban!(ktmp)
        st = Perth._kanban_state()
        @test !Perth._kanban_permitted(st, other, "editCard")
        @test Perth._kanban_permitted(st, other, "delCard")   # revertido antes, nunca voltou a ser bloqueado
    end

    @testset "kanban: dispatch de WS (autorização de verdade)" begin
        ktmp = mktempdir()
        Perth._init_kanban!(ktmp)
        st = Perth._kanban_state()

        other = "192.168.0.60"
        @test Perth._kanban_apply!(st, Dict{String,Any}(
            "type" => "setPermissions", "changes" => Any[
                Dict{String,Any}("ip" => other, "action" => "addCard", "allowed" => false)]))

        ipref = Ref("")
        server, port = _kanban_test_server(ipref)
        try
            # ação restringida pro IP: opDenied + resync, nada aplicado —
            # o servidor barra mesmo que o cliente burle a UI e mande a op
            # direto (é exatamente o que o comentário em kanban.jl promete)
            ipref[] = other
            HTTP.WebSockets.open("ws://127.0.0.1:$port") do ws
                HTTP.WebSockets.receive(ws)     # init da conexão
                HTTP.WebSockets.send(ws, JSON3.write(Dict("type" => "op", "op" => Dict(
                    "type" => "addCard", "col" => "c1", "id" => "denied01", "text" => "nope"))))
                denied = JSON3.read(HTTP.WebSockets.receive(ws))
                @test denied["type"] == "opDenied"
                @test denied["action"] == "addCard"
                resync = JSON3.read(HTTP.WebSockets.receive(ws))
                @test resync["type"] == "init"
            end
            @test isempty(kanban_cards())

            # mesma ação, IP sem restrição: aplica e faz broadcast normal
            ipref[] = "192.168.0.61"
            HTTP.WebSockets.open("ws://127.0.0.1:$port") do ws
                HTTP.WebSockets.receive(ws)
                HTTP.WebSockets.send(ws, JSON3.write(Dict("type" => "op", "op" => Dict(
                    "type" => "addCard", "col" => "c1", "id" => "ok01", "text" => "sim"))))
                applied = JSON3.read(HTTP.WebSockets.receive(ws))
                @test applied["type"] == "op"
            end
            @test any(c -> c.id == "ok01", kanban_cards())

            # ação só-host (resetBoard) vinda de não-host: resync silencioso,
            # sem opDenied — é barrada antes mesmo de consultar a matriz
            ipref[] = other
            HTTP.WebSockets.open("ws://127.0.0.1:$port") do ws
                HTTP.WebSockets.receive(ws)
                HTTP.WebSockets.send(ws, JSON3.write(Dict("type" => "op", "op" => Dict(
                    "type" => "resetBoard"))))
                resync = JSON3.read(HTTP.WebSockets.receive(ws))
                @test resync["type"] == "init"
            end
            @test any(c -> c.id == "ok01", kanban_cards())   # board não foi resetado

            # mesma ação, do host (127.0.0.1 é sempre host): aplica
            ipref[] = "127.0.0.1"
            HTTP.WebSockets.open("ws://127.0.0.1:$port") do ws
                HTTP.WebSockets.receive(ws)
                HTTP.WebSockets.send(ws, JSON3.write(Dict("type" => "op", "op" => Dict(
                    "type" => "resetBoard"))))
                applied = JSON3.read(HTTP.WebSockets.receive(ws))
                @test applied["type"] == "op"
            end
            @test isempty(kanban_cards())
        finally
            Perth._quiet(() -> close(server))
        end

        # keyok = false: nega educadamente e encerra a conexão, sem
        # chegar a registrar o cliente nem expor o board
        ipref2 = Ref(other)
        server2, port2 = _kanban_test_server(ipref2; keyok = false)
        try
            HTTP.WebSockets.open("ws://127.0.0.1:$port2") do ws
                denied = JSON3.read(HTTP.WebSockets.receive(ws))
                @test denied["type"] == "denied"
            end
        finally
            Perth._quiet(() -> close(server2))
        end
    end

    @testset "ponte gantt↔kanban" begin
        # estado limpo para as duas pontas (isola do resto da suíte)
        gtmp = mktempdir(); Perth._init_state!(gtmp)
        ktmp = mktempdir(); Perth._init_kanban!(ktmp)

        p = create_project("Ponte")
        t1 = add_task!(p, "A fazer";   start = Date(2026, 8, 1), duration = 3)             # 0%
        t2 = add_task!(p, "Andamento"; start = Date(2026, 8, 4), duration = 4, progress = 40)  # doing
        t3 = add_task!(p, "Pronta";    start = Date(2026, 8, 8), duration = 2, progress = 100) # done

        # progresso atual de uma tarefa, relendo do estado persistido
        progressof(name, tid) = (pp = project(name);
            pp.tasks[findfirst(t -> t.id == tid, pp.tasks)].progress)

        made = kanban_from_project!(p)
        @test made == 3

        # um card por tarefa, na coluna certa segundo o progresso
        cards = kanban_cards()
        bycol = Dict(c.text => c.column for c in cards)
        @test bycol["A fazer"]   == "backlog"
        @test bycol["Andamento"] == "doing"
        @test bycol["Pronta"]    == "done"

        # os cards ficam VINCULADOS às tarefas (campos task/project)
        st = Perth._kanban_state()
        linked = Dict{String,Any}()
        for c in Perth._kcols(st), card in c["cards"]
            haskey(card, "task") && (linked[String(card["task"])] = card)
        end
        @test Set(keys(linked)) == Set([t1.id, t2.id, t3.id])
        @test all(String(c["project"]) == p.id for c in values(linked))

        # idempotência: rodar de novo não duplica
        @test kanban_from_project!(p) == 0
        @test length(kanban_cards()) == 3

        # sincronização card -> tarefa: concluir o card de t1 põe a tarefa a 100%
        card1 = linked[t1.id]
        @test Perth._kanban_commit!(Dict{String,Any}(
            "type" => "setDone", "id" => String(card1["id"]), "done" => true))
        @test progressof("Ponte", t1.id) == 100

        # reabrir (mover para fora de "done") volta a tarefa a 0
        @test kanban_move_card!(String(card1["id"]), "backlog")
        @test progressof("Ponte", t1.id) == 0

        # mover para a coluna "done" também conclui (via nome da coluna)
        card2 = linked[t2.id]
        @test kanban_move_card!(String(card2["id"]), "done")
        @test progressof("Ponte", t2.id) == 100

        # replace = true regenera a partir do estado atual do projeto
        n = kanban_from_project!(project("Ponte"); replace = true)
        @test n == 3
        @test length(kanban_cards()) == 3   # não acumulou

        # resumos WBS não viram card (só folhas)
        pw = create_project("Com resumo")
        pai  = add_task!(pw, "Fase";   start = Date(2026, 9, 1), duration = 5)
        filho = add_task!(pw, "Item";  start = Date(2026, 9, 1), duration = 2)
        set_parent!(pw, filho.id, pai.id)
        Perth._init_kanban!(mktempdir())
        made_w = kanban_from_project!(pw)
        @test made_w == 1   # só a folha "Item"
        @test [c.text for c in kanban_cards()] == ["Item"]
    end

    @testset "ponte de campos (assignee, prazo, nome)" begin
        Perth._init_state!(mktempdir())
        Perth._init_kanban!(mktempdir())
        p = create_project("Campos")
        t = add_task!(p, "Sincronizar"; start = Date(2026, 8, 3), duration = 5,
                      assignee = "Ana")
        kanban_from_project!(p)

        cardof() = begin      # o dict do card vinculado, direto do board
            st = Perth._kanban_state()
            local found = nothing
            for c in Perth._kcols(st), card in c["cards"]
                get(card, "task", "") == t.id && (found = card)
            end
            found
        end
        taskof() = (pp = project("Campos");
                    pp.tasks[findfirst(x -> x.id == t.id, pp.tasks)])

        # criação já espelha assignee e prazo (due = data-fim da tarefa)
        c0 = cardof()
        @test String(c0["assignee"]) == "Ana"
        @test String(c0["due"]) == "2026-08-07"   # 3/ago + 5 dias corridos

        # gantt -> kanban: editar a tarefa espelha no card
        update_task!(project("Campos"), t.id;
                     name = "Sincronizar tudo", assignee = "Bruno", duration = 3)
        c1 = cardof()
        @test String(c1["text"]) == "Sincronizar tudo"
        @test String(c1["assignee"]) == "Bruno"
        @test String(c1["due"]) == "2026-08-05"   # duração 3 -> termina 5/ago

        # kanban -> gantt: responsável do card vira assignee da tarefa
        @test Perth._kanban_commit!(Dict{String,Any}(
            "type" => "setAssignee", "id" => c1["id"], "name" => "Carla"))
        @test taskof().assignee == "Carla"

        # kanban -> gantt: prazo do card recalcula a duração
        @test Perth._kanban_commit!(Dict{String,Any}(
            "type" => "setDue", "id" => c1["id"], "due" => "2026-08-12"))
        @test taskof().duration == 10             # 3..12/ago, inclusive
        @test String(cardof()["due"]) == "2026-08-12"   # eco convergiu

        # kanban -> gantt: 1ª linha do card vira o nome; resto preservado
        @test Perth._kanban_commit!(Dict{String,Any}(
            "type" => "editCard", "id" => c1["id"],
            "text" => "Nome novo\n#tag descrição"))
        @test taskof().name == "Nome novo"
        @test startswith(String(cardof()["text"]), "Nome novo\n#tag")

        # renomear no gantt preserva as linhas extras do card
        update_task!(project("Campos"), t.id; name = "Nome final")
        @test String(cardof()["text"]) == "Nome final\n#tag descrição"

        # ops de sync não poluem o log de atividades do kanban
        st = Perth._kanban_state()
        @test all(e -> get(e, "ip", "") != "gantt", st.log)

        # cor estável por IP: mesma máquina -> mesma cor, sempre
        colors = Dict{String,Int}()
        c_a = Perth._color_for_ip(colors, "192.168.0.10")
        c_b = Perth._color_for_ip(colors, "192.168.0.11")
        @test Perth._color_for_ip(colors, "192.168.0.10") == c_a  # "refresh"
        @test Perth._color_for_ip(colors, "192.168.0.10") == c_a
        @test c_a != c_b                                          # anticolisão
        @test Perth._dur_between(Perth.CalendarDays(),
                                 Date(2026, 8, 3), Date(2026, 8, 12)) == 10
    end

    include("splash.jl")

end