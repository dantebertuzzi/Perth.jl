# Ciclo de vida do servidor gantt. Por padrão sobe em Sockets.localhost,
# de forma não bloqueante, para manter o REPL vivo — a graça é editar o
# projeto pelo REPL com a página aberta ao lado.
#
# share = true replica o modelo do kanban: bind em 0.0.0.0, canal de
# presença por WebSocket em /ws (cursores etiquetados com nome/IP de cada
# máquina da rede) e chave de acesso opcional. As mudanças de dados
# continuam fluindo pela API REST + polling de /api/rev; o WS acrescenta
# um aviso "rev" instantâneo para os clientes recarregarem na hora.

const SERVER = Ref{Union{HTTP.Server,Nothing}}(nothing)
const PORT = Ref{Int}(0)
const GANTT_HUB = PresenceHub()
const GANTT_SHARED = Ref{Bool}(false)
const GANTT_KEY = Ref{String}("")             # chave de acesso do share ("" = aberto)
const GANTT_TIMER = Ref{Union{Timer,Nothing}}(nothing)

_gantt_key_suffix() = isempty(GANTT_KEY[]) ? "" :
    "?key=" * HTTP.URIs.escapeuri(GANTT_KEY[])

"""
    Perth.run(; port = 8123, open_browser = true, data_dir = nothing,
              share = false, host = nothing, key = "") -> String

Start the Perth server and (optionally) open the app in your browser.
Returns the URL. The server does not block the REPL; stop it with
[`Perth.stop`](@ref).

By default the server binds to `localhost` only. Pass `share = true` to
bind to `0.0.0.0` and let other machines on the local network open the
same projects: every connected machine shows up as a labelled cursor
with its name and IP address — exactly like `Perth.kanban(share = true)`.
`host` overrides the bind address explicitly; `key` requires an access
key from non-host machines.

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
             key::AbstractString = "")
    if SERVER[] !== nothing
        @info "Perth already running — use Perth.stop() first."
        return _url()
    end
    GANTT_KEY[] = String(key)
    data_dir === nothing || _init_state!(data_dir)
    _state()  # garante estado carregado antes de aceitar requisições

    router = _build_router()
    bindhost = something(host, share ? "0.0.0.0" : "127.0.0.1")
    addr = parse(Sockets.IPAddr, String(bindhost))
    server, chosen = _serve_with_fallback(router, addr, port)
    SERVER[] = server
    PORT[] = chosen
    GANTT_SHARED[] = addr == Sockets.IPv4(0)

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

    url = _url()
    printstyled("\n  Perth "; color = :magenta, bold = true)
    println("running at $url")
    if GANTT_SHARED[]
        lan = try
            filter(a -> a isa Sockets.IPv4, Sockets.getipaddrs())
        catch
            Sockets.IPv4[]
        end
        for a in lan
            println("  on your network:  http://$(a):$(chosen)$(_gantt_key_suffix())  ← share this link")
        end
        if !isempty(lan)
            m = _qr_matrix("http://$(first(lan)):$(chosen)" * _gantt_key_suffix())
            if m === nothing
                println("  (tip: run `using QRCoders` before Perth.run() to print a QR code here)")
            else
                println()
                _print_qr(stdout, m)
            end
        end
        if isempty(GANTT_KEY[])
            println("  Anyone on the network can edit the projects — pass key = \"...\" to require an access key.")
        else
            println("  Access requires the key (already embedded in the links above).")
        end
        println("  Do not expose this port to the internet.")
    end
    println("  Projects at $(_state().data_dir) — Perth.stop() to shut down.\n")
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
        if HTTP.WebSockets.isupgrade(http.message)
            HTTP.WebSockets.upgrade(ws -> _presence_ws(GANTT_HUB, ws, ip, keyok;
                                                       extra_init = (; rev = _state().rev)),
                                    http)
        else
            # o router não vê o stream: propaga o IP p/ o log de atividades
            HTTP.setheader(http.message, "X-Perth-Peer" => ip)
            path = HTTP.URI(http.message.target).path
            if startswith(path, "/api/") && !keyok
                HTTP.streamhandler(_ -> _error("access key required"; status = 403))(http)
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
    close(SERVER[])
    SERVER[] = nothing
    @info "Perth stopped."
    return nothing
end

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
