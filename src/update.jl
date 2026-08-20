# update.jl — aviso de que existe versão nova.
#
# A pergunta "tem versão nova?" tem duas respostas possíveis e só uma delas é
# barata: o registro General JÁ está na máquina de quem instalou o pacote
# (~/.julia/registries), com todas as versões publicadas de Perth. Ler dali
# custa zero requisição, funciona offline e não manda um byte sequer para
# lugar nenhum — um pacote de gestão de projetos não tem por que telefonar
# para casa toda vez que é carregado. O preço é que o registro local só é
# atualizado quando alguém roda `] up`: uma release recém-publicada demora a
# aparecer. É a troca certa aqui, porque o aviso é uma cortesia, não um alarme.
#
# Nada disto acontece na frente de quem chamou `using Perth`:
#
#   • o __init__ só LÊ o cache (~/.perth/update-check.json, uns 80 bytes) e,
#     se houver versão nova, acrescenta uma linha ao bloco que o _hint já
#     imprime. Não carrega Pkg, não abre registro, não bloqueia;
#   • a revalidação do cache vai para uma @async depois do _pick, e o que ela
#     descobre aparece na PRÓXIMA sessão. É o padrão de npm e cargo, e evita
#     que o carregamento do Pkg (~0,3 s) e a leitura do registro disputem o
#     terminal com o desenho do splash;
#   • Perth.check_update() faz tudo na hora, para quem perguntar de propósito.
#
# Desligar: PERTH_UPDATE_CHECK=0 (e PERTH_SPLASH=0 já silencia junto com o
# resto da decoração, porque a linha mora dentro do bloco do _hint).

# UUID do próprio Perth no registro; o do Pkg é fixo desde sempre.
const _PERTH_UUID = UUID("b3f8c2a1-4e6d-4f9a-8c7b-2d5e9f1a3c4b")
const _PKG_ID = Base.PkgId(Base.UUID("44cfe95a-1eb2-52ea-b672-e2afdf69b78f"), "Pkg")

const _UPDATE_TTL = 24 * 60 * 60          # segundos entre duas leituras do registro

_update_enabled() = get(ENV, "PERTH_UPDATE_CHECK", "1") != "0"

# O cache mora junto dos projetos, mas _init_state! ignora este arquivo: ele
# exige "id" e "tasks" em todo .json do diretório, e este não tem nenhum dos
# dois. Usamos _default_data_dir() direto, e não _state(), porque o __init__
# não pode ter como efeito colateral carregar todos os projetos do disco.
_update_file() = joinpath(_default_data_dir(), "update-check.json")

# Pkg é stdlib, mas não é dependência: carregá-lo no `using Perth` custaria
# 0,3 s a toda sessão para responder uma pergunta que quase sempre já está no
# cache. Base.require só é chamado quando a resposta realmente falta.
_pkg_module() = try Base.require(_PKG_ID) catch; nothing end

"""
    Perth._registry_latest() -> Union{VersionNumber,Nothing}

Highest non-yanked Perth version across the package registries installed on
this machine. Returns `nothing` when no registry is reachable or readable —
never throws, and never touches the network.
"""
function _registry_latest()
    P = _pkg_module()
    P === nothing && return nothing
    try
        # invokelatest não é enfeite: Base.require acabou de trazer os métodos
        # do Pkg para o mundo, e esta chamada foi compilada num mundo anterior
        # a eles. Sem isto, a PRIMEIRA leitura de cada sessão levantava
        # MethodError, o catch engolia, e a resposta era um "não sei" que só
        # sumia na segunda chamada.
        return Base.invokelatest(_registry_max, getfield(P, :Registry))
    catch
        return nothing
    end
end

function _registry_max(R)
    best = nothing
    for reg in R.reachable_registries()
        entry = get(reg.pkgs, _PERTH_UUID, nothing)
        entry === nothing && continue
        for (v, info) in R.registry_info(entry).version_info
            info.yanked && continue
            (best === nothing || v > best) && (best = v)
        end
    end
    return best
end

_current_version() = try pkgversion(@__MODULE__) catch; nothing end

# `] up Perth` não mexe num checkout de desenvolvimento — quem está com o
# repositório aberto (o mantenedor, quem deu `] dev Perth`) recebe o número,
# mas não o conselho errado. Instalado pelo Pkg ⇒ o código mora sob
# <depot>/packages; em qualquer outro lugar é dev.
function _dev_checkout()
    dir = try pkgdir(@__MODULE__) catch; nothing end
    dir === nothing && return false
    return !any(d -> startswith(dir, joinpath(d, "packages")), DEPOT_PATH)
end

# ─────────────────────────────────────────────────────────────── cache ──

"""Lê o cache; devolve `(checked, latest)` ou `nothing` se faltar ou estiver corrompido."""
function _update_cache()
    f = _update_file()
    isfile(f) || return nothing
    try
        j = JSON3.read(read(f, String))
        return (checked = Float64(j.checked), latest = VersionNumber(String(j.latest)))
    catch
        return nothing
    end
end

function _update_cache!(latest::VersionNumber)
    try
        mkpath(_default_data_dir())
        write(_update_file(), JSON3.write((checked = time(),
                                           latest  = string(latest),
                                           current = string(something(_current_version(), "")))))
    catch
    end
    return latest
end

_update_stale(c = _update_cache()) = c === nothing || time() - c.checked > _UPDATE_TTL

"""
    Perth._update_available() -> Union{VersionNumber,Nothing}

The newer version recorded by the last check, or `nothing` when Perth is up to
date, when nothing has been checked yet, or when checking is turned off. Reads
one small file — no registry, no `Pkg`, no network.
"""
function _update_available()
    _update_enabled() || return nothing
    cur = _current_version()
    cur === nothing && return nothing
    c = _update_cache()
    c === nothing && return nothing
    return c.latest > cur ? c.latest : nothing
end

"""
Revalida o cache em segundo plano; silenciosa em qualquer falha. Devolve a
tarefa (ou `nothing`, quando não havia o que revalidar) — o `__init__` ignora,
mas os testes precisam de algo em que esperar.
"""
function _update_refresh_async()
    _update_enabled() || return nothing
    _update_stale() || return nothing
    return @async try
        v = _registry_latest()
        v === nothing || _update_cache!(v)
    catch
    end
end

"""
    Perth._update_payload() -> Union{String,Nothing}

Campo `update` de `/api/apps`: a versão nova como texto, ou `nothing`. A visita
serve também de gatilho para revalidar o cache em segundo plano — é o que faz o
aviso chegar em sessão NÃO interativa (script, systemd, `julia -e Perth.run()`),
onde o `__init__` devolve cedo e nunca chega a revalidar. O que a revalidação
descobrir aparece no próximo boot da página, nunca nesta resposta: quem pediu
`/api/apps` está esperando bytes, não uma leitura de registro.
"""
function _update_payload()
    _update_refresh_async()
    v = _update_available()
    return v === nothing ? nothing : string(v)
end

# ────────────────────────────────────────────────────────────── fachada ──

"""
    Perth.check_update(io = stdout) -> Union{VersionNumber,Nothing}

Check right now whether a newer Perth has been published, and say so.

The answer comes from the package registries **already installed on this
machine** — the same ones `Pkg` resolves against. Nothing is sent over the
network, so the reading is only as fresh as the last `] up`: a release
published minutes ago shows up here once the registry is refreshed.

Returns the newer version, or `nothing` when Perth is current (or when no
registry could be read, which is reported but not raised). The result also
updates the cache behind the one-line notice that `using Perth` prints, so
calling this makes the next session's notice accurate.

`PERTH_UPDATE_CHECK=0` turns off the notice and the background check;
this function still answers whenever you call it directly.

```julia
julia> Perth.check_update()
perth v0.12.0 → 0.13.0 available · ] up Perth
v"0.13.0"
```
"""
function check_update(io::IO = stdout)
    cur    = _current_version()
    latest = _registry_latest()

    if latest === nothing
        _fancy(io) ? println(io, "  ", _DIM, "perth", _RESET, "  ", _GREY,
                             "no package registry to read — is Perth installed by Pkg?",
                             _RESET) :
                     @info "Perth: no package registry to read."
        return nothing
    end
    _update_cache!(latest)

    nova = (cur !== nothing && latest > cur) ? latest : nothing
    vstr = cur === nothing ? "?" : string(cur)

    if !_fancy(io)
        nova === nothing ? @info("Perth v$vstr is up to date.") :
                           @info("Perth v$vstr — v$nova is available. Run: ] up Perth")
        return nova
    end

    print(io, "  ", _fg(0x95, 0x58, 0xB2), _BOLD, "perth", _RESET,
              " ", _DIM, "v", vstr, _RESET)
    if nova === nothing
        println(io, "  ", _GREY, "up to date", _RESET)
    else
        print(io, " ", _fg(0x38, 0x98, 0x26), "→ ", nova, _RESET, "  ",
                  _GREY, "available", _RESET)
        println(io, _dev_checkout() ? string(" ", _DIM, "· dev checkout, `] up` won't touch it", _RESET) :
                                      string(" ", _DIM, "· ] up Perth", _RESET))
    end
    return nova
end
