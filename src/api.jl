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
            @error "Perth: unhandled API error" error = (err, catch_backtrace())
            return _error("internal error"; status = 500)
        end
    end
end

function _get_rev(::HTTP.Request)
    _with_state(st -> _json((; rev = st.rev)))
end

function _list_projects(::HTTP.Request)
    _json(projects())
end

function _create_project(req::HTTP.Request)
    body = JSON3.read(String(req.body))
    name = strip(get(body, :name, ""))
    isempty(name) && return _error("field 'name' is required")
    _json(create_project(name); status = 201)
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
    _with_state(st -> begin
        haskey(st.projects, id) || return _error("not found"; status = 404)
        incoming.created_at = st.projects[id].created_at
        st.projects[id] = incoming
        _save!(st, incoming)
        _json(incoming)
    end)
end

function _delete_project(req::HTTP.Request)
    id = HTTP.getparams(req)["id"]
    ok = _with_state(st -> _delete!(st, id))
    ok ? _json((; ok = true)) : _error("not found"; status = 404)
end

function _import_project(req::HTTP.Request)
    body = String(req.body)
    # Sniff do formato: JSON legado começa com '{'; senão, .perth.jl
    p = try
        startswith(lstrip(body), "{") ? JSON3.read(body, Project) :
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
            _json((; cycle = false, finish = c.finish, calendar = p.calendar,
                     tasks = slack(p)))
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

# ---------------------------------------------------------------------------
# Arquivos estáticos do frontend
# ---------------------------------------------------------------------------

const _FRONTEND_DIR = normpath(joinpath(@__DIR__, "..", "frontend"))

const _MIME = Dict(
    ".html" => "text/html; charset=utf-8",
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

    HTTP.register!(router, "GET",    "/api/rev",                  _handled(_get_rev))
    HTTP.register!(router, "GET",    "/api/fs/complete",          _handled(_fs_complete))
    HTTP.register!(router, "GET",    "/api/fs/list",              _handled(_fs_list))
    HTTP.register!(router, "PUT",    "/api/projects/{id}/path",   _handled(_put_path))
    HTTP.register!(router, "GET",    "/api/projects/{id}/cpm",    _handled(_get_cpm))
    HTTP.register!(router, "POST",   "/api/projects/{id}/schedule", _handled(_post_schedule))
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
