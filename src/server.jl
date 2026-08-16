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
const GANTT_VIEW_KEY = Ref{String}("")        # chave de leitura ("" = sem link somente-leitura)
const GANTT_TIMER = Ref{Union{Timer,Nothing}}(nothing)

_key_suffix(key::AbstractString) = isempty(key) ? "" :
    "?key=" * HTTP.URIs.escapeuri(key)
_gantt_key_suffix() = _key_suffix(GANTT_KEY[])

# Porteiro da transmissão: a máquina do servidor entra sempre; as demais,
# só enquanto a transmissão estiver ligada
_gantt_share_ok(ip::AbstractString) = GANTT_SHARED[] || _presence_is_host(ip)

# Links da sessão para uma chave qualquer — a de edição por padrão, a de
# leitura quando se quer o link que só mostra (ver _gantt_view_urls)
function _gantt_urls(key::AbstractString = GANTT_KEY[])
    sfx = _key_suffix(key)
    urls = ["http://localhost:$(PORT[])" * sfx]
    GANTT_SHARED[] || return urls
    for a in _lan_ipv4()
        push!(urls, "http://$(a):$(PORT[])" * sfx)
    end
    return urls
end

# Só os endereços de rede: na máquina do servidor o link somente-leitura
# não vale (o host edita sempre, como é isento da chave de acesso), então
# oferecer um "localhost?key=…" seria prometer o que ele não faz.
_gantt_view_urls() = isempty(GANTT_VIEW_KEY[]) ? String[] :
    _gantt_urls(GANTT_VIEW_KEY[])[2:end]

# Payload de /api/share — o mesmo formato do kanban, para o frontend
# compartilhar o desenho do diálogo.
#
# Os links carregam a chave, então o payload é escrito para quem pergunta:
# a chave de edição não pode aparecer para quem entrou pelo link de leitura
# (seria entregar, na primeira tela, a permissão que o link nega), e a de
# leitura só interessa a quem a distribui — o host.
function _gantt_share_payload(ip::AbstractString = ""; viewing::Bool = false)
    host = _presence_is_host(ip)
    urls = _gantt_urls(viewing ? GANTT_VIEW_KEY[] : GANTT_KEY[])
    target = length(urls) > 1 ? urls[2] : urls[1]
    return (; urls, target, qr = _qr_rows(target),
            shared = GANTT_SHARED[], can_share = GANTT_CAN_SHARE[],
            keyed = !isempty(GANTT_KEY[]), host,
            viewing, view_keyed = !isempty(GANTT_VIEW_KEY[]),
            view_urls = host ? _gantt_view_urls() : String[])
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

"""
    Perth.key!(key = "") -> Bool

Set (or drop, with `""`) the access key of the running gantt server,
live — no restart, no [`Perth.stop`](@ref). Returns whether a key is
required from now on. Surrounding whitespace is trimmed, so a pasted key
does not fail on a trailing space.

Machines on the network must send the key on every request and on the
presence socket; the machine running the server never needs it. The LAN
links (and the QR code) carry the key, so nobody has to type it — see
[`Perth.run`](@ref).

Changing the key disconnects every machine on the network immediately:
the key they hold is now the wrong one, and each is asked for the new
one on screen rather than left with a dead page. Dropping the key
(`key!()`) disconnects nobody — nothing they hold became invalid.

The same control is in the UI (File → Share / QR…), available only from
the machine running the server. For a link that opens the projects but
refuses to change them, see [`Perth.view_key!`](@ref).

```julia
Perth.key!("obra-2026")   # exige a chave de quem vem da rede
Perth.key!()              # volta a aceitar qualquer um da rede
```
"""
function key!(key::AbstractString = ""; actor::AbstractString = "repl")
    SERVER[] === nothing && throw(ArgumentError("Perth is not running — Perth.run() first"))
    new = _cap_text(strip(String(key)))
    GANTT_KEY[] == new && return !isempty(new)
    GANTT_KEY[] = new
    # a chave antiga virou inválida: quem está de fora precisa reentrar (o
    # porteiro sozinho só barra conexões novas). Tirar a chave não invalida
    # ninguém — derrubar seria pedir na tela uma chave que não existe mais.
    # Quem entrou pelo link somente-leitura fica: a chave dele é outra, e
    # continua certa.
    isempty(new) || _hub_drop_remote!(GANTT_HUB; reason = "key", only = :editors)
    _with_state(st -> _log_activity!(st, actor, "key",
        isempty(new) ? "removed the access key" : "changed the access key"))
    _hub_broadcast(GANTT_HUB, JSON3.write((; type = "key", keyed = !isempty(new))))
    @info(isempty(new) ?
          "Perth: access key removed — anyone on the network can open the projects." :
          "Perth: access key set — new links: " * join(_gantt_urls(), " "))
    return !isempty(new)
end

"""
    Perth.view_key!(key = "") -> Bool

Set (or drop, with `""`) the **read-only key** of the running gantt
server, live — no restart, no [`Perth.stop`](@ref). Returns whether a
read-only link exists from now on.

Whoever opens a link carrying this key sees the projects — chart, table,
analytics, exports — and cannot change them: every write is refused with
403, including the ones that would go through the presence socket (chat).
That is the link you hand to a client, a director, the whole site.

It is a *second* key, independent of [`Perth.key!`](@ref): with an access
key set, one link edits and the other only shows; with no access key, the
plain link still edits and only the read-only link is restricted. The two
keys cannot be the same string — one link cannot mean both things.

Changing or dropping the read-only key disconnects the machines that came
in through it, and only those: what the editors hold is still valid.

The machine running the server always edits, even through the read-only
link — it is the machine that hands the link out (same reason it never
needs the access key). The read-only links therefore start at the network
addresses, and the UI (File → Share / QR…) shows them there.

```julia
Perth.run(share = true, key = "obra-2026", view_key = "obra-2026-ver")
Perth.view_key!("so-olhar")   # troca o link de leitura
Perth.view_key!()             # acaba com o link de leitura
```
"""
function view_key!(key::AbstractString = ""; actor::AbstractString = "repl")
    SERVER[] === nothing && throw(ArgumentError("Perth is not running — Perth.run() first"))
    new = _cap_text(strip(String(key)))
    (!isempty(new) && new == GANTT_KEY[]) && throw(ArgumentError(
        "the read-only key cannot be the same as the access key"))
    GANTT_VIEW_KEY[] == new && return !isempty(new)
    GANTT_VIEW_KEY[] = new
    # ao contrário da chave de acesso, tirar a de leitura TAMBÉM invalida:
    # sem ela o link vira um link comum, e quem estava só olhando passaria a
    # editar sem ninguém ter decidido isso. Por isso derruba nos dois casos.
    _hub_drop_remote!(GANTT_HUB; reason = "key", only = :readers)
    _with_state(st -> _log_activity!(st, actor, "key",
        isempty(new) ? "removed the read-only link" : "changed the read-only link"))
    _hub_broadcast(GANTT_HUB, JSON3.write((; type = "view_key",
                                           view_keyed = !isempty(new))))
    @info(isempty(new) ?
          "Perth: read-only link removed." :
          "Perth: read-only link — " * join(_gantt_view_urls(), " "))
    return !isempty(new)
end

# POST /api/key e /api/view_key {"key": "…"} — só do host, como o toggle da
# transmissão. Devolvem o payload de /api/share: os links (e o QR) mudam
# com a chave.
function _gantt_key_set(req::HTTP.Request, ip::AbstractString; view::Bool = false)
    _presence_is_host(ip) ||
        return _error("only the machine running Perth can change this"; status = 403)
    key = try
        String(get(JSON3.read(String(req.body)), "key", ""))
    catch
        return _error("expected {\"key\": \"…\"}"; status = 400)
    end
    try
        view ? view_key!(key; actor = ip) : key!(key; actor = ip)
    catch err
        err isa ArgumentError && return _error(err.msg; status = 409)
        rethrow()
    end
    return _json(_gantt_share_payload(ip))
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
              share = false, host = nothing, key = "", view_key = "") -> String

Start the Perth server and (optionally) open the app in your browser.
Returns the URL. The server does not block the REPL; stop it with
[`Perth.stop`](@ref).

By default only this machine can open the app. Pass `share = true` to let
other machines on the local network open the same projects: every
connected machine shows up as a labelled cursor with its name and IP
address — exactly like `Perth.kanban(share = true)`. `key` requires an
access key from those machines; `view_key` adds a second link that opens
the projects and refuses to change them — see [`Perth.view_key!`](@ref).

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
             view_key::AbstractString = "",
             watch::Bool = true,
             banner::Bool = true)
    if SERVER[] !== nothing
        @info "Perth already running — use Perth.stop() first."
        return _url()
    end

    banner && splash(; version = string(pkgversion(@__MODULE__)))

    GANTT_KEY[] = String(key)
    # um mesmo texto não pode significar as duas permissões
    (!isempty(view_key) && String(view_key) == String(key)) && throw(ArgumentError(
        "view_key cannot be the same as key — one link cannot both edit and not edit"))
    GANTT_VIEW_KEY[] = String(view_key)
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
    # Espelho de volta: quem edita o .perth.jl no editor vê o navegador
    # acompanhar (ver watch.jl). Desligável com run(watch = false).
    _WATCH_ON[] = watch
    watch && _with_state(_watch_sync!)

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
        for u in _gantt_view_urls()
            push!(notes, "Read-only link: $u")
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

# Veredito do porteiro para uma requisição HTTP (o WS tem o seu, logo
# abaixo): :not_shared (transmissão desligada), :need_key (rota de dados sem
# a chave) ou :ok. Vive fora do handler para poder ser testado com um IP
# remoto de mentira — do loopback, que é isento, o teste seria sempre :ok.
# Ações cuja consequência SAI do aplicativo e alcança a máquina que hospeda:
# escrever arquivo em caminho arbitrário (o espelho .perth.jl), ler a árvore
# de diretórios e iniciar um processo. Não são edição de projeto — são acesso
# à máquina —, e por isso só do host, como o toggle de transmissão e a chave.
#
# O espelho é o mais grave dos três: _resolve_save_path aceita literalmente
# qualquer caminho terminado em .jl, então um convidado apontaria o espelho
# para ~/.julia/config/startup.jl e a máquina anfitriã sobrescreveria o
# arquivo no salvamento seguinte. A exigência do .jl, que parece proteção, é
# justamente o que põe o alvo mais sensível ao alcance.
function _gantt_host_only(path::AbstractString, method::AbstractString)
    startswith(path, "/api/fs/") && return true            # lista diretórios
    path == "/api/launch/kanban" && return true            # inicia processo
    return method == "PUT" && startswith(path, "/api/projects/") &&
           endswith(path, "/path")                         # espelho em disco
end

# Papel de quem faz a requisição, pelo IP e pela chave que ele apresenta:
# :host (a máquina do servidor, isenta de tudo), :viewer (veio pelo link
# somente-leitura), :guest (pode editar) ou :nokey.
#
# A chave de leitura é conferida ANTES da de edição de propósito: sem chave
# de acesso configurada — que é o caso comum — _keyok aceita qualquer um, e
# testar na outra ordem faria o link somente-leitura nunca valer nada.
function _gantt_role(ip::AbstractString, qp)
    _presence_is_host(ip) && return :host
    view = GANTT_VIEW_KEY[]
    (!isempty(view) && get(qp, "key", "") == view) && return :viewer
    _keyok(ip, qp, GANTT_KEY[]) && return :guest
    return :nokey
end

# Escrita é o método, não a rota: toda mutação de projeto passa por
# POST/PUT/DELETE (inclusive /schedule e /pert, que aplicam o motor no
# projeto guardado), e todo o resto — inclusive os exports e o PNG — é GET.
# Fecha por padrão: um método novo entra como escrita até que se diga o
# contrário.
_gantt_writes(method::AbstractString) = !(method in ("GET", "HEAD", "OPTIONS"))

function _gantt_gate(path::AbstractString, ip::AbstractString, qp;
                     method::AbstractString = "GET")
    _gantt_share_ok(ip) || return :not_shared
    role = _gantt_role(ip, qp)
    (role === :nokey && _key_protected(path)) && return :need_key
    # antes do :host_only porque explica melhor: quem entrou para olhar não
    # está sendo barrado por ser outra máquina, e sim pelo link que abriu
    (role === :viewer && _gantt_writes(method)) && return :read_only
    (_gantt_host_only(path, method) && role !== :host) && return :host_only
    return :ok
end

# WebSocket exige handler de stream; o resto delega ao router de Request.
# Quando há chave configurada, máquinas que não são o host precisam dela
# tanto no upgrade do WS quanto nas rotas de dados (ver _key_protected —
# mesmo modelo do kanban).
function _gantt_handler(router)
    return function (http::HTTP.Stream)
        ip = _peer_ip(http)
        qp = try
            HTTP.URIs.queryparams(HTTP.URI(http.message.target))
        catch
            Dict{String,String}()
        end
        if HTTP.WebSockets.isupgrade(http.message)
            # porteiro da transmissão, antes de tudo: com o share desligado a
            # porta existe (para o botão poder religá-la) mas só atende o host
            _gantt_share_ok(ip) || return HTTP.WebSockets.upgrade(
                ws -> _presence_deny(ws, "share_off"), http)
            role = _gantt_role(ip, qp)
            HTTP.WebSockets.upgrade(ws -> _presence_ws(GANTT_HUB, ws, ip, role !== :nokey;
                                                       readonly = role === :viewer,
                                                       extra_init = (; rev = _state().rev)),
                                    http)
        else
            # o router não vê o stream: propaga o IP p/ o log de atividades
            HTTP.setheader(http.message, "X-Perth-Peer" => ip)
            path = HTTP.URI(http.message.target).path
            verdict = _gantt_gate(path, ip, qp; method = http.message.method)
            if verdict === :not_shared
                HTTP.streamhandler(_ -> _error("this Perth server is not sharing to the network";
                                               status = 403))(http)
            elseif verdict === :need_key
                HTTP.streamhandler(_ -> _error("access key required"; status = 403))(http)
            elseif verdict === :read_only
                HTTP.streamhandler(_ -> _error(
                    "this is a read-only link — ask for an editing link to change anything";
                    status = 403))(http)
            elseif verdict === :host_only
                HTTP.streamhandler(_ -> _error(
                    "only the machine running Perth can do this"; status = 403))(http)
            elseif path == "/api/share"
                # fica fora do router de propósito: o toggle é do host, e só
                # aqui o IP real da conexão é conhecido (header é do cliente)
                HTTP.streamhandler(http.message.method == "POST" ?
                    req -> _gantt_share_toggle(req, ip) :
                    _ -> _json(_gantt_share_payload(ip;
                                                    viewing = _gantt_role(ip, qp) === :viewer)))(http)
            elseif path == "/api/key" && http.message.method == "POST"
                HTTP.streamhandler(req -> _gantt_key_set(req, ip))(http)   # idem: host-only
            elseif path == "/api/view_key" && http.message.method == "POST"
                HTTP.streamhandler(req -> _gantt_key_set(req, ip; view = true))(http)
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
    _watch_stop_all!()
    GANTT_KEY[] = ""
    GANTT_VIEW_KEY[] = ""
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
