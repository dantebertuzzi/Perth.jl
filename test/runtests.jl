using Test
using Dates
using Logging          # ← acrescente (para NullLogger / with_logger)
using Random           # sementes fixas na simulação de Monte Carlo (PERT)
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
function _presence_test_server(hub::Perth.PresenceHub, ipref::Ref{String};
                               keyok::Bool = true, readonly::Bool = false)
    handler = function (http::HTTP.Stream)
        if HTTP.WebSockets.isupgrade(http.message)
            HTTP.WebSockets.upgrade(
                ws -> Perth._presence_ws(hub, ws, ipref[], keyok; readonly = readonly), http)
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

        # Regressão: o término do projeto sai das tarefas, nunca do
        # calendário de parede. `maximum(ef; init = Dates.today())` fazia o
        # término virar max(hoje, último fim) — `init` é a semente da
        # redução, não um default para vetor vazio —, então todo projeto já
        # concluído ganhava folga fantasma do tamanho do tempo decorrido e
        # ficava sem caminho crítico. Datas no passado por construção: o
        # teste vale hoje e daqui a dez anos.
        old = create_project("Concluído")
        o1 = add_task!(old, "Escavação"; start = Date(2020, 1, 6), duration = 5)
        o2 = add_task!(old, "Fundação"; start = Date(2020, 1, 13), duration = 5,
                       dependencies = [o1.id])
        @test project_finish(old) == Date(2020, 1, 17)
        @test critical_path(old) == [o2.id]
        osl = Dict(r.id => r.slack_days for r in slack(old))
        @test osl[o2.id] == 0
        @test osl[o1.id] == 2          # folga real: o2 só começa 2 dias depois
        delete_project(old.id)
    end

    @testset "prazo (deadline) e folga negativa" begin
        # Corrente A -> B -> C, dias corridos. Datas no passado por construção.
        p = create_project("Prazo")
        a = add_task!(p, "A"; start = Date(2026, 3, 2), duration = 3)   # 02–04/03
        b = add_task!(p, "B"; start = Date(2026, 3, 5), duration = 5,
                      dependencies = [a.id])                            # 05–09/03
        c = add_task!(p, "C"; start = Date(2026, 3, 10), duration = 4,
                      dependencies = [b.id])                            # 10–13/03
        @test project_finish(p) == Date(2026, 3, 13)
        @test all(r.slack_days == 0 for r in slack(p))

        # Prazo posterior ao término do projeto é inerte: lf já é limitado
        # pelo término em todas as tarefas
        update_task!(p, c.id; deadline = Date(2026, 3, 20))
        @test all(r.slack_days == 0 for r in slack(p))
        @test isempty(deadline_slip(p))

        # Prazo estourado: a folga fica negativa na tarefa E em tudo que a
        # alimenta, do tamanho exato do atraso (3 dias)
        update_task!(p, c.id; deadline = Date(2026, 3, 10))
        sl = Dict(r.id => r.slack_days for r in slack(p))
        @test sl[c.id] == -3 && sl[b.id] == -3 && sl[a.id] == -3
        # e a cadeia estourada continua no caminho crítico (slack <= 0)
        @test critical_path(p) == [a.id, b.id, c.id]
        @test all(r.critical for r in slack(p))

        # O prazo não move nada: é compromisso, não plano
        starts = [t.start for t in project(p.id).tasks]
        schedule!(p)
        @test [t.start for t in project(p.id).tasks] == starts

        miss = deadline_slip(p)
        @test length(miss) == 1
        @test miss[1].id == c.id && miss[1].deadline == Date(2026, 3, 10)
        @test miss[1].finish == Date(2026, 3, 13) && miss[1].slip_days == 3

        # tasktable carrega prazo e atraso; sem prazo, missing
        tt = Dict(r.id => r for r in tasktable(p))
        @test tt[c.id].deadline == Date(2026, 3, 10) && tt[c.id].deadline_slip == 3
        @test tt[a.id].deadline === missing && tt[a.id].deadline_slip === missing

        # roundtrip .perth.jl preserva o prazo
        path = joinpath(tmp, "prazo.perth.jl")
        Perth.save(p, path)
        @test occursin("deadline = Date(\"2026-03-10\")", read(path, String))
        rp = Perth.load(path; register = false)
        @test rp.tasks[3].deadline == Date(2026, 3, 10)
        @test rp.tasks[1].deadline === nothing

        # dias úteis: o mesmo prazo, com o atraso medido no calendário
        set_calendar!(p, "Brazil")
        sl2 = Dict(r.id => r.slack_days for r in slack(p))
        @test sl2[c.id] < 0
        set_calendar!(p, "")
        delete_project(p.id)
    end

    @testset "data fixa (pinned)" begin
        p = create_project("Fixa")
        a = add_task!(p, "A"; start = Date(2026, 3, 2), duration = 3)
        b = add_task!(p, "B"; start = Date(2026, 3, 2), duration = 2,
                      dependencies = [a.id])
        c = add_task!(p, "C"; start = Date(2026, 3, 2), duration = 2,
                      dependencies = [a.id], pinned = true)

        schedule!(p)
        @test b.start == Date(2026, 3, 5)     # empurrada para depois de A
        @test c.start == Date(2026, 3, 2)     # data contratual: não se move

        # o motor continua calculando para onde ELA IRIA — é assim que o
        # conflito aparece, em vez de a data mudar sozinha
        rows = Dict(r.id => r for r in slack(p))
        @test rows[c.id].early_start == Date(2026, 3, 5)
        @test rows[c.id].early_start > c.start
        @test rows[b.id].early_start == b.start   # sem pin, planejada = calculada

        # soltar o pin devolve a tarefa ao motor
        update_task!(p, c.id; pinned = false)
        schedule!(p)
        @test c.start == Date(2026, 3, 5)

        # roundtrip .perth.jl preserva o pin
        update_task!(p, c.id; pinned = true)
        path = joinpath(tmp, "fixa.perth.jl")
        Perth.save(p, path)
        @test occursin("pinned = true", read(path, String))
        @test Perth.load(path; register = false).tasks[3].pinned
        delete_project(p.id)
    end

    @testset "exportação iCalendar (.ics)" begin
        p = create_project("Fachada, Bloco B")     # vírgula: escape de TEXT
        pai = add_task!(p, "Etapa"; start = Date(2026, 3, 2), duration = 1)
        t = add_task!(p, "Compra do vidro"; start = Date(2026, 3, 2), duration = 6,
                      assignee = "Bruno", progress = 40, parent = pai.id,
                      deadline = Date(2026, 3, 4))          # termina 07/03: 3 dias
        m = add_task!(p, "Vistoria; final"; start = Date(2026, 3, 20),
                      milestone = true, assignee = "Ana",
                      notes = "levar\ntrena")
        add_task!(p, "Sem compromisso"; start = Date(2026, 3, 2), duration = 3)

        ics = icalendar(p)
        lines = split(ics, "\r\n")
        @test lines[1] == "BEGIN:VCALENDAR"
        @test lines[end - 1] == "END:VCALENDAR" && lines[end] == ""
        @test count(==("BEGIN:VEVENT"), lines) == 2      # 1 marco + 1 prazo
        @test count(==("END:VEVENT"), lines) == 2
        # o resumo "Etapa" é contêiner, e tarefa sem marco/prazo não vira evento
        @test !occursin("Etapa", ics) && !occursin("Sem compromisso", ics)

        # CRLF em toda linha, inclusive a última (RFC 5545 §3.1)
        @test endswith(ics, "\r\n")
        @test !occursin(r"(?<!\r)\n", ics)

        # DTEND de dia inteiro é EXCLUSIVO: um dia termina no dia seguinte
        @test occursin("DTSTART;VALUE=DATE:20260320", ics)
        @test occursin("DTEND;VALUE=DATE:20260321", ics)
        @test occursin("DTSTART;VALUE=DATE:20260304", ics)   # prazo
        @test occursin("DTEND;VALUE=DATE:20260305", ics)

        # escape de TEXT: vírgula do projeto, ponto-e-vírgula do marco,
        # quebra de linha das notas
        @test occursin("X-WR-CALNAME:Fachada\\, Bloco B", ics)
        @test occursin("SUMMARY:Vistoria\\; final", ics)
        @test occursin("levar\\ntrena", ics)
        @test occursin("SUMMARY:Deadline: Compra do vidro", ics)
        @test occursin("Planned finish: 2026-03-07 (3 days late)", ics)

        # UID estável: reexportar não duplica o evento no cliente
        uids = [l for l in lines if startswith(l, "UID:")]
        @test length(uids) == 2 && allunique(uids)
        @test uids == [l for l in split(icalendar(p), "\r\n") if startswith(l, "UID:")]
        @test any(u -> occursin("$(m.id)-milestone@$(p.id)", u), uids)
        @test any(u -> occursin("$(t.id)-deadline@$(p.id)", u), uids)

        # SEQUENCE cresce quando o projeto muda, senão o cliente ignora a
        # reimportação como se fosse o mesmo evento de antes
        seq1 = only(unique(l for l in lines if startswith(l, "SEQUENCE:")))
        update_task!(p, m.id; start = Date(2026, 3, 21))
        seq2 = only(unique(l for l in split(icalendar(p), "\r\n")
                           if startswith(l, "SEQUENCE:")))
        @test parse(Int, seq2[10:end]) >= parse(Int, seq1[10:end])

        # dobra em 75 OCTETOS, com continuação começando por espaço, sem
        # partir caractere multibyte no meio
        long = create_project("Longo")
        add_task!(long, "Ação " * repeat("ãé ", 40) * "final";
                  start = Date(2026, 3, 2), milestone = true)
        li = split(icalendar(long), "\r\n")
        @test all(l -> ncodeunits(l) <= 75, li)
        @test any(l -> startswith(l, " "), li)           # houve continuação
        # desdobrar (juntar as continuações) devolve o nome intacto
        unfolded = replace(icalendar(long), "\r\n " => "")
        @test occursin("SUMMARY:Ação " * repeat("ãé ", 40) * "final", unfolded)
        delete_project(long.id)

        # projeto sem marco nem prazo ainda produz um calendário válido
        empty_p = create_project("Vazio")
        add_task!(empty_p, "Só trabalho"; start = Date(2026, 3, 2), duration = 3)
        eics = icalendar(empty_p)
        @test occursin("BEGIN:VCALENDAR", eics) && occursin("END:VCALENDAR", eics)
        @test !occursin("BEGIN:VEVENT", eics)
        delete_project(empty_p.id)

        # escrita em arquivo e endpoint
        path = joinpath(tmp, "cal.ics")
        @test icalendar(p, path) == path
        @test read(path, String) == icalendar(p)

        router = Perth._build_router()
        resp = router(HTTP.Request("GET", "/api/projects/$(p.id)/export.ics"))
        @test resp.status == 200
        @test Dict(resp.headers)["Content-Type"] == "text/calendar; charset=utf-8"
        @test occursin("filename=\"Fachada__Bloco_B.ics\"",
                       Dict(resp.headers)["Content-Disposition"])
        @test occursin("BEGIN:VCALENDAR", String(resp.body))
        @test router(HTTP.Request("GET", "/api/projects/naoexiste/export.ics")).status == 404
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

    # Quebras de linha misturadas dentro do MESMO arquivo.
    #
    # O repositório é CRLF (ver .gitattributes: `* -text`, guardar como está).
    # Qualquer ferramenta que leia e reescreva em modo texto converte o arquivo
    # inteiro em silêncio, e o diff vira o arquivo todo — ou, pior, metade dele
    # fica LF e ninguém percebe. Aconteceu quatro vezes no mesmo dia de
    # trabalho, uma delas chegando ao repositório publicado.
    #
    # O comando `file` NÃO serve de guarda: ele diz "CRLF line terminators"
    # mesmo com dezenas de linhas LF no meio. Contar bytes serve.
    @testset "quebras de linha consistentes" begin
        raiz = joinpath(@__DIR__, "..")
        exts = (".jl", ".js", ".css", ".html", ".md", ".toml")
        misturados = String[]
        for (dir, _, arqs) in walkdir(raiz)
            occursin(r"(^|/)(\.git|node_modules)(/|$)", dir) && continue
            for a in arqs
                any(e -> endswith(a, e), exts) || continue
                caminho = joinpath(dir, a)
                bytes = read(caminho)
                crlf = count(i -> bytes[i] == 0x0d && bytes[i+1] == 0x0a,
                             1:max(length(bytes) - 1, 0))
                lf = count(==(0x0a), bytes)
                (crlf > 0 && lf > crlf) && push!(misturados, relpath(caminho, raiz))
            end
        end
        @test isempty(misturados)
        isempty(misturados) || @info "arquivos com quebras misturadas" misturados
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

        # ── file_path num arquivo de terceiros: sobrescrevia arquivo alheio ──
        #
        # file_path é o caminho de espelhamento DESTA máquina e nunca é escrito
        # no formato (types.jl). O leitor não dizia o mesmo: quem declarasse o
        # campo à mão fazia o primeiro _save! gravar por cima do que ele
        # apontasse. Verificado como ataque de verdade, não por inspeção.
        alvo = joinpath(tmp, "alvo-do-usuario.txt")
        write(alvo, "conteúdo que não é do Perth")
        hostil = joinpath(tmp, "hostil.perth.jl")
        write(hostil, """
            Project(id = "hostil1", name = "Cronograma inocente",
                    file_path = "$(alvo)",
                    tasks = [GanttTask(id = "t1", name = "T",
                                       start = Date("2026-01-01"), duration = 1)])
            """)
        @test_throws ArgumentError Perth.load(hostil)
        @test read(alvo, String) == "conteúdo que não é do Perth"   # intacto
        @test !haskey(Perth._state().projects, "hostil1")           # nem registrou

        # ── aninhamento: o parser do PRÓPRIO Julia morre com core dump ──
        #
        # Não é exceção capturável: alguns milhares de colchetes aninhados
        # derrubam o processo. Se a guarda sumir, este teste não falha — ele
        # MATA a suíte, que é o mesmo que aconteceria com o servidor.
        fundo = "Project(id=\"x\", name=\"y\", tasks = " * "["^5_000 * "]"^5_000 * ")"
        @test_throws ArgumentError Perth._parse_project_source(fundo)
        @test_throws ArgumentError Perth._parse_project_source(
            "Project(id=\"x\", name=\"" * "a"^(5 * 1024 * 1024) * "\")")

        # e nada disso pode custar projeto legítimo: parêntese e colchete em
        # nome de tarefa são texto, não aninhamento
        legit = create_project("Obra ((especial))")
        add_task!(legit, "Coleta [campo] (fase 1)"; start = Date(2026, 1, 1), duration = 2)
        recarregado = Perth._parse_project_source(Perth._to_julia_source(legit))
        @test recarregado.tasks[1].name == "Coleta [campo] (fase 1)"
        delete_project(legit.id)

        delete_project(p.id)
    end

    # O espelho já ia do Perth para o disco; isto é a VOLTA — editar o
    # .perth.jl no editor e o projeto acompanhar. As três propriedades que
    # sustentam a funcionalidade são testadas pela função de recarga, sem
    # depender de evento do sistema de arquivos (que é assíncrono e tornaria
    # a suíte instável): o laço que não pode existir, o arquivo pela metade
    # que não pode estragar nada, e o que o arquivo não decide.
    @testset "observador do arquivo espelhado" begin
        d = mktempdir()
        p = create_project("Espelho de volta")
        t = add_task!(p, "Fundação"; start = Date(2026, 3, 2), duration = 5)
        arq = joinpath(d, "obra.perth.jl")
        set_file_path!(p, arq)
        criado, id = p.created_at, p.id

        # nossa própria escrita não recarrega nada: é assim que o laço morre
        @test Perth._watch_reload!(id, arq) === :same
        rev0 = Perth._state().rev
        @test Perth._watch_reload!(id, arq) === :same
        @test Perth._state().rev == rev0            # nem bumpou revisão

        # edição de fora entra
        write(arq, replace(read(arq, String), "duration = 5" => "duration = 12"))
        @test Perth._watch_reload!(id, arq) === :reloaded
        @test project(id).tasks[1].duration == 12
        @test Perth._state().rev > rev0             # é isso que avisa o navegador

        # arquivo pela metade (o editor grava em etapas) não estraga nada
        write(arq, "Project(id = \"x\", name = \"Obra\", tas")
        @test Perth._watch_reload!(id, arq) === :invalid
        @test project(id).tasks[1].duration == 12

        # o arquivo não decide identidade — mesma regra do painel de código
        write(arq, replace(Perth._to_julia_source(project(id)),
                           "id = \"$(id)\"" => "id = \"sequestrado\""))
        @test Perth._watch_reload!(id, arq) === :reloaded
        @test project(id).id == id
        @test project(id).created_at == criado
        @test project(id).file_path == arq
        @test !haskey(Perth._state().projects, "sequestrado")

        # a alça do REPL continua válida depois de uma recarga: o objeto é
        # mutado no lugar, não trocado. Sem isto, um `p = project("obra")`
        # aberto viraria órfão e a próxima edição nele ressuscitaria o
        # estado antigo por cima do arquivo.
        @test p === Perth._state().projects[id]
        @test p.tasks[1].duration == 12

        # desvinculado ou apagado, o observador tem que saber parar
        @test Perth._watch_reload!("nao-existe", arq) === :unlinked
        @test Perth._watch_reload!(id, joinpath(d, "sumiu.perth.jl")) === :gone
        set_file_path!(p, nothing)
        @test Perth._watch_reload!(id, arq) === :unlinked

        delete_project(id)
    end

    @testset "espelhamento em arquivo (set_file_path!)" begin
        p = create_project("Espelho")
        add_task!(p, "Tarefa"; start = Date(2026, 7, 20), duration = 2)

        # Resolução de caminho: diretório -> slug do nome; sem .jl -> anexa
        dir = mktempdir()
        @test Perth._resolve_save_path(p, dir) == joinpath(dir, "espelho.perth.jl")

        # Acento no nome do projeto é transliterado, não jogado fora: antes
        # "Análise estatística" virava "an-lise-estat-stica.perth.jl" — e
        # este é um nome de arquivo que o usuário vê e convive
        nome(n) = begin
            q = create_project(n)
            out = basename(Perth._resolve_save_path(q, dir))
            delete_project(q.id)
            out
        end
        @test nome("Análise estatística") == "analise-estatistica.perth.jl"
        @test nome("Obra do cartório — Bloco B") == "obra-do-cartorio-bloco-b.perth.jl"
        @test nome("AÇÃO 2026") == "acao-2026.perth.jl"
        @test nome("münchen/köln") == "munchen-koln.perth.jl"
        # nome do qual não sobra nada ainda cai no id, como antes
        @test endswith(nome("  ---  "), ".perth.jl")
        @test !startswith(nome("  ---  "), "-")
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

    @testset "aviso: começa antes do que a dependência permite" begin
        # No Perth uma dependência não move ninguém (quem move é schedule!),
        # então um plano pode ter a seta apontando para trás — e até aqui o
        # único sinal disso era o desenho da seta.
        p = create_project("Fora de ordem")
        a = add_task!(p, "lilás"; start = Date(2026, 8, 16), duration = 5)
        b = add_task!(p, "verde"; start = Date(2026, 8, 12), duration = 5,
                      dependencies = [a.id])
        router = Perth._build_router()
        avisos() = JSON3.read(String(router(HTTP.Request(
            "GET", "/api/projects/$(p.id)/warnings")).body))["warnings"]

        w = only(filter(x -> x["kind"] == "too_early", avisos()))
        @test w["task_id"] == b.id
        @test w["at"] == "2026-08-21"          # depois do fim de lilás
        @test w["days"] == 9                   # 12/8 -> 21/8
        @test w["severity"] == "warning"
        @test w["pinned"] == false

        # a tarefa sem predecessor não é avisada: o começo dela é o começo dela
        @test all(x -> x["task_id"] != a.id,
                  filter(x -> x["kind"] == "too_early", avisos()))

        # programar o plano resolve, e o aviso some
        schedule!(p)
        @test b.start == Date(2026, 8, 21)
        @test isempty(filter(x -> x["kind"] == "too_early", avisos()))

        # data fixa é o caso em que o auto-schedule NÃO resolve: o aviso
        # continua, e diz que é isso
        b.start = Date(2026, 8, 12)
        b.pinned = true
        Perth._with_state(st -> Perth._save!(st, p))
        schedule!(p)
        @test b.start == Date(2026, 8, 12)     # presa de propósito
        w2 = only(filter(x -> x["kind"] == "too_early", avisos()))
        @test w2["pinned"] == true

        # com ciclo o CPM não tem por onde começar: sobra o aviso do ciclo,
        # que é o que precisa ser resolvido primeiro
        a.dependencies = [b.id]
        Perth._with_state(st -> Perth._save!(st, p))
        tipos = [x["kind"] for x in avisos()]
        @test "cycle" in tipos
        @test "too_early" ∉ tipos

        delete_project(p.id)
    end

    @testset "erro do Perth chega à tela (não vira \"internal error\")" begin
        # Calendário de dias úteis sem `using BusinessDays`: a exceção traz a
        # frase que resolve ("Run `using BusinessDays`"), e a API a trocava por
        # um "internal error" — escondendo justamente a instrução. Só as
        # mensagens do Perth atravessam; o resto continua 500 sem detalhe.
        p = create_project("Calendário ausente")
        add_task!(p, "A"; start = Date(2026, 9, 1), duration = 3)
        set_calendar!(p, "Brazil")
        router = Perth._build_router()
        resp = router(HTTP.Request("GET", "/api/projects/$(p.id)/stats"))
        if isdefined(Perth, :_business_calendar) &&
           hasmethod(Perth._business_calendar, Tuple{String})
            @test resp.status == 200          # extensão carregada: nem há erro
        else
            @test resp.status == 409
            msg = JSON3.read(String(resp.body))["error"]
            @test occursin("BusinessDays", msg)
        end

        # o mecanismo em si, sem depender de qual extensão está carregada na
        # sessão de teste (com BusinessDays carregado o erro nem acontece)
        nossa = Perth._handled(_ -> error("Perth: faça `using BusinessDays`"))
        r1 = nossa(HTTP.Request("GET", "/x"))
        @test r1.status == 409
        @test occursin("BusinessDays", JSON3.read(String(r1.body))["error"])

        # erro que não é nosso segue sendo 500 sem detalhe
        opaco = Perth._handled(_ -> error("segredo do servidor"))
        r2 = opaco(HTTP.Request("GET", "/x"))
        @test r2.status == 500
        @test JSON3.read(String(r2.body))["error"] == "internal error"

        delete_project(p.id)
    end

    @testset "ordem manual das tarefas (move_task!)" begin
        # A ordem das linhas sempre foi derivada da data. `order` é o que a
        # mão diz — e só vale onde a mão passou: um plano que ninguém
        # arrastou continua saindo pela data, exatamente como antes.
        p = create_project("Ordem")
        a = add_task!(p, "A"; start = Date(2026, 9, 1), duration = 2)
        b = add_task!(p, "B"; start = Date(2026, 9, 5), duration = 2)
        c = add_task!(p, "C"; start = Date(2026, 9, 9), duration = 2)
        nomes() = [t.name for (t, _) in ordered_tasks(p)]

        @test all(t -> t.order == 0, p.tasks)
        @test nomes() == ["A", "B", "C"]                # pela data, como sempre

        # subir a última: o grupo inteiro é renumerado 1,2,3 — sem buracos e
        # sem meia ordenação (metade à mão, metade pela data)
        move_task!(p, c.id; position = 1)
        @test nomes() == ["C", "A", "B"]
        @test [t.order for t in (c, a, b)] == [1, 2, 3]

        # e agora a data deixa de mandar: adiar C não a devolve para o fim
        c.start = Date(2026, 12, 1)
        @test nomes() == ["C", "A", "B"]

        # posição fora da faixa é grudada na ponta, não é erro: quem arrasta
        # para o fim da lista quer o fim da lista
        move_task!(p, c.id; position = 99)
        @test nomes() == ["A", "B", "C"]
        move_task!(p, c.id; position = -3)
        @test nomes() == ["C", "A", "B"]

        # tarefa nova entra sem posição (order = 0) e vai para o FIM do grupo
        # arrumado — na frente estaria dizendo uma posição que ninguém pediu
        d = add_task!(p, "D"; start = Date(2026, 8, 1), duration = 1)
        @test d.order == 0
        @test nomes() == ["C", "A", "B", "D"]

        # mover para dentro de um resumo: pai e posição no mesmo gesto
        move_task!(p, d.id; parent = a.id, position = 1)
        @test d.parent == a.id
        @test nomes() == ["C", "A", "D", "B"]
        # a ordem é uma frase sobre UM grupo: os irmãos de fora não mudaram
        @test [t.order for t in (c, a, b)] == [1, 2, 3]

        # as recusas são as de set_parent!
        m = add_task!(p, "Marco"; start = Date(2026, 9, 20), milestone = true)
        @test_throws ArgumentError move_task!(p, b.id; parent = m.id)
        @test_throws ArgumentError move_task!(p, a.id; parent = d.id)   # descendente
        @test_throws ArgumentError move_task!(p, a.id; parent = a.id)
        @test_throws KeyError move_task!(p, "nao-existe"; position = 1)

        # sair do resumo devolve a tarefa ao topo, na posição pedida
        move_task!(p, d.id; parent = nothing, position = 2)
        @test d.parent == ""
        @test nomes()[1:2] == ["C", "D"]

        # duplicar num grupo arrumado à mão põe a cópia ao lado do original,
        # e não no fim: numa lista posta à mão, o fim pareceria outra coisa
        copia = duplicate_task!(p, a.id)
        @test copia.order == a.order + 1
        @test nomes()[3:4] == ["A", "A (copy)"]
        # apagá-la deixa um buraco na numeração, e o buraco não muda nada: a
        # ordem é relativa, não um índice de linha
        remove_task!(p, copia.id)
        @test nomes()[3] == "A"

        # sobrevive ao disco (JSON) e ao .perth.jl
        Perth._with_state(st -> Perth._save!(st, p))
        p2 = Perth._parse_project_source(Perth._to_julia_source(p))
        @test [t.order for t in p2.tasks] == [t.order for t in p.tasks]
        @test [t.name for (t, _) in ordered_tasks(p2)] == nomes()

        # projeto antigo, gravado antes do campo existir: sem `order` no
        # JSON, tudo volta como 0 — ou seja, ordenado pela data
        velho = JSON3.read(replace(JSON3.write(p), "\"order\"" => "\"ordem_antiga\""), Project)
        @test all(t -> t.order == 0, velho.tasks)

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

    @testset "PERT: estimativa de três pontos" begin
        p = create_project("PERT")
        a = add_task!(p, "A"; start = Date(2026, 9, 1), duration = 5)

        @test !has_estimate(a)
        @test expected_duration(a) == 5.0        # sem estimativa: a duração atual
        @test isempty(pert(p))

        # te = (4 + 4*6 + 14)/6 = 7 ; σ = (14 - 4)/6
        set_estimate!(p, a.id, 4, 6, 14)
        @test has_estimate(a)
        @test expected_duration(a) ≈ 7.0
        @test a.duration == 7                    # apply = true por padrão
        row = only(pert(p))
        @test row.expected ≈ 7.0 && row.sd ≈ 10 / 6 && row.variance ≈ (10 / 6)^2

        # apply = false registra a estimativa sem mexer no plano
        set_estimate!(p, a.id, 2, 2, 2; apply = false)
        @test a.duration == 7 && expected_duration(a) ≈ 2.0
        @test pert!(p) === p && a.duration == 2   # pert! é quem aplica

        # ordem imposta empurrando para cima: o otimista é o piso
        set_estimate!(p, a.id, 8, 5, 6)
        @test (a.optimistic, a.most_likely, a.pessimistic) == (8, 8, 8)
        # estimativa parcial: o que falta vem da duração atual (8, após o apply)
        set_estimate!(p, a.id, 0, 0, 20)
        @test (a.optimistic, a.most_likely, a.pessimistic) == (8, 8, 20)
        @test a.duration == 10                   # te = (8 + 4*8 + 20)/6

        # Empate arredonda PARA CIMA, não para o par. O default do Julia
        # (RoundNearest) daria 4 para te = 4.5 e 6 para te = 5.5 — vizinhos
        # que discordam na tabela, e o 4.5 encolhendo o prazo justamente no
        # empate. O Math.round do navegador já fazia assim na prévia do
        # modal, então era o servidor que destoava.
        for (o, m, q, esperado) in [(3, 4, 8, 5),    # te 4.5
                                    (4, 5, 9, 6),    # te 5.5
                                    (5, 6, 10, 7),   # te 6.5
                                    (2, 4, 6, 4)]    # te 4.0, sem empate
            e = add_task!(p, "empate $(o)$(m)$(q)"; start = Date(2026, 9, 1))
            set_estimate!(p, e.id, o, m, q)
            @test expected_duration(e) == esperado - 0.5 || expected_duration(e) == 4.0
            @test e.duration == esperado
        end

        # marco não recebe duração do PERT (ocupa o próprio dia)
        m = add_task!(p, "Marco"; start = Date(2026, 9, 20), milestone = true)
        set_estimate!(p, m.id, 3, 5, 9)
        @test m.duration == 1

        clear_estimate!(p, a.id)
        @test !has_estimate(a) && a.duration == 10  # tirar a estimativa não move o plano

        delete_project(p.id)
    end

    @testset "PERT: término probabilístico" begin
        p = create_project("PERT fim")
        a = add_task!(p, "A"; start = Date(2026, 9, 1), duration = 1)
        b = add_task!(p, "B"; start = Date(2026, 9, 1), duration = 1,
                      dependencies = [a.id])
        set_estimate!(p, a.id, 4, 6, 14)         # te 7, var (10/6)^2
        set_estimate!(p, b.id, 2, 3, 10)         # te 4, var (8/6)^2
        schedule!(p)

        f = pert_finish(p)
        @test f.expected == Date(2026, 9, 11)    # 7 + 4 dias corridos a partir de 1/9
        @test f.variance ≈ (10 / 6)^2 + (8 / 6)^2
        @test f.sd_days ≈ sqrt(f.variance)
        @test f.critical == 2 && f.estimated == 2

        # Φ no ponto esperado = 50%; monotônica e nos limites
        @test finish_probability(p, f.expected) ≈ 0.5 atol = 1e-6
        @test finish_probability(p, f.expected + Day(30)) > 0.999
        @test finish_probability(p, f.expected - Day(30)) < 0.001
        @test finish_probability(p, f.expected + Day(2)) >
              finish_probability(p, f.expected + Day(1))

        # pert_date é a inversa: a data do P80 devolve ~80%
        d80 = pert_date(p, 0.8)
        @test d80 > f.expected
        @test finish_probability(p, d80) ≈ 0.8 atol = 0.15   # arredondado a dias
        @test pert_date(p, 0.5) == f.expected

        # sem estimativa nenhuma: σ = 0, e a resposta é a certeza do plano
        q = create_project("Sem estimativa")
        add_task!(q, "T"; start = Date(2026, 9, 1), duration = 3)
        fq = pert_finish(q)
        @test fq.sd_days == 0.0
        @test finish_probability(q, fq.expected) == 1.0
        @test finish_probability(q, fq.expected - Day(1)) == 0.0
        @test pert_date(q, 0.99) == fq.expected

        @test pert_finish(create_project("Vazio")).critical == 0   # projeto vazio não quebra

        delete_project(p.id); delete_project(q.id)
    end

    @testset "PERT: as estimativas não gravam nada até pert!" begin
        # a análise roda o motor com durações substitutas (ver _cpm), então
        # perguntar não pode mexer no projeto
        p = create_project("PERT puro")
        a = add_task!(p, "A"; start = Date(2026, 9, 1), duration = 3)
        set_estimate!(p, a.id, 6, 10, 20; apply = false)
        @test a.duration == 3
        f = pert_finish(p)
        @test f.expected == Date(2026, 9, 11)     # 11 dias esperados, não 3
        @test a.duration == 3                     # e a tarefa continua como estava
        pert_simulate(p; n = 50)
        @test a.duration == 3
        delete_project(p.id)
    end

    @testset "PERT: simulação de Monte Carlo" begin
        p = create_project("PERT sim")
        a = add_task!(p, "A"; start = Date(2026, 9, 1), duration = 1)
        b = add_task!(p, "B"; start = Date(2026, 9, 1), duration = 1,
                      dependencies = [a.id])
        set_estimate!(p, a.id, 4, 6, 14)
        set_estimate!(p, b.id, 2, 3, 10)
        schedule!(p)

        s = pert_simulate(p; n = 4000, rng = MersenneTwister(42))
        @test s.runs == 4000
        @test s.p10 <= s.p50 <= s.p80 <= s.p90
        # cadeia em série, sem caminhos paralelos: não há merge bias, então a
        # simulação e a fórmula têm de concordar
        f = pert_finish(p)
        @test abs(Dates.value(s.p50 - f.expected)) <= 1
        @test abs(s.sd_days - f.sd_days) < 0.5
        # a semente manda: mesmo rng, mesmo resultado
        @test pert_simulate(p; n = 500, rng = MersenneTwister(1)).p80 ==
              pert_simulate(p; n = 500, rng = MersenneTwister(1)).p80

        # merge bias: seis frentes paralelas do mesmo tamanho. A fórmula olha
        # UMA cadeia crítica; o projeto só acaba quando a ÚLTIMA das seis
        # acaba, então a simulação tem de cair depois — é o viés inteiro.
        q = create_project("PERT paralelo")
        ini = add_task!(q, "início"; start = Date(2026, 9, 1), duration = 1)
        fim = add_task!(q, "fim"; start = Date(2026, 9, 2), duration = 1)
        deps = String[]
        for i in 1:6
            t = add_task!(q, "frente $i"; start = Date(2026, 9, 2), duration = 10,
                          dependencies = [ini.id])
            set_estimate!(q, t.id, 6, 10, 20)
            push!(deps, t.id)
        end
        update_task!(q, fim.id; dependencies = deps)
        schedule!(q)
        fq = pert_finish(q)
        sq = pert_simulate(q; n = 4000, rng = MersenneTwister(7))
        @test fq.critical == 8                       # as seis frentes empatam
        # σ de UMA frente, não das seis somadas (o que inflaria com o nº de frentes)
        @test fq.sd_days ≈ 14 / 6 atol = 1e-9
        @test sq.p50 > fq.expected                   # o viés, medido

        # sem estimativa nenhuma não há o que sortear: uma passada só
        r = create_project("PERT sem sorteio")
        add_task!(r, "T"; start = Date(2026, 9, 1), duration = 4)
        @test pert_simulate(r; n = 9999).runs == 1
        @test pert_simulate(create_project("PERT vazio")).runs == 0

        delete_project(p.id); delete_project(q.id); delete_project(r.id)
    end

    @testset "PERT: persistência e tabelas" begin
        p = create_project("PERT io")
        a = add_task!(p, "A"; start = Date(2026, 9, 1), duration = 5)
        b = add_task!(p, "B"; start = Date(2026, 9, 1), duration = 5)
        set_estimate!(p, a.id, 4, 6, 14)

        # roundtrip .perth.jl (o leitor é o avaliador restrito, sem eval)
        dir = mktempdir()
        q = Perth.load(Perth.save(p, joinpath(dir, "pert.perth.jl")); register = false)
        qa = only(filter(t -> t.name == "A", q.tasks))
        qb = only(filter(t -> t.name == "B", q.tasks))
        @test (qa.optimistic, qa.most_likely, qa.pessimistic) == (4, 6, 14)
        @test !has_estimate(qb)                  # sem estimativa não vai pro arquivo
        src = read(joinpath(dir, "pert.perth.jl"), String)
        @test count("optimistic", src) == 1

        # roundtrip JSON em disco (o formato interno)
        r = Perth.project(p.id)
        @test (r.tasks[1].optimistic, r.tasks[1].pessimistic) == (4, 14)

        # tasktable / add_tasks!
        rows = tasktable(p)
        @test rows[1].optimistic == 4 && rows[1].expected ≈ 7.0
        @test rows[2].optimistic === missing && rows[2].expected === missing
        s = create_project("PERT tabela")
        add_tasks!(s, [(name = "X", duration = 2, optimistic = 1, most_likely = 4,
                        pessimistic = 7)])
        sx = only(s.tasks)
        @test has_estimate(sx) && expected_duration(sx) ≈ 4.0
        @test sx.duration == 2                   # a tabela registra, pert! é que aplica

        delete_project(p.id); delete_project(s.id)
    end

    # Painel de avisos: reúne o que o motor já sabia e estava espalhado.
    # O teste guarda duas promessas — que cada tipo de problema aparece, e que
    # a rota devolve CAMPOS, não frases: frase pronta aqui sairia em inglês no
    # meio de uma tela traduzida.
    @testset "avisos do plano" begin
        router = Perth._build_router()
        p = create_project("Com problemas")
        a = add_task!(p, "Escavação"; start = Date(2026, 1, 5), duration = 5,
                      assignee = "Ana", deadline = Date(2026, 1, 6))
        b = add_task!(p, "Fundação"; start = Date(2026, 1, 6), duration = 5,
                      assignee = "Ana")
        set_baseline!(p)
        update_task!(p, b.id; start = Date(2026, 1, 20))

        r = JSON3.read(String(router(HTTP.Request("GET",
                "/api/projects/$(p.id)/warnings")).body))
        tipos = Set(String(w.kind) for w in r.warnings)
        @test "deadline" in tipos          # compromisso quebrado
        @test "overdue" in tipos           # passou do fim sem terminar
        @test "slippage" in tipos          # atrás do baseline

        # campos, não frases prontas
        prazo = first(w for w in r.warnings if w.kind == "deadline")
        @test prazo.severity == "error"    # impede o plano, não só aperta
        @test prazo.task == "Escavação"
        @test prazo.days == 3
        @test prazo.at == "2026-01-06"
        @test !haskey(prazo, :text)        # a frase é montada no navegador
        @test all(w -> haskey(w, :task_id), r.warnings)   # dá para levar até lá

        # sobreposição da mesma pessoa aparece como sobrecarga
        update_task!(p, b.id; start = Date(2026, 1, 6))
        r = JSON3.read(String(router(HTTP.Request("GET",
                "/api/projects/$(p.id)/warnings")).body))
        sobre = first(w for w in r.warnings if w.kind == "overallocation")
        @test sobre.who == "Ana"
        @test Set([sobre.task, sobre.other]) == Set(["Escavação", "Fundação"])

        # ciclo é do plano inteiro, não de uma tarefa: vem sem task_id
        update_task!(p, a.id; dependencies = [b.id])
        update_task!(p, b.id; dependencies = [a.id])
        r = JSON3.read(String(router(HTTP.Request("GET",
                "/api/projects/$(p.id)/warnings")).body))
        ciclo = first(w for w in r.warnings if w.kind == "cycle")
        @test ciclo.severity == "error" && ciclo.task_id == ""

        # plano são não inventa aviso nenhum
        limpo = create_project("Sem problemas")
        add_task!(limpo, "Futura"; start = Dates.today() + Dates.Day(30), duration = 3)
        r = JSON3.read(String(router(HTTP.Request("GET",
                "/api/projects/$(limpo.id)/warnings")).body))
        @test isempty(r.warnings)

        @test router(HTTP.Request("GET", "/api/projects/naoexiste/warnings")).status == 404
        delete_project(p.id); delete_project(limpo.id)
    end

    @testset "PERT: rotas REST" begin
        router = Perth._build_router()
        p = create_project("PERT web")
        a = add_task!(p, "A"; start = Date(2026, 9, 1), duration = 3)
        b = add_task!(p, "B"; start = Date(2026, 9, 1), duration = 3,
                      dependencies = [a.id])

        # sem estimativa nenhuma, /cpm não inventa uma seção de PERT
        r = JSON3.read(String(router(HTTP.Request("GET",
                "/api/projects/$(p.id)/cpm")).body))
        @test r.pert === nothing

        # aplicar sem nada estimado é 409, não um no-op silencioso
        resp = router(HTTP.Request("POST", "/api/projects/$(p.id)/pert"))
        @test resp.status == 409
        @test occursin("three-point estimate", String(resp.body))

        set_estimate!(p, a.id, 4, 6, 14; apply = false)
        set_estimate!(p, b.id, 2, 3, 10; apply = false)
        @test a.duration == 3                       # nada aplicado ainda

        r = JSON3.read(String(router(HTTP.Request("GET",
                "/api/projects/$(p.id)/cpm")).body))
        @test r.pert.expected == "2026-09-11"       # com as durações esperadas
        @test r.pert.estimated == 2
        @test r.pert.sd_days > 0
        @test Date(r.pert.p80) > Date(r.pert.expected)
        @test r.finish == "2026-09-06"              # o CPM segue no plano real

        resp = router(HTTP.Request("POST", "/api/projects/$(p.id)/pert"))
        @test resp.status == 200
        back = JSON3.read(String(resp.body))
        @test sort([t.duration for t in back.tasks]) == [4, 7]
        @test Perth.project(p.id).tasks[1].duration == 7   # persistido
        log = JSON3.read(String(router(HTTP.Request("GET", "/api/activity")).body))
        @test any(e -> occursin("applied 2 PERT estimates", e.text), log)

        @test router(HTTP.Request("POST", "/api/projects/naoexiste/pert")).status == 404
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

    @testset "cadastro de colaboradores" begin
        p = create_project("Time")
        a = add_task!(p, "A"; start = Date(2026, 3, 2), duration = 1,
                      assignee = "  ana  paula ")
        b = add_task!(p, "B"; start = Date(2026, 3, 2), duration = 1,
                      assignee = "Ana Paula")

        # espaço nas pontas e no meio some; a segunda grafia adota a que o
        # projeto já conhecia, em vez de reescrever a tarefa alheia
        @test a.assignee == "ana paula"
        @test b.assignee == "ana paula"

        # cadastrar é o jeito explícito de CORRIGIR a grafia de todo mundo
        @test [pe.name for pe in add_person!(p, "Ana Paula")] == ["Ana Paula"]
        @test all(t -> t.assignee == "Ana Paula", p.tasks)

        # acento NÃO é unificado: podem ser duas pessoas de verdade
        r = create_project("Acento")
        add_task!(r, "A"; start = Date(2026, 3, 2), duration = 1, assignee = "Ana")
        add_task!(r, "B"; start = Date(2026, 3, 2), duration = 1, assignee = "Âna")
        @test Set(t.assignee for t in r.tasks) == Set(["Ana", "Âna"])

        # o cadastro aceita nome solto, NamedTuple e Person; apara, tira
        # repetido (ignorando caixa) e ordena por nome
        lista = people!(p, ["  Chen  Wei ", (name = "bruno", role = " Eletricista "),
                            "BRUNO", "", Person(name = "Dara", team = "Obra")])
        @test [pe.name for pe in lista] == ["bruno", "Chen Wei", "Dara"]
        @test lista[1].role == "Eletricista"      # espaço aparado nos campos
        @test lista[3].team == "Obra"
        @test_throws ArgumentError people!(p, [42])

        # person() acha ignorando caixa; quem não existe devolve nothing
        @test person(p, "CHEN wei").name == "Chen Wei"
        @test person(p, "ninguém") === nothing

        # add_person! num nome que já existe ATUALIZA, não duplica: só os
        # campos passados mudam, o resto da ficha fica de pé
        add_person!(p, "Bruno"; team = "Obra")
        @test length(people(p)) == 3
        @test person(p, "bruno").name == "Bruno"   # a grafia nova vence
        @test person(p, "bruno").role == "Eletricista"
        @test person(p, "bruno").team == "Obra"

        # people() devolve cópia: mexer no resultado não mexe no projeto
        copia = people(p); push!(copia, Person(name = "Intruso"))
        @test length(people(p)) == 3

        # tirar do cadastro não tira o nome das tarefas
        add_person!(p, "Ana Paula")
        @test [pe.name for pe in remove_person!(p, "ana paula")] ==
              ["Bruno", "Chen Wei", "Dara"]
        @test all(t -> t.assignee == "Ana Paula", project(p.id).tasks)

        # sobrevive à ida e volta pelo .perth.jl e pelo JSON
        dir = mktempdir()
        arq = joinpath(dir, "time.perth.jl")
        set_file_path!(p, arq)
        fonte = read(arq, String)
        @test occursin("Person(name = \"Bruno\", role = \"Eletricista\", team = \"Obra\")",
                       fonte)
        @test occursin("Person(name = \"Chen Wei\")", fonte)   # campo vazio não é escrito
        lido = Perth.load(arq)
        @test [pe.name for pe in lido.people] == ["Bruno", "Chen Wei", "Dara"]
        @test person(lido, "bruno").role == "Eletricista"
        volta = JSON3.read(JSON3.write(p), Project)
        @test person(volta, "bruno").team == "Obra"
        # projeto antigo, gravado antes do campo existir, ainda abre
        sem = replace(JSON3.write(p), r"\"people\":\[.*?\]," => "")
        @test JSON3.read(sem, Project).people == Person[]

        # a mudança no cadastro entra no diário de atividade — por nome:
        # mexer no cargo de alguém não é cadastrar nem descadastrar
        outro = JSON3.read(JSON3.write(p), Project)
        outro.people = filter(pe -> pe.name != "Dara", outro.people)
        linhas = Perth._describe_diff(project(p.id), outro)
        @test any(l -> occursin("unregistered Dara", l), linhas)
        outro.people = [outro.people; Person(name = "Elis")]
        @test any(l -> occursin("registered Elis", l),
                  Perth._describe_diff(project(p.id), outro))
        so_cargo = JSON3.read(JSON3.write(p), Project)
        person(so_cargo, "Dara").role = "Mestre de obras"
        @test isempty(Perth._describe_diff(project(p.id), so_cargo))

        delete_project(p.id); delete_project(r.id)
    end

    @testset "faixas do calendário" begin
        p = create_project("Sprints")
        add_task!(p, "A"; start = Date(2026, 3, 2), duration = 5)

        @test isempty(bands(p))
        add_band!(p, "Sprint 2", Date(2026, 3, 30), Date(2026, 4, 24))
        # ponta invertida é engano de digitação, não plano: vira em vez de
        # desenhar uma faixa de largura negativa
        add_band!(p, "Sprint 1", Date(2026, 3, 27), Date(2026, 3, 2))
        fs = bands(p)
        @test [f.name for f in fs] == ["Sprint 1", "Sprint 2"]   # por início
        @test (fs[1].from, fs[1].to) == (Date(2026, 3, 2), Date(2026, 3, 27))

        # faixa sem nome não entra: trecho sombreado que não diz por quê é
        # ruído, não informação
        @test length(bands!(p, [fs; Band(from = Date(2026, 5, 1),
                                             to = Date(2026, 5, 5))])) == 2

        # nome repetido MOVE a faixa em vez de duplicar
        add_band!(p, "sprint 1", Date(2026, 2, 2), Date(2026, 2, 9))
        @test length(bands(p)) == 2
        @test person(p, "x") === nothing   # cadastro segue intacto ao lado
        movida = bands(p)[1]
        @test movida.name == "sprint 1" && movida.from == Date(2026, 2, 2)

        # cor é livre; faixas podem se sobrepor (semana crítica dentro de um
        # sprint é coisa que se quer dizer)
        add_band!(p, "Crítico", Date(2026, 2, 4), Date(2026, 2, 6); color = "#cb3c33")
        @test bands(p)[2].color == "#cb3c33"
        @test length(bands(p)) == 3

        @test length(remove_band!(p, "CRÍTICO")) == 2

        # ida e volta pelo .perth.jl e pelo JSON
        dir = mktempdir()
        arq = joinpath(dir, "s.perth.jl")
        set_file_path!(p, arq)
        fonte = read(arq, String)
        @test occursin("Band(name = \"sprint 1\", from = Date(\"2026-02-02\"), " *
                       "to = Date(\"2026-02-09\"))", fonte)
        lido = Perth.load(arq)
        @test [f.name for f in lido.bands] == ["sprint 1", "Sprint 2"]
        @test JSON3.read(JSON3.write(p), Project).bands[2].to == Date(2026, 4, 24)
        # projeto gravado antes do campo existir ainda abre
        sem = replace(JSON3.write(p), r"\"bands\":\[.*?\}\]," => "")
        @test JSON3.read(sem, Project).bands == Band[]

        # a faixa é anotação: não move tarefa nem entra no motor
        @test p.tasks[1].start == Date(2026, 3, 2)
        @test project_finish(p) == Date(2026, 3, 6)

        delete_project(p.id)
    end

    @testset "dias marcados" begin
        p = create_project("Marcos")
        add_task!(p, "A"; start = Date(2026, 3, 2), duration = 5)

        @test isempty(markers(p))
        add_marker!(p, "Entrega", Date(2026, 4, 30))
        add_marker!(p, "Auditoria", Date(2026, 3, 15); color = "#cb3c33")
        @test [m.name for m in markers(p)] == ["Auditoria", "Entrega"]   # por data
        @test markers(p)[1].color == "#cb3c33"

        # nome repetido MOVE de data em vez de duplicar: duas linhas com o
        # mesmo rótulo em dias diferentes é quase sempre uma segunda tentativa
        add_marker!(p, "ENTREGA", Date(2026, 5, 10))
        @test length(markers(p)) == 2
        @test markers(p)[2].date == Date(2026, 5, 10)

        # marco sem nome não entra: linha que não diz o que marca é um risco
        # na tela, não informação
        @test length(markers!(p, [markers(p); Marker(date = Date(2026, 6, 1))])) == 2

        # é anotação, como a faixa: não move tarefa nem entra no motor
        @test p.tasks[1].start == Date(2026, 3, 2)
        @test project_finish(p) == Date(2026, 3, 6)

        @test length(remove_marker!(p, "auditoria")) == 1

        dir = mktempdir()
        arq = joinpath(dir, "m.perth.jl")
        set_file_path!(p, arq)
        @test occursin("Marker(name = \"ENTREGA\", date = Date(\"2026-05-10\"))",
                       read(arq, String))
        @test [m.name for m in Perth.load(arq).markers] == ["ENTREGA"]
        volta = JSON3.read(JSON3.write(p), Project)
        @test volta.markers[1].date == Date(2026, 5, 10)
        sem = replace(JSON3.write(p), r"\"markers\":\[.*?\}\]," => "")
        @test JSON3.read(sem, Project).markers == Marker[]

        # label_at: onde o nome fica na vertical (0–100% da altura do gráfico).
        # Deitado sobre a linha, o nome cai em cima de alguma barra, e qual
        # barra depende do plano — daí ser ajuste de quem olha.
        @test markers(p)[1].label_at == 0                 # o padrão é o topo
        add_marker!(p, "Vistoria", Date(2026, 6, 2); label_at = 60)
        @test only(filter(m -> m.name == "Vistoria", markers(p))).label_at == 60
        # porcentagem, não pixel: fora da faixa é grudado na ponta
        markers!(p, [Marker(name = "Alta", date = Date(2026, 6, 3), label_at = 999),
                     Marker(name = "Baixa", date = Date(2026, 6, 4), label_at = -5)])
        @test [m.label_at for m in markers(p)] == [100, 0]
        # vai e volta pelo .perth.jl e pelo JSON, e 0 não suja o arquivo
        markers!(p, [Marker(name = "Vistoria", date = Date(2026, 6, 2), label_at = 60),
                     Marker(name = "Topo", date = Date(2026, 6, 5))])
        fonte = Perth._to_julia_source(p)
        @test occursin("label_at = 60", fonte)
        @test occursin("Marker(name = \"Topo\", date = Date(\"2026-06-05\"))", fonte)
        @test [m.label_at for m in Perth._parse_project_source(fonte).markers] == [60, 0]
        @test JSON3.read(JSON3.write(p), Project).markers[1].label_at == 60

        delete_project(p.id)
    end

    @testset "meses marcados" begin
        # Irmão do dia marcado, para o mês — e a diferença com a faixa é onde
        # cada um pinta: a faixa sombreia o fundo do gráfico, o mês marcado
        # pinta só a célula da régua que já escreve o nome dele.
        p = create_project("Meses")
        add_task!(p, "T"; start = Date(2026, 9, 1), duration = 3)

        @test isempty(month_marks(p))
        add_month_mark!(p, Date(2026, 9, 17); name = "chuvas", color = "#4063d8")
        add_month_mark!(p, Date(2026, 12, 2))
        # qualquer dia do mês serve: a chave é o primeiro dia
        @test [m.month for m in month_marks(p)] == [Date(2026, 9, 1), Date(2026, 12, 1)]
        @test month_marks(p)[1].name == "chuvas"

        # nome vazio é permitido, ao contrário do dia marcado: a célula da
        # régua já escreve "dez 2026", então a cor sozinha pode ser o recado
        @test month_marks(p)[2].name == ""

        # marcar de novo o mesmo mês é CORREÇÃO, não um segundo mês
        add_month_mark!(p, Date(2026, 9, 30); name = "estação de chuvas",
                        color = "#cb3c33")
        @test length(month_marks(p)) == 2
        @test month_marks(p)[1].name == "estação de chuvas"
        @test month_marks(p)[1].color == "#cb3c33"

        # é anotação: não move tarefa nem entra no motor
        @test p.tasks[1].start == Date(2026, 9, 1)
        @test project_finish(p) == Date(2026, 9, 3)

        @test length(remove_month_mark!(p, Date(2026, 12, 25))) == 1

        # vai e volta pelo disco e pelo .perth.jl
        volta = JSON3.read(JSON3.write(p), Project)
        @test volta.month_marks[1].month == Date(2026, 9, 1)
        fonte = Perth._to_julia_source(p)
        @test occursin("MonthMark(month = Date(\"2026-09-01\")", fonte)
        @test [m.month for m in Perth._parse_project_source(fonte).month_marks] ==
              [Date(2026, 9, 1)]
        # projeto gravado antes do campo existir volta sem mês nenhum
        sem = replace(JSON3.write(p), r"\"month_marks\":\[.*?\}\]," => "")
        @test JSON3.read(sem, Project).month_marks == MonthMark[]

        delete_project(p.id)
    end

    @testset "estatísticas por pessoa e por setor" begin
        p = create_project("Obra")
        pai = add_task!(p, "Estrutura"; start = Date(2026, 3, 2), duration = 1)
        a = add_task!(p, "Projeto"; start = Date(2026, 3, 2), duration = 5,
                      assignee = "Ana", progress = 100)
        b = add_task!(p, "Fundação"; start = Date(2026, 3, 4), duration = 5,
                      assignee = "Ana")
        set_parent!(p, b.id, pai.id)
        c = add_task!(p, "Alvenaria"; start = Date(2026, 3, 9), duration = 4,
                      assignee = "Chen", cost = 40.0, progress = 50)
        m = add_task!(p, "Entrega"; start = Date(2026, 3, 20), duration = 1,
                      assignee = "Chen", milestone = true, deadline = Date(2026, 3, 10))
        add_task!(p, "Telhado"; start = Date(2026, 4, 1), duration = 3)
        people!(p, [(name = "Ana", role = "Arquiteta", team = "Projetos"),
                    (name = "Chen", role = "Pedreiro", team = "Obra")])

        linhas = people_stats(p)
        @test [r.assignee for r in linhas] == ["Ana", "Chen", ""]   # sem dono por último
        ana = linhas[1]
        @test (ana.role, ana.team) == ("Arquiteta", "Projetos")
        @test ana.tasks == 2 && ana.milestones == 0
        @test ana.effort == 10.0                    # 5 + 5 pessoa-dias
        @test ana.done == 5.0 && ana.progress == 50
        @test (ana.first, ana.last) == (Date(2026, 3, 2), Date(2026, 3, 8))
        @test ana.busy_days == 7                    # 2..6 e 4..8, sobrepostos
        @test ana.over_days == 3                    # 4, 5 e 6
        @test ana.late == 0

        chen = linhas[2]
        @test chen.milestones == 1
        @test chen.effort == 41.0                   # custo quando informado + marco
        @test chen.late == 1                        # a entrega passou do prazo

        # o resumo de WBS não conta: somá-lo contaria o trabalho dos filhos
        # duas vezes
        @test sum(r.tasks for r in linhas) == 5
        @test all(r -> r.assignee != "Estrutura", linhas)
        # tarefa sem dono não some: trabalho sem responsável é fato do plano
        @test linhas[3].tasks == 1 && linhas[3].role == ""

        setores = team_stats(p)
        @test [r.team for r in setores] == ["Obra", "Projetos", ""]
        @test setores[1].members == 1 && setores[1].people == ["Chen"]
        @test setores[2].effort == ana.effort
        # dias de sobrecarga são por pessoa e o setor SOMA os das suas: duas
        # pessoas do mesmo setor no mesmo dia é o normal
        @test setores[2].over_days == ana.over_days
        # quem não tem setor (nem cadastro) cai na faixa vazia, junto com o
        # trabalho sem dono
        @test setores[3].tasks == 1 && setores[3].members == 0

        # projeto sem tarefa nenhuma não quebra as duas tabelas
        vazio = create_project("Vazio")
        @test isempty(people_stats(vazio)) && isempty(team_stats(vazio))

        delete_project(p.id); delete_project(vazio.id)
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

    @testset "carga diária por responsável (workload)" begin
        # Datas no passado por construção (hoje > 2026-03): nada aqui depende
        # da data de hoje, mas a lição do 0.5.1 vale como higiene
        p = create_project("Carga")
        pai = add_task!(p, "Grupo"; start = Date(2026, 3, 2), duration = 1)
        a = add_task!(p, "A"; start = Date(2026, 3, 2), duration = 5,
                      assignee = "Dante", parent = pai.id)      # 02–06/03
        b = add_task!(p, "B"; start = Date(2026, 3, 4), duration = 5,
                      assignee = "Dante")                       # 04–08/03
        add_task!(p, "C"; start = Date(2026, 3, 20), duration = 5,
                  assignee = "Dante", cost = 10.0)              # disjunta, com custo
        add_task!(p, "D"; start = Date(2026, 3, 4), duration = 2,
                  assignee = "Ana")
        add_task!(p, "Sem dono"; start = Date(2026, 3, 4), duration = 3)

        w = workload(p)
        dante = filter(r -> r.assignee == "Dante", w)
        @test [r.date for r in dante] ==
              vcat(collect(Date(2026, 3, 2):Day(1):Date(2026, 3, 8)),
                   collect(Date(2026, 3, 20):Day(1):Date(2026, 3, 24)))
        # os dias com 2 tarefas são exatamente a interseção que overallocations
        # devolve como um par — a mesma verdade, dia a dia em vez de par a par
        ov = only(filter(r -> r.assignee == "Dante", overallocations(p)))
        @test [r.date for r in dante if r.tasks == 2] ==
              collect(ov.from:Day(1):ov.to)
        @test Set(only(filter(r -> r.date == Date(2026, 3, 4), dante)).task_ids) ==
              Set([a.id, b.id])

        # resumo é contêiner, não trabalho: "Grupo" cobre o período e não entra
        @test all(r -> !(pai.id in r.task_ids), w)
        # sem responsável não vira linha
        @test Set(r.assignee for r in w) == Set(["Dante", "Ana"])
        # ordenação: pessoa, depois data
        @test issorted(w; by = r -> (lowercase(r.assignee), r.date))

        # esforço: pessoa-dias por padrão (1/dia), custo quando informado
        @test only(filter(r -> r.date == Date(2026, 3, 2), dante)).effort ≈ 1.0
        @test only(filter(r -> r.date == Date(2026, 3, 4), dante)).effort ≈ 2.0
        @test only(filter(r -> r.date == Date(2026, 3, 20), dante)).effort ≈ 2.0
        # o peso de cada tarefa é conservado ao ser espalhado pelos dias
        @test sum(r.effort for r in w) ≈ 5 + 5 + 10 + 2

        # marco ocupa só o próprio dia
        m = add_task!(p, "Entrega"; start = Date(2026, 3, 30), assignee = "Ana",
                      milestone = true)
        ana = filter(r -> r.assignee == "Ana", workload(p))
        @test only(filter(r -> m.id in r.task_ids, ana)).date == Date(2026, 3, 30)

        # endpoint: mesma carga, densificada na janela do projeto. Despacha
        # pelo router de verdade, senão o teste não pega esquecer o register!
        router = Perth._build_router()
        resp = router(HTTP.Request("GET", "/api/projects/$(p.id)/workload"))
        @test resp.status == 200
        pl = JSON3.read(String(resp.body))
        @test pl.start == "2026-03-02"
        @test pl.days == 29                       # 02/03 até o marco em 30/03
        dan = only(filter(e -> e.assignee == "Dante", pl.people))
        @test length(dan.load) == pl.days
        @test dan.load[3] == 2                    # 04/03: A e B juntas
        @test dan.load[1] == 1 && dan.load[10] == 0
        @test dan.peak == 2 && dan.over_days == 3 && dan.busy_days == 12
        @test Set(t.name for t in dan.tasks) == Set(["A", "B", "C"])
        # tarefa sem responsável vira uma faixa própria, sob a chave ""
        @test only(filter(e -> e.assignee == "", pl.people)).busy_days == 3
        @test router(HTTP.Request("GET", "/api/projects/naoexiste/workload")).status == 404
        delete_project(p.id)

        # calendário de dias úteis: é o caso que obriga o cálculo a viver no
        # motor. Sex 06/03 + 2 dias úteis carrega sexta e SEGUNDA — o fim de
        # semana no meio do intervalo não carrega ninguém
        pb = create_project("CargaBD")
        set_calendar!(pb, "Brazil")
        add_task!(pb, "Vistoria"; start = Date(2026, 3, 6), duration = 2,
                  assignee = "Ana")
        wb = workload(pb)
        @test [r.date for r in wb] == [Date(2026, 3, 6), Date(2026, 3, 9)]
        @test all(r -> r.tasks == 1 && r.effort ≈ 1.0, wb)
        delete_project(pb.id)
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

    @testset "chave de acesso (key)" begin
        # Numa conexão loopback o IP de origem é sempre 127.0.0.1 — e o host
        # é isento da chave —, então um teste HTTP de ponta a ponta jamais
        # exercitaria o portão. Por isso o veredito do gantt (_gantt_gate) e
        # o handler estático do kanban são chamados com o IP por fora, como
        # nos harness de WS lá de cima.
        other = "192.168.0.60"
        noqp = Dict{String,String}()
        withkey = Dict("key" => "s3cr3t")
        wrong = Dict("key" => "s3cr3T")

        gantt_key, gantt_was = Perth.GANTT_KEY[], Perth.GANTT_SHARED[]
        kanban_key, kanban_was = Perth.KANBAN_KEY[], Perth.KANBAN_SHARED[]
        try
            # ── quem passa pela chave ──
            @test Perth._keyok(other, noqp, "")            # sem chave: todos
            @test Perth._keyok("127.0.0.1", noqp, "s3cr3t")  # host: isento
            @test Perth._keyok("::1", noqp, "s3cr3t")
            @test Perth._keyok(other, withkey, "s3cr3t")
            @test !Perth._keyok(other, noqp, "s3cr3t")
            @test !Perth._keyok(other, wrong, "s3cr3t")     # comparação exata

            # ── que rotas a chave protege ──
            # Os dados e a imagem de fundo (única rota que serve bytes de
            # fora do frontend). O shell da página fica aberto de propósito:
            # é ele que mostra o diálogo pedindo a chave.
            for p in ("/api/rev", "/api/projects", "/api/projects/x1",
                      "/api/projects/x1/export", "/api/projects/x1/export.csv",
                      "/api/projects/x1/export.ics", "/api/projects/x1/chart",
                      "/api/projects/x1/scurve", "/api/projects/x1/workload",
                      "/api/projects/x1/cpm", "/api/projects/x1/schedule",
                      "/api/projects/x1/path", "/api/import", "/api/activity",
                      "/api/apps", "/api/launch/kanban", "/api/launch/gantt",
                      "/api/boards", "/api/share", "/api/background",
                      "/api/fs/list", "/api/fs/complete", "/background")
                @test Perth._key_protected(p)
            end
            for p in ("/", "/index.html", "/app.js", "/style.css", "/logo.png",
                      "/favicon.svg", "/sw.js", "/manifest.webmanifest",
                      "/shared/ui.css", "/shared/presence.js", "/shared/i18n.js")
                @test !Perth._key_protected(p)
            end

            # ── gantt: veredito do porteiro ──
            Perth.GANTT_SHARED[] = true
            Perth.GANTT_KEY[] = ""
            @test Perth._gantt_gate("/api/projects", other, noqp) === :ok

            # ── só-host: o que alcança a MÁQUINA, não o projeto ──
            #
            # Espelho em disco, navegação de diretórios e iniciar processo não
            # são edição — são acesso à máquina que hospeda. O espelho é o pior:
            # _resolve_save_path aceita qualquer caminho terminado em .jl, então
            # um convidado apontaria para ~/.julia/config/startup.jl e a máquina
            # anfitriã sobrescreveria o arquivo no salvamento seguinte.
            for (rota, metodo) in (("/api/projects/x1/path", "PUT"),
                                   ("/api/fs/list", "GET"),
                                   ("/api/fs/complete", "GET"),
                                   ("/api/launch/kanban", "POST"))
                @test Perth._gantt_gate(rota, other, noqp; method = metodo) === :host_only
                @test Perth._gantt_gate(rota, "127.0.0.1", noqp; method = metodo) === :ok
            end
            # e o que É edição de projeto continua passando: esta guarda não é
            # o interruptor de somente-leitura, é outro assunto
            @test Perth._gantt_gate("/api/projects/x1", other, noqp; method = "PUT") === :ok
            @test Perth._gantt_gate("/api/projects", other, noqp; method = "POST") === :ok
            # GET no caminho do espelho não escreve nada: só o PUT é bloqueado
            @test Perth._gantt_gate("/api/projects/x1/path", other, noqp;
                                    method = "GET") === :ok

            Perth.GANTT_KEY[] = "s3cr3t"
            @test Perth._gantt_gate("/api/projects", other, noqp) === :need_key
            @test Perth._gantt_gate("/api/projects", other, wrong) === :need_key
            @test Perth._gantt_gate("/background", other, noqp) === :need_key
            @test Perth._gantt_gate("/api/projects", other, withkey) === :ok
            @test Perth._gantt_gate("/background", other, withkey) === :ok
            # o shell da página abre sem chave (é o que permite pedi-la)
            @test Perth._gantt_gate("/", other, noqp) === :ok
            @test Perth._gantt_gate("/app.js", other, noqp) === :ok
            # o host nunca precisa da chave
            @test Perth._gantt_gate("/api/projects", "127.0.0.1", noqp) === :ok
            # transmissão desligada vence a chave: nem com ela se entra
            Perth.GANTT_SHARED[] = false
            @test Perth._gantt_gate("/api/projects", other, withkey) === :not_shared
            @test Perth._gantt_gate("/", other, withkey) === :not_shared
            @test Perth._gantt_gate("/api/projects", "127.0.0.1", noqp) === :ok

            # ── kanban: mesma regra, pelo handler HTTP de verdade ──
            ktmp = mktempdir(); Perth._init_kanban!(ktmp)
            Perth.KANBAN_SHARED[] = true
            Perth.KANBAN_KEY[] = "s3cr3t"
            status(target, ip) =
                Perth._kanban_static(HTTP.Request("GET", target), ip).status
            @test status("/api/boards", other) == 403
            @test status("/api/boards?key=s3cr3T", other) == 403
            @test status("/api/boards?key=s3cr3t", other) == 200
            @test status("/api/boards", "127.0.0.1") == 200
            # /background: sem chave é 403; com ela chega à rota (404 aqui,
            # que é a resposta de "nenhum fundo apontado")
            @test status("/background", other) == 403
            @test status("/background?key=s3cr3t", other) == 404
            @test status("/background", "127.0.0.1") == 404
            # o shell da página segue aberto (diálogo da chave)
            @test status("/", other) == 200
            @test status("/app.js", other) == 200

            # ── trocar a chave ao vivo (Perth.key! / botão do diálogo) ──
            # sem servidor no ar não há chave a trocar
            @test Perth.SERVER[] === nothing
            @test_throws ArgumentError Perth.key!("nova")
            @test Perth.KANBAN_SERVER[] === nothing
            @test_throws ArgumentError Perth.kanban_key!("nova")

            # com o board de pé (listener de mentira no loopback: o que
            # importa é KANBAN_SERVER[] não ser `nothing`)
            dummy = Perth._quiet() do
                HTTP.listen!(http -> nothing, "127.0.0.1", 0; verbose = false)
            end
            Perth.KANBAN_SERVER[] = dummy
            @test Perth.kanban_key!("outra") == true
            @test Perth.KANBAN_KEY[] == "outra"
            @test status("/api/boards?key=s3cr3t", other) == 403   # a antiga morreu
            @test status("/api/boards?key=outra", other) == 200
            # espaços em volta somem: chave colada não quebra por um espaço
            @test Perth.kanban_key!("  espacos  ") == true
            @test Perth.KANBAN_KEY[] == "espacos"
            # remover volta a deixar a rede entrar sem chave
            @test Perth.kanban_key!() == false
            @test Perth.KANBAN_KEY[] == ""
            @test status("/api/boards", other) == 200
            # a troca entra no log de atividades do board
            @test any(e -> e["type"] == "key", Perth._kanban_state().log)

            # o endpoint: só o host, e é POST
            post_key(k, ip) = Perth._kanban_static(
                HTTP.Request("POST", "/api/key", ["Content-Type" => "application/json"],
                             """{"key":"$k"}"""), ip)
            Perth.KANBAN_SHARED[] = true
            @test post_key("de-fora", other).status == 403
            @test Perth.KANBAN_KEY[] == ""              # e nada mudou
            ok = post_key("do-host", "127.0.0.1")
            @test ok.status == 200
            @test Perth.KANBAN_KEY[] == "do-host"
            @test JSON3.read(ok.body)["keyed"] == true  # payload de /api/share
            @test occursin("key=do-host", JSON3.read(ok.body)["urls"][1])
            @test post_key("", "127.0.0.1").status == 200
            @test Perth.KANBAN_KEY[] == ""
            @test JSON3.read(post_key("x", "127.0.0.1").body)["keyed"] == true
            # GET em /api/key não é rota: cai no 404 da API
            @test Perth._kanban_static(HTTP.Request("GET", "/api/key"), "127.0.0.1").status == 404

            # gantt: mesma coisa pelo endpoint, com o servidor "de pé"
            Perth.SERVER[] = dummy
            Perth.GANTT_SHARED[] = true
            Perth.GANTT_KEY[] = ""
            gpost(k, ip) = Perth._gantt_key_set(
                HTTP.Request("POST", "/api/key", ["Content-Type" => "application/json"],
                             """{"key":"$k"}"""), ip)
            @test gpost("de-fora", other).status == 403
            @test Perth.GANTT_KEY[] == ""
            gok = gpost("do-host", "127.0.0.1")
            @test gok.status == 200
            @test Perth.GANTT_KEY[] == "do-host"
            @test JSON3.read(gok.body)["keyed"] == true
            @test Perth._gantt_gate("/api/projects", other, noqp) === :need_key
            @test Perth._gantt_gate("/api/projects", other,
                                    Dict("key" => "do-host")) === :ok
            @test Perth.key!() == false          # remove
            @test Perth._gantt_gate("/api/projects", other, noqp) === :ok
            # corpo sem "key" limpa a chave (o botão "remove" manda "")
            Perth.key!("z")
            @test Perth._gantt_key_set(HTTP.Request("POST", "/api/key", [], "{}"),
                                       "127.0.0.1").status == 200
            @test Perth.GANTT_KEY[] == ""
        finally
            Perth.GANTT_KEY[], Perth.GANTT_SHARED[] = gantt_key, gantt_was
            Perth.KANBAN_KEY[], Perth.KANBAN_SHARED[] = kanban_key, kanban_was
            Perth.SERVER[] = nothing
            if Perth.KANBAN_SERVER[] !== nothing
                Perth._quiet(() -> close(Perth.KANBAN_SERVER[]))
                Perth.KANBAN_SERVER[] = nothing
            end
        end

        # trocar a chave derruba quem é de fora com reason "key" — é o que
        # faz a UI pedir a chave nova em vez de oferecer "tentar de novo"
        hub = Perth.PresenceHub()
        ipref = Ref("192.168.0.90")
        server, port = _presence_test_server(hub, ipref)
        try
            reason = Ref{Any}(nothing)
            t = @async HTTP.WebSockets.open("ws://127.0.0.1:$port") do ws
                HTTP.WebSockets.receive(ws)          # init
                msg = JSON3.read(HTTP.WebSockets.receive(ws))
                reason[] = (msg["type"], get(msg, "reason", nothing))
            end
            @test _await_clients(hub, 1) == 1
            @test Perth._hub_drop_remote!(hub; reason = "key") == 1
            wait(t)
            @test reason[] == ("denied", "key")
        finally
            Perth._quiet(() -> close(server))
        end

        # ...mas TIRAR a chave não derruba ninguém: nada do que a máquina
        # remota tem virou inválido, e pedir na tela uma chave que não
        # existe mais seria só um beco sem saída
        # ...mas TIRAR a chave não derruba ninguém: nada do que a máquina
        # remota tem virou inválido, e pedir na tela uma chave que não
        # existe mais seria só um beco sem saída. Aqui o hub é o global
        # (GANTT_HUB), porque é nele que key! mexe.
        gantt_key2, gantt_was2 = Perth.GANTT_KEY[], Perth.GANTT_SHARED[]
        dummy2 = Perth._quiet() do
            HTTP.listen!(http -> nothing, "127.0.0.1", 0; verbose = false)
        end
        Perth.SERVER[] = dummy2
        ipref2 = Ref("192.168.0.91")
        server3, port3 = _presence_test_server(Perth.GANTT_HUB, ipref2)
        try
            Perth.GANTT_SHARED[] = true
            Perth.GANTT_KEY[] = "antiga"
            release = Channel{Bool}(1)
            alive = @async HTTP.WebSockets.open("ws://127.0.0.1:$port3") do ws
                HTTP.WebSockets.receive(ws)      # init
                take!(release)
            end
            @test _await_clients(Perth.GANTT_HUB, 1) == 1
            @test Perth.key!() == false
            @test Perth.GANTT_KEY[] == ""
            @test length(Perth.GANTT_HUB.clients) == 1   # seguiu conectado
            put!(release, true)
            wait(alive)
        finally
            Perth._quiet(() -> close(server3))
            Perth.GANTT_KEY[], Perth.GANTT_SHARED[] = gantt_key2, gantt_was2
            Perth.SERVER[] = nothing
            Perth._quiet(() -> close(dummy2))
            _await_clients(Perth.GANTT_HUB, 0)
        end
    end

    @testset "link somente-leitura (view_key)" begin
        # A chave de leitura é uma SEGUNDA chave: um link abre e edita, o
        # outro abre e não edita. Como o loopback é isento de chave, o papel
        # é testado com o IP por fora, como no testset da chave de acesso.
        other = "192.168.0.70"
        noqp = Dict{String,String}()
        edita = Dict("key" => "s3cr3t")
        olha = Dict("key" => "so-ver")

        key0, view0, was0 = Perth.GANTT_KEY[], Perth.GANTT_VIEW_KEY[], Perth.GANTT_SHARED[]
        porta0 = Perth.PORT[]
        try
            Perth.GANTT_SHARED[] = true
            Perth.GANTT_KEY[] = "s3cr3t"
            Perth.GANTT_VIEW_KEY[] = "so-ver"

            # ── papéis ──
            @test Perth._gantt_role("127.0.0.1", olha) === :host   # a máquina do servidor edita sempre
            @test Perth._gantt_role(other, olha) === :viewer
            @test Perth._gantt_role(other, edita) === :guest
            @test Perth._gantt_role(other, noqp) === :nokey

            # ── o que o espectador pode: ler tudo ──
            for rota in ("/api/projects", "/api/projects/x1", "/api/rev",
                         "/api/projects/x1/export", "/api/projects/x1/export.csv",
                         "/api/projects/x1/chart", "/api/projects/x1/cpm",
                         "/api/activity", "/background", "/", "/app.js")
                @test Perth._gantt_gate(rota, other, olha) === :ok
            end

            # ── e o que não pode: qualquer escrita, pelo método ──
            for (rota, metodo) in (("/api/projects/x1", "PUT"),
                                   ("/api/projects/x1", "POST"),
                                   ("/api/projects/x1", "DELETE"),
                                   ("/api/projects", "POST"),
                                   ("/api/import", "POST"),
                                   ("/api/projects/x1/schedule", "POST"),
                                   ("/api/projects/x1/pert", "POST"))
                @test Perth._gantt_gate(rota, other, olha; method = metodo) === :read_only
                # a mesma rota, pelo link de edição, continua passando: o que
                # separa os dois é a chave apresentada, não a rota
                @test Perth._gantt_gate(rota, other, edita; method = metodo) === :ok
                @test Perth._gantt_gate(rota, "127.0.0.1", olha; method = metodo) === :ok
            end

            # sem chave de acesso configurada — o caso comum — o link somente
            # -leitura tem que continuar valendo, e o link pelado segue editando
            Perth.GANTT_KEY[] = ""
            @test Perth._gantt_role(other, olha) === :viewer
            @test Perth._gantt_gate("/api/projects/x1", other, olha; method = "PUT") === :read_only
            @test Perth._gantt_gate("/api/projects/x1", other, noqp; method = "PUT") === :ok

            # transmissão desligada vence tudo, como na chave de acesso
            Perth.GANTT_SHARED[] = false
            @test Perth._gantt_gate("/api/projects", other, olha) === :not_shared
            Perth.GANTT_SHARED[] = true

            # ── o payload de /api/share é escrito para quem pergunta ──
            # (os links carregam a chave: entregar a de edição a quem entrou
            # para olhar seria desfazer o link na primeira tela)
            Perth.GANTT_KEY[] = "s3cr3t"
            Perth.PORT[] = 8123
            espectador = Perth._gantt_share_payload(other; viewing = true)
            @test espectador.viewing
            @test !espectador.host
            @test isempty(espectador.view_urls)
            @test !any(occursin("s3cr3t", u) for u in espectador.urls)
            @test all(occursin("so-ver", u) for u in espectador.urls)

            anfitriao = Perth._gantt_share_payload("127.0.0.1")
            @test anfitriao.host
            @test !anfitriao.viewing
            @test anfitriao.view_keyed
            @test all(occursin("so-ver", u) for u in anfitriao.view_urls)
            # o link de leitura não começa em localhost: nesta máquina ele
            # não vale (o host edita sempre), e prometê-lo seria mentir
            @test !any(occursin("localhost", u) for u in anfitriao.view_urls)
        finally
            Perth.GANTT_KEY[], Perth.GANTT_VIEW_KEY[] = key0, view0
            Perth.GANTT_SHARED[], Perth.PORT[] = was0, porta0
        end

        # ── view_key!: só com o servidor no ar, e nunca igual à de acesso ──
        key1, view1, was1 = Perth.GANTT_KEY[], Perth.GANTT_VIEW_KEY[], Perth.GANTT_SHARED[]
        @test Perth.SERVER[] === nothing
        @test_throws ArgumentError Perth.view_key!("qualquer")
        dummy = Perth._quiet() do
            HTTP.listen!(http -> nothing, "127.0.0.1", 0; verbose = false)
        end
        try
            Perth.SERVER[] = dummy
            Perth.GANTT_KEY[] = "mesma"
            # um texto não pode significar as duas permissões
            @test_throws ArgumentError Perth.view_key!("mesma")
            @test Perth.GANTT_VIEW_KEY[] == ""
            @test Perth.view_key!("so-ver") == true
            @test Perth.GANTT_VIEW_KEY[] == "so-ver"
            @test Perth.view_key!() == false        # remove
            @test Perth.GANTT_VIEW_KEY[] == ""

            # a rota é a do host, como /api/key
            post(k, ip) = Perth._gantt_key_set(
                HTTP.Request("POST", "/api/view_key", ["Content-Type" => "application/json"],
                             """{"key":"$k"}"""), ip; view = true)
            @test post("de-fora", "192.168.0.71").status == 403
            @test Perth.GANTT_VIEW_KEY[] == ""
            ok = post("do-host", "127.0.0.1")
            @test ok.status == 200
            @test Perth.GANTT_VIEW_KEY[] == "do-host"
            @test JSON3.read(ok.body)["view_keyed"] == true
            # igual à de acesso: 409, e a chave de leitura não muda
            @test post("mesma", "127.0.0.1").status == 409
            @test Perth.GANTT_VIEW_KEY[] == "do-host"
        finally
            Perth.GANTT_KEY[], Perth.GANTT_VIEW_KEY[] = key1, view1
            Perth.GANTT_SHARED[] = was1
            Perth.SERVER[] = nothing
            Perth._quiet(() -> close(dummy))
        end

        # ── a porta dos fundos: o WS ──
        # Recusar o PUT e deixar o socket escrever seria trocar a fechadura
        # e deixar a janela aberta. O chat persiste em disco e chega a todo
        # mundo: é escrita, e o espectador não a faz.
        #
        # O cliente devolve o que recebeu por um Channel (take! espera o
        # tempo que precisar) e só sai quando o teste solta — desconectar
        # antes tiraria o cliente do hub no meio da verificação.
        hub = Perth.PresenceHub()
        ipref = Ref("192.168.0.72")
        server, port = _presence_test_server(hub, ipref; readonly = true)
        try
            leitura = Ref{Any}(nothing)
            recebidos = Channel{String}(4)
            solta = Channel{Bool}(1)
            t = @async HTTP.WebSockets.open("ws://127.0.0.1:$port") do ws
                init = JSON3.read(HTTP.WebSockets.receive(ws))
                # o init diz o papel: é assim que a UI sabe antes de tentar
                leitura[] = init["readonly"]
                HTTP.WebSockets.send(ws, JSON3.write(Dict(
                    "type" => "chat", "text" => "não deveria entrar")))
                # o hello volta como "peer" e serve de marca-passo: se o chat
                # tivesse passado, ele chegaria antes
                HTTP.WebSockets.send(ws, JSON3.write(Dict("type" => "hello", "name" => "TV")))
                put!(recebidos, String(JSON3.read(HTTP.WebSockets.receive(ws))["type"]))
                take!(solta)
            end
            @test _await_clients(hub, 1) == 1
            @test take!(recebidos) == "peer"
            @test leitura[] == true
            @test isempty(hub.chat)
            # e ele aparece na lista de máquinas marcado como espectador
            @test all(c -> c.readonly, values(hub.clients))
            put!(solta, true)
            wait(t)
        finally
            Perth._quiet(() -> close(server))
        end

        # o mesmo caminho, um cliente comum: o chat passa (controle do teste)
        hub2 = Perth.PresenceHub()
        ipref2 = Ref("192.168.0.73")
        server2, port2 = _presence_test_server(hub2, ipref2)
        try
            leitura2 = Ref{Any}(nothing)
            recebidos2 = Channel{String}(4)
            solta2 = Channel{Bool}(1)
            t = @async HTTP.WebSockets.open("ws://127.0.0.1:$port2") do ws
                init = JSON3.read(HTTP.WebSockets.receive(ws))
                leitura2[] = init["readonly"]
                HTTP.WebSockets.send(ws, JSON3.write(Dict(
                    "type" => "chat", "text" => "oi")))
                put!(recebidos2, String(JSON3.read(HTTP.WebSockets.receive(ws))["type"]))
                take!(solta2)
            end
            @test _await_clients(hub2, 1) == 1
            @test take!(recebidos2) == "chat"
            @test leitura2[] == false
            @test length(hub2.chat) == 1
            put!(solta2, true)
            wait(t)
        finally
            Perth._quiet(() -> close(server2))
        end

        # ── trocar uma chave derruba só quem ela invalidou ──
        key2, view2, was2 = Perth.GANTT_KEY[], Perth.GANTT_VIEW_KEY[], Perth.GANTT_SHARED[]
        dummy2 = Perth._quiet() do
            HTTP.listen!(http -> nothing, "127.0.0.1", 0; verbose = false)
        end
        ipref3 = Ref("192.168.0.74")
        srv_ed, port_ed = _presence_test_server(Perth.GANTT_HUB, ipref3)
        srv_ve, port_ve = _presence_test_server(Perth.GANTT_HUB, ipref3; readonly = true)
        try
            Perth.SERVER[] = dummy2
            Perth.GANTT_SHARED[] = true
            Perth.GANTT_KEY[] = "antiga"
            Perth.GANTT_VIEW_KEY[] = "so-ver"

            solta_ed = Channel{Bool}(1)
            editor = @async HTTP.WebSockets.open("ws://127.0.0.1:$port_ed") do ws
                HTTP.WebSockets.receive(ws)      # init
                take!(solta_ed)
            end
            @test _await_clients(Perth.GANTT_HUB, 1) == 1
            motivo = Ref{Any}(nothing)
            # até o "denied": no caminho vem o "join" do editor, que é ruído
            # para esta pergunta
            espectador = @async HTTP.WebSockets.open("ws://127.0.0.1:$port_ve") do ws
                for raw in ws
                    msg = JSON3.read(raw)
                    if msg["type"] == "denied"
                        motivo[] = (String(msg["type"]), String(get(msg, "reason", "")))
                        break
                    end
                end
            end
            @test _await_clients(Perth.GANTT_HUB, 2) == 2

            # trocar o link de leitura derruba quem entrou por ele...
            @test Perth.view_key!("outro") == true
            wait(espectador)
            @test motivo[] == ("denied", "key")
            # ...e não o editor, cuja chave continua certa
            @test length(Perth.GANTT_HUB.clients) == 1
            put!(solta_ed, true)
            wait(editor)
        finally
            Perth._quiet(() -> close(srv_ed))
            Perth._quiet(() -> close(srv_ve))
            Perth.GANTT_KEY[], Perth.GANTT_VIEW_KEY[] = key2, view2
            Perth.GANTT_SHARED[] = was2
            Perth.SERVER[] = nothing
            Perth._quiet(() -> close(dummy2))
            _await_clients(Perth.GANTT_HUB, 0)
        end
    end

    @testset "imagem de fundo da UI" begin
        bgtmp = mktempdir()
        Perth._init_state!(bgtmp)

        # PNG 1x1 de verdade: o sniff olha os bytes, não a extensão
        png = UInt8[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
                    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
                    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
                    0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89]
        img = joinpath(bgtmp, "fundo.png")
        write(img, png)

        # sem fundo apontado: nada aplicado e a rota devolve 404
        @test Perth.background() === nothing
        @test Perth._bg_payload().set == false
        @test Perth._bg_response().status == 404

        @test Perth.background!(img) == img
        @test Perth.background() == img
        info = Perth._bg_payload()
        @test info.set == true
        @test info.name == "fundo.png"
        @test startswith(info.url, "/background?v=")
        @test info.opacity == Perth._BG_DEFAULT_OPACITY

        resp = Perth._bg_response()
        @test resp.status == 200
        @test HTTP.header(resp, "Content-Type") == "image/png"
        @test resp.body == png

        # a versão na URL muda quando a imagem muda — senão o navegador (e o
        # service worker, que é network-first) serviria a foto antiga
        v1 = Perth._bg_payload().url
        sleep(0.01)
        write(img, vcat(png, UInt8[0x00]))
        @test Perth._bg_payload().url != v1

        # opacidade: ajustável sozinha e presa a [0, 1]
        @test Perth.background!(opacity = 0.42) == 0.42
        @test Perth._bg_payload().opacity == 0.42
        @test Perth.background() == img            # imagem intacta
        @test Perth.background!(opacity = 3.5) == 1.0
        @test Perth.background!(opacity = -1) == 0.0

        # persistência: vive no settings.json, junto das outras preferências
        Perth.background!(img; opacity = 0.3)
        @test isfile(joinpath(bgtmp, "settings.json"))
        Perth._init_state!(bgtmp)                  # recarrega do disco
        @test Perth.background() == img
        @test Perth._bg_payload().opacity == 0.3

        # validação: o que não for imagem de verdade não vira fundo servido
        # para a rede, por mais que a extensão diga o contrário
        fake = joinpath(bgtmp, "cavalo-de-troia.png")
        write(fake, "isto é texto, não uma imagem")
        @test_throws ArgumentError Perth.background!(fake)
        @test_throws ArgumentError Perth.background!(joinpath(bgtmp, "nao-existe.png"))
        @test Perth.background() == img            # o fundo válido continua

        # formatos aceitos (por assinatura) e recusados
        @test Perth._bg_sniff(png) == "image/png"
        @test Perth._bg_sniff(vcat(UInt8[0xFF, 0xD8, 0xFF], zeros(UInt8, 12))) == "image/jpeg"
        @test Perth._bg_sniff(vcat(Vector{UInt8}("GIF89a"), zeros(UInt8, 12))) == "image/gif"
        @test Perth._bg_sniff(vcat(Vector{UInt8}("RIFF"), zeros(UInt8, 4),
                                   Vector{UInt8}("WEBP"), zeros(UInt8, 4))) == "image/webp"
        # AVIF: imagem parada ("avif") e sequência animada ("avis"). Quem
        # decide é a marca — a mesma caixa ftyp carrega MP4, que fica de fora.
        @test Perth._bg_sniff(vcat(zeros(UInt8, 4), Vector{UInt8}("ftypavif"),
                                   zeros(UInt8, 4))) == "image/avif"
        @test Perth._bg_sniff(vcat(zeros(UInt8, 4), Vector{UInt8}("ftypavis"),
                                   zeros(UInt8, 4))) == "image/avif"
        @test Perth._bg_sniff(vcat(zeros(UInt8, 4), Vector{UInt8}("ftypmp42"),
                                   zeros(UInt8, 4))) === nothing
        @test Perth._bg_sniff(Vector{UInt8}("<svg xmlns=\"http://www.w3.org/2000/svg\">")) === nothing
        @test Perth._bg_sniff(UInt8[1, 2, 3]) === nothing

        # imagem apagada do disco depois de apontada: degrada para "sem
        # fundo" em vez de quebrar a página
        rm(img)
        @test Perth.background() === nothing
        @test Perth._bg_payload().set == false
        @test Perth._bg_response().status == 404

        Perth.background_clear!()
        @test Perth.background() === nothing
        @test !haskey(Perth._state().settings, Perth._BG_KEY)

        # a rota do kanban serve os mesmos bytes (setting único, data dir
        # compartilhado) e não depende da whitelist de estáticos
        write(img, png)
        Perth.background!(img)
        kresp = Perth._kanban_static(HTTP.Request("GET", "/background"), "127.0.0.1")
        @test kresp.status == 200
        @test kresp.body == png
        kinfo = JSON3.read(Perth._kanban_static(
            HTTP.Request("GET", "/api/background"), "127.0.0.1").body)
        @test kinfo["set"] == true

        # e a rota do gantt idem, pelo router de verdade
        groute = Perth._build_router()(HTTP.Request("GET", "/background"))
        @test groute.status == 200
        @test groute.body == png

        # trocar a imagem avisa os navegadores conectados pelo WS — é o que
        # faz o fundo mudar sem reload (o payload é o mesmo de /api/background)
        Perth.background_clear!()
        dummy = Perth._quiet() do
            HTTP.listen!(http -> nothing, "127.0.0.1", 0; verbose = false)
        end
        Perth.SERVER[] = dummy                 # _bg_broadcast só fala com servidor no ar
        ipref = Ref("192.168.0.88")
        server, port = _presence_test_server(Perth.GANTT_HUB, ipref)
        try
            got = Ref{Any}(nothing)
            t = @async HTTP.WebSockets.open("ws://127.0.0.1:$port") do ws
                HTTP.WebSockets.receive(ws)    # init
                got[] = JSON3.read(HTTP.WebSockets.receive(ws))
            end
            @test _await_clients(Perth.GANTT_HUB, 1) == 1
            Perth.background!(img; opacity = 0.25)
            wait(t)
            @test got[]["type"] == "background"
            @test got[]["set"] == true
            @test got[]["opacity"] == 0.25
            @test startswith(got[]["url"], "/background?v=")
        finally
            Perth._quiet(() -> close(server))
            Perth._quiet(() -> close(dummy))
            Perth.SERVER[] = nothing
            lock(Perth.GANTT_HUB.lock) do
                empty!(Perth.GANTT_HUB.clients)
            end
        end

        Perth.background_clear!()
        Perth._init_state!(tmp)   # devolve o estado global do resto da suíte
    end

    @testset "fundo da UI: rotação de imagens" begin
        bgtmp = mktempdir()
        Perth._init_state!(bgtmp)
        png(n) = vcat(UInt8[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
                      fill(UInt8(n), 24))
        jpg = vcat(UInt8[0xFF, 0xD8, 0xFF], fill(UInt8(9), 24))

        pasta = joinpath(bgtmp, "fundos")
        mkpath(pasta)
        write(joinpath(pasta, "b.png"), png(2))
        write(joinpath(pasta, "a.png"), png(1))
        write(joinpath(pasta, "c.jpg"), jpg)
        # o que a pasta tem e não serve: ignorado, não é erro
        write(joinpath(pasta, "leiame.txt"), "não sou imagem")
        write(joinpath(pasta, "mentira.png"), "extensão .png, conteúdo de texto")
        mkpath(joinpath(pasta, "subpasta"))
        write(joinpath(pasta, "subpasta", "d.png"), png(4))

        got = Perth.background!(pasta)
        @test got isa Vector{String}
        # ordenada por nome: é a ordem que todos os navegadores usam para
        # concordar sobre qual foto está em exibição agora
        @test basename.(got) == ["a.png", "b.png", "c.jpg"]
        @test Perth.backgrounds() == got
        @test Perth.background() == got[1]        # a primeira, para quem só quer uma

        info = Perth._bg_payload()
        @test info.set == true
        @test length(info.images) == 3
        @test info.name == "a.png"                 # compat: descreve a primeira
        @test info.url == info.images[1].url
        @test info.url == first(info.images).url && !occursin("i=", info.url)
        @test occursin("i=1&", info.images[2].url) && occursin("i=2&", info.images[3].url)
        @test [i.name for i in info.images] == ["a.png", "b.png", "c.jpg"]
        @test info.interval == Perth._BG_DEFAULT_INTERVAL

        # cada índice serve os bytes da sua imagem; fora da faixa é 404
        @test Perth._bg_response(0).body == png(1)
        @test Perth._bg_response(1).body == png(2)
        @test Perth._bg_response(2).body == jpg
        @test HTTP.header(Perth._bg_response(2), "Content-Type") == "image/jpeg"
        @test Perth._bg_response(3).status == 404
        @test Perth._bg_response(-1).status == 404
        # o índice vem da query (?i=N); lixo vira a primeira, não erro
        @test Perth._bg_response(HTTP.Request("GET", "/background?i=1")).body == png(2)
        @test Perth._bg_response(HTTP.Request("GET", "/background")).body == png(1)
        @test Perth._bg_response(HTTP.Request("GET", "/background?i=abc")).body == png(1)

        # a lista é CONGELADA: o que cair na pasta depois não é publicado
        # para a rede sem alguém apontar de novo
        write(joinpath(pasta, "intrusa.png"), png(7))
        @test length(Perth._bg_payload().images) == 3
        @test Perth._bg_response(3).status == 404
        Perth.background!(pasta)                   # apontar de novo é que inclui
        @test length(Perth._bg_payload().images) == 4

        # apagar um arquivo encurta a rotação em vez de dar 404 no meio dela
        rm(joinpath(pasta, "intrusa.png"))
        rm(joinpath(pasta, "b.png"))
        @test basename.(Perth.backgrounds()) == ["a.png", "c.jpg"]
        @test Perth._bg_response(1).body == jpg
        @test Perth._bg_response(2).status == 404

        # intervalo: persistente, ajustável sozinho, e 0 desliga a rotação
        @test Perth._bg_interval() == Perth._BG_DEFAULT_INTERVAL
        Perth.background!(interval = 15)
        @test Perth._bg_interval() == 15
        @test Perth._bg_payload().interval == 15
        Perth.background!(interval = 0)
        @test Perth._bg_payload().interval == 0
        Perth.background!(interval = 90)
        @test_throws ArgumentError Perth.background!()   # sem imagem nem ajuste

        # persistência no settings.json (a lista vai como JSON)
        @test isfile(joinpath(bgtmp, "settings.json"))
        Perth._init_state!(bgtmp)
        @test length(Perth.backgrounds()) == 2
        @test Perth._bg_interval() == 90

        # lista explícita: aqui um caminho ruim é engano de quem digitou e
        # aborta a chamada, ao contrário do descarte silencioso da pasta
        solta = joinpath(bgtmp, "solta.png")
        write(solta, png(5))
        @test Perth.background!([solta, joinpath(pasta, "a.png")]) ==
              [solta, joinpath(pasta, "a.png")]
        @test length(Perth.backgrounds()) == 2
        @test_throws ArgumentError Perth.background!([solta, joinpath(pasta, "leiame.txt")])
        @test_throws ArgumentError Perth.background!(String[])
        @test length(Perth.backgrounds()) == 2     # a rotação válida continua
        # duplicatas somem: duas entradas iguais girariam para a mesma foto
        @test length(Perth.background!([solta, solta])) == 1

        # uma imagem só volta a gravar no formato antigo (_BG_KEY), que é o
        # que um Perth anterior a esta feature sabe ler
        Perth.background!(solta)
        @test Perth._state().settings[Perth._BG_KEY] == solta
        @test !haskey(Perth._state().settings, Perth._BG_LIST_KEY)
        @test Perth._bg_payload().interval == 0    # uma imagem não gira
        @test length(Perth._bg_payload().images) == 1

        # e apontar uma pasta volta a gravar a lista, limpando a chave antiga
        Perth.background!(pasta)
        @test haskey(Perth._state().settings, Perth._BG_LIST_KEY)
        @test !haskey(Perth._state().settings, Perth._BG_KEY)
        Perth.background_clear!()
        @test isempty(Perth.backgrounds()) && Perth.background() === nothing
        @test !haskey(Perth._state().settings, Perth._BG_LIST_KEY)

        # pasta sem nenhuma imagem utilizável é erro, não rotação vazia
        vazia = joinpath(bgtmp, "vazia")
        mkpath(vazia)
        @test_throws ArgumentError Perth.background!(vazia)
        write(joinpath(vazia, "x.txt"), "nada aqui")
        @test_throws ArgumentError Perth.background!(vazia)

        # a rota do kanban entende o índice do mesmo jeito que a do gantt
        Perth.background!(pasta)
        krot = Perth._kanban_static(HTTP.Request("GET", "/background?i=1"), "127.0.0.1")
        @test krot.status == 200 && krot.body == Perth._bg_response(1).body
        grot = Perth._build_router()(HTTP.Request("GET", "/background?i=1"))
        @test grot.status == 200 && grot.body == krot.body

        Perth.background_clear!()
        Perth._init_state!(tmp)
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
        shared_files = ("ui.css", "presence.js", "i18n.js", "draggable.js",
                        "background.js")
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

    @testset "kanban: nome de board com acento" begin
        # Regressão de uso real: _slugify jogava fora o caractere acentuado
        # em vez de transliterá-lo, então "cálculo" virava "clculo" — quem
        # digitasse o nome com e sem acento ficava com DOIS boards, sem
        # aviso nenhum. Havia um par assim num diretório de dados de verdade.
        @test Perth._slugify("cálculo") == "calculo"
        @test Perth._slugify("cálculo") == Perth._slugify("calculo")
        @test Perth._slugify("estatística") == "estatistica"
        @test Perth._slugify("Obra São Paulo") == "obra-sao-paulo"
        @test Perth._slugify("AÇÃO") == "acao"
        @test Perth._slugify("münchen") == "munchen"
        @test Perth._slugify("  Já  Foi  ") == "ja-foi"
        # nome que era inválido por ser só de acentuados agora funciona
        @test Perth._slugify("ação") == "acao"
        @test_throws ArgumentError Perth._slugify("")
        @test_throws ArgumentError Perth._slugify("!!!")

        # o slug antigo continua sendo o que era: é dele que sai o fallback
        @test Perth._legacy_slug("cálculo") == "clculo"
        @test Perth._legacy_slug("") == ""

        # board gravado antes do conserto continua respondendo pelo nome
        # que o criou, em vez de sumir atrás de um slug novo
        sdir = mktempdir()
        @test Perth._board_slug(sdir, "cálculo") == "calculo"   # nada em disco: o certo
        write(joinpath(sdir, "kanban-clculo.json"), "{\"columns\":[]}")
        @test Perth._board_slug(sdir, "cálculo") == "clculo"    # só o antigo: acha
        @test Perth._board_slug(sdir, "clculo") == "clculo"     # pelo slug literal também
        write(joinpath(sdir, "kanban-calculo.json"), "{\"columns\":[]}")
        @test Perth._board_slug(sdir, "cálculo") == "calculo"   # os dois: o certo ganha
        @test Perth._board_slug(sdir, "board") == "board"       # default intocado

        # ponta a ponta: abrir "cálculo" carrega o board gravado como
        # "clculo", com o conteúdo dele, e não cria um arquivo novo
        adir = mktempdir()
        Perth._init_kanban!(adir; name = "cálculo")
        kanban_add_card!("backlog", "de antes do conserto")
        antigo = joinpath(adir, "kanban-clculo.json")
        mv(joinpath(adir, "kanban-calculo.json"), antigo)       # simula o arquivo velho
        Perth._init_kanban!(adir; name = "cálculo")
        @test Perth._kanban_state().name == "clculo"
        @test [c.text for c in kanban_cards()] == ["de antes do conserto"]
        @test !isfile(joinpath(adir, "kanban-calculo.json"))

        Perth._init_kanban!(mktempdir())   # devolve o estado global do resto da suíte
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
                # o motivo é o que separa "falta a chave" de "parou de
                # transmitir" na UI: um pede a chave, o outro oferece retry
                @test denied["reason"] == "key"
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

    @testset "ponte de campos: boards que não estão carregados" begin
        # Regressão de uso real: a ponte só espelhava no board ATIVO, então
        # um card vinculado num board qualquer parava de acompanhar o gantt
        # assim que você trocasse de board — e não se recuperava, porque
        # voltar ao board só relê o arquivo, que já estava velho. Com o
        # kanban tendo um board por vez, bastava ter dois para a ponte
        # deixar de valer no segundo.
        # um diretório só, como em produção: o board vive no mesmo data
        # dir dos projetos (os .json de projeto não colidem — a varredura
        # olha só o prefixo kanban)
        bdir = mktempdir()
        Perth._init_state!(bdir)
        Perth._init_kanban!(bdir; name = "obra")
        p = create_project("Dois boards")
        t = add_task!(p, "Original"; start = Date(2026, 9, 1), duration = 3,
                      assignee = "Ana")
        kanban_from_project!(p)
        @test [c.text for c in kanban_cards()] == ["Original"]

        cardsof(slug) = begin      # lê o board direto do arquivo
            file = first(Perth._board_paths(bdir, slug))
            b = Perth._plain(JSON3.read(read(file, String)))
            [card for col in b["columns"] for card in col["cards"]]
        end

        # troca de board e edita a tarefa: o card do board "obra" tem de
        # acompanhar mesmo estando só em disco
        kanban_board!("outro")
        update_task!(project("Dois boards"), t.id;
                     name = "Renomeada", assignee = "Bruno", duration = 6,
                     progress = 100)
        card = only(cardsof("obra"))
        @test String(card["text"]) == "Renomeada"
        @test String(card["assignee"]) == "Bruno"
        @test String(card["due"]) == "2026-09-06"
        @test card["done"] === true
        # done_at é o que alimenta o auto-arquivamento: o board em disco não
        # pode ficar num formato que o board carregado nunca produziria
        @test haskey(card, "done_at")

        # reabrir o board mostra o que o gantt gravou, sem surpresa
        kanban_board!("obra")
        @test [c.text for c in kanban_cards()] == ["Renomeada"]

        # reabrir o gantt na direção contrária continua funcionando
        update_task!(project("Dois boards"), t.id; progress = 0)
        @test only(cardsof("obra"))["done"] === false
        @test !haskey(only(cardsof("obra")), "done_at")

        # esvaziar o responsável apaga a chave, como faz o setAssignee
        kanban_board!("outro")
        update_task!(project("Dois boards"), t.id; assignee = "")
        @test !haskey(only(cardsof("obra")), "assignee")

        # board sem card do projeto não é regravado: a porta barata (o id do
        # projeto no texto cru) evita fazer parse de tudo a cada save
        vazio = first(Perth._board_paths(bdir, "outro"))
        Perth._kanban_persist(Perth._kanban_state())
        antes = mtime(vazio)
        sleep(0.05)
        update_task!(project("Dois boards"), t.id; name = "Outra vez")
        @test mtime(vazio) == antes

        # arquivo de board ilegível não derruba o salvamento do projeto.
        # Precisa citar o id do projeto: sem isso a porta barata o descarta
        # antes de qualquer parse — que é o comportamento desejado, e o
        # motivo de lixo solto no diretório não custar nem um aviso.
        quebrado = joinpath(bdir, "kanban-quebrado.json")
        write(quebrado, "{ isto não é json, mas cita " * p.id)
        @test_logs (:warn,) match_mode = :any begin
            update_task!(project("Dois boards"), t.id; name = "Depois do lixo")
        end
        @test String(only(cardsof("obra"))["text"]) == "Depois do lixo"
        rm(quebrado)
        # lixo que NÃO cita o projeto nem é aberto: nenhum aviso
        write(joinpath(bdir, "kanban-lixo.json"), "{ nem json nem projeto")
        @test_logs min_level = Logging.Warn begin
            update_task!(project("Dois boards"), t.id; name = "Depois do lixo 2")
        end

        # e vale com o kanban NUNCA aberto nesta sessão: os cards estão em
        # disco independentemente de alguém ter olhado o board
        antigo = Perth.KANBAN[]
        try
            Perth.KANBAN[] = nothing
            update_task!(project("Dois boards"), t.id; name = "Sem kanban aberto")
            @test String(only(cardsof("obra"))["text"]) == "Sem kanban aberto"
        finally
            Perth.KANBAN[] = antigo
        end

        Perth._init_kanban!(mktempdir())
    end

    include("splash.jl")

end