# Imagem de fundo da UI (gantt e kanban).
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

const _BG_KEY = "background"
const _BG_OPACITY_KEY = "background_opacity"
const _BG_MAX_BYTES = 12 * 1024 * 1024      # 12 MB: fundo, não acervo
const _BG_DEFAULT_OPACITY = 0.18            # discreto por padrão — a UI vem primeiro

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

function _bg_opacity()
    raw = get(_state().settings, _BG_OPACITY_KEY, "")
    v = tryparse(Float64, raw)
    v === nothing ? _BG_DEFAULT_OPACITY : clamp(v, 0.0, 1.0)
end

# Versão para cache-busting: o navegador (e o service worker, que é
# network-first) precisa de URL nova quando a imagem troca
function _bg_version(path::AbstractString)
    isfile(path) || return "0"
    return string(hash((path, mtime(path), filesize(path))), base = 16)
end

function _bg_payload()
    path = _bg_path()
    ok = !isempty(path) && isfile(path)
    return (; set = ok, opacity = _bg_opacity(),
            url = ok ? "/background?v=" * _bg_version(path) : nothing,
            name = ok ? basename(path) : nothing)
end

# Serve os bytes. Relê do disco a cada requisição de propósito: trocar a
# foto no lugar (mesmo caminho) aparece no próximo reload, sem REPL.
function _bg_response()
    path = _bg_path()
    (isempty(path) || !isfile(path)) && return _error("no background set"; status = 404)
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

# Avisa os navegadores conectados — o fundo troca ao vivo, sem reload, nos
# dois apps (o setting é único e o data dir é compartilhado)
function _bg_broadcast()
    msg = JSON3.write((; type = "background", _bg_payload()...))
    SERVER[] === nothing || _hub_broadcast(GANTT_HUB, msg)
    KANBAN_SERVER[] === nothing || _kanban_broadcast(msg)
    return nothing
end

"""
    Perth.background!(path; opacity = 0.18) -> String
    Perth.background!(; opacity) -> Float64

Use a local image as the background of the Perth UI — gantt and kanban,
every connected browser. `path` is read from the machine running the
server; the file itself is never copied, so replacing it on disk changes
the background on the next reload.

`opacity` (0–1) is how strongly the image shows through the page colour.
The default is deliberately low: panels, cards and bars keep their solid
surfaces, and the image fills the space around them. Pass `opacity`
alone to adjust it without changing the image.

The setting is persisted in `settings.json` in the Perth data directory.
Clear it with [`Perth.background_clear!`](@ref); read it back with
[`Perth.background`](@ref).

Accepted formats are PNG, JPEG, GIF and WebP, checked by content rather
than by file extension, up to 12 MB.

!!! note
    Every machine that can open Perth can see this image — it is served
    over the same port, behind the same access key as the rest of the
    data. Each browser can hide it locally (settings panel → *Hide
    background*), which is a rendering preference, not a way to keep the
    image private.

```julia
Perth.background!("~/Imagens/escritorio.jpg")
Perth.background!(opacity = 0.35)
Perth.background_clear!()
```
"""
function background!(path::AbstractString; opacity::Union{Nothing,Real} = nothing)
    full = abspath(expanduser(String(path)))
    isfile(full) || throw(ArgumentError("no such file: $full"))
    sz = filesize(full)
    sz <= _BG_MAX_BYTES || throw(ArgumentError(
        "image is $(round(sz / 1024^2; digits = 1)) MB — the limit is $(_BG_MAX_BYTES ÷ 1024^2) MB"))
    mime = _bg_sniff(read(full, 16))
    mime === nothing && throw(ArgumentError(
        "$full is not a PNG, JPEG, GIF or WebP image"))
    _with_state(st -> begin
        st.settings[_BG_KEY] = full
        opacity === nothing || (st.settings[_BG_OPACITY_KEY] = string(clamp(Float64(opacity), 0.0, 1.0)))
        _save_settings!(st)
    end)
    _bg_broadcast()
    @info "Perth: background set to $full ($(mime), opacity $(_bg_opacity()))."
    return full
end

function background!(; opacity::Real)
    o = clamp(Float64(opacity), 0.0, 1.0)
    _with_state(st -> begin
        st.settings[_BG_OPACITY_KEY] = string(o)
        _save_settings!(st)
    end)
    _bg_broadcast()
    return o
end

"""
    Perth.background() -> Union{String,Nothing}

Path of the image currently used as the UI background, or `nothing` when
none is set (or the file is gone). See [`Perth.background!`](@ref).
"""
function background()
    path = _bg_path()
    return (isempty(path) || !isfile(path)) ? nothing : path
end

"""
    Perth.background_clear!()

Drop the UI background image, live on every connected browser. The image
file itself is left alone. See [`Perth.background!`](@ref).
"""
function background_clear!()
    _with_state(st -> begin
        delete!(st.settings, _BG_KEY)
        _save_settings!(st)
    end)
    _bg_broadcast()
    @info "Perth: background cleared."
    return nothing
end
