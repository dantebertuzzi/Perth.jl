# Imagens coladas num card do kanban.
#
# ONDE OS BYTES MORAM, e por que não é dentro do board. _kanban_persist
# reescreve o kanban.json INTEIRO a cada op, e _kanban_init_payload manda o
# board INTEIRO pelo WebSocket a cada conexão e a cada troca de board. Uma
# imagem em base64 dentro do card seria, então, ~270 KB regravados no disco
# toda vez que alguém arrasta um card, e retransmitidos por completo a cada
# F5 de cada máquina. Dez cards com foto e o board vira 3 MB no fio.
#
# Por isso o blob fica FORA do board, num arquivo endereçado pelo conteúdo
# (<sha256>.<ext>), e o card guarda só o nome. Duas consequências que valem
# o desenho: a mesma captura colada em cinco cards ocupa um arquivo, e um
# arquivo cujo nome É o hash do conteúdo pode enfim ser servido com cache
# imutável — o resto do servidor é no-store porque o resto muda.
#
# ISTO REABRE UMA DECISÃO QUE O PROJETO JÁ TINHA TOMADO. O cabeçalho de
# background.jl diz que não existe endpoint de upload de propósito: os
# servidores escutam em 0.0.0.0, e upload é superfície de ESCRITA na rede
# local. O que muda aqui é que o kanban JÁ é superfície de escrita — quem
# passa pelo porteiro da transmissão e pela chave cria, edita e apaga card, e
# isso já grava no disco. O que ele não era é superfície de BYTES sem teto, e
# é exatamente isso que o porteiro abaixo existe para não deixar virar:
#
#   1. tamanho por imagem (o cliente já reduz antes de mandar; isto é o teto
#      de quem não passou pelo cliente),
#   2. tipo real pelos magic bytes, reusando o farejador de background.jl —
#      SVG fica de fora pelo mesmo motivo de lá: é texto arbitrário servido
#      para a rede,
#   3. teto do armazém inteiro, porque um cliente teimoso com imagens
#      distintas passa por (1) e (2) quantas vezes quiser,
#   4. a mesma matriz de permissões por IP das outras ações do quadro.
#
# O nome do arquivo é validado na LEITURA e na ESCRITA (_asset_names), e não
# só quando chega do cliente: ele acaba dentro de um <img src> em todas as
# máquinas do quadro, e é o único lugar do board onde um texto vira caminho
# de arquivo no servidor.

const _ASSET_DIR = "kanban-assets"
const _ASSET_MAX_BYTES = 768 * 1024        # por imagem; o cliente manda bem menos
const _ASSET_MAX_TOTAL = 128 * 1024 * 1024 # o armazém inteiro
const _ASSET_MAX_PER_CARD = 3              # o card é um card, não um álbum
const _ASSET_KEEP_DAYS = 7                 # carência antes de coletar órfão (ver _asset_gc!)

# Extensão por tipo real — a do arquivo é derivada dos bytes, nunca do que o
# cliente disse. Mesma lista de _bg_sniff, menos o que ele não reconhece.
const _ASSET_EXT = Dict("image/png" => "png", "image/jpeg" => "jpg",
                        "image/gif" => "gif", "image/webp" => "webp",
                        "image/avif" => "avif")

const _ASSET_NAME_RE = r"^[0-9a-f]{64}\.(?:png|jpg|gif|webp|avif)$"

# O diretório é parâmetro com padrão porque a coleta roda DENTRO de
# _init_kanban!, quando _kanban_state() ainda recursaria de volta nele.
_asset_dir(data_dir::AbstractString = _kanban_state().data_dir) =
    joinpath(data_dir, _ASSET_DIR)

# Peneira que todo nome de blob atravessa, venha do cliente ou do board salvo.
# Devolve os nomes válidos, sem repetição e no teto por card; qualquer outra
# coisa (caminho, "..", nome inventado) simplesmente não sai daqui.
function _asset_names(raw)::Vector{String}
    raw === nothing && return String[]
    items = raw isa AbstractString ? Any[raw] : (raw isa AbstractVector ? raw : Any[])
    out = String[]
    for it in items
        it isa AbstractString || continue
        n = String(it)
        occursin(_ASSET_NAME_RE, n) || continue
        n in out && continue
        push!(out, n)
        length(out) >= _ASSET_MAX_PER_CARD && break
    end
    return out
end

_asset_total_bytes(dir::AbstractString) =
    isdir(dir) ? sum(f -> filesize(joinpath(dir, f)), readdir(dir); init = 0) : 0

# Grava os bytes e devolve o nome. Erros voltam como Response porque é isso
# que o chamador (a rota) tem para fazer com eles.
function _asset_store(bytes::Vector{UInt8})
    isempty(bytes) && return _error("empty upload"; status = 400)
    length(bytes) > _ASSET_MAX_BYTES && return _error(
        "image is $(round(length(bytes) / 1024; digits = 0)) KB — the limit is " *
        "$(_ASSET_MAX_BYTES ÷ 1024) KB"; status = 413)
    mime = _bg_sniff(bytes)
    mime === nothing && return _error(
        "not an image (PNG, JPEG, GIF, WebP or AVIF)"; status = 415)
    dir = _asset_dir()
    name = bytes2hex(SHA.sha256(bytes)) * "." * _ASSET_EXT[mime]
    path = joinpath(dir, name)
    # já existe: mesma imagem, mesmo arquivo — nada a gravar, e o teto do
    # armazém não se aplica a quem não vai ocupar espaço novo
    isfile(path) && return _json((; name))
    _asset_total_bytes(dir) + length(bytes) > _ASSET_MAX_TOTAL && return _error(
        "the image store is full ($(_ASSET_MAX_TOTAL ÷ 1024^2) MB)"; status = 507)
    try
        mkpath(dir)
        tmp = path * ".tmp"
        write(tmp, bytes)
        mv(tmp, path; force = true)
    catch err
        @warn "Perth kanban: could not store image" error = err
        return _error("could not store the image"; status = 500)
    end
    return _json((; name))
end

# Serve o blob. O tipo sai dos BYTES de novo, não da extensão do nome: o
# arquivo pode ter sido trocado no disco por fora, e o navegador é quem
# decodifica o que sair daqui.
function _asset_response(name::AbstractString)
    occursin(_ASSET_NAME_RE, name) || return _error("not found"; status = 404)
    path = joinpath(_asset_dir(), name)
    isfile(path) || return _error("not found"; status = 404)
    bytes = read(path)
    mime = _bg_sniff(bytes)
    mime === nothing && return _error("not found"; status = 404)
    # o nome É o hash do conteúdo: este é o único recurso do servidor que
    # nunca muda debaixo de uma URL, e o único que pode ser cacheado assim
    return HTTP.Response(200, ["Content-Type" => mime,
                               "Cache-Control" => "public, max-age=31536000, immutable"],
                         bytes)
end

function _asset_upload(req::HTTP.Request, ip::AbstractString)
    st = _kanban_state()
    _kanban_permitted(st, ip, "setImages") ||
        return _error("the host restricted images for this machine"; status = 403)
    return _asset_store(Vector{UInt8}(req.body))
end

# Nomes citados por algum card de UM board (colunas + arquivo).
function _asset_used_in!(used::Set{String}, board)
    for col in get(board, "columns", Any[])
        for card in get(col, "cards", Any[])
            union!(used, _asset_names(get(card, "images", nothing)))
        end
    end
    for card in get(board, "archive", Any[])
        union!(used, _asset_names(get(card, "images", nothing)))
    end
    return used
end

# Nomes citados por QUALQUER board do diretório de dados. O armazém é um só
# para todos eles — é o que faz a mesma captura colada em dois boards ocupar
# um arquivo, e o que faz trocar de board não quebrar imagem nenhuma.
#
# Devolve `nothing` se algum board não pôde ser lido: board ilegível não pode
# virar "ninguém cita nada", porque isso apagaria justamente as imagens dele.
function _asset_referenced(data_dir::AbstractString)
    used = Set{String}()
    for f in readdir(data_dir; join = true)
        base = basename(f)
        (startswith(base, "kanban") && endswith(base, ".json")) || continue
        try
            _asset_used_in!(used, _plain(JSON3.read(read(f, String))))
        catch err
            @warn "Perth kanban: skipping image collection, unreadable board" file = f error = err
            return nothing
        end
    end
    return used
end

"""
    Perth._asset_gc!(data_dir = ...; keep_days = 7) -> Int

Apaga os blobs que nenhum card de nenhum board cita mais, e devolve quantos
foram. Roda sozinho ao subir o kanban.

`keep_days` é carência, e é o ponto delicado: a pilha de desfazer vive no
NAVEGADOR (ver pushUndo em frontend/kanban/app.js), então logo depois de
alguém tirar a imagem de um card existe um Ctrl+Z capaz de trazê-la de volta
— e ele não sabe que o arquivo sumiu. Sete dias é mais do que qualquer aba
aberta, e o custo de errar para o outro lado é um arquivo a mais no disco.
"""
function _asset_gc!(data_dir::AbstractString = _kanban_state().data_dir;
                    keep_days::Real = _ASSET_KEEP_DAYS)
    dir = _asset_dir(data_dir)
    isdir(dir) || return 0
    used = _asset_referenced(data_dir)
    used === nothing && return 0
    limite = time() - keep_days * 86_400
    n = 0
    for f in readdir(dir)
        occursin(_ASSET_NAME_RE, f) || continue
        f in used && continue
        path = joinpath(dir, f)
        try
            mtime(path) < limite || continue
            rm(path)
            n += 1
        catch err
            @warn "Perth kanban: could not delete unused image" file = path error = err
        end
    end
    n > 0 && @info "Perth kanban: collected $(n) unused image$(n == 1 ? "" : "s")."
    return n
end
