# Formato de intercâmbio .perth.jl: o projeto exportado é código Julia
# legível — diffável em git e reconstruível no REPL. A leitura NÃO usa
# eval/include: um avaliador restrito caminha a AST e aceita apenas os
# construtores da whitelist. Qualquer outra chamada (run, readline, …)
# é rejeitada, então importar um arquivo de terceiros é seguro.
#
# O armazenamento interno em ~/.perth continua JSON (parsing rápido e
# inequívoco na inicialização); .jl é o formato de exportação/importação.

const _SAFE_CONSTRUCTORS = Dict{Symbol,Any}(
    :Project   => Project,
    :GanttTask => GanttTask,
    :Date      => Dates.Date,
    :DateTime  => Dates.DateTime,
)

# ---------------------------------------------------------------------------
# Escrita
# ---------------------------------------------------------------------------

# Gera o código-fonte do projeto. Campos com valor default são omitidos
# para o arquivo ficar limpo e os diffs, mínimos.
function _to_julia_source(p::Project)
    io = IOBuffer()
    println(io, "# Perth project — readable, executable Julia source")
    println(io, "# Rebuild in the REPL:  using Perth;  p = Perth.load(\"file.perth.jl\")")
    println(io, "# (Perth.load uses a restricted parser and never executes code)")
    println(io, "Project(")
    println(io, "    id = ", repr(p.id), ",")
    println(io, "    name = ", repr(p.name), ",")
    isempty(p.calendar) ||
        println(io, "    calendar = ", repr(p.calendar), ",")
    p.baseline_at === nothing ||
        println(io, "    baseline_at = DateTime(", repr(string(p.baseline_at)), "),")
    println(io, "    created_at = DateTime(", repr(string(p.created_at)), "),")
    println(io, "    updated_at = DateTime(", repr(string(p.updated_at)), "),")
    println(io, "    tasks = [")
    for t in p.tasks
        println(io, "        GanttTask(")
        println(io, "            id = ", repr(t.id), ",")
        println(io, "            name = ", repr(t.name), ",")
        println(io, "            start = Date(", repr(string(t.start)), "),")
        t.milestone || println(io, "            duration = ", t.duration, ",")
        t.progress != 0 && println(io, "            progress = ", t.progress, ",")
        isempty(t.dependencies) ||
            println(io, "            dependencies = ", repr(t.dependencies), ",")
        isempty(t.color) || println(io, "            color = ", repr(t.color), ",")
        isempty(t.assignee) || println(io, "            assignee = ", repr(t.assignee), ",")
        isempty(t.notes) || println(io, "            notes = ", repr(t.notes), ",")
        t.milestone && println(io, "            milestone = true,")
        isempty(t.parent) || println(io, "            parent = ", repr(t.parent), ",")
        t.baseline_start === nothing ||
            println(io, "            baseline_start = Date(", repr(string(t.baseline_start)), "),")
        t.baseline_duration == 0 ||
            println(io, "            baseline_duration = ", t.baseline_duration, ",")
        println(io, "        ),")
    end
    println(io, "    ],")
    print(io, ")")
    return String(take!(io))
end

"""
    Perth.save(p::Project, path::AbstractString) -> String

Write `p` to `path` as readable, git-diffable Julia source
(the `.perth.jl` interchange format). Returns the path.
"""
function save(p::Project, path::AbstractString)
    write(path, _to_julia_source(p))
    return String(path)
end

# Normaliza o caminho digitado pelo usuário (UI ou REPL) para um arquivo
# .perth.jl absoluto:
#   ~            -> expandido
#   diretório/   -> anexa "<slug-do-nome>.perth.jl"
#   sem .jl      -> anexa ".perth.jl"
# Lança ArgumentError se o diretório-pai não existir (não criamos diretórios
# silenciosamente: um typo não deve espalhar pastas pelo disco).
function _resolve_save_path(p::Project, raw::AbstractString)
    raw = strip(raw)
    path = abspath(expanduser(raw))
    if isdir(path) || endswith(raw, '/') || endswith(raw, '\\')
        slug = strip(replace(lowercase(p.name), r"[^a-z0-9]+" => "-"), '-')
        isempty(slug) && (slug = p.id)
        path = joinpath(path, "$(slug).perth.jl")
    end
    endswith(lowercase(path), ".jl") || (path *= ".perth.jl")
    dir = dirname(path)
    isdir(dir) || throw(ArgumentError("directory does not exist: $dir"))
    return path
end

"""
    set_file_path!(p::Project, path::AbstractString) -> String
    set_file_path!(p::Project, nothing) -> String

Link `p` to a `.perth.jl` file on disk (Pluto-style): the file is written
immediately and re-written on every subsequent save, from the web UI or
the REPL. `~` is expanded; a directory path gets a filename derived from
the project name; a missing `.jl` extension is appended.

Pass `nothing` (or an empty string) to unlink the project from the file.
Returns the resolved path (empty string when unlinked).
"""
function set_file_path!(p::Project, path::Union{Nothing,AbstractString})
    raw = path === nothing ? "" : strip(path)
    if isempty(raw)
        p.file_path = ""
        _with_state(st -> _save!(st, p))
        return ""
    end
    resolved = _resolve_save_path(p, raw)
    write(resolved, _to_julia_source(p))  # falha aqui aborta antes de vincular
    p.file_path = resolved
    _with_state(st -> begin
        _save!(st, p)
        _remember_save_dir!(st, resolved)
    end)
    return resolved
end

# ---------------------------------------------------------------------------
# Leitura (avaliador restrito — nunca eval)
# ---------------------------------------------------------------------------

_eval_safe(x::Union{AbstractString,Bool,Int,Float64}) = x
_eval_safe(x) = throw(ArgumentError("Perth: literal not allowed in project file: $(repr(x))"))

function _eval_safe(e::Expr)
    if e.head === :vect
        return [_eval_safe(a) for a in e.args]
    elseif e.head === :call
        f = e.args[1]
        (f isa Symbol && haskey(_SAFE_CONSTRUCTORS, f)) ||
            throw(ArgumentError("Perth: call not allowed in project file: $f"))
        args = Any[]
        kws = Pair{Symbol,Any}[]
        for a in e.args[2:end]
            if a isa Expr && a.head === :kw
                push!(kws, a.args[1] => _eval_safe(a.args[2]))
            elseif a isa Expr && a.head === :parameters
                for k in a.args
                    (k isa Expr && k.head === :kw) ||
                        throw(ArgumentError("Perth: unsupported keyword syntax"))
                    push!(kws, k.args[1] => _eval_safe(k.args[2]))
                end
            else
                push!(args, _eval_safe(a))
            end
        end
        return _SAFE_CONSTRUCTORS[f](args...; kws...)
    end
    throw(ArgumentError("Perth: construct not allowed in project file: $(e.head)"))
end

# Faz o parse do fonte completo e exige exatamente uma expressão Project(...)
function _parse_project_source(src::AbstractString)
    ex = Meta.parseall(String(src))
    exprs = [a for a in ex.args if !(a isa LineNumberNode)]
    length(exprs) == 1 ||
        throw(ArgumentError("Perth: project file must contain exactly one expression"))
    val = _eval_safe(exprs[1])
    val isa Project ||
        throw(ArgumentError("Perth: file does not evaluate to a Project"))
    _prune_dependencies!(val)
    _prune_parents!(val)
    _rollup_summaries!(val)
    foreach(_normalize!, val.tasks)
    return val
end

"""
    Perth.load(path::AbstractString; register = true) -> Project

Read a `.perth.jl` project file using a restricted AST evaluator —
no code in the file is ever executed; only `Project`, `GanttTask`,
`Date`, `DateTime`, literals and vectors are accepted.

With `register = true` (default) the project is stored (a project with
the same `id` is replaced), so it appears in the web UI immediately.
"""
function load(path::AbstractString; register::Bool = true)
    p = _parse_project_source(read(path, String))
    register && _with_state(st -> begin
        st.projects[p.id] = p
        _save!(st, p)
    end)
    return p
end
