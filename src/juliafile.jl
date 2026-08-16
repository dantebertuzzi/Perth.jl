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
    :Person    => Person,
    :Band     => Band,
    :Marker   => Marker,
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
    if !isempty(p.markers)
        println(io, "    markers = [")
        for m in p.markers
            campos = ["name = " * repr(m.name),
                     "date = Date(" * repr(string(m.date)) * ")"]
            isempty(m.color) || push!(campos, "color = " * repr(m.color))
            println(io, "        Marker(", join(campos, ", "), "),")
        end
        println(io, "    ],")
    end
    if !isempty(p.bands)
        println(io, "    bands = [")
        for f in p.bands
            campos = ["name = " * repr(f.name),
                     "from = Date(" * repr(string(f.from)) * ")",
                     "to = Date(" * repr(string(f.to)) * ")"]
            isempty(f.color) || push!(campos, "color = " * repr(f.color))
            println(io, "        Band(", join(campos, ", "), "),")
        end
        println(io, "    ],")
    end
    if !isempty(p.people)
        println(io, "    people = [")
        for pe in p.people
            campos = ["name = " * repr(pe.name)]
            for c in (:role, :team, :email, :notes)
                v = getfield(pe, c)
                isempty(v) || push!(campos, string(c) * " = " * repr(v))
            end
            println(io, "        Person(", join(campos, ", "), "),")
        end
        println(io, "    ],")
    end
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
        t.deadline === nothing ||
            println(io, "            deadline = Date(", repr(string(t.deadline)), "),")
        t.pinned && println(io, "            pinned = true,")
        if has_estimate(t)   # os três juntos ou nenhum: meia estimativa não diz nada
            println(io, "            optimistic = ", t.optimistic, ",")
            println(io, "            most_likely = ", t.most_likely, ",")
            println(io, "            pessimistic = ", t.pessimistic, ",")
        end
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
        # acento é transliterado, não descartado: sem isto "Análise
        # estatística" virava o arquivo "an-lise-estat-stica.perth.jl".
        # Mesma armadilha do slug de board no kanban (ver _slugify), e este
        # é um nome que o usuário vê e convive.
        ascii = Unicode.normalize(lowercase(p.name); stripmark = true)
        slug = strip(replace(ascii, r"[^a-z0-9]+" => "-"), '-')
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

# Tetos do fonte aceito. Um .perth.jl real aninha 4 níveis (Project → tasks
# → GanttTask → Date); 32 é folga de sobra. O motivo de existirem é grave: o
# parser do PRÓPRIO Julia é recursivo e morre — não lança exceção, derruba o
# processo com core dump — em poucos milhares de colchetes aninhados. Como
# fonte chega por HTTP (import e o painel "ver código"), sem este teto
# qualquer cliente derruba o servidor com alguns KB de "[[[[[".
const _MAX_SOURCE_BYTES = 4 * 1024 * 1024
const _MAX_SOURCE_DEPTH = 32

# Conta profundidade ignorando o que está dentro de string e de comentário:
# um nome de tarefa com "(((" não é aninhamento, e recusá-lo seria um falso
# positivo em projeto legítimo.
function _guard_source(src::AbstractString)
    sizeof(src) <= _MAX_SOURCE_BYTES || throw(ArgumentError(
        "Perth: project file is too large " *
        "(over $(_MAX_SOURCE_BYTES ÷ 1024^2) MB)"))
    depth = 0
    nastring = escapado = nocomentario = false
    for c in src
        if nocomentario
            c == '\n' && (nocomentario = false)
        elseif nastring
            if escapado;        escapado = false
            elseif c == '\\';   escapado = true
            elseif c == '"';    nastring = false
            end
        elseif c == '"';       nastring = true
        elseif c == '#';        nocomentario = true
        elseif c == '(' || c == '[' || c == '{'
            depth += 1
            depth <= _MAX_SOURCE_DEPTH || throw(ArgumentError(
                "Perth: project file nests too deeply " *
                "(over $(_MAX_SOURCE_DEPTH) levels)"))
        elseif c == ')' || c == ']' || c == '}'
            depth = max(depth - 1, 0)
        end
    end
    return nothing
end

# Faz o parse do fonte completo e exige exatamente uma expressão Project(...)
function _parse_project_source(src::AbstractString)
    _guard_source(src)          # antes do Meta.parseall: ver _guard_source
    ex = Meta.parseall(String(src))
    exprs = [a for a in ex.args if !(a isa LineNumberNode)]
    length(exprs) == 1 ||
        throw(ArgumentError("Perth: project file must contain exactly one expression"))
    val = _eval_safe(exprs[1])
    val isa Project ||
        throw(ArgumentError("Perth: file does not evaluate to a Project"))
    # file_path é caminho de espelhamento DESTA máquina e, por isso, nunca é
    # escrito no formato (ver types.jl). O leitor precisa dizer o mesmo: um
    # arquivo que o declare faz o primeiro salvamento gravar por cima do que
    # ele apontar — ~/.ssh/authorized_keys, um fonte, um documento. Recusar é
    # melhor que ignorar: arquivo de terceiros com esse campo não é engano de
    # digitação, e falhar alto é o que o resto deste parser faz.
    isempty(val.file_path) ||
        throw(ArgumentError("Perth: file_path is machine-specific and never " *
                            "part of a project file — set it with set_file_path!"))
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
