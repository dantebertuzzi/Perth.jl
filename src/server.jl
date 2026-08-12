# Ciclo de vida do servidor gantt. Por padrão sobe em Sockets.localhost,
# de forma não bloqueante, para manter o REPL vivo — a graça é editar o
# projeto pelo REPL com a página aberta ao lado.
#
# share = true replica o modelo do kanban: canal de presença por WebSocket
# em /ws (cursores etiquetados com nome/IP de cada máquina da rede) e chave
# de acesso opcional. As mudanças de dados continuam fluindo pela API REST +
# polling de /api/rev; o WS acrescenta um aviso "rev" instantâneo para os
# clientes recarregarem na hora.
#
# A transmissão liga e desliga com o servidor no ar (botão da UI ou
# Perth.share!): endereço de bind não muda depois do socket aberto, então o
# socket sobe sempre em 0.0.0.0 e quem decide se máquinas de fora entram é
# GANTT_SHARED[], consultado a cada conexão. Com a transmissão desligada, só
# o loopback passa do porteiro — de fora a porta responde 403.

const SERVER = Ref{Union{HTTP.Server,Nothing}}(nothing)
const PORT = Ref{Int}(0)
const GANTT_HUB = PresenceHub()
const GANTT_SHARED = Ref{Bool}(false)         # transmitindo agora (mutável em runtime)
const GANTT_CAN_SHARE = Ref{Bool}(false)      # socket em 0.0.0.0: dá para alternar
const GANTT_KEY = Ref{String}("")             # chave de acesso do share ("" = aberto)
const GANTT_TIMER = Ref{Union{Timer,Nothing}}(nothing)

_gantt_key_suffix() = isempty(GANTT_KEY[]) ? "" :
    "?key=" * HTTP.URIs.escapeuri(GANTT_KEY[])

# Porteiro da transmissão: a máquina do servidor entra sempre; as demais,
# só enquanto a transmissão estiver ligada
_gantt_share_ok(ip::AbstractString) = GANTT_SHARED[] || _presence_is_host(ip)

function _gantt_urls()
    urls = ["http://localhost:$(PORT[])" * _gantt_key_suffix()]
    GANTT_SHARED[] || return urls
    for a in _lan_ipv4()
        push!(urls, "http://$(a):$(PORT[])" * _gantt_key_suffix())
    end
    return urls
end

# Payload de /api/share — o mesmo formato do kanban, para o frontend
# compartilhar o desenho do diálogo
function _gantt_share_payload(ip::AbstractString = "")
    urls = _gantt_urls()
    target = length(urls) > 1 ? urls[2] : urls[1]
    return (; urls, target, qr = _qr_rows(target),
            shared = GANTT_SHARED[], can_share = GANTT_CAN_SHARE[],
            keyed = !isempty(GANTT_KEY[]), host = _presence_is_host(ip))
end

"""
    Perth.share!(on = true) -> Bool

Turn network sharing on or off on the running gantt server, live — no
restart, no [`Perth.stop`](@ref). With sharing on, other machines on the
local network can open the same projects (see [`Perth.run`](@ref)); with
it off, only this machine can, and remote browsers already connected are
disconnected immediately.

The same switch is in the UI (File → Share / QR…), available only from
the machine running the server. Sharing can only be toggled when the
server was started without an explicit `host` — see [`Perth.run`](@ref).
"""
function share!(on::Bool = true; actor::AbstractString = "repl")
    SERVER[] === nothing && throw(ArgumentError("Perth is not running — Perth.run() first"))
    GANTT_CAN_SHARE[] || throw(ArgumentError(
        "this server is bound to a fixed address — restart without `host` to allow toggling"))
    GANTT_SHARED[] == on && return on
    GANTT_SHARED[] = on
    on || _hub_drop_remote!(GANTT_HUB)   # o porteiro só barra conexões novas
    _with_state(st -> _log_activity!(st, actor, "share",
        on ? "turned network sharing on" : "turned network sharing off"))
    _hub_broadcast(GANTT_HUB, JSON3.write((; type = "share", shared = on)))
    if on
        for u in _gantt_urls()[2:end]
            @info "Perth: sharing on — $u"
        end
    else
        @info "Perth: sharing off — localhost only."
    end
    return on
end

function _gantt_share_toggle(req::HTTP.Request, ip::AbstractString)
    _presence_is_host(ip) ||
        return _error("only the machine running Perth can change this"; status = 403)
    on = try
        Bool(get(JSON3.read(String(req.body)), "on", !GANTT_SHARED[]))
    catch
        !GANTT_SHARED[]
    end
    try
        share!(on; actor = ip)
    catch err
        err isa ArgumentError && return _error(err.msg; status = 409)
        rethrow()
    end
    return _json(_gantt_share_payload(ip))
end

"""
    Perth.run(; port = 8123, open_browser = true, data_dir = nothing,
              share = false, host = nothing, key = "") -> String

Start the Perth server and (optionally) open the app in your browser.
Returns the URL. The server does not block the REPL; stop it with
[`Perth.stop`](@ref).

By default only this machine can open the app. Pass `share = true` to let
other machines on the local network open the same projects: every
connected machine shows up as a labelled cursor with its name and IP
address — exactly like `Perth.kanban(share = true)`. `key` requires an
access key from those machines.

Sharing is a live switch, not a startup-only decision: turn it on and off
with the server running via [`Perth.share!`](@ref) or the UI (File →
Share / QR…). To that end the socket binds to `0.0.0.0` and every
connection is checked against the current setting — with sharing off,
requests from other machines are refused with 403. Pass `host` to bind a
fixed address instead (which disables the live switch).

If `port` is busy, the next free port is used (up to 20 attempts).
`data_dir` overrides the project storage directory
(default: `\$PERTH_DATA_DIR` or `~/.perth`).

!!! warning
    With `share = true` and no `key`, anyone on the local network who
    knows the port can edit the projects. Never expose the port to the
    internet.
"""
function run(; port::Integer = 8123, open_browser::Bool = true,
             data_dir::Union{Nothing,AbstractString} = nothing,
             share::Bool = false,
             host::Union{Nothing,AbstractString} = nothing,
             key::AbstractString = "",
             banner::Bool = true)
    if SERVER[] !== nothing
        @info "Perth already running — use Perth.stop() first."
        return _url()
    end

    banner && splash(; version = string(pkgversion(@__MODULE__)))

    GANTT_KEY[] = String(key)
    # bind sempre em 0.0.0.0 (ver comentário do topo): o filtro de quem
    # entra é o porteiro, não o socket — é o que permite ligar/desligar a
    # transmissão sem derrubar o servidor
    bindhost = something(host, "0.0.0.0")
    addr = parse(Sockets.IPAddr, String(bindhost))

    nproj = _step(stdout, "Loading projects") do
        data_dir === nothing || _init_state!(data_dir)
        _state()                      # garante estado carregado
        length(projects())
    end

    # Chat geral: mesmo arquivo append-only do kanban, uma pasta acima —
    # recarrega a cada run() (troca de data_dir muda o histórico visível)
    GANTT_HUB.chatfile = joinpath(_state().data_dir, "chat.jsonl")
    GANTT_HUB.chat = _load_capped_jsonl(GANTT_HUB.chatfile, _HUB_CHAT_CAP, _HUB_CHAT_KEEP)

    server, chosen = _step(stdout, "Starting HTTP server") do
        _quiet() do                   # engole os @info do HTTP.jl
            _serve_with_fallback(_build_router(), addr, port)
        end
    end
    SERVER[] = server
    PORT[] = chosen
    # `host` explícito fixa o alcance no socket: o que vale é o endereço
    # pedido, e o botão de transmitir fica indisponível
    GANTT_CAN_SHARE[] = addr == Sockets.IPv4(0)
    GANTT_SHARED[] = GANTT_CAN_SHARE[] ? share : !_presence_is_host(string(addr))

    _step(stdout, "Wiring live updates") do
        # Mudança de dados (REPL, API, outra máquina) -> aviso "rev" imediato
        # aos clientes conectados; assíncrono para nunca segurar o lock do estado
        _ON_REV[] = rev -> @async _hub_broadcast(GANTT_HUB,
            JSON3.write(Dict("type" => "rev", "rev" => rev)))

        # Heartbeat: mantém intermediários acordados e permite ao cliente
        # detectar conexão morta (mesmo período do kanban)
        GANTT_TIMER[] = Timer(30.0; interval = 30.0) do _
            try
                _hub_broadcast(GANTT_HUB, "{\"type\":\"hb\"}")
            catch
            end
        end
    end

    # ── painel final: links de LAN, avisos e QR viram argumentos do `ready` ──
    url   = _url()
    net   = String[]
    notes = String[]
    qr    = nothing

    if GANTT_SHARED[]
        for a in _lan_ipv4()
            push!(net, "http://$(a):$(chosen)$(_gantt_key_suffix())")
        end
        if !isempty(net)
            m = _qr_matrix(first(net))   # mesmo texto do link impresso
            if m === nothing
                push!(notes, "tip: `using QRCoders` before Perth.run() prints a QR code here")
            else
                qr = io -> (println(io); _print_qr(io, m))
            end
        end
        push!(notes, isempty(GANTT_KEY[]) ?
            "Anyone on the network can edit the projects — pass key = \"…\" to require an access key." :
            "Access requires the key (already embedded in the links above).")
        push!(notes, "Perth.share!(false) stops sharing without stopping the server.")
        push!(notes, "Do not expose this port to the internet.")
    elseif GANTT_CAN_SHARE[]
        push!(notes, "Localhost only — Perth.share!() (or File → Share / QR…) opens it to your network.")
    end

    _ready(; url = url,
            projects = nproj,
            dir = _state().data_dir,
            network = net,
            notes = notes,
            tail = qr)

    open_browser && _open_browser(url * _gantt_key_suffix())
    return url
end

# WebSocket exige handler de stream; o resto delega ao router de Request.
# Quando há chave configurada, máquinas que não são o host precisam dela
# tanto no upgrade do WS quanto nas rotas /api/* (mesmo modelo do kanban).
function _gantt_handler(router)
    return function (http::HTTP.Stream)
        ip = _peer_ip(http)
        qp = try
            HTTP.URIs.queryparams(HTTP.URI(http.message.target))
        catch
            Dict{String,String}()
        end
        keyok = isempty(GANTT_KEY[]) || _presence_is_host(ip) ||
                get(qp, "key", "") == GANTT_KEY[]
        # porteiro da transmissão, antes de tudo: com o share desligado a
        # porta existe (para o botão poder religá-la) mas só atende o host
        share_ok = _gantt_share_ok(ip)
        if HTTP.WebSockets.isupgrade(http.message)
            share_ok || return HTTP.WebSockets.upgrade(
                ws -> _presence_deny(ws, "share_off"), http)
            HTTP.WebSockets.upgrade(ws -> _presence_ws(GANTT_HUB, ws, ip, keyok;
                                                       extra_init = (; rev = _state().rev)),
                                    http)
        else
            # o router não vê o stream: propaga o IP p/ o log de atividades
            HTTP.setheader(http.message, "X-Perth-Peer" => ip)
            path = HTTP.URI(http.message.target).path
            if !share_ok
                HTTP.streamhandler(_ -> _error("this Perth server is not sharing to the network";
                                               status = 403))(http)
            elseif startswith(path, "/api/") && !keyok
                HTTP.streamhandler(_ -> _error("access key required"; status = 403))(http)
            elseif path == "/api/share"
                # fica fora do router de propósito: o toggle é do host, e só
                # aqui o IP real da conexão é conhecido (header é do cliente)
                HTTP.streamhandler(http.message.method == "POST" ?
                    req -> _gantt_share_toggle(req, ip) :
                    _ -> _json(_gantt_share_payload(ip)))(http)
            else
                HTTP.streamhandler(router)(http)
            end
        end
        return nothing
    end
end

# Tenta portas sequenciais a partir da pedida (8123, 8124, ...).
# listen!, não serve!: o upgrade de WebSocket precisa do stream.
function _serve_with_fallback(router, addr, port::Integer; attempts::Int = 20)
    handler = _gantt_handler(router)
    for p in port:(port + attempts - 1)
        try
            server = HTTP.listen!(handler, addr, p; verbose = false)
            return server, p
        catch err
            # Porta ocupada -> tenta a próxima; outros erros propagam
            err isa Base.IOError || rethrow()
        end
    end
    error("Perth: no free port in range $(port)–$(port + attempts - 1)")
end

_url() = "http://localhost:$(PORT[])"

"""
    Perth.stop()

Stop the running Perth server, if any.
"""
function stop()
    if SERVER[] === nothing
        @info "Perth is not running."
        return nothing
    end
    lock(GANTT_HUB.lock) do
        for c in values(GANTT_HUB.clients)
            try
                HTTP.WebSockets.close(c.ws)
            catch
            end
        end
        empty!(GANTT_HUB.clients)
    end
    if GANTT_TIMER[] !== nothing
        close(GANTT_TIMER[])
        GANTT_TIMER[] = nothing
    end
    _ON_REV[] = nothing
    GANTT_KEY[] = ""
    GANTT_SHARED[] = false
    GANTT_CAN_SHARE[] = false
    close(SERVER[])
    SERVER[] = nothing
    @info "Perth stopped."
    return nothing
end

"""
    Perth.chat!(text) -> Bool

Post a message to the shared gantt chat — visible live on every
connected browser, under actor `"repl"`, same as other REPL mutations.
"""
chat!(text::AbstractString) = _hub_chat_commit!(GANTT_HUB, text)

"""
    Perth.chat_log(; limit = 50) -> Vector{NamedTuple}

Latest messages on the shared gantt chat as `(at, by, text)` rows,
newest first. Tables.jl-compatible.
"""
chat_log(; limit::Integer = 50) =
    [(at = String(e["at"]), by = String(e["ip"]), text = String(e["text"]))
     for e in reverse(GANTT_HUB.chat[max(1, end - limit + 1):end])]

# Abre a URL no navegador padrão, cross-platform, sem dependência extra
function _open_browser(url::AbstractString)
    cmd = if Sys.islinux()
        `xdg-open $url`
    elseif Sys.isapple()
        `open $url`
    elseif Sys.iswindows()
        `cmd /c start "" $url`
    else
        nothing
    end
    cmd === nothing && return
    try
        Base.run(pipeline(cmd; stdout = devnull, stderr = devnull); wait = false)
    catch
        @info "Open manually: $url"
    end
    return nothing
end
