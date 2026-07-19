# Ciclo de vida do servidor. Sobe em Sockets.localhost (nunca 0.0.0.0),
# de forma não bloqueante (HTTP.serve!), para manter o REPL vivo —
# a graça é editar o projeto pelo REPL com a página aberta ao lado.

const SERVER = Ref{Union{HTTP.Server,Nothing}}(nothing)
const PORT = Ref{Int}(0)

"""
    Perth.run(; port = 8123, open_browser = true, data_dir = nothing) -> String

Start the Perth server and (optionally) open the app in your browser.
Returns the URL. The server binds to `localhost` only and does not block
the REPL; stop it with [`Perth.stop`](@ref).

If `port` is busy, the next free port is used (up to 20 attempts).
`data_dir` overrides the project storage directory
(default: `\$PERTH_DATA_DIR` or `~/.perth`).
"""
function run(; port::Integer = 8123, open_browser::Bool = true,
             data_dir::Union{Nothing,AbstractString} = nothing)
    if SERVER[] !== nothing
        @info "Perth already running — use Perth.stop() first."
        return _url()
    end
    data_dir === nothing || _init_state!(data_dir)
    _state()  # garante estado carregado antes de aceitar requisições

    router = _build_router()
    server, chosen = _serve_with_fallback(router, port)
    SERVER[] = server
    PORT[] = chosen

    url = _url()
    printstyled("\n  Perth "; color = :magenta, bold = true)
    println("running at $url")
    println("  Projects at $(_state().data_dir) — Perth.stop() to shut down.\n")
    open_browser && _open_browser(url)
    return url
end

# Tenta portas sequenciais a partir da pedida (8123, 8124, ...)
function _serve_with_fallback(router, port::Integer; attempts::Int = 20)
    for p in port:(port + attempts - 1)
        try
            server = HTTP.serve!(router, Sockets.localhost, p; verbose = false)
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
