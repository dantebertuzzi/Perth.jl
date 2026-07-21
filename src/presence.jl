# Presença compartilhada (multiplayer): infraestrutura comum ao Perth gantt
# e ao Perth kanban. Um "hub" mantém os clientes WebSocket conectados e
# retransmite presença (cursores ancorados a elementos, etiquetados com
# nome/IP — estilo pareação do VS Code) e avisos de mudança de dados.
#
# O protocolo é o mesmo consolidado no kanban:
#   servidor -> cliente: init / join / leave / peer / presence / rev / hb / denied
#   cliente -> servidor: hello {name} / presence {state}
#
# O kanban mantém (por ora) seu próprio loop de WS porque ele carrega também
# as operações do board; os utilitários de baixo nível (IP da conexão,
# detecção de host, paleta, QR) vivem aqui e são usados pelos dois.

mutable struct PresenceClient
    id::Int
    ws::HTTP.WebSockets.WebSocket
    ip::String
    name::String
    color::Int
end

mutable struct PresenceHub
    clients::Dict{Int,PresenceClient}
    nextid::Int
    colors::Dict{String,Int}   # IP -> cor estável (sobrevive a refresh)
    lock::ReentrantLock
end

PresenceHub() = PresenceHub(Dict{Int,PresenceClient}(), 0,
                            Dict{String,Int}(), ReentrantLock())

# Espelha a paleta de cores dos frontends (shared/presence.js e kanban)
const _PRESENCE_NCOLORS = 8

# Só a máquina do servidor (loopback) é "host"
_presence_is_host(ip::AbstractString) = ip in ("127.0.0.1", "::1")

# Cor estável por máquina: derivada do hash do IP (mesma cor após F5 e
# entre sessões), com anticolisão — se a cor "natural" já pertence a outro
# IP nesta sessão, avança para a próxima livre. Chamar sob o lock do dono
# do Dict (hub ou kanban).
function _color_for_ip(assigned::Dict{String,Int}, ip::AbstractString)
    haskey(assigned, ip) && return assigned[ip]
    start = mod(Int(hash(String(ip)) % UInt(_PRESENCE_NCOLORS)), _PRESENCE_NCOLORS)
    used = Set(values(assigned))
    c = start
    for k in 0:(_PRESENCE_NCOLORS - 1)
        cand = mod(start + k, _PRESENCE_NCOLORS)
        if !(cand in used)
            c = cand
            break
        end
    end
    assigned[String(ip)] = c
    return c
end

# Desconexões abruptas do navegador (aba fechada, Ctrl+F5, máquina saindo
# da rede) chegam como EOFError no Unix e como IOError (ECANCELED,
# ECONNRESET, EPIPE) no Windows. Todas são o fim normal de uma conexão —
# não merecem warning no log.
_ws_disconnect(err) = err isa EOFError || err isa Base.IOError

# IP da outra ponta da conexão — é o que a UI mostra na etiqueta do cursor
function _peer_ip(http::HTTP.Stream)
    for f in (() -> Sockets.getpeername(HTTP.IOExtras.tcpsocket(http.stream)),
              () -> Sockets.getpeername(http.stream.io))
        try
            return string(f()[1])
        catch
        end
    end
    return "unknown"
end

_peer_payload(c::PresenceClient) =
    Dict("id" => c.id, "ip" => c.ip, "name" => c.name, "color" => c.color)

function _hub_broadcast(hub::PresenceHub, msg::String; except::Int = -1)
    lock(hub.lock) do
        for (id, c) in collect(hub.clients)
            id == except && continue
            try
                HTTP.WebSockets.send(c.ws, msg)
            catch
                delete!(hub.clients, id)   # conexão morta: remove e segue
            end
        end
    end
    return nothing
end

function _hub_init_payload(hub::PresenceHub, me::PresenceClient; extra = (;))
    lock(hub.lock) do
        JSON3.write(merge(Dict{String,Any}(
            "type" => "init",
            "you" => merge(_peer_payload(me),
                           Dict("host" => _presence_is_host(me.ip))),
            "peers" => [_peer_payload(c) for c in values(hub.clients)]),
            Dict{String,Any}(String(k) => v for (k, v) in pairs(extra))))
    end
end

# Loop de WS de presença pura (gantt): registra o cliente, publica
# join/leave e retransmite presença e trocas de nome. `keyok=false`
# encerra educadamente (mesmo comportamento do kanban).
function _presence_ws(hub::PresenceHub, ws::HTTP.WebSockets.WebSocket,
                      ip::String, keyok::Bool = true; extra_init = (;))
    if !keyok
        try
            HTTP.WebSockets.send(ws, "{\"type\":\"denied\"}")
            HTTP.WebSockets.close(ws)
        catch
        end
        return nothing
    end
    me = lock(hub.lock) do
        hub.nextid += 1
        c = PresenceClient(hub.nextid, ws, ip, ip,
                           _color_for_ip(hub.colors, ip))
        hub.clients[c.id] = c
        c
    end
    try
        HTTP.WebSockets.send(ws, _hub_init_payload(hub, me; extra = extra_init))
        _hub_broadcast(hub, JSON3.write(Dict("type" => "join",
                                             "peer" => _peer_payload(me)));
                       except = me.id)
        for raw in ws
            msg = _plain(JSON3.read(raw))
            t = String(get(msg, "type", ""))
            if t == "presence"
                _hub_broadcast(hub, JSON3.write(Dict(
                    "type" => "presence", "from" => me.id,
                    "state" => get(msg, "state", nothing))); except = me.id)
            elseif t == "hello"
                name = strip(String(get(msg, "name", "")))
                lock(hub.lock) do
                    me.name = isempty(name) ? me.ip : name
                end
                _hub_broadcast(hub, JSON3.write(Dict("type" => "peer",
                                                     "peer" => _peer_payload(me))))
            end
        end
    catch err
        _ws_disconnect(err) || @warn "Perth: presence websocket error" error = err
    finally
        lock(hub.lock) do
            delete!(hub.clients, me.id)
        end
        _hub_broadcast(hub, JSON3.write(Dict("type" => "leave", "id" => me.id)))
    end
    return nothing
end

# JSON3 lê de forma preguiçosa (Object/Array imutáveis); converte para
# Dict/Vector nativos quando o payload precisa ser mutado/reenviado
_plain(x::JSON3.Object) = Dict{String,Any}(String(k) => _plain(v) for (k, v) in x)
_plain(x::JSON3.Array) = Any[_plain(v) for v in x]
_plain(x) = x

# ---------------------------------------------------------------------------
# QR code (opcional, via extensão PerthQRCodersExt) — usado por gantt e kanban
# ---------------------------------------------------------------------------

# A extensão define _qr_matrix(::AbstractString) -> BitMatrix quando o
# usuário carrega QRCoders; sem ela, retorna nothing e a feature degrada
# com uma dica — mesmo padrão das extensões BusinessDays/Makie do Perth.
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
