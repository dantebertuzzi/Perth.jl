# Board kanban colaborativo — Perth.kanban().
#
# Ao contrário do servidor Gantt (polling de revisão), o kanban é um
# servidor próprio, opcionalmente exposto à rede local (share = true),
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
    file::String                      # kanban[-<board>].json no dir de dados
    clients::Dict{Int,KanbanClient}
    nextid::Int
    lock::ReentrantLock
    log::Vector{Any}                  # últimos eventos (cap em memória)
    logfile::String                   # kanban[-<board>]-log.jsonl, append-only
    chat::Vector{Any}                 # últimas mensagens do chat (cap em memória)
    chatfile::String                  # kanban[-<board>]-chat.jsonl, append-only
    name::String                      # board ativo ("board" é o default)
    data_dir::String
end

const KANBAN = Ref{Union{KanbanState,Nothing}}(nothing)
const KANBAN_SERVER = Ref{Union{HTTP.Server,Nothing}}(nothing)
const KANBAN_PORT = Ref{Int}(0)
const KANBAN_SHARED = Ref{Bool}(false)        # transmitindo agora (mutável em runtime)
const KANBAN_CAN_SHARE = Ref{Bool}(false)     # socket em 0.0.0.0: dá para alternar
const KANBAN_KEY = Ref{String}("")            # chave de acesso do share ("" = aberto)
const KANBAN_TIMER = Ref{Union{Timer,Nothing}}(nothing)
const _HB_TICKS = Ref{Int}(0)
const _KANBAN_PEER_COLORS = Dict{String,Int}()   # IP -> cor estável na sessão
const _KANBAN_LOG_CAP = 500                   # eventos em memória
const _KANBAN_LOG_KEEP = 2000                 # linhas mantidas no .jsonl ao subir
const _KANBAN_CHAT_CAP = 300                  # mensagens em memória
const _KANBAN_CHAT_KEEP = 2000                # linhas mantidas no .jsonl ao subir

# _cap_text (teto de tamanho pra texto livre) vem de types.jl — compartilhado
# com o normalize! do gantt, mesmo valor no pacote inteiro.

_default_kanban_board() = Dict{String,Any}(
    "columns" => Any[
        Dict{String,Any}("id" => "c1", "name" => "backlog", "cards" => Any[]),
        Dict{String,Any}("id" => "c2", "name" => "doing", "cards" => Any[]),
        Dict{String,Any}("id" => "c3", "name" => "done", "cards" => Any[]),
    ],
    "archive" => Any[],
    "aliases" => Dict{String,Any}(),
)

# Nomes de board viram slugs de arquivo: minúsculas, dígitos, - e _.
#
# Acento é TRANSLITERADO, não descartado: "cálculo" vira "calculo". A
# versão anterior removia o caractere inteiro junto com o resto do que não
# fosse [a-z0-9_-], e "cálculo" virava "clculo" — quem digitasse o nome com
# e sem acento acabava com dois boards diferentes sem nenhum aviso, que foi
# exatamente o que aconteceu em uso real. Unicode.normalize(stripmark) é
# stdlib e resolve todo o alfabeto latino de uma vez (ç, ñ, ü, ...).
function _slugify(name::AbstractString)
    s = Unicode.normalize(lowercase(strip(String(name))); stripmark = true)
    s = replace(s, r"\s+" => "-")
    s = replace(s, r"[^a-z0-9_-]" => "")
    isempty(s) && throw(ArgumentError("kanban: invalid board name \"$name\""))
    return s
end

# O slug que a versão anterior geraria. Existe só para não perder board
# criado antes do conserto: um arquivo gravado como "clculo" continua
# respondendo pelo nome "cálculo" que o criou (ver _board_slug). Não lança
# em nome vazio — quem valida isso é o _slugify de verdade.
function _legacy_slug(name::AbstractString)
    s = lowercase(strip(String(name)))
    s = replace(s, r"\s+" => "-")
    return replace(s, r"[^a-z0-9_-]" => "")
end

# Nome digitado -> slug do arquivo, honrando o histórico: vale o slug novo,
# a menos que ele ainda não tenha arquivo e o antigo tenha. Assim o
# conserto não esconde board nenhum, e quando os DOIS existem (o caso de
# quem digitou com e sem acento) o novo ganha — é o nome escrito certo.
function _board_slug(dir::AbstractString, name::AbstractString)
    slug = _slugify(name)
    isfile(first(_board_paths(dir, slug))) && return slug
    old = _legacy_slug(name)
    (old != slug && !isempty(old) && isfile(first(_board_paths(dir, old)))) && return old
    return slug
end

_board_paths(dir::AbstractString, name::AbstractString) = name == "board" ?
    (joinpath(dir, "kanban.json"), joinpath(dir, "kanban-log.jsonl"),
     joinpath(dir, "kanban-chat.jsonl")) :
    (joinpath(dir, "kanban-$(name).json"), joinpath(dir, "kanban-$(name)-log.jsonl"),
     joinpath(dir, "kanban-$(name)-chat.jsonl"))

# Carrega um .jsonl append-only, rotacionando-o em disco para as últimas
# `keep` linhas (cresceria para sempre) e devolvendo só as últimas `cap`
# em memória. Usado pelo log de atividades e pelo chat — mesmo formato.
function _load_capped_jsonl(path::AbstractString, cap::Int, keep::Int)
    items = Any[]
    isfile(path) || return items
    try
        lines = filter(l -> !isempty(strip(l)), readlines(path))
        if length(lines) > keep
            lines = lines[end - keep + 1:end]
            tmp = path * ".tmp"
            open(io -> foreach(l -> println(io, l), lines), tmp, "w")
            mv(tmp, path; force = true)
        end
        for line in lines[max(1, end - cap + 1):end]
            push!(items, _plain(JSON3.read(line)))
        end
    catch err
        @warn "Perth kanban: ignoring unreadable file" path error = err
    end
    return items
end

# Carrega board + log + chat de um nome
function _load_board_files(dir::AbstractString, name::AbstractString)
    file, logfile, chatfile = _board_paths(dir, name)
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
    log = _load_capped_jsonl(logfile, _KANBAN_LOG_CAP, _KANBAN_LOG_KEEP)
    chat = _load_capped_jsonl(chatfile, _KANBAN_CHAT_CAP, _KANBAN_CHAT_KEEP)
    return board, log, chat, file, logfile, chatfile
end

function _init_kanban!(data_dir::AbstractString; name::AbstractString = "board")
    mkpath(data_dir)
    slug = _board_slug(data_dir, name)
    board, log, chat, file, logfile, chatfile = _load_board_files(data_dir, slug)
    KANBAN[] = KanbanState(board, 0, file, Dict{Int,KanbanClient}(), 0,
                           ReentrantLock(), log, logfile, chat, chatfile,
                           slug, String(data_dir))
    return KANBAN[]
end

# Troca o board ativo PARA TODOS (modelo "canal de TV compartilhada"):
# persiste o atual, carrega o novo (criando se não existir) e reenvia o
# init a cada cliente conectado.
function _kanban_use_board!(name::AbstractString)
    st = _kanban_state()
    slug = _board_slug(st.data_dir, name)
    changed = lock(st.lock) do
        slug == st.name && return false
        _kanban_persist(st)
        board, log, chat, file, logfile, chatfile = _load_board_files(st.data_dir, slug)
        st.board = board
        st.rev = 0
        st.file = file
        st.logfile = logfile
        st.log = log
        st.chatfile = chatfile
        st.chat = chat
        st.name = slug
        true
    end
    changed && _kanban_sync_all()
    return st.name
end

function _kanban_sync_all()
    st = _kanban_state()
    lock(st.lock) do
        for (id, c) in collect(st.clients)
            try
                HTTP.WebSockets.send(c.ws, _kanban_init_payload(st, c))
            catch
                delete!(st.clients, id)
            end
        end
    end
    return nothing
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
# e ligar/desligar a transmissão
_kanban_is_host(ip::AbstractString) = _presence_is_host(ip)

# Porteiro da transmissão: o host entra sempre; as demais máquinas, só
# enquanto a transmissão estiver ligada (ver kanban_share!)
_kanban_share_ok(ip::AbstractString) = KANBAN_SHARED[] || _kanban_is_host(ip)

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

# ---------------------------------------------------------------------------
# Permissões por IP (matriz configurada pelo host — Board -> Permissions…)
# ---------------------------------------------------------------------------
#
# Toda ação que mexe em cards ou colunas pode ser restrita por máquina; fora
# daqui ficam as ações de administração do board inteiro (resetBoard,
# setAutoArchive, setAlias, useBoard/newBoard), que já são só-host
# independentemente disso.
const _KANBAN_GATED_ACTIONS = (
    "addCard", "editCard", "delCard", "moveCard",
    "setDone", "archiveCard", "restoreCard", "delArchived",
    "setAssignee", "setDue", "addCheck", "toggleCheck", "delCheck",
    "addCol", "renameCol", "delCol", "moveCol", "setWip", "sortCol",
)

# Guardadas dentro do próprio board (mesmo padrão de "aliases"): persistem
# com o resto do board e sobrevivem a restart de graça. get! só é usado ao
# mutar (dentro do lock, em _kanban_apply!) — leitura usa get simples.
_kperms(st) = get!(st.board, "permissions", Dict{String,Any}())::Dict{String,Any}

# Fail-open por padrão: IP sem entrada na matriz, ou ação não listada na
# entrada do IP, é permitido. Isso preserva o comportamento atual de quem já
# usa o board (nenhuma restrição configurada = nada muda) e mantém ações
# futuras liberadas para IPs já restritos, em vez de negar por omissão. O
# host nunca é restringido — senão poderia se trancar fora do próprio board.
function _kanban_permitted(st::KanbanState, ip::AbstractString, action::AbstractString)::Bool
    _kanban_is_host(ip) && return true
    perms = get(st.board, "permissions", nothing)
    perms === nothing && return true
    ipperm = get(perms, String(ip), nothing)
    ipperm === nothing && return true
    return Bool(get(ipperm, action, true))
end

# Aplica uma operação (Dict de chaves String, vinda do WS ou do REPL).
# Retorna true se o board mudou. "toIndex" chega em base 0 (protocolo JS)
# e vira base 1 com clamp — colisões simultâneas resolvem por última
# escrita vence, sem quebrar.
function _kanban_apply!(st::KanbanState, op)::Bool
    t = String(op["type"])
    if t == "addCard"
        ci = _kfindcol(st, String(op["col"])); ci === nothing && return false
        card = Dict{String,Any}("id" => String(op["id"]), "text" => _cap_text(String(op["text"])),
                                "done" => Bool(get(op, "done", false)))
        haskey(op, "by") && (card["by"] = String(op["by"]))
        haskey(op, "at") && (card["at"] = String(op["at"]))
        d = strip(_cap_text(String(get(op, "due", ""))))
        isempty(d) || (card["due"] = String(d))
        for k in ("assignee", "done_at", "task", "project")   # undo/vínculo gantt preserva tudo
            haskey(op, k) && !isempty(String(op[k])) && (card[k] = String(op[k]))
        end
        haskey(op, "checklist") && (card["checklist"] = Any[c for c in op["checklist"]])
        dest = _kcols(st)[ci]["cards"]
        idx = haskey(op, "index") ?
            clamp(Int(op["index"]) + 1, 1, length(dest) + 1) : length(dest) + 1
        insert!(dest, idx, card)
    elseif t == "editCard"
        f = _kfindcard(st, String(op["id"])); f === nothing && return false
        f[1]["cards"][f[2]]["text"] = _cap_text(String(op["text"]))
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
                               "name" => _cap_text(String(op["name"])), "cards" => cards)
        idx = haskey(op, "index") ?
            clamp(Int(op["index"]) + 1, 1, length(_kcols(st)) + 1) :
            length(_kcols(st)) + 1
        insert!(_kcols(st), idx, col)
    elseif t == "renameCol"
        ci = _kfindcol(st, String(op["id"])); ci === nothing && return false
        _kcols(st)[ci]["name"] = _cap_text(String(op["name"]))
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
        card = f[1]["cards"][f[2]]
        card["done"] = Bool(op["done"])
        # done_at alimenta o auto-arquivamento por idade
        Bool(op["done"]) ? (card["done_at"] = _kanban_now()) : delete!(card, "done_at")
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
    elseif t == "resetBoard"
        # zera colunas e arquivo; aliases/permissões são config de
        # máquinas, não conteúdo do board — sobrevivem
        al = copy(_kaliases(st))
        pm = copy(_kperms(st))
        st.board = _default_kanban_board()
        st.board["aliases"] = al
        st.board["permissions"] = pm
    elseif t == "setAssignee"
        f = _kfindcard(st, String(op["id"])); f === nothing && return false
        n = strip(_cap_text(String(get(op, "name", ""))))
        card = f[1]["cards"][f[2]]
        isempty(n) ? delete!(card, "assignee") : (card["assignee"] = String(n))
    elseif t == "addCheck"
        f = _kfindcard(st, String(op["card"])); f === nothing && return false
        cl = get!(f[1]["cards"][f[2]], "checklist", Any[])
        push!(cl, Dict{String,Any}("id" => String(op["id"]),
                                   "text" => _cap_text(String(op["text"])), "done" => false))
    elseif t == "toggleCheck"
        f = _kfindcard(st, String(op["card"])); f === nothing && return false
        cl = get(f[1]["cards"][f[2]], "checklist", Any[])
        i = findfirst(c -> c["id"] == String(op["id"]), cl)
        i === nothing && return false
        cl[i]["done"] = Bool(op["done"])
    elseif t == "delCheck"
        f = _kfindcard(st, String(op["card"])); f === nothing && return false
        cl = get(f[1]["cards"][f[2]], "checklist", Any[])
        i = findfirst(c -> c["id"] == String(op["id"]), cl)
        i === nothing && return false
        deleteat!(cl, i)
    elseif t == "setAutoArchive"
        d = Int(op["days"])
        d > 0 ? (st.board["auto_archive_days"] = d) :
                delete!(st.board, "auto_archive_days")
    elseif t == "setWip"
        # limite de WIP é sinalização, não trava: a coluna fica vermelha ao
        # estourar, mas mover continua permitido (kanban clássico)
        ci = _kfindcol(st, String(op["id"])); ci === nothing && return false
        w = Int(op["wip"])
        col = _kcols(st)[ci]
        w > 0 ? (col["wip"] = w) : delete!(col, "wip")
    elseif t == "setDue"
        f = _kfindcard(st, String(op["id"])); f === nothing && return false
        d = strip(_cap_text(String(get(op, "due", ""))))
        card = f[1]["cards"][f[2]]
        isempty(d) ? delete!(card, "due") : (card["due"] = String(d))
    elseif t == "sortCol"
        ci = _kfindcol(st, String(op["id"])); ci === nothing && return false
        # sem prazo vai para o fim; sort é estável (empates mantêm a ordem)
        sort!(_kcols(st)[ci]["cards"], by = c -> String(get(c, "due", "9999-99-99")))
    elseif t == "setAlias"
        ip = strip(String(op["ip"]))
        isempty(ip) && return false
        name = strip(_cap_text(String(get(op, "name", ""))))
        al = _kaliases(st)
        isempty(name) ? delete!(al, String(ip)) : (al[String(ip)] = String(name))
    elseif t == "setPermissions"
        # um único op cobre toggle individual e ações em lote (linha,
        # coluna ou tudo, vindas do modal): um log, um broadcast
        changes = get(op, "changes", Any[])
        isempty(changes) && return false
        perms = _kperms(st)
        changed = false
        for ch in changes
            ip = strip(String(get(ch, "ip", "")))
            isempty(ip) && continue
            action = String(get(ch, "action", ""))
            action in _KANBAN_GATED_ACTIONS || continue
            ipperm = get!(perms, ip, Dict{String,Any}())::Dict{String,Any}
            ipperm[action] = Bool(get(ch, "allowed", true))
            changed = true
        end
        # nenhuma mudança válida (só IPs vazios/ações fora da lista): não
        # gera log, persistência nem broadcast à toa
        changed || return false
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
    elseif t == "resetBoard"
        return "reset the board", true
    elseif t == "setAssignee"
        n = strip(String(get(op, "name", "")))
        return (isempty(n) ? "unassigned \"$(cardtext(op["id"]))\"" :
                             "assigned \"$(cardtext(op["id"]))\" to $(n)"), false
    elseif t == "addCheck"
        return "added \"$(snip(get(op, "text", "")))\" to checklist", false
    elseif t == "toggleCheck"
        done = Bool(op["done"])
        return (done ? "checked a checklist item" : "unchecked a checklist item"), false
    elseif t == "delCheck"
        return "deleted a checklist item", false
    elseif t == "setAutoArchive"
        d = Int(op["days"])
        return (d > 0 ? "set auto-archive of done cards to $(d) day$(d == 1 ? "" : "s")" :
                        "disabled auto-archive"), false
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
    elseif t == "setPermissions"
        changes = get(op, "changes", Any[])
        ips = unique(strip(String(get(c, "ip", ""))) for c in changes)
        n = length(changes)
        return (length(ips) == 1 ?
            "updated $(n) permission$(n == 1 ? "" : "s") for $(first(ips))" :
            "updated permissions for $(length(ips)) machine$(length(ips) == 1 ? "" : "s")"), false
    end
    return "", false
end

function _kanban_log_append(path::AbstractString, entry)
    try
        open(path, "a") do io
            JSON3.write(io, entry)
            print(io, '\n')
        end
    catch err
        @warn "Perth kanban: could not persist" path error = err
    end
end

# ---------------------------------------------------------------------------
# Ponte de campos kanban <-> gantt. Um card vinculado (campos task/project)
# espelha a tarefa: texto (1ª linha) <-> nome, responsável <-> assignee,
# prazo (due) <-> data-fim (duração recalculada respeitando o calendário) e
# concluído <-> progresso 100. Cada direção só grava quando o valor muda,
# então os ecos convergem em um passo — sem ping-pong.
# ---------------------------------------------------------------------------

# Aplica no gantt a mudança vinda de um card vinculado.
# kind: :done(Bool), :assignee(String), :due(String), :text(String)
function _apply_card_sync(card, kind::Symbol, val)
    tid = String(get(card, "task", ""))
    pid = String(get(card, "project", ""))
    (isempty(tid) || isempty(pid)) && return nothing
    try
        _with_state(st -> begin
            p = get(st.projects, pid, nothing)
            p === nothing && return nothing
            i = findfirst(t -> t.id == tid, p.tasks)
            i === nothing && return nothing
            t = p.tasks[i]
            if kind === :done
                done = Bool(val)
                if done && t.progress < 100
                    t.progress = 100
                    _log_activity!(st, "kanban", "edit",
                                   "completed \"$(t.name)\" — $(p.name) (via kanban)")
                    _save!(st, p)
                elseif !done && t.progress == 100
                    t.progress = 0
                    _log_activity!(st, "kanban", "edit",
                                   "reopened \"$(t.name)\" — $(p.name) (via kanban)")
                    _save!(st, p)
                end
            elseif kind === :assignee
                a = strip(String(val))
                if t.assignee != a
                    t.assignee = String(a)
                    _log_activity!(st, "kanban", "edit",
                                   "assigned \"$(t.name)\" to $(isempty(a) ? "nobody" : a) (via kanban)")
                    _save!(st, p)
                end
            elseif kind === :due
                d = strip(String(val))
                isempty(d) && return nothing        # prazo removido: tarefa não muda
                due = tryparse(Date, d)
                due === nothing && return nothing
                dur = _dur_between(_cal(p), t.start, due)
                if !t.milestone && t.duration != dur
                    t.duration = dur
                    _log_activity!(st, "kanban", "edit",
                                   "rescheduled \"$(t.name)\" to end $(d) (via kanban)")
                    _save!(st, p)
                end
            elseif kind === :text
                name = String(first(split(String(val), '\n')))
                if !isempty(strip(name)) && t.name != name
                    _log_activity!(st, "kanban", "edit",
                                   "renamed \"$(t.name)\" to \"$(name)\" (via kanban)")
                    t.name = name
                    _save!(st, p)
                end
            end
            nothing
        end)
    catch err
        @warn "Perth kanban: could not sync linked gantt task" error = err
    end
    return nothing
end

# Após aplicar uma op, decide se ela deve refletir na tarefa vinculada.
function _linked_sync_of(st::KanbanState, op)
    t = String(get(op, "type", ""))
    card_of(id) = begin
        f = _kfindcard(st, String(id))
        f === nothing ? nothing : f
    end
    if t == "setDone"
        f = card_of(op["id"]); f === nothing && return nothing
        card = f[1]["cards"][f[2]]
        haskey(card, "task") || return nothing
        return (copy(card), :done, Bool(op["done"]))
    elseif t == "moveCard"
        f = card_of(op["id"]); f === nothing && return nothing
        card = f[1]["cards"][f[2]]
        haskey(card, "task") || return nothing
        return (copy(card), :done, lowercase(String(f[1]["name"])) == "done")
    elseif t == "setAssignee"
        f = card_of(op["id"]); f === nothing && return nothing
        card = f[1]["cards"][f[2]]
        haskey(card, "task") || return nothing
        return (copy(card), :assignee, String(get(op, "name", "")))
    elseif t == "setDue"
        f = card_of(op["id"]); f === nothing && return nothing
        card = f[1]["cards"][f[2]]
        haskey(card, "task") || return nothing
        return (copy(card), :due, String(get(op, "due", "")))
    elseif t == "editCard"
        f = card_of(op["id"]); f === nothing && return nothing
        card = f[1]["cards"][f[2]]
        haskey(card, "task") || return nothing
        return (copy(card), :text, String(op["text"]))
    end
    return nothing
end

# Aplica + persiste + registra no log + broadcast. Ponto único de mutação:
# WS e REPL passam por aqui, então uma edição no REPL aparece ao vivo em
# todos os navegadores — e entra no mesmo log de atividades.
function _kanban_commit!(op; from::Int = -1, actor::AbstractString = "repl",
                         quiet::Bool = false, sync::Bool = false)::Bool
    st = _kanban_state()
    local entry = nothing
    local linked = nothing
    ok = lock(st.lock) do
        text, notify = _kanban_describe(st, op)
        changed = _kanban_apply!(st, op)
        # ops vindas do próprio gantt (sync=true) não reecoam de volta
        changed && !sync && (linked = _linked_sync_of(st, op))
        if changed
            st.rev += 1
            _kanban_persist(st)
            if !isempty(text) && !quiet
                entry = Dict{String,Any}(
                    "at" => _kanban_now(), "ip" => String(actor),
                    "type" => String(op["type"]), "text" => text,
                    "notify" => notify)
                push!(st.log, entry)
                length(st.log) > _KANBAN_LOG_CAP && popfirst!(st.log)
                _kanban_log_append(st.logfile, entry)
            end
        end
        changed
    end
    if ok
        msg = Dict{String,Any}("type" => "op", "op" => op, "rev" => st.rev,
                               "from" => from, "board" => st.board)
        entry === nothing || (msg["log"] = entry)
        _kanban_broadcast(JSON3.write(msg))
        linked === nothing || _apply_card_sync(linked...)
    end
    return ok
end

# Chat é um canal à parte do board (sem lock de op, sem undo/redo, sem
# entrar no log de atividades): só uma lista append-only, persistida e
# rebroadcast. WS e REPL passam por aqui, como em _kanban_commit!.
function _kanban_chat_commit!(text::AbstractString; actor::AbstractString = "repl")
    text = _cap_text(strip(String(text)))
    isempty(text) && return false
    st = _kanban_state()
    entry = Dict{String,Any}("at" => _kanban_now(), "ip" => String(actor), "text" => text)
    lock(st.lock) do
        push!(st.chat, entry)
        length(st.chat) > _KANBAN_CHAT_CAP && popfirst!(st.chat)
    end
    _kanban_log_append(st.chatfile, entry)
    _kanban_broadcast(JSON3.write(Dict{String,Any}("type" => "chat", "entry" => entry)))
    return true
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

# O que num card vinculado está diferente da tarefa, como pares
# (campo => valor novo). Uma função só, usada pelas DUAS direções de
# escrita: o board carregado (que vira op de verdade, com broadcast para
# quem está olhando) e os boards que só existem em disco. Sem isto a regra
# de espelhamento teria duas cópias, que divergiriam na primeira mudança.
#
# Cada campo só entra quando o valor difere, e é isso que faz o eco da
# direção contrária convergir em um passo, sem ping-pong.
function _card_task_diff(p::Project, card, t::GanttTask)
    out = Pair{String,Any}[]
    # nome <-> 1ª linha do texto (preserva descrição/tags das demais)
    lines = split(String(card["text"]), '\n')
    String(first(lines)) == t.name ||
        push!(out, "text" => join([t.name; lines[2:end]], "\n"))
    String(get(card, "assignee", "")) == t.assignee ||
        push!(out, "assignee" => t.assignee)
    due = string(end_date(p, t))
    String(get(card, "due", "")) == due || push!(out, "due" => due)
    done = t.progress >= 100
    Bool(get(card, "done", false)) == done || push!(out, "done" => done)
    return out
end

# A diferença virando op, para o board carregado
function _sync_op(field::AbstractString, id::AbstractString, val)
    field == "text" &&
        return Dict{String,Any}("type" => "editCard", "id" => id, "text" => val)
    field == "assignee" &&
        return Dict{String,Any}("type" => "setAssignee", "id" => id, "name" => val)
    field == "due" &&
        return Dict{String,Any}("type" => "setDue", "id" => id, "due" => val)
    return Dict{String,Any}("type" => "setDone", "id" => id, "done" => val)
end

# A mesma diferença aplicada direto no Dict do card, para board em disco.
# Espelha _kanban_apply! campo a campo — inclusive apagar a chave quando o
# valor fica vazio e carimbar done_at, que é o que alimenta o
# auto-arquivamento por idade. Divergir daqui faria o board de disco ficar
# num formato que o board carregado nunca produz.
function _apply_card_diff!(card, diff)
    for (field, val) in diff
        if field == "text"
            card["text"] = _cap_text(String(val))
        elseif field == "assignee"
            s = strip(String(val))
            isempty(s) ? delete!(card, "assignee") : (card["assignee"] = String(s))
        elseif field == "due"
            s = strip(String(val))
            isempty(s) ? delete!(card, "due") : (card["due"] = String(s))
        elseif field == "done"
            card["done"] = Bool(val)
            Bool(val) ? (card["done_at"] = _kanban_now()) : delete!(card, "done_at")
        end
    end
    return card
end

# Espelha o projeto nos boards que NÃO estão carregados agora.
#
# Sem isto, um card vinculado a uma tarefa do gantt só acompanha o projeto
# enquanto o board dele for o board ativo: editar a tarefa com outro board
# aberto deixava o card velho para SEMPRE — voltar para o board só relê o
# arquivo, que já estava desatualizado. E como o kanban tem um board por
# vez, bastava ter dois boards para a ponte parar de valer no segundo.
#
# Não precisa carregar board nenhum para consertar: estes arquivos não têm
# cliente conectado (o único board com clientes é o ativo), então não há o
# que transmitir nem log a escrever — é ler, aplicar e regravar.
#
# Porta barata: sem o id do projeto no texto cru do arquivo não existe card
# vinculado ali, e a maioria dos boards cai fora sem passar por JSON.
function _sync_boards_on_disk(p::Project, dir::AbstractString,
                              active::AbstractString)
    files = try
        [joinpath(dir, f) for f in readdir(dir)
         if startswith(f, "kanban") && endswith(f, ".json")]
    catch
        return 0
    end
    byid = Dict(t.id => t for t in p.tasks)
    touched = 0
    for file in files
        file == active && continue          # o ativo vai pelo caminho das ops
        raw = try
            read(file, String)
        catch
            continue
        end
        occursin(p.id, raw) || continue
        board = try
            _plain(JSON3.read(raw))
        catch err
            @warn "Perth kanban: ignoring unreadable board file" file error = err
            nothing
        end
        (board === nothing || !haskey(board, "columns")) && continue
        changed = false
        # o arquivo (archive) fica de fora, como no board carregado: card
        # arquivado é trabalho encerrado, não espelho de tarefa viva
        for c in board["columns"]::Vector{Any}, card in c["cards"]
            String(get(card, "project", "")) == p.id || continue
            t = get(byid, String(get(card, "task", "")), nothing)
            t === nothing && continue       # tarefa excluída: card fica
            diff = _card_task_diff(p, card, t)
            isempty(diff) && continue
            _apply_card_diff!(card, diff)
            changed = true
        end
        changed || continue
        # gravação atômica, como _kanban_persist: se alguém trocar para
        # este board no meio, lê o arquivo inteiro velho ou o inteiro novo,
        # nunca um pela metade — e o velho se corrige no próximo save,
        # quando ele passa a ser o board ativo
        tmp = file * ".tmp"
        try
            open(io -> JSON3.write(io, board), tmp, "w")
            mv(tmp, file; force = true)
            touched += 1
        catch err
            @warn "Perth kanban: could not sync board file" file error = err
        end
    end
    return touched
end

# Espelha um projeto salvo nas cartas vinculadas a ele (hook _ON_SAVE do
# storage), em TODOS os boards — o carregado por ops (que os navegadores
# conectados recebem ao vivo) e os demais direto no arquivo. Ops de sync
# não entram no log de atividades (quiet) e não reecoam para o gantt
# (sync=true).
function _kanban_sync_from_project(p::Project)
    ops = Any[]
    if KANBAN[] !== nothing
        byid = Dict(t.id => t for t in p.tasks)
        _with_kanban(st -> begin
            for c in _kcols(st), card in c["cards"]
                String(get(card, "project", "")) == p.id || continue
                t = get(byid, String(get(card, "task", "")), nothing)
                t === nothing && continue       # tarefa excluída: card fica
                for (field, val) in _card_task_diff(p, card, t)
                    push!(ops, _sync_op(field, String(card["id"]), val))
                end
            end
        end)
    end
    for op in ops
        _kanban_commit!(op; actor = "gantt", quiet = true, sync = true)
    end
    # os boards em disco valem mesmo com o kanban nunca aberto nesta sessão:
    # os cards existem lá independentemente de alguém ter olhado. Quem nunca
    # usou o kanban não tem arquivo kanban*.json, e a varredura custa um
    # readdir do diretório em que o projeto acabou de ser gravado.
    dir = KANBAN[] === nothing ? _state().data_dir : KANBAN[].data_dir
    _sync_boards_on_disk(p, dir, KANBAN[] === nothing ? "" : KANBAN[].file)
    return nothing
end

"""
    kanban_from_project!(project; replace = false) -> Int

Populate the active kanban board from a Gantt [`Project`](@ref) (or a
project name/id), creating one card per leaf task in `backlog`, `doing`
or `done` according to its progress (0 / 1–99 / 100). Cards are *linked*
to their tasks: dragging a linked card into the `done` column (or ticking
it done) sets the task's progress to 100 in the Gantt — live, on every
connected browser — and dragging it out reopens it.

Tasks that already have a linked card on the board are skipped, so the
function is idempotent; pass `replace = true` to remove previously linked
cards first. Returns the number of cards created.

The link holds across boards: editing a task in the Gantt updates its
card even when that card sits on a board nobody has open — the board
file is rewritten in place. Switching boards is not a way to lose the
mirror.
"""
function kanban_from_project!(p::Project; replace::Bool = false)
    if replace
        ids = String[]
        _with_kanban(st -> begin
            for c in _kcols(st), card in c["cards"]
                get(card, "project", "") == p.id && push!(ids, String(card["id"]))
            end
        end)
        for id in ids
            _kanban_commit!(Dict{String,Any}("type" => "delCard", "id" => id))
        end
    end
    linkedids = Set{String}()
    _with_kanban(st -> begin
        for c in _kcols(st), card in c["cards"]
            get(card, "project", "") == p.id &&
                push!(linkedids, String(get(card, "task", "")))
        end
    end)
    colfor(prog) = prog >= 100 ? "done" : prog > 0 ? "doing" : "backlog"
    made = 0
    for t in p.tasks
        _has_children(p, t.id) && continue      # resumos são contêineres
        t.id in linkedids && continue
        col = _with_kanban(st -> _kanban_col(st, colfor(t.progress)))
        col === nothing && continue             # coluna renomeada: pula
        op = Dict{String,Any}("type" => "addCard", "col" => col["id"],
            "id" => _short_id(), "text" => String(t.name),
            "done" => t.progress >= 100, "task" => t.id, "project" => p.id,
            "due" => string(end_date(p, t)),
            "by" => "repl", "at" => _kanban_now())
        isempty(t.assignee) || (op["assignee"] = String(t.assignee))
        _kanban_commit!(op) && (made += 1)
    end
    return made
end

kanban_from_project!(name::AbstractString; kwargs...) =
    kanban_from_project!(project(name); kwargs...)

"""
    kanban_reset!() -> Bool

Wipe the shared kanban board back to the default empty columns
(backlog / doing / done), clearing cards and the archive. Host aliases
survive — they describe machines, not cards. The reset is broadcast live
and recorded in the activity log. Also available in the UI (Board →
Reset board…) on the host machine only.
"""
kanban_reset!() = _kanban_commit!(Dict{String,Any}("type" => "resetBoard"))

"""
    kanban_boards() -> Vector{String}

Names of the boards found in the Perth data directory (plus the active
one). Switch with [`kanban_board!`](@ref) or `Perth.kanban("name")`.
"""
function kanban_boards()
    st = _kanban_state()
    names = Set{String}([st.name])
    try
        for f in readdir(st.data_dir)
            f == "kanban.json" && push!(names, "board")
            m = match(r"^kanban-(.+)\.json$", f)
            m === nothing || push!(names, String(m.captures[1]))
        end
    catch
    end
    return sort!(collect(names))
end

"""
    kanban_board!(name) -> String

Switch the active board — for every connected browser at once (the
board is one shared space, like a TV channel). Creates the board on
first use. Also available in the UI (Board → Boards…) to the host.
"""
kanban_board!(name::AbstractString) = _kanban_use_board!(name)

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
    kanban_chat!(text) -> Bool

Post a message to the shared kanban chat — visible live on every
connected browser, under actor `"repl"`, same as other REPL mutations.
"""
kanban_chat!(text::AbstractString) = _kanban_chat_commit!(text)

"""
    kanban_chat_log(; limit = 50) -> Vector{NamedTuple}

Latest messages on the shared kanban chat as `(at, by, text)` rows,
newest first. Tables.jl-compatible.
"""
kanban_chat_log(; limit::Integer = 50) = _with_kanban(st ->
    [(at = String(e["at"]), by = String(e["ip"]), text = String(e["text"]))
     for e in reverse(st.chat[max(1, end - limit + 1):end])])

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
            "chat" => st.chat[max(1, end - 99):end],
            "board_name" => st.name,
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

function _kanban_ws(ws::HTTP.WebSockets.WebSocket, ip::String, keyok::Bool = true)
    if !keyok
        # sem a chave não há board: envia o motivo e encerra educadamente
        return _presence_deny(ws, "key")
    end
    st = _kanban_state()
    me = lock(st.lock) do
        st.nextid += 1
        c = KanbanClient(st.nextid, ws, ip, ip,
                         _color_for_ip(_KANBAN_PEER_COLORS, ip))
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
                # autoridade é o servidor: mesmo que o cliente burle a UI e
                # mande a op direto, uma máquina restrita não passa daqui.
                # A aplicação otimista que o cliente já fez localmente é
                # revertida pelo resync (init) que segue a negativa.
                if optype in _KANBAN_GATED_ACTIONS && !_kanban_permitted(st, me.ip, optype)
                    HTTP.WebSockets.send(ws, JSON3.write(Dict(
                        "type" => "opDenied", "action" => optype)))
                    HTTP.WebSockets.send(ws, _kanban_init_payload(st, me))
                    continue
                end
                if optype == "addCard"
                    # criador default é a ponta da conexão; ops de undo já
                    # trazem o autor original e são respeitadas
                    haskey(op, "by") || (op["by"] = me.ip)
                    haskey(op, "at") || (op["at"] = _kanban_now())
                elseif optype in ("setAlias", "resetBoard", "setAutoArchive", "setPermissions") &&
                       !_kanban_is_host(me.ip)
                    # só o host renomeia usuários / mexe em config do board;
                    # ressincroniza o insistente
                    HTTP.WebSockets.send(ws, _kanban_init_payload(st, me))
                    continue
                end
                ok = _kanban_commit!(op; from = me.id, actor = me.ip)
                # op inválida (ex.: card já removido por outra máquina):
                # ressincroniza só este cliente
                ok || HTTP.WebSockets.send(ws, _kanban_init_payload(st, me))
            elseif t == "chat"
                _kanban_chat_commit!(String(get(msg, "text", "")); actor = me.ip)
            elseif t == "typing"
                # sinal efêmero, não persiste: cada cliente expira sozinho
                # quem estava digitando se ninguém reenviar em alguns segundos
                _kanban_broadcast(JSON3.write(Dict("type" => "typing",
                                                   "from" => me.id)); except = me.id)
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
            elseif t == "useBoard" || t == "newBoard"
                # trocar o board troca para TODOS; só o host comanda
                if _kanban_is_host(me.ip)
                    try
                        _kanban_use_board!(String(get(msg, "name", "")))
                    catch err
                        err isa ArgumentError || rethrow()
                    end
                else
                    HTTP.WebSockets.send(ws, _kanban_init_payload(st, me))
                end
            end
        end
    catch err
        _ws_disconnect(err) || @warn "Perth kanban: websocket error" error = err
    finally
        lock(st.lock) do
            delete!(st.clients, me.id)
        end
        _kanban_broadcast(JSON3.write(Dict("type" => "leave", "id" => me.id)))
    end
    return nothing
end

const _KANBAN_DONE_FMT = dateformat"yyyy-mm-dd HH:MM"

# Move para o arquivo os cards concluídos há mais de auto_archive_days.
# Roda no timer do heartbeat (a cada hora). Cards concluídos antes desta
# feature (sem done_at) ganham o carimbo agora — a contagem começa hoje.
function _kanban_autoarchive_sweep!()
    st = _kanban_state()
    local entry = nothing
    lock(st.lock) do
        days = Int(get(st.board, "auto_archive_days", 0))
        days > 0 || return
        now = Dates.now()
        moved = 0
        for col in _kcols(st)
            cards = col["cards"]
            i = 1
            while i <= length(cards)
                card = cards[i]
                if get(card, "done", false) === true
                    dt = try
                        Dates.DateTime(String(get(card, "done_at", "")), _KANBAN_DONE_FMT)
                    catch
                        card["done_at"] = _kanban_now()
                        nothing
                    end
                    if dt !== nothing && dt + Dates.Day(days) < now
                        deleteat!(cards, i)
                        e = copy(card)
                        e["col"] = String(col["name"])
                        e["archived_at"] = _kanban_now()
                        push!(_karchive(st), e)
                        moved += 1
                        continue
                    end
                end
                i += 1
            end
        end
        if moved > 0
            st.rev += 1
            _kanban_persist(st)
            entry = Dict{String,Any}("at" => _kanban_now(), "ip" => "server",
                "type" => "autoArchive", "notify" => false,
                "text" => "auto-archived $(moved) done card$(moved == 1 ? "" : "s")")
            push!(st.log, entry)
            length(st.log) > _KANBAN_LOG_CAP && popfirst!(st.log)
            _kanban_log_append(st.logfile, entry)
        end
    end
    entry === nothing || _kanban_broadcast(JSON3.write(Dict{String,Any}(
        "type" => "op", "op" => Dict("type" => "autoArchive"), "rev" => st.rev,
        "from" => -1, "board" => st.board, "log" => entry)))
    return nothing
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
    "/shared/ui.css" => ("shared/ui.css", :main),
    "/shared/presence.js" => ("shared/presence.js", :main),
    "/shared/i18n.js" => ("shared/i18n.js", :main),
    "/shared/draggable.js" => ("shared/draggable.js", :main),
    "/shared/background.js" => ("shared/background.js", :main),
    "/shared/shortcuts.js" => ("shared/shortcuts.js", :main),
    "/shared/toast.js" => ("shared/toast.js", :main),
    "/manifest.webmanifest" => ("kanban/manifest.webmanifest", :root),
    "/sw.js" => ("shared/sw.js", :root),
)

_key_suffix() = isempty(KANBAN_KEY[]) ? "" :
    "?key=" * HTTP.URIs.escapeuri(KANBAN_KEY[])

function _kanban_boards_info()
    _json((; boards = kanban_boards(), current = _kanban_state().name))
end

function _kanban_urls()
    urls = ["http://localhost:$(KANBAN_PORT[])" * _key_suffix()]
    KANBAN_SHARED[] || return urls
    for a in _lan_ipv4()
        push!(urls, "http://$(a):$(KANBAN_PORT[])" * _key_suffix())
    end
    return urls
end

function _kanban_share_payload(ip::AbstractString = "")
    urls = _kanban_urls()
    target = length(urls) > 1 ? urls[2] : urls[1]
    return (; urls, target, qr = _qr_rows(target),
            shared = KANBAN_SHARED[], can_share = KANBAN_CAN_SHARE[],
            keyed = !isempty(KANBAN_KEY[]), host = _kanban_is_host(ip))
end

function _kanban_share_toggle(req::HTTP.Request, ip::AbstractString)
    _kanban_is_host(ip) ||
        return _error("only the machine running Perth can change this"; status = 403)
    on = try
        Bool(get(JSON3.read(String(req.body)), "on", !KANBAN_SHARED[]))
    catch
        !KANBAN_SHARED[]
    end
    try
        kanban_share!(on; actor = ip)
    catch err
        err isa ArgumentError && return _error(err.msg; status = 409)
        rethrow()
    end
    return _json(_kanban_share_payload(ip))
end

"""
    kanban_key!(key = "") -> Bool

Set (or drop, with `""`) the access key of the running kanban board,
live — no restart, no [`Perth.kanban_stop`](@ref). Returns whether a key
is required from now on. Twin of [`Perth.key!`](@ref) for the board:
machines on the network must send the key (the links Perth prints carry
it), the machine running the server never needs it, and changing it
disconnects everyone on the network, who are then asked for the new key
on screen. Dropping the key disconnects nobody.

The same control is in the UI (Board → Share / QR…), available only
from the machine running the server.
"""
function kanban_key!(key::AbstractString = ""; actor::AbstractString = "repl")
    KANBAN_SERVER[] === nothing &&
        throw(ArgumentError("Perth kanban is not running — Perth.kanban() first"))
    new = _cap_text(strip(String(key)))
    KANBAN_KEY[] == new && return !isempty(new)
    KANBAN_KEY[] = new
    # a chave antiga virou inválida; tirar a chave não invalida ninguém
    # (ver key!) — derrubar só pediria na tela uma chave que não existe mais
    isempty(new) || _kanban_drop_remote!(; reason = "key")
    st = _kanban_state()
    entry = Dict{String,Any}(
        "at" => _kanban_now(), "ip" => String(actor), "type" => "key",
        "text" => isempty(new) ? "removed the access key" : "changed the access key",
        "notify" => false)
    lock(st.lock) do
        push!(st.log, entry)
        length(st.log) > _KANBAN_LOG_CAP && popfirst!(st.log)
    end
    _kanban_log_append(st.logfile, entry)
    _kanban_broadcast(JSON3.write((; type = "key", keyed = !isempty(new), log = entry)))
    @info(isempty(new) ?
          "Perth kanban: access key removed — anyone on the network can open the board." :
          "Perth kanban: access key set — new links: " * join(_kanban_urls(), " "))
    return !isempty(new)
end

# POST /api/key {"key": "…"} — só do host, como o toggle da transmissão
function _kanban_key_set(req::HTTP.Request, ip::AbstractString)
    _kanban_is_host(ip) ||
        return _error("only the machine running Perth can change this"; status = 403)
    key = try
        String(get(JSON3.read(String(req.body)), "key", ""))
    catch
        return _error("expected {\"key\": \"…\"}"; status = 400)
    end
    try
        kanban_key!(key; actor = ip)
    catch err
        err isa ArgumentError && return _error(err.msg; status = 409)
        rethrow()
    end
    return _json(_kanban_share_payload(ip))
end

# Derruba as conexões de máquinas remotas, preservando as do host — irmã de
# _hub_drop_remote! (presence.jl) para o dicionário de clientes do kanban.
# `reason` escolhe o diálogo do outro lado — ver _hub_drop_remote!.
function _kanban_drop_remote!(; reason::AbstractString = "share_off")
    st = _kanban_state()
    gone = lock(st.lock) do
        out = KanbanClient[]
        for (id, c) in collect(st.clients)
            _kanban_is_host(c.ip) && continue
            delete!(st.clients, id)
            push!(out, c)
        end
        out
    end
    for c in gone
        _presence_deny(c.ws, reason)
        _kanban_broadcast(JSON3.write(Dict("type" => "leave", "id" => c.id)))
    end
    return length(gone)
end

"""
    kanban_share!(on = true) -> Bool

Turn network sharing on or off on the running kanban server, live — no
restart, no [`Perth.kanban_stop`](@ref). With sharing on, other machines
on the local network can open the same board (see [`Perth.kanban`](@ref));
with it off, only this machine can, and remote browsers already connected
are disconnected immediately.

The same switch is in the UI (Board → Share / QR…), available only from
the machine running the server. Sharing can only be toggled when the
server was started without an explicit `host`.
"""
function kanban_share!(on::Bool = true; actor::AbstractString = "repl")
    KANBAN_SERVER[] === nothing &&
        throw(ArgumentError("Perth kanban is not running — Perth.kanban() first"))
    KANBAN_CAN_SHARE[] || throw(ArgumentError(
        "this board is bound to a fixed address — restart without `host` to allow toggling"))
    KANBAN_SHARED[] == on && return on
    KANBAN_SHARED[] = on
    on || _kanban_drop_remote!()   # o porteiro só barra conexões novas
    st = _kanban_state()
    entry = Dict{String,Any}(
        "at" => _kanban_now(), "ip" => String(actor), "type" => "share",
        "text" => on ? "turned sharing on" : "turned sharing off",
        "notify" => false)
    lock(st.lock) do
        push!(st.log, entry)
        length(st.log) > _KANBAN_LOG_CAP && popfirst!(st.log)
    end
    _kanban_log_append(st.logfile, entry)
    _kanban_broadcast(JSON3.write((; type = "share", shared = on, log = entry)))
    if on
        for u in _kanban_urls()[2:end]
            @info "Perth kanban: sharing on — $u"
        end
    else
        @info "Perth kanban: sharing off — localhost only."
    end
    return on
end

function _kanban_static(req::HTTP.Request, ip::AbstractString = "127.0.0.1")
    uri = HTTP.URI(req.target)
    path = uri.path
    # porteiro da transmissão: com o share desligado a porta existe (para o
    # botão poder religá-la) mas só atende a máquina do servidor
    _kanban_share_ok(ip) ||
        return _error("this board is not being shared to the network"; status = 403)
    # rotas de dados respeitam a chave; o host (loopback) é isento
    if _key_protected(path)
        _keyok(ip, HTTP.URIs.queryparams(uri), KANBAN_KEY[]) ||
            return _error("access key required"; status = 403)
    end
    if startswith(path, "/api/")
        if path == "/api/share"
            return req.method == "POST" ? _kanban_share_toggle(req, ip) :
                   _json(_kanban_share_payload(ip))
        end
        path == "/api/key" && req.method == "POST" &&
            return _kanban_key_set(req, ip)
        path == "/api/background" && return _json(_bg_payload())
        path == "/api/boards" && return _kanban_boards_info()
        if path == "/api/apps"
            return _json((; app = "kanban", kanban = KANBAN_PORT[],
                          gantt = SERVER[] === nothing ? nothing : PORT[]))
        end
        if path == "/api/launch/gantt"
            try
                SERVER[] === nothing && run(open_browser = false)
                return _json((; port = PORT[]))
            catch err
                @error "Perth: could not launch gantt from the UI" error = err
                return _error("could not start the gantt: $(sprint(showerror, err))";
                              status = 500)
            end
        end
        return _error("not found"; status = 404)
    end
    # Fundo da UI: bytes vêm de fora do frontend (caminho apontado pelo
    # REPL), então não passa pela whitelist de arquivos estáticos — e por
    # isso a chave o protege como um endpoint de dados (_key_protected)
    path == "/background" && return _bg_response(req)
    entry = get(_KANBAN_FILES, path, nothing)
    entry === nothing && return _error("not found"; status = 404)
    name, origin = entry
    file = origin === :kanban ? joinpath(_KANBAN_DIR, name) :
           joinpath(_FRONTEND_DIR, name)   # :main e :root são relativos a frontend/
    isfile(file) || return _error("not found"; status = 404)
    ext = splitext(file)[2]
    mime = ext == ".mp3" ? "audio/mpeg" :
        ext == ".webmanifest" ? "application/manifest+json" :
        get(_MIME, ext, "application/octet-stream")
    return HTTP.Response(200, ["Content-Type" => mime,
                               "Cache-Control" => "no-store"], read(file))
end

# WebSocket exige handler de stream; o resto delega ao handler de Request
function _kanban_handler(http::HTTP.Stream)
    ip = _peer_ip(http)
    if HTTP.WebSockets.isupgrade(http.message)
        qp = try
            HTTP.URIs.queryparams(HTTP.URI(http.message.target))
        catch
            Dict{String,String}()
        end
        keyok = _keyok(ip, qp, KANBAN_KEY[])
        _kanban_share_ok(ip) ||
            return HTTP.WebSockets.upgrade(ws -> _presence_deny(ws, "share_off"), http)
        HTTP.WebSockets.upgrade(ws -> _kanban_ws(ws, ip, keyok), http)
    else
        HTTP.streamhandler(req -> _kanban_static(req, ip))(http)
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

By default only this machine can open the board, like `Perth.run`. Pass
`share = true` to let other machines on the local network open the same
board: every change (dragging a card, editing, renaming a column) is
broadcast live over a WebSocket, and each connected machine shows up as a
labelled cursor with its name and IP address — pair-programming style.

Sharing is a live switch, not a startup-only decision: turn it on and off
with the board running via [`kanban_share!`](@ref) or the UI (Board →
Share / QR…). To that end the socket binds to `0.0.0.0` and every
connection is checked against the current setting — with sharing off,
requests from other machines are refused with 403. Pass `host` to bind a
fixed address instead (which disables the live switch).

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
function kanban(name::AbstractString = "board";
                port::Integer = 8150, share::Bool = false,
                host::Union{Nothing,AbstractString} = nothing,
                key::AbstractString = "",
                open_browser::Bool = true,
                data_dir::Union{Nothing,AbstractString} = nothing)
    # o diretório precisa ser conhecido antes do slug: é ele que diz se o
    # nome pertence a um board gravado com o slug antigo (ver _board_slug)
    dir = data_dir !== nothing ? String(data_dir) :
          KANBAN[] === nothing ? _state().data_dir : KANBAN[].data_dir
    slug = _board_slug(dir, name)
    if KANBAN_SERVER[] !== nothing
        if _kanban_state().name != slug
            _kanban_use_board!(slug)
            @info "Perth kanban: switched every connected client to board \"$slug\"."
        else
            @info "Perth kanban already running — Perth.kanban_stop() first to change port or key."
        end
        return "http://localhost:$(KANBAN_PORT[])" * _key_suffix()
    end
    KANBAN_KEY[] = String(key)
    if data_dir !== nothing
        _init_kanban!(String(data_dir); name = slug)
    elseif KANBAN[] === nothing
        _init_kanban!(_state().data_dir; name = slug)
    elseif _kanban_state().name != slug
        _kanban_use_board!(slug)
    end
    _kanban_state()   # garante board carregado antes de aceitar conexões

    # bind sempre em 0.0.0.0: o filtro de quem entra é o porteiro
    # (_kanban_share_ok), não o socket — é o que permite ligar/desligar a
    # transmissão sem derrubar o board. `host` explícito fixa o alcance no
    # socket e desabilita o botão.
    bindhost = something(host, "0.0.0.0")
    addr = parse(Sockets.IPAddr, String(bindhost))
    server, chosen = _kanban_listen(_kanban_handler, addr, port)
    KANBAN_SERVER[] = server
    KANBAN_PORT[] = chosen
    KANBAN_CAN_SHARE[] = addr == Sockets.IPv4(0)
    KANBAN_SHARED[] = KANBAN_CAN_SHARE[] ? share : !_kanban_is_host(string(addr))

    # Heartbeat: mantém intermediários acordados e permite ao cliente
    # detectar conexão morta; o mesmo timer roda o auto-arquivamento (1x/h)
    _HB_TICKS[] = 0
    KANBAN_TIMER[] = Timer(30.0; interval = 30.0) do _
        try
            _kanban_broadcast("{\"type\":\"hb\"}")
            _HB_TICKS[] += 1
            (_HB_TICKS[] == 1 || _HB_TICKS[] % 120 == 0) && _kanban_autoarchive_sweep!()
        catch
        end
    end

    url = "http://localhost:$(chosen)" * _key_suffix()
    printstyled("\n  Perth kanban "; color = :magenta, bold = true)
    println("board \"$(_kanban_state().name)\" running at $url")
    if KANBAN_SHARED[]   # transmitindo: mostra os endereços da rede local
        lan = _lan_ipv4()
        for a in lan
            println("  on your network:  http://$(a):$(chosen)$(_key_suffix())  ← share this link")
        end
        if !isempty(lan)
            m = _qr_matrix("http://$(first(lan)):$(chosen)" * _key_suffix())
            if m === nothing
                println("  (tip: run `using QRCoders` before Perth.kanban() to print a QR code here)")
            else
                println()
                _print_qr(stdout, m)
            end
        end
        if isempty(KANBAN_KEY[])
            println("  Anyone on the network can edit the board — pass key = \"...\" to require an access key.")
        else
            println("  Access requires the key (already embedded in the links above).")
        end
        println("  Perth.kanban_share!(false) stops sharing without stopping the board.")
        println("  Do not expose this port to the internet.")
    elseif KANBAN_CAN_SHARE[]
        println("  Localhost only — Perth.kanban_share!() (or Board → Share / QR…) opens it to your network.")
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
    if KANBAN_TIMER[] !== nothing
        close(KANBAN_TIMER[])
        KANBAN_TIMER[] = nothing
    end
    KANBAN_KEY[] = ""
    KANBAN_SHARED[] = false
    KANBAN_CAN_SHARE[] = false
    close(KANBAN_SERVER[])
    KANBAN_SERVER[] = nothing
    @info "Perth kanban stopped."
    return nothing
end

# Liga a ponte de campos: todo _save! de projeto espelha nas cartas
# vinculadas (no-op enquanto o kanban não for usado nesta sessão).
_ON_SAVE[] = _kanban_sync_from_project
