# Runtime integration for portable boards. Hold the current KanbanState lock
# while reading/replacing boards or changing the link registry. The watcher
# lock only protects task ownership; never acquire the state lock inside it.
const _KANBAN_LINK_WATCHERS = Dict{Tuple{String,String},Tuple{String,Task}}()
const _KANBAN_LINK_LOCK = ReentrantLock()

_kanban_links_file(dir) = joinpath(dir, ".kanban-links.json")

function _kanban_links(dir)
    file = _kanban_links_file(dir)
    if !isfile(file)
        legacy = joinpath(dir, "kanban-links.json")
        isfile(legacy) || return Dict{String,String}()
        data = JSON3.read(read(legacy, String))
        haskey(data, "columns") && return Dict{String,String}()  # A real board named "links".
        links = Dict{String,String}(String(k) => String(v) for (k, v) in pairs(data))
        all(isabspath, values(links)) || throw(ArgumentError("Perth: invalid legacy Kanban links"))
        mv(legacy, file)  # Move the earlier extension's registry out of the board namespace.
    end
    links = Dict{String,String}(String(k) => String(v)
        for (k, v) in pairs(JSON3.read(read(file, String))))
    for (slug, path) in links
        _slugify(slug) == slug && isabspath(path) ||
            throw(ArgumentError("Perth: invalid Kanban link registry entry $slug"))
    end
    return links
end

_save_kanban_links(dir, links) = _kanban_atomic_write(_kanban_links_file(dir), JSON3.write(links))

function _kanban_slug_from_json_file(file)
    name = basename(file)
    name == "kanban.json" && return "board"
    matched = match(r"^kanban-(.+)\.json$", name)
    return matched === nothing ? nothing : String(matched.captures[1])
end

function _kanban_read_board(st, slug)
    slug == st.name && return st.board
    return _plain(JSON3.read(read(first(_board_paths(st.data_dir, slug)), String)))
end

function _kanban_mirror_after_persist!(slug, board, data_dir)
    # JSON has already committed. Report a mirror failure separately, without
    # disguising a successful runtime save as a failed one.
    try
        path = get(_kanban_links(data_dir), slug, "")
        isempty(path) && return nothing
        snapshot = _kanban_snapshot(board, slug)
        source = _to_julia_source(snapshot)
        _export_assets!(snapshot, path, data_dir)
        isfile(path) && _kanban_read_source(path) == source && return nothing
        _kanban_atomic_write(path, source)
    catch err
        @warn "Perth kanban: could not update linked file" slug error=err
    end
    return nothing
end

"""
    kanban_save(path; board=nothing) -> String

Export the active board, a named board, or a `KanbanBoard` snapshot and its
referenced images. A directory gets `<board>.kanban.perth.jl`; other paths get
that suffix if missing. The parent directory must exist. Returns the absolute
path. This does not create a live link.
"""
function kanban_save(path::AbstractString; board=nothing)
    return _with_kanban() do st
        snapshot = if board isa KanbanBoard
            board
        elseif board isa AbstractDict
            _kanban_snapshot(board, st.name)
        else
            slug = board === nothing ? st.name : _board_slug(st.data_dir, String(board))
            _kanban_snapshot(_kanban_read_board(st, slug), slug)
        end
        resolved = _resolve_kanban_path(path, snapshot.name)
        source = _to_julia_source(snapshot)
        _export_assets!(snapshot, resolved, st.data_dir)
        _kanban_atomic_write(resolved, source)
    end
end

# Shared by explicit imports and watcher reloads. Validate and copy assets
# before committing JSON; keep local policy from the latest runtime board.
function _kanban_import!(st, snapshot, path, slug)
    file = first(_board_paths(st.data_dir, slug))
    old = if slug == st.name || isfile(file)
        _kanban_read_board(st, slug)
    else
        Dict{String,Any}()
    end
    board = _kanban_dict(snapshot)
    # Verify canonical output is readable before changing either store.
    _to_julia_source(_kanban_snapshot(board, slug))
    for key in ("aliases", "permissions")
        haskey(old, key) && (board[key] = old[key])
    end
    _validate_import_assets!(snapshot, path, st.data_dir)
    _kanban_atomic_write(file, JSON3.write(board))
    if slug == st.name
        st.board = board
        st.rev += 1
        _kanban_sync_all()
    end
    _kanban_mirror_after_persist!(slug, board, st.data_dir)
    return _kanban_snapshot(board, slug)
end

"""
    kanban_load(path; name=nothing, switch=true) -> KanbanBoard

Validate source and bundled images, then import into the board named by the
filename (or `name`). Replace portable content while retaining local aliases,
permissions, logs, and chat. `switch=false` keeps the current board selected;
importing that same board still refreshes it and its connected clients.
"""
function kanban_load(path::AbstractString; name=nothing, switch::Bool=true)
    resolved = abspath(expanduser(path))
    snapshot = parse_kanban(_kanban_read_source(resolved))
    return _with_kanban() do st
        requested = name === nothing ? replace(basename(resolved), r"\.kanban\.perth\.jl$"i => "") : String(name)
        slug = _board_slug(st.data_dir, requested)
        imported = _kanban_import!(st, snapshot, resolved, slug)
        switch && slug != st.name && _kanban_use_board!(slug)
        imported
    end
end

_kanban_read_source(path) = open(io -> String(read(io, _MAX_SOURCE_BYTES + 1)), path)

"""
    set_kanban_file_path!(path; board=nothing) -> String

Export and link the active or named board to a live two-way mirror. Existing
content at `path` is replaced: call [`kanban_load`](@ref) first to import it.
Pass `nothing` or an empty string to unlink without deleting the source or
assets. Each path can belong to only one board in the current data directory.
"""
function set_kanban_file_path!(path::Union{Nothing,AbstractString}; board=nothing)
    return _with_kanban() do st
        slug = board === nothing ? st.name : _board_slug(st.data_dir, String(board))
        links = _kanban_links(st.data_dir)
        if path === nothing || isempty(strip(path))
            delete!(links, slug)
            _save_kanban_links(st.data_dir, links)
            _kanban_links_sync!(st.data_dir)
            return ""
        end
        resolved = _resolve_kanban_path(path, slug)
        for (other, linked) in links
            same = linked == resolved || (ispath(linked) && ispath(resolved) && samefile(linked, resolved))
            other != slug && same && throw(ArgumentError("Kanban file is already linked to $other"))
        end
        snapshot = _kanban_snapshot(_kanban_read_board(st, slug), slug)
        source = _to_julia_source(snapshot)
        _export_assets!(snapshot, resolved, st.data_dir)
        _kanban_atomic_write(resolved, source)
        # Persist a newly created active board too, so its link survives restart.
        _kanban_atomic_write(first(_board_paths(st.data_dir, slug)), JSON3.write(_kanban_read_board(st, slug)))
        links[slug] = resolved
        _save_kanban_links(st.data_dir, links)
        _kanban_links_sync!(st.data_dir)
        resolved
    end
end

function _kanban_reload_link!(slug, path, data_dir)
    st = KANBAN[]
    (st === nothing || st.data_dir != data_dir) && return :unlinked
    return lock(st.lock) do
        get(_kanban_links(data_dir), slug, "") == path || return :unlinked
        isfile(first(_board_paths(data_dir, slug))) || return :unlinked
        isfile(path) || return :gone
        source = try
            _kanban_read_source(path)
        catch
            return :invalid   # leitura no meio de um salvamento: a próxima volta pega
        end
        current = _kanban_snapshot(_kanban_read_board(st, slug), slug)
        if source == _to_julia_source(current)
            delete!(_KANBAN_LINK_REFUSED, (data_dir, slug))
            return :same
        end
        snapshot = try
            parse_kanban(source)
        catch err
            err isa InterruptException && rethrow()
            _kanban_link_refused!(data_dir, slug, path, source, err)
            return :invalid
        end
        try
            _kanban_import!(st, snapshot, path, slug)
        catch err
            err isa InterruptException && rethrow()
            _kanban_link_refused!(data_dir, slug, path, source, err)
            return :invalid
        end
        delete!(_KANBAN_LINK_REFUSED, (data_dir, slug))
        return :reloaded
    end
end

# Fonte recusada por link, guardada pelo hash para avisar UMA vez por
# conteúdo. Quem edita o arquivo à mão e erra precisa saber que a edição não
# entrou — antes a recusa era muda, e o board simplesmente não mudava. Mas o
# watcher reavalia o arquivo a cada volta (_WATCH_TIMEOUT), então avisar a
# cada recusa repetiria o mesmo aviso de cinco em cinco segundos até alguém
# consertar. Mexido só dentro do lock do KanbanState, como o resto do reload.
const _KANBAN_LINK_REFUSED = Dict{Tuple{String,String},UInt}()

function _kanban_link_refused!(data_dir, slug, path, source, err)
    key = (String(data_dir), String(slug))
    get(_KANBAN_LINK_REFUSED, key, nothing) == hash(source) && return nothing
    _KANBAN_LINK_REFUSED[key] = hash(source)
    msg = err isa ArgumentError ? err.msg : sprint(showerror, err)
    @warn "Perth kanban: linked file was not loaded; the board keeps its last good state" path board=slug error=msg
    # Só para as abas do host: o arquivo é da máquina dele, e só ele pode
    # consertá-lo. Para quem está de fora não há o que fazer com o aviso.
    _kanban_broadcast(JSON3.write(Dict("type" => "linkRefused", "board" => slug,
                                       "file" => basename(path), "error" => msg));
                      hosts_only = true)
    return nothing
end

function _kanban_link_owned(key, path, task)
    return lock(_KANBAN_LINK_LOCK) do
        get(_KANBAN_LINK_WATCHERS, key, nothing) == (path, task)
    end
end

function _kanban_link_task(key, path)
    task = current_task()
    dir, slug = key
    try
        while _kanban_link_owned(key, path, task)
            # Check before waiting, and after timeouts too: this catches edits
            # made while Perth was stopped and atomic editor replacements.
            result = try
                _kanban_reload_link!(slug, path, dir)
            catch err
                @warn "Perth kanban: linked file watcher failed" path error=err
                :invalid
            end
            result == :unlinked && break
            if !isfile(path)
                sleep(1)  # Retry missing files, e.g. during an editor rename.
                continue
            end
            try
                FileWatching.watch_file(path, _WATCH_TIMEOUT)
            catch
                sleep(1)
            end
            sleep(0.12)
        end
    finally
        lock(_KANBAN_LINK_LOCK) do
            _kanban_link_owned(key, path, task) && delete!(_KANBAN_LINK_WATCHERS, key)
        end
    end
end

function _kanban_links_sync!(dir)
    links = try
        _kanban_links(dir)
    catch err
        @warn "Perth kanban: could not read link registry" error=err
        Dict{String,String}()
    end
    lock(_KANBAN_LINK_LOCK) do
        for key in collect(keys(_KANBAN_LINK_WATCHERS))
            key[1] == dir && haskey(links, key[2]) && continue
            delete!(_KANBAN_LINK_WATCHERS, key)
        end
        for (slug, path) in links
            key = (String(dir), slug)
            existing = get(_KANBAN_LINK_WATCHERS, key, nothing)
            existing !== nothing && existing[1] == path && continue
            task = Task(() -> _kanban_link_task(key, path))
            _KANBAN_LINK_WATCHERS[key] = (path, task)
            schedule(task)
        end
    end
    return nothing
end
