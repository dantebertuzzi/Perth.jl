# Board kanban colaborativo — Perth.kanban().
#
# Ao contrário do servidor Gantt (localhost, polling de revisão), o kanban é
# um servidor próprio, opcionalmente exposto à rede local (share = true),
# com sincronização por WebSocket: cada mudança é aplicada sob lock e o
# board completo vai em broadcast para todos os navegadores — em LAN isso
# custa nada e elimina qualquer lógica de reconciliação (última escrita
# vence). O mesmo canal carrega presença: cursor de cada máquina ancorado
# a elementos da página, etiquetado com nome/IP, estilo pareação do VS Code.
#
# Fiel à filosofia do pacote, o REPL opera sobre o mesmo board:
# kanban_add_card!/kanban_move_card! aparecem ao vivo na tela de todo mundo.

# ---------------------------------------------------------------------------
# Estado
# ---------------------------------------------------------------------------

mutable struct KanbanClient
    id::Int
    ws::HTTP.WebSockets.WebSocket
    ip::String
    name::String
    color::Int
end

mutable struct KanbanState
    board::Dict{String,Any}
    rev::Int
    file::String                      # kanban.json no diretório de dados
    clients::Dict{Int,KanbanClient}
    nextid::Int
    lock::ReentrantLock
    log::Vector{Any}                  # últimos eventos (cap em memória)
    logfile::String                   # kanban-log.jsonl, append-only
end

const KANBAN = Ref{Union{KanbanState,Nothing}}(nothing)
const KANBAN_SERVER = Ref{Union{HTTP.Server,Nothing}}(nothing)
const KANBAN_PORT = Ref{Int}(0)
const KANBAN_SHARED = Ref{Bool}(false)
const _KANBAN_LOG_CAP = 500
const _KANBAN_NCOLORS = 8             # espelha a paleta do frontend

# JSON3 lê de forma preguiçosa (Object/Array imutáveis); converte para
# Dict/Vector nativos para o board (e as ops) poderem ser mutados
_plain(x::JSON3.Object) = Dict{String,Any}(String(k) => _plain(v) for (k, v) in x)
_plain(x::JSON3.Array) = Any[_plain(v) for v in x]
_plain(x) = x

_default_kanban_board() = Dict{String,Any}(
    "columns" => Any[
        Dict{String,Any}("id" => "c1", "name" => "backlog", "cards" => Any[]),
        Dict{String,Any}("id" => "c2", "name" => "doing", "cards" => Any[]),
        Dict{String,Any}("id" => "c3", "name" => "done", "cards" => Any[]),
    ],
    "archive" => Any[],
    "aliases" => Dict{String,Any}(),
)

function _init_kanban!(data_dir::AbstractString)
    mkpath(data_dir)
    file = joinpath(data_dir, "kanban.json")
    board = if isfile(file)
        try
            b = _plain(JSON3.read(read(file, String)))
            haskey(b, "columns") || error("missing 'columns'")
            b
        catch err
            @warn "Perth kanban: ignoring unreadable board file" file error = err
            _default_kanban_board()
        end
    else
        _default_kanban_board()
    end
    logfile = joinpath(data_dir, "kanban-log.jsonl")
    log = Any[]
    if isfile(logfile)
        try
            lines = readlines(logfile)
            for line in lines[max(1, end - _KANBAN_LOG_CAP + 1):end]
                isempty(strip(line)) && continue
                push!(log, _plain(JSON3.read(line)))
            end
        catch err
            @warn "Perth kanban: ignoring unreadable activity log" logfile error = err
        end
    end
    KANBAN[] = KanbanState(board, 0, file, Dict{Int,KanbanClient}(), 0,
                           ReentrantLock(), log, logfile)
    return KANBAN[]
end

# Garante estado carregado; por padrão vive no mesmo diretório do Perth
function _kanban_state()
    KANBAN[] === nothing && _init_kanban!(_state().data_dir)
    return KANBAN[]::KanbanState
end

# Executa f com o lock do board; toda mutação deve usar isto
function _with_kanban(f)
    st = _kanban_state()
    lock(st.lock) do
        f(st)
    end
end

function _kanban_persist(st::KanbanState)
    tmp = st.file * ".tmp"
    try
        open(io -> JSON3.write(io, st.board), tmp, "w")
        mv(tmp, st.file; force = true)
    catch err
        @warn "Perth kanban: could not persist board" error = err
    end
    return st
end

# ---------------------------------------------------------------------------
# Operações
# ---------------------------------------------------------------------------

_kcols(st) = st.board["columns"]::Vector{Any}

# Criados sob demanda para boards salvos antes destas features existirem
_karchive(st) = get!(st.board, "archive", Any[])::Vector{Any}
_kaliases(st) = get!(st.board, "aliases", Dict{String,Any}())::Dict{String,Any}

_kanban_now() = Dates.format(Dates.now(), dateformat"yyyy-mm-dd HH:MM")

# Só a máquina do servidor (loopback) é "host": pode renomear usuários por IP
_kanban_is_host(ip::AbstractString) = ip in ("127.0.0.1", "::1")

_kfindcol(st, id) = findfirst(c -> c["id"] == id, _kcols(st))

function _kfindcard(st, id)
    for c in _kcols(st), (i, card) in enumerate(c["cards"])
        card["id"] == id && return (c, i)
    end
    return nothing
end

# Coluna por id OU nome (case-insensitive), estilo project()
function _kanban_col(st, key::AbstractString)
    for c in _kcols(st)
        (c["id"] == key || lowercase(c["name"]) == lowercase(key)) && return c
    end
    return nothing
end

# Aplica uma operação (Dict de chaves String, vinda do WS ou do REPL).
# Retorna true se o board mudou. "toIndex" chega em base 0 (protocolo JS)
# e vira base 1 com clamp — colisões simultâneas resolvem por última
# escrita vence, sem quebrar.
function _kanban_apply!(st::KanbanState, op)::Bool
    t = String(op["type"])
    if t == "addCard"
        ci = _kfindcol(st, String(op["col"])); ci === nothing && return false
        card = Dict{String,Any}("id" => String(op["id"]), "text" => String(op["text"]),
                                "done" => Bool(get(op, "done", false)))
        haskey(op, "by") && (card["by"] = String(op["by"]))
        haskey(op, "at") && (card["at"] = String(op["at"]))
        d = strip(String(get(op, "due", "")))
        isempty(d) || (card["due"] = String(d))
        dest = _kcols(st)[ci]["cards"]
        idx = haskey(op, "index") ?
            clamp(Int(op["index"]) + 1, 1, length(dest) + 1) : length(dest) + 1
        insert!(dest, idx, card)
    elseif t == "editCard"
        f = _kfindcard(st, String(op["id"])); f === nothing && return false
        f[1]["cards"][f[2]]["text"] = String(op["text"])
    elseif t == "delCard"
        f = _kfindcard(st, String(op["id"])); f === nothing && return false
        deleteat!(f[1]["cards"], f[2])
    elseif t == "moveCard"
        f = _kfindcard(st, String(op["id"])); f === nothing && return false
        ci = _kfindcol(st, String(op["toCol"])); ci === nothing && return false
        card = f[1]["cards"][f[2]]
        deleteat!(f[1]["cards"], f[2])
        dest = _kcols(st)[ci]["cards"]
        insert!(dest, clamp(Int(op["toIndex"]) + 1, 1, length(dest) + 1), card)
    elseif t == "addCol"
        cards = Any[c for c in get(op, "cards", Any[])]
        col = Dict{String,Any}("id" => String(op["id"]),
                               "name" => String(op["name"]), "cards" => cards)
        idx = haskey(op, "index") ?
            clamp(Int(op["index"]) + 1, 1, length(_kcols(st)) + 1) :
            length(_kcols(st)) + 1
        insert!(_kcols(st), idx, col)
    elseif t == "renameCol"
        ci = _kfindcol(st, String(op["id"])); ci === nothing && return false
        _kcols(st)[ci]["name"] = String(op["name"])
    elseif t == "delCol"
        ci = _kfindcol(st, String(op["id"])); ci === nothing && return false
        deleteat!(_kcols(st), ci)
    elseif t == "moveCol"
        ci = _kfindcol(st, String(op["id"])); ci === nothing && return false
        col = _kcols(st)[ci]
        deleteat!(_kcols(st), ci)
        insert!(_kcols(st), clamp(Int(op["toIndex"]) + 1, 1, length(_kcols(st)) + 1), col)
    elseif t == "setDone"
        f = _kfindcard(st, String(op["id"])); f === nothing && return false
        f[1]["cards"][f[2]]["done"] = Bool(op["done"])
    elseif t == "archiveCard"
        # arquivar exige concluído (a UI só oferece o botão nesse estado)
        f = _kfindcard(st, String(op["id"])); f === nothing && return false
        card = f[1]["cards"][f[2]]
        get(card, "done", false) === true || return false
        deleteat!(f[1]["cards"], f[2])
        entry = copy(card)
        entry["col"] = String(f[1]["name"])          # para restaurar no lugar certo
        entry["archived_at"] = _kanban_now()
        push!(_karchive(st), entry)
    elseif t == "restoreCard"
        isempty(_kcols(st)) && return false
        arch = _karchive(st)
        i = findfirst(c -> c["id"] == String(op["id"]), arch)
        i === nothing && return false
        entry = arch[i]
        deleteat!(arch, i)
        ci = findfirst(c -> c["name"] == get(entry, "col", ""), _kcols(st))
        card = Dict{String,Any}(k => v for (k, v) in entry
                                if k != "col" && k != "archived_at")
        push!(_kcols(st)[something(ci, 1)]["cards"], card)
    elseif t == "delArchived"
        arch = _karchive(st)
        i = findfirst(c -> c["id"] == String(op["id"]), arch)
        i === nothing && return false
        deleteat!(arch, i)
    elseif t == "setWip"
        # limite de WIP é sinalização, não trava: a coluna fica vermelha ao
        # estourar, mas mover continua permitido (kanban clássico)
        ci = _kfindcol(st, String(op["id"])); ci === nothing && return false
        w = Int(op["wip"])
        col = _kcols(st)[ci]
        w > 0 ? (col["wip"] = w) : delete!(col, "wip")
    elseif t == "setDue"
        f = _kfindcard(st, String(op["id"])); f === nothing && return false
        d = strip(String(get(op, "due", "")))
        card = f[1]["cards"][f[2]]
        isempty(d) ? delete!(card, "due") : (card["due"] = String(d))
    elseif t == "sortCol"
        ci = _kfindcol(st, String(op["id"])); ci === nothing && return false
        # sem prazo vai para o fim; sort é estável (empates mantêm a ordem)
        sort!(_kcols(st)[ci]["cards"], by = c -> String(get(c, "due", "9999-99-99")))
    elseif t == "setAlias"
        ip = strip(String(op["ip"]))
        isempty(ip) && return false
        name = strip(String(get(op, "name", "")))
        al = _kaliases(st)
        isempty(name) ? delete!(al, String(ip)) : (al[String(ip)] = String(name))
    else
        return false
    end
    return true
end

# Descreve a op para o log de atividades. Chamado ANTES do apply: exclusões
# e edições precisam do texto/coluna que ainda existem. Retorna
# (texto, notificar) — notificar=true dispara toast nos outros clientes
# (card novo, concluído ou excluído, como combinado).
function _kanban_describe(st::KanbanState, op)
    t = String(get(op, "type", ""))
    snip(s) = (s = String(s); length(s) > 40 ? first(s, 37) * "…" : s)
    cardtext(id) = begin
        f = _kfindcard(st, String(id))
        f === nothing ? "?" : snip(f[1]["cards"][f[2]]["text"])
    end
    colname(id) = begin
        ci = _kfindcol(st, String(id))
        ci === nothing ? "?" : String(_kcols(st)[ci]["name"])
    end
    if t == "addCard"
        return "added \"$(snip(get(op, "text", "")))\" to $(colname(op["col"]))", true
    elseif t == "editCard"
        return "edited \"$(cardtext(op["id"]))\"", false
    elseif t == "delCard"
        return "deleted \"$(cardtext(op["id"]))\"", true
    elseif t == "moveCard"
        return "moved \"$(cardtext(op["id"]))\" to $(colname(op["toCol"]))", false
    elseif t == "setDone"
        done = Bool(op["done"])
        return (done ? "completed" : "reopened") * " \"$(cardtext(op["id"]))\"", done
    elseif t == "archiveCard"
        return "archived \"$(cardtext(op["id"]))\"", false
    elseif t == "restoreCard" || t == "delArchived"
        i = findfirst(c -> c["id"] == String(op["id"]), _karchive(st))
        text = i === nothing ? "?" : snip(_karchive(st)[i]["text"])
        verb = t == "restoreCard" ? "restored" : "permanently deleted"
        return "$(verb) \"$(text)\"", false
    elseif t == "addCol"
        return "created column \"$(get(op, "name", "?"))\"", false
    elseif t == "renameCol"
        return "renamed column \"$(colname(op["id"]))\" to \"$(get(op, "name", "?"))\"", false
    elseif t == "delCol"
        return "deleted column \"$(colname(op["id"]))\"", false
    elseif t == "moveCol"
        return "reordered the columns", false
    elseif t == "setWip"
        w = Int(op["wip"])
        return (w > 0 ? "set a WIP limit of $(w) on $(colname(op["id"]))" :
                        "removed the WIP limit on $(colname(op["id"]))"), false
    elseif t == "setDue"
        d = strip(String(get(op, "due", "")))
        return (isempty(d) ? "cleared the due date of \"$(cardtext(op["id"]))\"" :
                             "set \"$(cardtext(op["id"]))\" due $(d)"), false
    elseif t == "sortCol"
        return "sorted $(colname(op["id"])) by due date", false
    elseif t == "setAlias"
        name = strip(String(get(op, "name", "")))
        return (isempty(name) ? "cleared the name of $(op["ip"])" :
                                "named $(op["ip"]) \"$(name)\""), false
    end
    return "", false
end

function _kanban_log_append(st::KanbanState, entry)
    try
        open(st.logfile, "a") do io
            JSON3.write(io, entry)
            print(io, '\n')
        end
    catch err
        @warn "Perth kanban: could not persist activity log" error = err
    end
end

# Aplica + persiste + registra no log + broadcast. Ponto único de mutação:
# WS e REPL passam por aqui, então uma edição no REPL aparece ao vivo em
# todos os navegadores — e entra no mesmo log de atividades.
function _kanban_commit!(op; from::Int = -1, actor::AbstractString = "repl")::Bool
    st = _kanban_state()
    local entry = nothing
    ok = lock(st.lock) do
        text, notify = _kanban_describe(st, op)
        changed = _kanban_apply!(st, op)
        if changed
            st.rev += 1
            _kanban_persist(st)
            if !isempty(text)
                entry = Dict{String,Any}(
                    "at" => _kanban_now(), "ip" => String(actor),
                    "type" => String(op["type"]), "text" => text,
                    "notify" => notify)
                push!(st.log, entry)
                length(st.log) > _KANBAN_LOG_CAP && popfirst!(st.log)
                _kanban_log_append(st, entry)
            end
        end
        changed
    end
    if ok
        msg = Dict{String,Any}("type" => "op", "op" => op, "rev" => st.rev,
                               "from" => from, "board" => st.board)
        entry === nothing || (msg["log"] = entry)
        _kanban_broadcast(JSON3.write(msg))
    end
    return ok
end

# ---------------------------------------------------------------------------
# API REPL (Tables-compatible onde faz sentido, como o resto do Perth)
# ---------------------------------------------------------------------------

"""
    kanban_columns() -> Vector{NamedTuple}

Columns of the shared kanban board as `(id, name, cards)` rows.
"""
kanban_columns() = _with_kanban(st ->
    [(id = String(c["id"]), name = String(c["name"]), cards = length(c["cards"]))
     for c in _kcols(st)])

"""
    kanban_cards() -> Vector{NamedTuple}

All cards on the shared kanban board as `(column, id, text)` rows —
Tables.jl-compatible, so `kanban_cards() |> DataFrame` just works.
"""
kanban_cards() = _with_kanban(st ->
    [(column = String(c["name"]), id = String(k["id"]), text = String(k["text"]))
     for c in _kcols(st) for k in c["cards"]])

"""
    kanban_add_card!(column, text) -> String

Add a card to `column` (id or name, case-insensitive) and return its id.
Connected browsers update live.
"""
function kanban_add_card!(column::AbstractString, text::AbstractString)
    col = _with_kanban(st -> _kanban_col(st, column))
    col === nothing &&
        throw(ArgumentError("kanban: no column with id or name \"$column\""))
    id = _short_id()
    _kanban_commit!(Dict{String,Any}("type" => "addCard", "col" => col["id"],
                                     "id" => id, "text" => String(text),
                                     "by" => "repl", "at" => _kanban_now()))
    return id
end

"""
    kanban_move_card!(card_id, column; index = nothing) -> Bool

Move a card to `column` (id or name). `index` is 1-based within the target
column; omit it to append at the end. Connected browsers animate the move.
"""
function kanban_move_card!(card_id::AbstractString, column::AbstractString;
                           index::Union{Nothing,Integer} = nothing)
    col = _with_kanban(st -> _kanban_col(st, column))
    col === nothing &&
        throw(ArgumentError("kanban: no column with id or name \"$column\""))
    to = index === nothing ? typemax(Int32) : Int(index) - 1  # protocolo é base 0
    return _kanban_commit!(Dict{String,Any}("type" => "moveCard",
                                            "id" => String(card_id),
                                            "toCol" => col["id"],
                                            "toIndex" => to))
end

"""
    kanban_remove_card!(card_id) -> Bool

Remove a card from the shared kanban board.
"""
kanban_remove_card!(card_id::AbstractString) =
    _kanban_commit!(Dict{String,Any}("type" => "delCard", "id" => String(card_id)))

"""
    kanban_alias!(ip, name) -> Bool

Set the display name for a machine, keyed by its IP address — the
host-side rename ("192.168.0.23" → "Paulo"). The mapping applies
everywhere the machine appears: cursors, presence chips and the card
creator stamp. Pass an empty `name` to remove the alias. Also available
in the UI, but only to the browser running on the server machine.
"""
kanban_alias!(ip::AbstractString, name::AbstractString) =
    _kanban_commit!(Dict{String,Any}("type" => "setAlias",
                                     "ip" => String(ip), "name" => String(name)))

"""
    kanban_log(; limit = 50) -> Vector{NamedTuple}

Latest activity on the shared kanban board as `(at, by, text)` rows,
newest first — every add, move, edit, completion, archive and rename,
with the actor's IP (or `"repl"`). Tables.jl-compatible.
"""
kanban_log(; limit::Integer = 50) = _with_kanban(st ->
    [(at = String(e["at"]), by = String(e["ip"]), text = String(e["text"]))
     for e in reverse(st.log[max(1, end - limit + 1):end])])

"""
    kanban_aliases() -> Dict{String,String}

Current IP → display-name mapping set by [`kanban_alias!`](@ref).
"""
kanban_aliases() = _with_kanban(st ->
    Dict{String,String}(String(k) => String(v) for (k, v) in _kaliases(st)))

# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

_kanban_peer_payload(c::KanbanClient) =
    Dict("id" => c.id, "ip" => c.ip, "name" => c.name, "color" => c.color)

function _kanban_init_payload(st::KanbanState, me::KanbanClient)
    lock(st.lock) do
        JSON3.write(Dict(
            "type" => "init", "rev" => st.rev, "board" => st.board,
            "you" => merge(_kanban_peer_payload(me),
                           Dict("host" => _kanban_is_host(me.ip))),
            "log" => st.log[max(1, end - 99):end],
            "peers" => [_kanban_peer_payload(c) for c in values(st.clients)]))
    end
end

function _kanban_broadcast(msg::String; except::Int = -1)
    st = _kanban_state()
    lock(st.lock) do
        for (id, c) in collect(st.clients)
            id == except && continue
            try
                HTTP.WebSockets.send(c.ws, msg)
            catch
                delete!(st.clients, id)   # conexão morta: remove e segue
            end
        end
    end
end

function _kanban_ws(ws::HTTP.WebSockets.WebSocket, ip::String)
    st = _kanban_state()
    me = lock(st.lock) do
        st.nextid += 1
        c = KanbanClient(st.nextid, ws, ip, ip, mod(st.nextid - 1, _KANBAN_NCOLORS))
        st.clients[c.id] = c
        c
    end
    try
        HTTP.WebSockets.send(ws, _kanban_init_payload(st, me))
        _kanban_broadcast(JSON3.write(Dict("type" => "join",
                                           "peer" => _kanban_peer_payload(me)));
                          except = me.id)
        for raw in ws
            msg = _plain(JSON3.read(raw))
            t = String(get(msg, "type", ""))
            if t == "op"
                op = msg["op"]
                optype = String(get(op, "type", ""))
                if optype == "addCard"
                    # criador default é a ponta da conexão; ops de undo já
                    # trazem o autor original e são respeitadas
                    haskey(op, "by") || (op["by"] = me.ip)
                    haskey(op, "at") || (op["at"] = _kanban_now())
                elseif optype == "setAlias" && !_kanban_is_host(me.ip)
                    # só o host renomeia usuários; ressincroniza o insistente
                    HTTP.WebSockets.send(ws, _kanban_init_payload(st, me))
                    continue
                end
                ok = _kanban_commit!(op; from = me.id, actor = me.ip)
                # op inválida (ex.: card já removido por outra máquina):
                # ressincroniza só este cliente
                ok || HTTP.WebSockets.send(ws, _kanban_init_payload(st, me))
            elseif t == "presence"
                _kanban_broadcast(JSON3.write(Dict(
                    "type" => "presence", "from" => me.id,
                    "state" => get(msg, "state", nothing))); except = me.id)
            elseif t == "hello"
                name = strip(String(get(msg, "name", "")))
                lock(st.lock) do
                    me.name = isempty(name) ? me.ip : name
                end
                _kanban_broadcast(JSON3.write(Dict("type" => "peer",
                                                   "peer" => _kanban_peer_payload(me))))
            elseif t == "sync"
                HTTP.WebSockets.send(ws, _kanban_init_payload(st, me))
            end
        end
    catch err
        err isa EOFError || @warn "Perth kanban: websocket error" error = err
    finally
        lock(st.lock) do
            delete!(st.clients, me.id)
        end
        _kanban_broadcast(JSON3.write(Dict("type" => "leave", "id" => me.id)))
    end
    return nothing
end

# ---------------------------------------------------------------------------
# QR code (opcional, via extensão PerthQRCodersExt)
# ---------------------------------------------------------------------------

# A extensão define _qr_matrix(::AbstractString) -> BitMatrix quando o
# usuário carrega QRCoders; sem ela, retorna nothing e a feature degrada
# com uma dica — mesmo padrão dos extensões BusinessDays/Makie do Perth.
_qr_matrix(text) = nothing

# Meio-blocos: duas linhas da matriz por linha de terminal
function _print_qr(io::IO, m; pad::Int = 2)
    h, w = size(m)
    at(i, j) = 1 <= i <= h && 1 <= j <= w ? m[i, j] : false
    for i in (1 - pad):2:(h + pad)
        print(io, "  ")
        for j in (1 - pad):(w + pad)
            top = at(i, j)
            bot = at(i + 1, j)
            print(io, top ? (bot ? '█' : '▀') : (bot ? '▄' : ' '))
        end
        println(io)
    end
end

# IP da outra ponta da conexão — é o que a UI mostra na etiqueta do cursor
function _kanban_peer_ip(http::HTTP.Stream)
    for f in (() -> Sockets.getpeername(HTTP.IOExtras.tcpsocket(http.stream)),
              () -> Sockets.getpeername(http.stream.io))
        try
            return string(f()[1])
        catch
        end
    end
    return "unknown"
end

# ---------------------------------------------------------------------------
# Servidor
# ---------------------------------------------------------------------------

const _KANBAN_DIR = normpath(joinpath(@__DIR__, "..", "frontend", "kanban"))

# Whitelist explícita, como o router principal; logo e favicon vêm do
# frontend principal para não duplicar assets
const _KANBAN_FILES = Dict(
    "/" => ("index.html", :kanban),
    "/index.html" => ("index.html", :kanban),
    "/app.js" => ("app.js", :kanban),
    "/style.css" => ("style.css", :kanban),
    "/alert.mp3" => ("alert.mp3", :kanban),
    "/logo.png" => ("logo.png", :main),
    "/favicon.svg" => ("favicon.svg", :main),
)

function _kanban_share_info()
    urls = ["http://localhost:$(KANBAN_PORT[])"]
    if KANBAN_SHARED[]
        lan = try
            filter(a -> a isa Sockets.IPv4, Sockets.getipaddrs())
        catch
            Sockets.IPv4[]
        end
        for a in lan
            push!(urls, "http://$(a):$(KANBAN_PORT[])")
        end
    end
    target = length(urls) > 1 ? urls[2] : urls[1]
    m = _qr_matrix(target)
    qr = m === nothing ? nothing :
        [join(x ? "1" : "0" for x in view(m, i, :)) for i in axes(m, 1)]
    return _json((; urls, shared = KANBAN_SHARED[], target, qr))
end

function _kanban_static(req::HTTP.Request)
    path = HTTP.URI(req.target).path
    path == "/api/share" && return _kanban_share_info()
    entry = get(_KANBAN_FILES, path, nothing)
    entry === nothing && return _error("not found"; status = 404)
    name, origin = entry
    file = joinpath(origin === :kanban ? _KANBAN_DIR : _FRONTEND_DIR, name)
    isfile(file) || return _error("not found"; status = 404)
    ext = splitext(file)[2]
    mime = ext == ".mp3" ? "audio/mpeg" :
        get(_MIME, ext, "application/octet-stream")
    return HTTP.Response(200, ["Content-Type" => mime,
                               "Cache-Control" => "no-store"], read(file))
end

# WebSocket exige handler de stream; o resto delega ao handler de Request
function _kanban_handler(http::HTTP.Stream)
    if HTTP.WebSockets.isupgrade(http.message)
        ip = _kanban_peer_ip(http)
        HTTP.WebSockets.upgrade(ws -> _kanban_ws(ws, ip), http)
    else
        HTTP.streamhandler(_kanban_static)(http)
    end
    return nothing
end

# Tenta portas sequenciais a partir da pedida (listen!, não serve!: o
# upgrade de WebSocket precisa do stream)
function _kanban_listen(handler, host, port::Integer; attempts::Int = 20)
    for p in port:(port + attempts - 1)
        try
            return HTTP.listen!(handler, host, p; verbose = false), p
        catch err
            err isa Base.IOError || rethrow()   # porta ocupada -> próxima
        end
    end
    error("Perth kanban: no free port in range $(port)–$(port + attempts - 1)")
end

"""
    Perth.kanban(; port = 8150, share = false, host = nothing,
                 open_browser = true, data_dir = nothing) -> String

Start the collaborative kanban board and (optionally) open it in your
browser. Returns the URL. Stop it with [`Perth.kanban_stop`](@ref).

By default the server binds to `localhost` only, like `Perth.run`. Pass
`share = true` to bind to `0.0.0.0` and let other machines on the local
network open the same board: every change (dragging a card, editing,
renaming a column) is broadcast live over a WebSocket, and each connected
machine shows up as a labelled cursor with its name and IP address —
pair-programming style. `host` overrides the bind address explicitly.

The board is a single shared entity, persisted as `kanban.json` in the
Perth data directory (`data_dir` overrides it). The REPL operates on the
same data: [`kanban_add_card!`](@ref), [`kanban_move_card!`](@ref),
[`kanban_remove_card!`](@ref) and [`kanban_cards`](@ref) — REPL edits
appear live in every connected browser.

!!! warning
    With `share = true` there is no authentication: anyone on the local
    network who knows the port can edit the board. Never expose the port
    to the internet.
"""
function kanban(; port::Integer = 8150, share::Bool = false,
                host::Union{Nothing,AbstractString} = nothing,
                open_browser::Bool = true,
                data_dir::Union{Nothing,AbstractString} = nothing)
    if KANBAN_SERVER[] !== nothing
        @info "Perth kanban already running — use Perth.kanban_stop() first."
        return "http://localhost:$(KANBAN_PORT[])"
    end
    data_dir === nothing || _init_kanban!(String(data_dir))
    _kanban_state()   # garante board carregado antes de aceitar conexões

    bindhost = something(host, share ? "0.0.0.0" : "127.0.0.1")
    addr = parse(Sockets.IPAddr, String(bindhost))
    server, chosen = _kanban_listen(_kanban_handler, addr, port)
    KANBAN_SERVER[] = server
    KANBAN_PORT[] = chosen
    KANBAN_SHARED[] = addr == Sockets.IPv4(0)

    url = "http://localhost:$(chosen)"
    printstyled("\n  Perth kanban "; color = :magenta, bold = true)
    println("running at $url")
    if addr == Sockets.IPv4(0)   # 0.0.0.0: mostra os endereços da rede local
        lan = try
            filter(a -> a isa Sockets.IPv4, Sockets.getipaddrs())
        catch
            Sockets.IPv4[]
        end
        for a in lan
            println("  on your network:  http://$(a):$(chosen)  ← share this link")
        end
        if !isempty(lan)
            m = _qr_matrix("http://$(first(lan)):$(chosen)")
            if m === nothing
                println("  (tip: run `using QRCoders` before Perth.kanban() to print a QR code here)")
            else
                println()
                _print_qr(stdout, m)
            end
        end
        println("  Anyone on the network can edit the board. Do not expose this port to the internet.")
    end
    println("  Board at $(_kanban_state().file) — Perth.kanban_stop() to shut down.\n")
    open_browser && _open_browser(url)
    return url
end

"""
    Perth.kanban_stop()

Stop the running kanban server, if any.
"""
function kanban_stop()
    if KANBAN_SERVER[] === nothing
        @info "Perth kanban is not running."
        return nothing
    end
    st = _kanban_state()
    lock(st.lock) do
        for c in values(st.clients)
            try
                HTTP.WebSockets.close(c.ws)
            catch
            end
        end
        empty!(st.clients)
    end
    close(KANBAN_SERVER[])
    KANBAN_SERVER[] = nothing
    @info "Perth kanban stopped."
    return nothing
end
