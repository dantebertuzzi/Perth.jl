# Imagem de fundo da UI (gantt e kanban) — uma foto ou uma rotação delas.
#
# O caminho é apontado pelo REPL — Perth.background!("~/foto.jpg") — e fica
# no settings.json do diretório de dados, junto das outras preferências
# persistentes. Não existe endpoint de upload de propósito: os servidores
# escutam em 0.0.0.0 (ver server.jl), e um upload seria superfície de
# ESCRITA na rede local; quem tem REPL já tem o disco inteiro, então apontar
# um caminho não concede nada de novo. O servidor só lê e serve os bytes.
#
# O arquivo é validado na hora de apontar (tipo real pelos magic bytes, não
# pela extensão, e teto de tamanho): um caminho digitado errado não vira
# arquivo qualquer publicado para a rede.
#
# UM DIRETÓRIO É AÇÚCAR PARA UMA LISTA, expandida e congelada na hora de
# apontar — não uma pasta relida a cada requisição. Três razões:
#
#   1. O índice da rotação é derivado do relógio no navegador, para todas
#      as máquinas mostrarem a MESMA foto sem tick do servidor. Isso exige
#      que a lista e a ordem sejam idênticas em todos os clientes; com
#      varredura ao vivo, duas máquinas que escaneiam em momentos
#      diferentes calculam índices diferentes.
#   2. Preserva o modelo acima: a autorização é o ato de apontar. Pasta
#      relida ao vivo troca isso por autorização por PASTA, e qualquer
#      coisa que caia ali depois passa a ser servida para a rede sem
#      ninguém ter apontado — e a pasta que as pessoas escolhem é a de
#      imagens, que costuma ser onde as capturas de tela caem.
#   3. Custo: lista congelada dispensa cache, invalidação por mtime e
#      ordenação acordada entre clientes.
#
# O preço é chamar background! de novo depois de acrescentar fotos. Cada
# caminho continua sendo relido do disco a cada requisição, então trocar
# uma foto no lugar aparece no próximo reload, como sempre.

const _BG_KEY = "background"                # uma imagem (formato original)
const _BG_LIST_KEY = "background_list"      # a rotação, como JSON de caminhos
const _BG_OPACITY_KEY = "background_opacity"
const _BG_INTERVAL_KEY = "background_interval"
const _BG_MAX_BYTES = 12 * 1024 * 1024      # 12 MB por imagem: fundo, não acervo
const _BG_MAX_IMAGES = 60                   # teto da rotação (uma pasta pode ter milhares)
const _BG_DEFAULT_OPACITY = 0.18            # discreto por padrão — a UI vem primeiro
const _BG_DEFAULT_INTERVAL = 60             # segundos; trocar rápido demais distrai

# Assinaturas reais dos formatos aceitos. SVG fica de fora: como
# background-image ele não executa script, mas é texto arbitrário servido
# para a rede — não vale o risco por um fundo.
function _bg_sniff(bytes::Vector{UInt8})
    length(bytes) >= 12 || return nothing
    b = bytes
    b[1:8] == UInt8[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] && return "image/png"
    b[1:3] == UInt8[0xFF, 0xD8, 0xFF] && return "image/jpeg"
    (b[1:6] == Vector{UInt8}("GIF87a") || b[1:6] == Vector{UInt8}("GIF89a")) && return "image/gif"
    (b[1:4] == Vector{UInt8}("RIFF") && b[9:12] == Vector{UInt8}("WEBP")) && return "image/webp"
    return nothing
end

_bg_path() = get(_state().settings, _BG_KEY, "")

# Caminhos apontados, na ordem em que valem — a lista quando existe, senão
# a imagem única (formato anterior a esta feature, que segue sendo o que
# background!(uma-foto) grava). Ainda não filtra o que sumiu do disco:
# quem faz isso é _bg_images, e a diferença importa porque background()
# precisa distinguir "nada apontado" de "apontado e apagado".
function _bg_list()
    raw = get(_state().settings, _BG_LIST_KEY, "")
    if !isempty(raw)
        try
            return String[String(p) for p in JSON3.read(raw)]
        catch err
            @warn "Perth: ignoring unreadable background list" error = err
        end
    end
    p = _bg_path()
    return isempty(p) ? String[] : String[p]
end

# A rotação de verdade: só o que ainda existe em disco. Apagar um arquivo
# encurta a rotação em vez de dar 404 no meio dela.
_bg_images() = filter(isfile, _bg_list())

function _bg_opacity()
    raw = get(_state().settings, _BG_OPACITY_KEY, "")
    v = tryparse(Float64, raw)
    v === nothing ? _BG_DEFAULT_OPACITY : clamp(v, 0.0, 1.0)
end

# Segundos entre trocas; 0 = sem rotação (fica na primeira imagem)
function _bg_interval()
    raw = get(_state().settings, _BG_INTERVAL_KEY, "")
    v = tryparse(Float64, raw)
    v === nothing && return _BG_DEFAULT_INTERVAL
    return v <= 0 ? 0 : max(round(Int, v), 1)
end

# Versão para cache-busting: o navegador (e o service worker, que é
# network-first) precisa de URL nova quando a imagem troca
function _bg_version(path::AbstractString)
    isfile(path) || return "0"
    return string(hash((path, mtime(path), filesize(path))), base = 16)
end

_bg_url(i::Int, path::AbstractString) =
    (i == 1 ? "/background?v=" : "/background?i=$(i - 1)&v=") * _bg_version(path)

# `url`/`name` seguem descrevendo a PRIMEIRA imagem: é o que um cliente
# anterior a esta feature entende, e é a imagem que a página mostra antes
# do primeiro giro. A rotação inteira vai em `images`.
function _bg_payload()
    imgs = _bg_images()
    ok = !isempty(imgs)
    return (; set = ok, opacity = _bg_opacity(),
            url = ok ? _bg_url(1, imgs[1]) : nothing,
            name = ok ? basename(imgs[1]) : nothing,
            interval = length(imgs) > 1 ? _bg_interval() : 0,
            images = [(; url = _bg_url(i, p), name = basename(p))
                      for (i, p) in enumerate(imgs)])
end

# Serve os bytes da i-ésima imagem (índice base 0 na query, como no JS;
# ausente = a primeira). Relê do disco a cada requisição de propósito:
# trocar a foto no lugar (mesmo caminho) aparece no próximo reload, sem
# REPL — e o sniff roda de novo aqui, então trocar por outra coisa que não
# seja imagem não passa a ser servido.
function _bg_response(i::Integer = 0)
    imgs = _bg_images()
    isempty(imgs) && return _error("no background set"; status = 404)
    (i < 0 || i >= length(imgs)) && return _error("no such background image"; status = 404)
    path = imgs[i + 1]
    bytes = try
        read(path)
    catch err
        @warn "Perth: could not read background image" path error = err
        return _error("could not read the background image"; status = 500)
    end
    length(bytes) > _BG_MAX_BYTES && return _error("background image is too large"; status = 413)
    mime = _bg_sniff(bytes)
    mime === nothing && return _error("background is not a supported image"; status = 415)
    # immutable: a URL já carrega a versão (ver _bg_version)
    return HTTP.Response(200, ["Content-Type" => mime,
                               "Cache-Control" => "public, max-age=86400, immutable"], bytes)
end

# Índice pedido na query (?i=N). Lixo vira 0 — a primeira imagem.
function _bg_response(req::HTTP.Request)
    i = try
        parse(Int, get(HTTP.URIs.queryparams(HTTP.URI(req.target)), "i", "0"))
    catch
        0
    end
    return _bg_response(i)
end

# Avisa os navegadores conectados — o fundo troca ao vivo, sem reload, nos
# dois apps (o setting é único e o data dir é compartilhado)
function _bg_broadcast()
    msg = JSON3.write((; type = "background", _bg_payload()...))
    SERVER[] === nothing || _hub_broadcast(GANTT_HUB, msg)
    KANBAN_SERVER[] === nothing || _kanban_broadcast(msg)
    return nothing
end

# Valida um caminho: existe, cabe no teto e é mesmo uma imagem (magic
# bytes, não extensão). Devolve (caminho absoluto, mime) ou lança.
function _bg_check(path::AbstractString)
    full = abspath(expanduser(String(path)))
    isfile(full) || throw(ArgumentError("no such file: $full"))
    sz = filesize(full)
    sz <= _BG_MAX_BYTES || throw(ArgumentError(
        "image is $(round(sz / 1024^2; digits = 1)) MB — the limit is $(_BG_MAX_BYTES ÷ 1024^2) MB"))
    mime = _bg_sniff(read(full, 16))
    mime === nothing && throw(ArgumentError(
        "$full is not a PNG, JPEG, GIF or WebP image"))
    return full, mime
end

# Mesma checagem, sem lançar — para varrer diretório, onde o que não serve
# é ignorado em vez de abortar tudo
_bg_ok(path::AbstractString) = try
    first(_bg_check(path))
catch
    nothing
end

# Expande um diretório na lista de imagens que ele contém, ordenada por
# nome (a ordem precisa ser determinística: é ela que todos os navegadores
# usam para concordar sobre qual foto mostrar agora). Não desce em
# subpastas — a pasta que você aponta é a que vale.
function _bg_expand_dir(dir::AbstractString)
    full = abspath(expanduser(String(dir)))
    entries = try
        sort!(readdir(full))
    catch err
        throw(ArgumentError("could not read directory $full: $(sprint(showerror, err))"))
    end
    ok = String[]
    seen = 0
    for name in entries
        p = joinpath(full, name)
        isfile(p) || continue
        seen += 1
        good = _bg_ok(p)
        good === nothing && continue
        push!(ok, good)
        length(ok) >= _BG_MAX_IMAGES && break
    end
    isempty(ok) && throw(ArgumentError(
        "no usable image in $full — looked at $(seen) file$(seen == 1 ? "" : "s") " *
        "(PNG, JPEG, GIF or WebP, up to $(_BG_MAX_BYTES ÷ 1024^2) MB each)"))
    return ok, seen
end

# Grava a lista resolvida. Uma imagem só continua indo para a chave antiga
# (_BG_KEY), que é o formato que um Perth anterior a esta feature lê.
function _bg_store!(paths::Vector{String}; opacity, interval)
    _with_state(st -> begin
        if length(paths) == 1
            st.settings[_BG_KEY] = paths[1]
            delete!(st.settings, _BG_LIST_KEY)
        else
            st.settings[_BG_LIST_KEY] = JSON3.write(paths)
            delete!(st.settings, _BG_KEY)
        end
        opacity === nothing ||
            (st.settings[_BG_OPACITY_KEY] = string(clamp(Float64(opacity), 0.0, 1.0)))
        interval === nothing ||
            (st.settings[_BG_INTERVAL_KEY] = string(max(Int(interval), 0)))
        _save_settings!(st)
    end)
    _bg_broadcast()
    return paths
end

"""
    Perth.background!(path; opacity = 0.18, interval = 60) -> String
    Perth.background!(dir; …) -> Vector{String}
    Perth.background!(paths::AbstractVector; …) -> Vector{String}
    Perth.background!(; opacity, interval) -> Float64

Use local images as the background of the Perth UI — gantt and kanban,
every connected browser. They are read from the machine running the
server; the files themselves are never copied, so replacing one on disk
changes the background on the next reload.

Point at **one file**, at a **list of files**, or at a **directory**: a
directory is read once, right here, and the images in it (sorted by
name, up to $(_BG_MAX_IMAGES)) become the rotation. Whatever is in there
that is not a usable image is skipped, and the log line says how many
were taken and how many were left out. The directory is *not* re-read
later — the list is frozen at this call, so a file dropped in the folder
afterwards is not published to your network behind your back. Add photos
by calling `background!` on the folder again.

With more than one image the UI cycles through them, `interval` seconds
apart, fading the current one out and the next one in. Every connected
browser derives the current image from the wall clock, so all of them
show the same photo without the server ticking. `interval = 0` stops the
rotation on the first image.

`opacity` (0–1) is how strongly the image shows through the page colour.
The default is deliberately low: panels, cards and bars keep their solid
surfaces, and the image fills the space around them. Pass `opacity` or
`interval` alone to adjust them without changing the images.

The setting is persisted in `settings.json` in the Perth data directory.
Clear it with [`Perth.background_clear!`](@ref); read it back with
[`Perth.background`](@ref) / [`Perth.backgrounds`](@ref).

Accepted formats are PNG, JPEG, GIF and WebP, checked by content rather
than by file extension, up to 12 MB each.

!!! note
    Every machine that can open Perth can see these images — they are
    served over the same port, behind the same access key as the rest of
    the data. Each browser can hide them locally (settings panel → *Hide
    background*), which is a rendering preference, not a way to keep an
    image private. Point at a folder you would be comfortable showing on
    the office wall.

```julia
Perth.background!("~/Imagens/escritorio.jpg")
Perth.background!("~/Imagens/fundos/"; interval = 90)
Perth.background!(["~/a.jpg", "~/b.png"])
Perth.background!(opacity = 0.35)
Perth.background_clear!()
```
"""
function background!(path::AbstractString; opacity::Union{Nothing,Real} = nothing,
                     interval::Union{Nothing,Integer} = nothing)
    expanded = abspath(expanduser(String(path)))
    if isdir(expanded)
        paths, seen = _bg_expand_dir(expanded)
        _bg_store!(paths; opacity, interval)
        skipped = seen - length(paths)
        @info "Perth: background set to $(length(paths)) image$(length(paths) == 1 ? "" : "s") " *
              "from $expanded" *
              (skipped > 0 ? " ($(skipped) file$(skipped == 1 ? "" : "s") ignored)" : "") *
              ", opacity $(_bg_opacity())" *
              (length(paths) > 1 ? ", every $(_bg_interval())s" : "") * "."
        return paths
    end
    full, mime = _bg_check(expanded)
    _bg_store!(String[full]; opacity, interval)
    @info "Perth: background set to $full ($(mime), opacity $(_bg_opacity()))."
    return full
end

function background!(paths::AbstractVector; opacity::Union{Nothing,Real} = nothing,
                     interval::Union{Nothing,Integer} = nothing)
    isempty(paths) && throw(ArgumentError("background!: no images given"))
    # cada caminho é validado, e um inválido aborta a chamada inteira: numa
    # lista explícita, arquivo ruim é engano de quem digitou, não sujeira
    # de pasta (o descarte silencioso é só na varredura de diretório)
    resolved = String[first(_bg_check(p)) for p in paths]
    unique!(resolved)
    length(resolved) > _BG_MAX_IMAGES && throw(ArgumentError(
        "background!: $(length(resolved)) images — the limit is $(_BG_MAX_IMAGES)"))
    _bg_store!(resolved; opacity, interval)
    @info "Perth: background set to $(length(resolved)) image$(length(resolved) == 1 ? "" : "s")" *
          ", opacity $(_bg_opacity())" *
          (length(resolved) > 1 ? ", every $(_bg_interval())s" : "") * "."
    return resolved
end

function background!(; opacity::Union{Nothing,Real} = nothing,
                     interval::Union{Nothing,Integer} = nothing)
    (opacity === nothing && interval === nothing) &&
        throw(ArgumentError("background!: pass an image, a folder, `opacity` or `interval`"))
    _with_state(st -> begin
        opacity === nothing ||
            (st.settings[_BG_OPACITY_KEY] = string(clamp(Float64(opacity), 0.0, 1.0)))
        interval === nothing ||
            (st.settings[_BG_INTERVAL_KEY] = string(max(Int(interval), 0)))
        _save_settings!(st)
    end)
    _bg_broadcast()
    return opacity === nothing ? _bg_interval() : _bg_opacity()
end

"""
    Perth.background() -> Union{String,Nothing}

Path of the first image used as the UI background, or `nothing` when none
is set (or the files are gone). With a rotation, this is where it starts;
[`Perth.backgrounds`](@ref) gives the whole list. See
[`Perth.background!`](@ref).
"""
function background()
    imgs = _bg_images()
    return isempty(imgs) ? nothing : imgs[1]
end

"""
    Perth.backgrounds() -> Vector{String}

Every image in the UI background rotation, in the order it cycles
through them — the list frozen by [`Perth.background!`](@ref), minus
whatever has since been deleted from disk. Empty when no background is
set.
"""
backgrounds() = _bg_images()

"""
    Perth.background_clear!()

Drop the UI background, live on every connected browser. The image files
themselves are left alone. See [`Perth.background!`](@ref).
"""
function background_clear!()
    _with_state(st -> begin
        delete!(st.settings, _BG_KEY)
        delete!(st.settings, _BG_LIST_KEY)
        _save_settings!(st)
    end)
    _bg_broadcast()
    @info "Perth: background cleared."
    return nothing
end
