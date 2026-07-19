# Persistência: estado em memória (Dict de projetos) espelhado em arquivos
# JSON, um por projeto, no diretório de dados. Todas as mutações passam por
# _with_state para garantir exclusão mútua e bump do contador de revisão,
# que o frontend usa para detectar mudanças feitas pelo REPL (e vice-versa).

mutable struct AppState
    projects::Dict{String,Project}
    data_dir::String
    rev::Int              # revisão monotônica; frontend faz polling disso
    settings::Dict{String,String}  # preferências persistentes (settings.json)
    lock::ReentrantLock
end

const STATE = Ref{Union{AppState,Nothing}}(nothing)

# Diretório de dados default: PERTH_DATA_DIR ou ~/.perth
_default_data_dir() = get(ENV, "PERTH_DATA_DIR", joinpath(homedir(), ".perth"))

# Garante estado inicializado (carrega projetos do disco na primeira chamada)
function _state()
    if STATE[] === nothing
        _init_state!(_default_data_dir())
    end
    return STATE[]::AppState
end

function _init_state!(data_dir::AbstractString)
    mkpath(data_dir)
    st = AppState(Dict{String,Project}(), String(data_dir), 0,
                  Dict{String,String}(), ReentrantLock())
    for f in readdir(data_dir; join = true)
        endswith(f, ".json") || continue
        basename(f) == "settings.json" && continue
        try
            p = JSON3.read(read(f, String), Project)
            st.projects[p.id] = p
        catch err
            @warn "Perth: ignoring unreadable project file" file = f error = err
        end
    end
    sf = _settings_file(st)
    if isfile(sf)
        try
            for (k, v) in JSON3.read(read(sf, String), Dict{String,String})
                st.settings[k] = v
            end
        catch err
            @warn "Perth: ignoring unreadable settings file" file = sf error = err
        end
    end
    STATE[] = st
    return st
end

_settings_file(st::AppState) = joinpath(st.data_dir, "settings.json")

function _save_settings!(st::AppState)
    try
        write(_settings_file(st), JSON3.write(st.settings))
    catch err
        @warn "Perth: could not persist settings" error = err
    end
    return st
end

# Memoriza o diretório do último vínculo de arquivo: o navegador de pastas
# da UI reabre nele, e ele vira o ponto de partida para projetos futuros.
function _remember_save_dir!(st::AppState, path::AbstractString)
    dir = dirname(path)
    isdir(dir) || return st
    st.settings["default_save_dir"] = dir
    _save_settings!(st)
end

# Executa f com o lock do estado; toda mutação deve usar isto
function _with_state(f)
    st = _state()
    lock(st.lock) do
        f(st)
    end
end

_project_file(st::AppState, p::Project) = joinpath(st.data_dir, "$(p.id).json")

# Persiste um projeto em disco e incrementa a revisão
function _save!(st::AppState, p::Project)
    p.updated_at = Dates.now()
    _prune_dependencies!(p)
    _prune_parents!(p)
    _rollup_summaries!(p)
    foreach(_normalize!, p.tasks)
    write(_project_file(st, p), JSON3.write(p))
    # Espelhamento estilo Pluto: se o usuário escolheu um arquivo na UI
    # (caixa de caminho na menubar) ou via set_file_path!, cada salvamento
    # também regrava o .perth.jl naquele local. Falha de escrita não pode
    # derrubar o salvamento interno — apenas avisa.
    if !isempty(p.file_path)
        try
            write(p.file_path, _to_julia_source(p))
        catch err
            @warn "Perth: could not mirror project to file" path = p.file_path error = err
        end
    end
    st.rev += 1
    return p
end

function _delete!(st::AppState, id::AbstractString)
    haskey(st.projects, id) || return false
    f = _project_file(st, st.projects[id])
    delete!(st.projects, id)
    isfile(f) && rm(f)
    st.rev += 1
    return true
end

# ---------------------------------------------------------------------------
# API pública de manipulação via REPL
# ---------------------------------------------------------------------------

"""
    create_project(name::AbstractString) -> Project

Create (and persist) a new empty project.
"""
function create_project(name::AbstractString)
    p = Project(name = String(name))
    _with_state(st -> begin
        st.projects[p.id] = p
        _save!(st, p)
    end)
    return p
end

"""
    project(name_or_id::AbstractString) -> Project

Fetch a project by exact id or by (case-insensitive) name.
Throws `KeyError` if not found.
"""
function project(key::AbstractString)
    _with_state(st -> begin
        haskey(st.projects, key) && return st.projects[key]
        for p in values(st.projects)
            lowercase(p.name) == lowercase(key) && return p
        end
        throw(KeyError(key))
    end)
end

"""
    projects() -> Vector{NamedTuple}

List all projects as a Tables.jl-compatible vector of rows
(`id`, `name`, `tasks`, `updated_at`).
"""
function projects()
    _with_state(st -> begin
        rows = [(id = p.id, name = p.name, tasks = length(p.tasks),
                 updated_at = p.updated_at) for p in values(st.projects)]
        sort!(rows; by = r -> r.updated_at, rev = true)
        rows
    end)
end

"""
    tasks(p::Project) -> Vector{NamedTuple}

Project tasks as a Tables.jl-compatible vector of rows, sorted by start date.
"""
function tasks(p::Project)
    rows = [(id = t.id, name = t.name, start = t.start, finish = end_date(p, t),
             duration = t.duration, progress = t.progress,
             assignee = t.assignee, milestone = t.milestone) for t in p.tasks]
    sort!(rows; by = r -> r.start)
    return rows
end

"""
    add_task!(p::Project, name; start = today(), duration = 1, kwargs...) -> GanttTask

Add a task to `p` and persist. Keyword arguments are forwarded to
[`GanttTask`](@ref) (`progress`, `dependencies`, `color`, `assignee`,
`notes`, `milestone`).
"""
function add_task!(p::Project, name::AbstractString;
                   start::Date = Dates.today(), duration::Integer = 1, kwargs...)
    t = GanttTask(; name = String(name), start, duration = Int(duration), kwargs...)
    _normalize!(t)
    _with_state(st -> begin
        push!(p.tasks, t)
        _save!(st, p)
    end)
    return t
end

"""
    update_task!(p::Project, id::AbstractString; kwargs...) -> GanttTask

Update fields of the task with the given `id` (any [`GanttTask`](@ref) field
except `id`) and persist.
"""
function update_task!(p::Project, id::AbstractString; kwargs...)
    i = findfirst(t -> t.id == id, p.tasks)
    i === nothing && throw(KeyError(id))
    t = p.tasks[i]
    for (k, v) in pairs(kwargs)
        k === :id && continue
        setproperty!(t, k, v)
    end
    _normalize!(t)
    _with_state(st -> _save!(st, p))
    return t
end

"""
    remove_task!(p::Project, id::AbstractString) -> Project

Remove the task with the given `id` (and any dependency references to
it), then persist. Children of a removed WBS summary are promoted to
its parent.
"""
function remove_task!(p::Project, id::AbstractString)
    i = findfirst(t -> t.id == id, p.tasks)
    grand = i === nothing ? "" : p.tasks[i].parent
    for o in p.tasks
        o.parent == id && (o.parent = grand)
    end
    filter!(t -> t.id != id, p.tasks)
    _with_state(st -> _save!(st, p))
    return p
end

"""
    duplicate_task!(p::Project, id::AbstractString) -> GanttTask

Insert a copy of the task with the given `id` right after the original
(same dates and fields, name suffixed with `" (copy)"`, fresh id) and
persist. Returns the top copy.

A WBS summary is duplicated as a whole subtree: descendants are cloned
with fresh ids, parent links and *internal* dependencies are remapped to
the clones, and dependencies on tasks outside the subtree are kept.
Tasks that depend on the original are never changed.
"""
function duplicate_task!(p::Project, id::AbstractString)
    i = findfirst(t -> t.id == id, p.tasks)
    i === nothing && throw(KeyError(id))
    t = p.tasks[i]
    subtree = [t; [o for o in p.tasks if o.id in _descendants(p, t.id)]]
    remap = Dict(o.id => _short_id() for o in subtree)
    clones = GanttTask[]
    for o in subtree
        push!(clones, GanttTask(;
            id = remap[o.id],
            name = o.id == t.id ? o.name * " (copy)" : o.name,
            start = o.start, duration = o.duration, progress = o.progress,
            dependencies = [get(remap, d, d) for d in o.dependencies],
            color = o.color, assignee = o.assignee, notes = o.notes,
            milestone = o.milestone,
            parent = o.id == t.id ? t.parent : get(remap, o.parent, o.parent),
            baseline_start = o.baseline_start,
            baseline_duration = o.baseline_duration))
    end
    for (k, c) in enumerate(clones)
        insert!(p.tasks, i + k, c)
    end
    _with_state(st -> _save!(st, p))
    return clones[1]
end

"""
    delete_project(name_or_id::AbstractString) -> Bool

Delete a project and its file on disk. Returns `true` if it existed.
"""
function delete_project(key::AbstractString)
    p = try
        project(key)
    catch
        return false
    end
    _with_state(st -> _delete!(st, p.id))
end
