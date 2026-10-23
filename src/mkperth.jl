# A ponte com o MK Perth.
#
# O MK Perth é o irmão em Rust: lê e grava o XML do Primavera P6 e agenda com
# as opções do P6 (folga de início, de término ou a menor; crítico pela folga
# ou pelo caminho mais longo). O Perth não ganha nada disso por dentro — ganha
# por FORA, pela linha de comando do MK Perth, sem FFI e sem dependência: o
# projeto vai como o JSON que o Perth já grava, o `mkperth-cli` faz o trabalho
# e o resultado volta como JSON. Se o binário não está instalado, nada aqui
# carrega nem quebra; só estas funções avisam que falta.
#
# POR QUE A LINHA DE COMANDO E NÃO O SERVIDOR MCP. Cada chamada é uma
# conversa curta, de um arquivo para outro; um processo por chamada é mais
# simples de acertar que uma sessão aberta, e o contrato da CLI (verbos,
# --format json, códigos de saída) é o que o MK Perth promete manter estável.

"""
    mkperth_cli() -> Union{String,Nothing}

Where MK Perth's command line is: `ENV["MKPERTH_CLI"]` when set, else
`mkperth-cli` on `PATH`; `nothing` when it isn't installed. The bridge
([`import_p6xml`](@ref), [`export_p6xml`](@ref), [`schedule_p6`](@ref))
needs it.
"""
function mkperth_cli()
    path = get(ENV, "MKPERTH_CLI", "")
    isempty(path) || return isfile(path) ? path : nothing
    return Sys.which("mkperth-cli")
end

# Roda o mkperth-cli; devolve o que ele escreveu na saída. O que ele diz no
# stderr vira aviso quando deu certo e a mensagem do erro quando não deu.
function _mkperth(args::Vector{String})
    exe = mkperth_cli()
    exe === nothing && error("Perth: MK Perth's command line (mkperth-cli) isn't installed: " *
                             "put it on PATH or set ENV[\"MKPERTH_CLI\"] to its path.")
    out, err = IOBuffer(), IOBuffer()
    # Base.run: o `run` do Perth é o servidor.
    proc = Base.run(pipeline(ignorestatus(`$exe $args`); stdout = out, stderr = err))
    said = strip(String(take!(err)))
    success(proc) || error("Perth: mkperth-cli: " * said)
    for line in split(said, '\n'; keepempty = false)
        @warn "Perth (MK Perth): $line"
    end
    return String(take!(out))
end

"""
    export_p6xml(p::Project, path::AbstractString) -> String

Write `p` as Primavera P6 XML at `path`, through MK Perth. Tasks become
activities (a task's `start` a *start on or after* constraint, its
`deadline` a *finish on or before*), dependencies relationships with their
lags, the WBS (`parent`) WBS elements. What P6's XML has no place for is
said as a warning. Returns `path`.
"""
function export_p6xml(p::Project, path::AbstractString)
    mktempdir() do dir
        json = joinpath(dir, "project.json")
        write(json, JSON3.write(p))
        _mkperth(["schedule", "--in", json, "--out", String(path), "--format", "csv"])
    end
    return String(path)
end

"""
    import_p6xml(path::AbstractString; name = "") -> Project

Read a Primavera P6 XML file through MK Perth into a new project (kept like
one made with [`create_project`](@ref)): activities as tasks, relationships
as dependencies, WBS elements as summaries, the calendar as the business-day
calendar Perth knows nearest. `name` replaces the file's project name.
"""
function import_p6xml(path::AbstractString; name::AbstractString = "")
    isfile(path) || throw(ArgumentError("Perth: no file at $(repr(path))"))
    p = mktempdir() do dir
        json = joinpath(dir, "project.json")
        _mkperth(["schedule", "--in", String(path), "--out", json, "--format", "csv"])
        JSON3.read(read(json, String), Project)
    end
    isempty(name) || (p.name = String(name))
    isempty(strip(p.name)) && (p.name = splitext(basename(path))[1])
    p.file_path = ""
    _with_state(st -> begin
        haskey(st.projects, p.id) && (p.id = _short_id())
        st.projects[p.id] = p
        _save!(st, p)
    end)
    return p
end

"""
    schedule_p6(p::Project; float = :finish, critical = :float, threshold = 0)
        -> Vector{NamedTuple}

Schedule `p` with MK Perth, as Primavera P6 would, without changing it:
total float measured as `:finish` (late finish − early finish), `:start` or
`:smallest`; critical when the total float is at most `threshold` working
days (`critical = :float`) or on the longest path (`critical =
:longest_path`). One row per task, Tables.jl-compatible: `id`, `name`,
`early_start`, `early_finish`, `late_start`, `late_finish`, `total_float`,
`free_float` (working days), `critical`, `longest_path`.
"""
function schedule_p6(p::Project; float::Symbol = :finish, critical::Symbol = :float, threshold::Integer = 0)
    float in (:finish, :start, :smallest) ||
        throw(ArgumentError("Perth: float is :finish, :start or :smallest, not $(repr(float))"))
    critical in (:float, :longest_path) ||
        throw(ArgumentError("Perth: critical is :float or :longest_path, not $(repr(critical))"))
    options = Dict{String,Any}("float" => String(float),
                               "critical" => critical == :float ? "float" : "longest-path")
    critical == :float && (options["threshold"] = Int(threshold))
    text = mktempdir() do dir
        json = joinpath(dir, "project.json")
        write(json, JSON3.write(p))
        _mkperth(["run", "--in", json, "--cmd", "project.options=" * JSON3.write(options), "--format", "json"])
    end
    day(s) = Date(String(s))
    return [(id = String(a.id), name = String(a.name),
             early_start = day(a.early_start), early_finish = day(a.early_finish),
             late_start = day(a.late_start), late_finish = day(a.late_finish),
             total_float = Float64(a.total_float), free_float = Float64(a.free_float),
             critical = Bool(a.critical), longest_path = Bool(a.longest_path))
            for a in JSON3.read(text).activities]
end
