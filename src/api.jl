# API REST consumida pelo frontend. Convenções:
#   GET    /api/rev                  -> {"rev": N}  (polling de mudanças)
#   GET    /api/projects             -> lista resumida
#   POST   /api/projects             -> cria projeto {name}
#   GET    /api/projects/{id}        -> projeto completo
#   PUT    /api/projects/{id}        -> substitui o projeto inteiro
#   DELETE /api/projects/{id}        -> remove
#   POST   /api/import               -> importa um projeto de JSON exportado
#   GET    /api/projects/{id}/export -> download do JSON
#   PUT    /api/projects/{id}/path   -> vincula/desvincula arquivo .perth.jl {path}
#   GET    /api/fs/complete?q=...    -> autocomplete de caminhos p/ a caixa da menubar
#   GET    /api/fs/list?dir=...      -> navegador de pastas (atalhos do sistema, subdirs)

const _JSON_HEADERS = ["Content-Type" => "application/json; charset=utf-8"]

_json(x; status = 200) = HTTP.Response(status, _JSON_HEADERS, JSON3.write(x))
_error(msg; status = 400) = _json((; error = msg); status)

# Envolve um handler com tratamento uniforme de erros
function _handled(f)
    return function (req::HTTP.Request)
        try
            return f(req)
        catch err
            err isa KeyError && return _error("not found"; status = 404)
            # Erro que o próprio Perth levantou para ser lido por gente. O
            # caso vivo é o calendário de dias úteis sem `using BusinessDays`:
            # a exceção diz exatamente o que fazer, e a tela mostrava
            # "internal error" — escondendo a única frase que resolvia. Só as
            # nossas (prefixo "Perth: ") atravessam; o resto continua 500 sem
            # detalhe, porque aí é bug nosso e não assunto do navegador.
            if err isa ErrorException && startswith(err.msg, "Perth: ")
                return _error(err.msg; status = 409)
            end
            @error "Perth: unhandled API error" error = (err, catch_backtrace())
            return _error("internal error"; status = 500)
        end
    end
end

function _get_rev(::HTTP.Request)
    _with_state(st -> _json((; rev = st.rev)))
end

_actor(req::HTTP.Request) = something(HTTP.header(req, "X-Perth-Peer", nothing), "browser")

function _get_activity(::HTTP.Request)
    _with_state(st -> _json(
        [(at = String(e["at"]), by = String(e["ip"]), text = String(e["text"]))
         for e in reverse(st.log[max(1, end - 99):end])]))
end

# Descreve o diff entre duas versões do projeto para o log de atividades.
# Cap de 6 entradas: um PUT normalmente muda 1-2 coisas.
function _describe_diff(old::Project, new::Project)
    out = String[]
    snip(x) = length(x) > 40 ? first(x, 37) * "…" : x
    oldby = Dict(t.id => t for t in old.tasks)
    newby = Dict(t.id => t for t in new.tasks)
    old.name != new.name &&
        push!(out, "renamed project to \"$(snip(new.name))\"")
    if old.people != new.people
        # por nome: mexer no cargo de alguém não é "cadastrou/descadastrou"
        antes  = [pe.name for pe in old.people]
        depois = [pe.name for pe in new.people]
        entrou = setdiff(depois, antes)
        saiu   = setdiff(antes, depois)
        isempty(entrou) || push!(out, "registered " * join(snip.(entrou), ", "))
        isempty(saiu)   || push!(out, "unregistered " * join(snip.(saiu), ", "))
    end
    for t in new.tasks
        haskey(oldby, t.id) || push!(out, "added \"$(snip(t.name))\"")
    end
    for t in old.tasks
        haskey(newby, t.id) || push!(out, "deleted \"$(snip(t.name))\"")
    end
    for t in new.tasks
        o = get(oldby, t.id, nothing)
        o === nothing && continue
        o.name != t.name &&
            push!(out, "renamed \"$(snip(o.name))\" to \"$(snip(t.name))\"")
        if o.progress != t.progress
            push!(out, t.progress >= 100 ? "completed \"$(snip(t.name))\"" :
                "set \"$(snip(t.name))\" to $(t.progress)%")
        end
        (o.start != t.start || o.duration != t.duration) &&
            push!(out, "rescheduled \"$(snip(t.name))\" ($(t.start), $(t.duration)d)")
        length(out) >= 6 && return out[1:6]
    end
    return out
end

function _list_projects(::HTTP.Request)
    _json(projects())
end

function _create_project(req::HTTP.Request)
    body = JSON3.read(String(req.body))
    name = strip(get(body, :name, ""))
    isempty(name) && return _error("field 'name' is required")
    p = create_project(name)
    _with_state(st -> _log_activity!(st, _actor(req), "project",
                                     "created project \"$(p.name)\""))
    _json(p; status = 201)
end

function _get_project(req::HTTP.Request)
    id = HTTP.getparams(req)["id"]
    _with_state(st -> begin
        haskey(st.projects, id) || return _error("not found"; status = 404)
        _json(st.projects[id])
    end)
end

# PUT substitui o projeto inteiro: simples e robusto para o frontend,
# que envia o estado completo (debounced) após cada edição.
function _put_project(req::HTTP.Request)
    id = HTTP.getparams(req)["id"]
    incoming = JSON3.read(String(req.body), Project)
    incoming.id = id  # o id da URL é canônico
    base = HTTP.header(req, "X-Perth-Base", "")
    actor = _actor(req)
    _with_state(st -> begin
        haskey(st.projects, id) || return _error("not found"; status = 404)
        old = st.projects[id]
        # Guarda de conflito: rejeita apenas quando a base do cliente é
        # ESTRITAMENTE mais velha que o carimbo do servidor — comparando
        # DateTime parseado, nunca strings. Base ilegível ou igual/mais nova
        # passa: a guarda protege contra sobrescrever edição alheia, não pune
        # o próprio cliente.
        if !isempty(base)
            base_dt = tryparse(DateTime, base)
            if base_dt !== nothing && base_dt < old.updated_at
                return HTTP.Response(409, _JSON_HEADERS, JSON3.write(old))
            end
        end
        incoming.created_at = old.created_at
        st.projects[id] = incoming
        for text in _describe_diff(old, incoming)
            _log_activity!(st, actor, "edit", "$(text) — $(incoming.name)")
        end
        _save!(st, incoming)
        _json(incoming)
    end)
end

function _delete_project(req::HTTP.Request)
    id = HTTP.getparams(req)["id"]
    name = _with_state(st -> haskey(st.projects, id) ? st.projects[id].name : "")
    ok = _with_state(st -> _delete!(st, id))
    ok && _with_state(st -> _log_activity!(st, _actor(req), "project",
                                           "deleted project \"$(name)\""))
    ok ? _json((; ok = true)) : _error("not found"; status = 404)
end

function _import_project(req::HTTP.Request)
    body = String(req.body)
    # Sniff do formato: JSON legado começa com '{'; planilha se a primeira
    # linha for um cabeçalho com a coluna `name`; senão, .perth.jl.
    #
    # O nome do projeto vem da QUERY porque o CSV não tem onde carregá-lo: é
    # uma tabela de tarefas, não um projeto. O navegador manda o nome do
    # arquivo, que é onde a exportação tinha guardado o nome do projeto — a
    # volta pega de onde a ida deixou.
    nome = strip(get(HTTP.URIs.queryparams(HTTP.URI(req.target)), "name", ""))
    p = try
        s = lstrip(body)
        startswith(s, "{") ? JSON3.read(body, Project) :
            _csv_looks_like(s) ? _project_from_csv(body, nome) :
            _parse_project_source(body)
    catch err
        msg = err isa ArgumentError ? err.msg : "unrecognized project file"
        return _error(msg)
    end
    isempty(strip(p.name)) && return _error("project has no name")
    # Caminho de espelhamento é específico da máquina: um JSON legado vindo
    # de outro computador não deve sobrescrever arquivos silenciosamente aqui
    p.file_path = ""
    _with_state(st -> begin
        # Se o id já existe, gera um novo para não sobrescrever silenciosamente
        haskey(st.projects, p.id) && (p.id = _short_id())
        st.projects[p.id] = p
        _save!(st, p)
    end)
    _json(p; status = 201)
end

function _export_project(req::HTTP.Request)
    id = HTTP.getparams(req)["id"]
    _with_state(st -> begin
        haskey(st.projects, id) || return _error("not found"; status = 404)
        p = st.projects[id]
        fname = replace(lowercase(p.name), r"[^a-z0-9]+" => "-")
        HTTP.Response(200, [
            "Content-Type" => "text/x-julia; charset=utf-8",
            "Content-Disposition" => "attachment; filename=\"$(fname).perth.jl\"",
        ], _to_julia_source(p))
    end)
end

# Vincula (ou desvincula, com path vazio) o projeto a um arquivo .perth.jl
# no disco — a caixa de caminho da menubar, estilo Pluto. O arquivo é escrito
# na hora e re-escrito a cada salvamento (ver _save! em storage.jl).
function _put_path(req::HTTP.Request)
    id = HTTP.getparams(req)["id"]
    body = JSON3.read(String(req.body))
    raw = strip(String(get(body, :path, "")))
    _with_state(st -> begin
        haskey(st.projects, id) || return _error("not found"; status = 404)
        p = st.projects[id]
        if isempty(raw)
            p.file_path = ""
            _save!(st, p)
            return _json(p)
        end
        path = try
            _resolve_save_path(p, raw)
        catch err
            err isa ArgumentError && return _error(err.msg)
            rethrow()
        end
        try
            write(path, _to_julia_source(p))
        catch err
            return _error("cannot write file: $(sprint(showerror, err))")
        end
        p.file_path = path
        _save!(st, p)
        _remember_save_dir!(st, path)
        _json(p)
    end)
end

# Atalhos "do explorer": Home + pastas conhecidas do usuário. No Linux os
# nomes podem estar localizados (Documentos, Área de Trabalho…), então lê
# ~/.config/user-dirs.dirs (XDG) quando existir; senão tenta os nomes usuais,
# que cobrem Windows e macOS.
function _system_places()
    home = homedir()
    places = [(label = "Home", path = home)]
    xdg = Dict{String,String}()
    userdirs = joinpath(home, ".config", "user-dirs.dirs")
    if isfile(userdirs)
        try
            for line in eachline(userdirs)
                m = match(r"^XDG_(\w+)_DIR=\"(.*)\"\s*$", line)
                m === nothing && continue
                xdg[m.captures[1]] = replace(m.captures[2], "\$HOME" => home)
            end
        catch
            # arquivo ilegível: segue com os nomes usuais
        end
    end
    for (key, fallback, label) in (("DESKTOP", "Desktop", "Desktop"),
                                   ("DOCUMENTS", "Documents", "Documents"),
                                   ("DOWNLOAD", "Downloads", "Downloads"))
        dir = get(xdg, key, joinpath(home, fallback))
        isdir(dir) && dir != home && push!(places, (label = label, path = dir))
    end
    return places
end

# Navegador de diretórios da caixa de caminho: devolve os subdiretórios de
# `dir` (ou do último diretório escolhido / home, se `dir` vazio), os
# atalhos do sistema e o pai — o suficiente para a UI navegar como um
# explorer. Mesmo modelo de confiança do file picker do Pluto.
function _fs_list(req::HTTP.Request)
    raw = get(HTTP.queryparams(HTTP.URI(req.target)), "dir", "")
    default = _with_state(st -> get(st.settings, "default_save_dir", ""))
    dir = abspath(expanduser(isempty(strip(raw)) ?
        (isdir(default) ? default : homedir()) : strip(raw)))
    isdir(dir) || return _error("directory does not exist: $dir")
    entries = try
        readdir(dir)
    catch
        return _error("cannot read directory: $dir"; status = 403)
    end
    subdirs = String[]
    for name in sort(entries; by = lowercase)
        startswith(name, ".") && continue
        isdir(joinpath(dir, name)) && push!(subdirs, name)
        length(subdirs) >= 200 && break
    end
    parent = dirname(dir)
    _json((; dir, parent = parent == dir ? nothing : parent,
             sep = Base.Filesystem.path_separator,
             places = _system_places(), dirs = subdirs,
             is_default = dir == default))
end

# Autocomplete de caminhos ao digitar na caixa da menubar (mesmo modelo
# de confiança do Pluto: o servidor roda como o usuário, em localhost).
# Devolve até 30 entradas: diretórios (com "/" final) e arquivos .jl.
function _fs_complete(req::HTTP.Request)
    raw = get(HTTP.queryparams(HTTP.URI(req.target)), "q", "")
    isempty(strip(raw)) && (raw = "~/")
    expanded = expanduser(raw)
    dir, prefix = if isdir(expanded) && (endswith(raw, '/') || endswith(raw, '\\'))
        expanded, ""
    else
        dirname(expanded), basename(expanded)
    end
    isdir(dir) || return _json(String[])
    base = chop(raw; tail = length(prefix))  # preserva "~" como o usuário digitou
    out = String[]
    entries = try
        readdir(dir)
    catch
        return _json(String[])  # sem permissão de leitura etc.
    end
    for name in sort(entries)
        startswith(name, ".") && !startswith(prefix, ".") && continue
        startswith(lowercase(name), lowercase(prefix)) || continue
        full = joinpath(dir, name)
        if isdir(full)
            push!(out, base * name * "/")
        elseif endswith(lowercase(name), ".jl")
            push!(out, base * name)
        end
        length(out) >= 30 && break
    end
    _json(out)
end

# Análise CPM do projeto: caminho crítico, folga e término, para a UI
# Término probabilístico junto do CPM: a UI já pede /cpm a cada mudança, e
# as duas análises saem do mesmo motor — não vale uma segunda ida à rede.
# `nothing` quando ninguém estimou nada, que é o estado da maioria dos
# projetos e o sinal para a barra de status não mostrar coisa nenhuma.
function _pert_payload(p::Project)
    any(has_estimate, p.tasks) || return nothing
    f = pert_finish(p)
    return (; f.expected, f.sd_days, f.estimated, p80 = pert_date(p, 0.8))
end

function _get_cpm(req::HTTP.Request)
    id = HTTP.getparams(req)["id"]
    _with_state(st -> begin
        haskey(st.projects, id) || return _error("not found"; status = 404)
        p = st.projects[id]
        isempty(p.tasks) &&
            return _json((; cycle = false, finish = nothing,
                            calendar = p.calendar, tasks = NamedTuple[]))
        has_cycle(p) &&
            return _json((; cycle = true, finish = nothing,
                            calendar = p.calendar, tasks = NamedTuple[]))
        try
            c = _cpm(_leaf_view(p))
            # Os dias não úteis da janela do projeto, com folga dos dois lados
            # para o arrasto não sair da tabela. É com isto que o navegador
            # calcula onde uma tarefa termina — antes ele somava dias
            # CORRIDOS e desenhava uma barra curta demais em todo plano com
            # calendário de dias úteis.
            d0, d1 = span(p)
            folga = Dates.Day(90)
            _json((; cycle = false, finish = c.finish, calendar = p.calendar,
                     tasks = slack(p), pert = _pert_payload(p),
                     nonworking = _nonworking_days(p, d0 - folga, d1 + folga)))
        catch err
            # Calendário de dias úteis sem BusinessDays carregado no servidor
            err isa ErrorException && return _error(err.msg; status = 409)
            rethrow()
        end
    end)
end

# Reprograma o projeto (schedule!) e devolve o estado atualizado
function _post_schedule(req::HTTP.Request)
    id = HTTP.getparams(req)["id"]
    p = _with_state(st -> get(st.projects, id, nothing))
    p === nothing && return _error("not found"; status = 404)
    try
        schedule!(p)
    catch err
        err isa ArgumentError && return _error(err.msg; status = 409)
        err isa ErrorException && return _error(err.msg; status = 409)
        rethrow()
    end
    return _json(p)
end

# Nivela o projeto (level!) e devolve o estado atualizado. Irmão de
# _post_schedule: o mesmo motor visto do outro lado — lá a restrição é
# dependência, aqui é capacidade —, e por isso a mesma forma de resposta.
function _post_level(req::HTTP.Request)
    id = HTTP.getparams(req)["id"]
    p = _with_state(st -> get(st.projects, id, nothing))
    p === nothing && return _error("not found"; status = 404)
    antes = Dict(t.id => t.start for t in p.tasks)
    try
        level!(p)
    catch err
        # Ciclo de dependência e "ninguém declarou capacidade" chegam como
        # ArgumentError; calendário de dias úteis sem BusinessDays no
        # servidor, como ErrorException. Os três são coisas que o plano diz,
        # não falhas — 409 com o texto do motor, como no auto-schedule.
        err isa ArgumentError && return _error(err.msg; status = 409)
        err isa ErrorException && return _error(err.msg; status = 409)
        rethrow()
    end
    # Resumo derivam dos filhos: um resumo que andou não é uma tarefa que
    # alguém moveu, é a consequência de uma que moveu.
    n = count(t -> !_has_children(p, t.id) && get(antes, t.id, t.start) != t.start,
              p.tasks)
    # O que sobrou merece a mesma linha do diário que o que foi resolvido: um
    # plano com mais trabalho do que capacidade não nivela, e o registro que
    # só conta o sucesso é o registro que mente. Só conta quem declarou
    # capacidade — o resto o motor nem tentou.
    sobra = length(unique((r.assignee, r.date)
                          for r in workload(p) if r.over && r.capacity > 0))
    _with_state(st -> _log_activity!(st, _actor(req), "edit",
        "levelled $(n) task$(n == 1 ? "" : "s")" *
        (sobra == 0 ? "" : ", $(sobra) day$(sobra == 1 ? "" : "s") still over") *
        " — $(p.name)"))
    return _json(p)
end

# Aplica as estimativas de três pontos (pert!) e devolve o projeto —
# irmão de _post_schedule: a UI recarrega o resultado do motor em vez de
# recalcular te no navegador.
function _post_pert(req::HTTP.Request)
    id = HTTP.getparams(req)["id"]
    p = _with_state(st -> get(st.projects, id, nothing))
    p === nothing && return _error("not found"; status = 404)
    n = count(t -> has_estimate(t) && !t.milestone, p.tasks)
    n == 0 && return _error("no task in this project has a three-point estimate";
                            status = 409)
    pert!(p)
    _with_state(st -> _log_activity!(st, _actor(req), "edit",
        "applied $(n) PERT estimate$(n == 1 ? "" : "s") — $(p.name)"))
    return _json(p)
end

# ---------------------------------------------------------------------------
# Portas das duas ferramentas (para o botão de troca gantt<->kanban).
# O frontend monta a URL com o hostname que o navegador já usa, então
# funciona igualmente em localhost e via IP da rede (share).
function _get_apps(::HTTP.Request)
    # `version` viaja aqui, e não numa rota só dela: esta já é a resposta que
    # diz o que está de pé neste processo, e a etiqueta da barra de status
    # pergunta uma vez, no boot, junto com o resto.
    _json((; app = "gantt", gantt = PORT[],
           kanban = KANBAN_SERVER[] === nothing ? nothing : KANBAN_PORT[],
           version = _version()))
end

# Sobe o kanban a partir do botão da UI, se ainda não estiver rodando.
# Herda o diretório de dados; bind localhost (share continua sendo uma
# decisão explícita do REPL). Devolve a porta para o navegador navegar.
function _launch_kanban(::HTTP.Request)
    try
        KANBAN_SERVER[] === nothing && kanban(open_browser = false)
        return _json((; port = KANBAN_PORT[]))
    catch err
        @error "Perth: could not launch kanban from the UI" error = err
        return _error("could not start the kanban: $(sprint(showerror, err))";
                      status = 500)
    end
end

# Exporta as tarefas como CSV (planilha universal). A serialização vive em
# src/csv.jl, ao lado da leitura: ida e volta no mesmo arquivo é o que
# mantém as duas de acordo sobre o que é uma coluna.
function _export_csv(req::HTTP.Request)
    id = HTTP.getparams(req)["id"]
    p = _with_state(st -> get(st.projects, id, nothing))
    p === nothing && return _error("not found"; status = 404)
    fname = replace(p.name, r"[^\w-]" => "_") * ".csv"
    return HTTP.Response(200, ["Content-Type" => "text/csv; charset=utf-8",
        "Content-Disposition" => "attachment; filename=\"$(fname)\""],
        _to_csv(p))
end

# Renderiza o chart via extensão Makie (save_chart). Sem a extensão
# carregada, degrada com 501 + dica — mesmo padrão do QR do kanban.
function _export_chart(req::HTTP.Request)
    id = HTTP.getparams(req)["id"]
    p = _with_state(st -> get(st.projects, id, nothing))
    p === nothing && return _error("not found"; status = 404)
    fmt = get(HTTP.URIs.queryparams(HTTP.URI(req.target)), "fmt", "png")
    fmt in ("png", "pdf", "svg") || return _error("fmt must be png, pdf or svg")
    isempty(methods(save_chart)) && return _error(
        "chart export needs a Makie backend — run `using CairoMakie` in the REPL and try again";
        status = 501)
    path = tempname() * "." * fmt
    try
        Base.invokelatest(save_chart, p, path)
        mime = fmt == "png" ? "image/png" :
               fmt == "svg" ? "image/svg+xml" : "application/pdf"
        fname = replace(p.name, r"[^\w-]" => "_") * "." * fmt
        return HTTP.Response(200, ["Content-Type" => mime,
            "Content-Disposition" => "attachment; filename=\"$(fname)\""],
            read(path))
    catch err
        @error "Perth: chart export failed" error = err
        return _error("chart export failed: $(sprint(showerror, err))"; status = 500)
    finally
        isfile(path) && rm(path; force = true)
    end
end

# Marcos e prazos como .ics. O 409 é o mesmo caso do CPM: o fim planejado
# que vai na descrição do prazo depende do calendário do projeto.
function _export_ics(req::HTTP.Request)
    id = HTTP.getparams(req)["id"]
    p = _with_state(st -> get(st.projects, id, nothing))
    p === nothing && return _error("not found"; status = 404)
    body = try
        icalendar(p)
    catch err
        err isa ErrorException && return _error(err.msg; status = 409)
        rethrow()
    end
    fname = replace(p.name, r"[^\w-]" => "_") * ".ics"
    return HTTP.Response(200, ["Content-Type" => "text/calendar; charset=utf-8",
        "Content-Disposition" => "attachment; filename=\"$(fname)\""],
        body)
end

# Painel de avisos: um lugar só para o que o plano tem de errado.
#
# Nada aqui é cálculo novo — o motor já sabia de tudo isto, espalhado: o ciclo
# virava exceção ao reprogramar, o prazo estourado virava um "+8d" na barra, a
# sobrecarga acendia no painel de recursos, e o atraso contra o baseline só
# aparecia em slippage() no REPL. Faltava reunir.
#
# Ordem é por gravidade, e a gravidade é a do PLANO, não a do gosto: ciclo
# impede programar qualquer coisa; prazo estourado é compromisso quebrado;
# sobrecarga e atraso são avisos de que a coisa vai apertar.
function _get_warnings(req::HTTP.Request)
    id = HTTP.getparams(req)["id"]
    _with_state(st -> begin
        haskey(st.projects, id) || return _error("not found"; status = 404)
        p = st.projects[id]
        avisos = Dict{String,Any}[]

        # Campos, não frases. Quem monta a frase é o navegador, que sabe o
        # idioma de quem está lendo — texto pronto daqui sairia em inglês no
        # meio de uma tela traduzida, que é o defeito que a varredura de i18n
        # existe para impedir do outro lado.
        add!(kind, sev; campos...) =
            push!(avisos, merge(Dict{String,Any}("kind" => kind, "severity" => sev),
                                Dict{String,Any}(String(k) => v for (k, v) in campos)))

        ciclo = has_cycle(p)
        ciclo && add!("cycle", "error"; task_id = "")

        for r in deadline_slip(p)
            add!("deadline", "error"; task_id = r.id, task = r.name,
                 days = r.slip_days, at = string(r.deadline))
        end

        # Vencida de verdade: passou do fim e não terminou. Resumo é
        # continente, não trabalho; marco só conta feito com 100%.
        hoje = Dates.today()
        for t in p.tasks
            _has_children(p, t.id) && continue
            t.progress >= 100 && continue
            fim = end_date(p, t)
            fim < hoje || continue
            add!("overdue", "warning"; task_id = t.id, task = t.name, at = string(fim))
        end

        # other_id junto com other: o navegador precisa ACENDER as duas
        # tarefas do par (destaque "overallocated", contagem na barra de
        # status), e um nome não serve para achar uma linha — ele tinha uma
        # cópia própria da regra só por causa disso.
        for r in overallocations(p)
            add!("overallocation", "warning"; task_id = r.task1, who = r.assignee,
                 task = r.task1_name, other = r.task2_name, other_id = r.task2,
                 from = string(r.from), to = string(r.to))
        end

        # Dia estourado por UMA tarefa só. Com capacidade declarada isso
        # passou a existir — dez horas de trabalho num dia de oito, sem
        # ninguém para colidir — e é exatamente o que uma lista de PARES não
        # tem como dizer. Sem capacidade nunca acontece (a regra antiga exige
        # duas tarefas), então nada aparece em plano nenhum que não tenha
        # pedido. Agrupado por tarefa: dez dias estourados da mesma tarefa são
        # um problema, não dez.
        sozinhas = Dict{String,Vector{Any}}()
        for r in _workload_rows(p)
            (r.over && length(r.task_ids) == 1) || continue
            push!(get!(sozinhas, only(r.task_ids), Any[]), r)
        end
        nomes = Dict(t.id => t.name for t in p.tasks)
        for tid in sort!(collect(keys(sozinhas)))
            rs = sozinhas[tid]
            add!("overload", "warning"; task_id = tid, task = get(nomes, tid, ""),
                 who = first(rs).assignee, days = length(rs),
                 at = string(minimum(r.date for r in rs)),
                 effort = round(maximum(r.effort for r in rs); digits = 2),
                 capacity = first(rs).capacity)
        end

        for r in slippage(p)
            r.slip_days > 0 || continue
            add!("slippage", "warning"; task_id = r.id, task = r.name, days = r.slip_days)
        end

        # Dependência que as DATAS não cumprem: a tarefa começa antes do que
        # os predecessores permitem. Não é erro de modelagem — no Perth uma
        # dependência nunca move ninguém, quem move é schedule! —, mas era o
        # único problema do plano cuja pista era só uma seta desenhada para
        # trás no gráfico. Auto-schedule resolve; numa tarefa de data fixa
        # não resolve, e aí o aviso vale ainda mais.
        #
        # Com ciclo o CPM não tem ordem topológica para percorrer: o aviso do
        # ciclo já está na lista, e é o que precisa ser resolvido primeiro.
        if !ciclo
            byid = Dict(t.id => t for t in p.tasks)
            for r in slack(p)
                t = get(byid, r.id, nothing)
                t === nothing && continue
                r.early_start > t.start || continue
                add!("too_early", "warning"; task_id = t.id, task = t.name,
                     days = Dates.value(r.early_start - t.start),
                     at = string(r.early_start), pinned = t.pinned)
            end
        end

        _json((; warnings = avisos))
    end)
end

function _get_scurve(req::HTTP.Request)
    id = HTTP.getparams(req)["id"]
    p = _with_state(st -> get(st.projects, id, nothing))
    p === nothing && return _error("not found"; status = 404)
    return _json(_scurve(p))
end

# Carga por responsável, densificada na janela de dias do projeto (a mesma
# que o gantt desenha), pro painel indexar por deslocamento. O 409 é o
# mesmo caso do CPM: projeto com calendário de dias úteis e BusinessDays
# não carregado no servidor.
# Estatísticas por pessoa e por setor. As duas tabelas vão juntas na mesma
# resposta: o painel troca de aba sem ir à rede de novo, e as duas leituras
# do mesmo plano nunca ficam de épocas diferentes.
function _get_stats(req::HTTP.Request)
    id = HTTP.getparams(req)["id"]
    _with_state(st -> begin
        haskey(st.projects, id) || return _error("not found"; status = 404)
        p = st.projects[id]
        _json((; people = people_stats(p), teams = team_stats(p)))
    end)
end

function _get_workload(req::HTTP.Request)
    id = HTTP.getparams(req)["id"]
    p = _with_state(st -> get(st.projects, id, nothing))
    p === nothing && return _error("not found"; status = 404)
    try
        return _json(_workload_payload(p))
    catch err
        err isa ErrorException && return _error(err.msg; status = 409)
        rethrow()
    end
end

# Arquivos estáticos do frontend
# ---------------------------------------------------------------------------

const _FRONTEND_DIR = normpath(joinpath(@__DIR__, "..", "frontend"))

const _MIME = Dict(
    ".html" => "text/html; charset=utf-8",
    ".webmanifest" => "application/manifest+json",
    ".js"   => "text/javascript; charset=utf-8",
    ".css"  => "text/css; charset=utf-8",
    ".svg"  => "image/svg+xml",
    ".png"  => "image/png",
)

function _static(file::AbstractString)
    path = joinpath(_FRONTEND_DIR, file)
    return function (::HTTP.Request)
        isfile(path) || return _error("not found"; status = 404)
        mime = get(_MIME, splitext(path)[2], "application/octet-stream")
        # no-store: frontend em desenvolvimento ativo; evita CSS/JS velho
        # servido do cache do navegador mascarando correções
        HTTP.Response(200, ["Content-Type" => mime,
                            "Cache-Control" => "no-store"], read(path))
    end
end

function _build_router()
    router = HTTP.Router()
    HTTP.register!(router, "GET", "/", _static("index.html"))
    HTTP.register!(router, "GET", "/index.html", _static("index.html"))
    HTTP.register!(router, "GET", "/app.js", _static("app.js"))
    HTTP.register!(router, "GET", "/style.css", _static("style.css"))
    HTTP.register!(router, "GET", "/favicon.svg", _static("favicon.svg"))
    HTTP.register!(router, "GET", "/logo.png", _static("logo.png"))
    HTTP.register!(router, "GET", "/shared/ui.css", _static(joinpath("shared", "ui.css")))
    HTTP.register!(router, "GET", "/shared/presence.js", _static(joinpath("shared", "presence.js")))
    HTTP.register!(router, "GET", "/shared/i18n.js", _static(joinpath("shared", "i18n.js")))
    HTTP.register!(router, "GET", "/shared/draggable.js", _static(joinpath("shared", "draggable.js")))
    HTTP.register!(router, "GET", "/shared/background.js", _static(joinpath("shared", "background.js")))
    HTTP.register!(router, "GET", "/shared/shortcuts.js", _static(joinpath("shared", "shortcuts.js")))
    HTTP.register!(router, "GET", "/shared/inline.js", _static(joinpath("shared", "inline.js")))
    HTTP.register!(router, "GET", "/shared/toast.js", _static(joinpath("shared", "toast.js")))
    HTTP.register!(router, "GET", "/manifest.webmanifest", _static("manifest.webmanifest"))
    HTTP.register!(router, "GET", "/sw.js", _static(joinpath("shared", "sw.js")))

    # Fundo da UI: só leitura — quem aponta a imagem é o REPL (background.jl)
    HTTP.register!(router, "GET",    "/background",               _handled(_bg_response))
    HTTP.register!(router, "GET",    "/api/background",           _handled(_ -> _json(_bg_payload())))

    HTTP.register!(router, "GET",    "/api/rev",                  _handled(_get_rev))
    HTTP.register!(router, "GET",    "/api/activity",             _handled(_get_activity))
    HTTP.register!(router, "GET",    "/api/apps",                 _handled(_get_apps))
    HTTP.register!(router, "POST",   "/api/launch/kanban",        _handled(_launch_kanban))
    HTTP.register!(router, "GET",    "/api/projects/{id}/export.csv", _handled(_export_csv))
    HTTP.register!(router, "GET",    "/api/projects/{id}/export.ics", _handled(_export_ics))
    HTTP.register!(router, "GET",    "/api/projects/{id}/chart",  _handled(_export_chart))
    HTTP.register!(router, "GET",    "/api/projects/{id}/scurve", _handled(_get_scurve))
    HTTP.register!(router, "GET",    "/api/projects/{id}/warnings", _handled(_get_warnings))
    HTTP.register!(router, "GET",    "/api/projects/{id}/workload", _handled(_get_workload))
    HTTP.register!(router, "GET",    "/api/projects/{id}/stats",   _handled(_get_stats))
    HTTP.register!(router, "GET",    "/api/fs/complete",          _handled(_fs_complete))
    HTTP.register!(router, "GET",    "/api/fs/list",              _handled(_fs_list))
    HTTP.register!(router, "PUT",    "/api/projects/{id}/path",   _handled(_put_path))
    HTTP.register!(router, "GET",    "/api/projects/{id}/cpm",    _handled(_get_cpm))
    HTTP.register!(router, "POST",   "/api/projects/{id}/schedule", _handled(_post_schedule))
    HTTP.register!(router, "POST",   "/api/projects/{id}/level",   _handled(_post_level))
    HTTP.register!(router, "POST",   "/api/projects/{id}/pert",    _handled(_post_pert))
    HTTP.register!(router, "GET",    "/api/projects",             _handled(_list_projects))
    HTTP.register!(router, "POST",   "/api/projects",             _handled(_create_project))
    HTTP.register!(router, "GET",    "/api/projects/{id}",        _handled(_get_project))
    HTTP.register!(router, "PUT",    "/api/projects/{id}",        _handled(_put_project))
    # navigator.sendBeacon (salvamento ao fechar a aba) só envia POST
    HTTP.register!(router, "POST",   "/api/projects/{id}",        _handled(_put_project))
    HTTP.register!(router, "DELETE", "/api/projects/{id}",        _handled(_delete_project))
    HTTP.register!(router, "POST",   "/api/import",               _handled(_import_project))
    HTTP.register!(router, "GET",    "/api/projects/{id}/export", _handled(_export_project))
    return router
end
