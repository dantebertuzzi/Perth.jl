# Git-friendly, safely parsed interchange format for Kanban boards. Runtime
# state stays in the existing Dict/JSON representation; these values are only
# the portable boundary.

"""Portable checklist entry with a stable ID, text, and completion flag."""
Base.@kwdef struct KanbanChecklistItem
    id::String
    text::String
    done::Bool = false
end

"""Portable card content, metadata, checklist, Gantt links, and image hashes."""
Base.@kwdef struct KanbanCard
    id::String
    text::String
    body::String = ""
    done::Bool = false
    done_at::String = ""
    by::String = ""
    at::String = ""
    assignee::String = ""
    due::String = ""
    checklist::Vector{KanbanChecklistItem} = KanbanChecklistItem[]
    project::String = ""
    task::String = ""
    images::Vector{String} = String[]
    col::String = ""             # archived-card origin
    archived_at::String = ""
end

"""Ordered cards in a named column; `wip=0` means no work-in-progress limit."""
Base.@kwdef struct KanbanColumn
    id::String
    name::String
    cards::Vector{KanbanCard} = KanbanCard[]
    wip::Int = 0
end

"""Version 1 board snapshot. Runtime permissions, history, and link paths are excluded."""
Base.@kwdef struct KanbanBoard
    format_version::Int = 1
    name::String = "board"
    columns::Vector{KanbanColumn} = KanbanColumn[]
    archive::Vector{KanbanCard} = KanbanCard[]
    auto_archive_days::Int = 0
end

const _KanbanValue = Union{KanbanBoard,KanbanColumn,KanbanCard,KanbanChecklistItem}

Base.:(==)(a::T, b::T) where {T<:_KanbanValue} =
    all(getfield(a, f) == getfield(b, f) for f in fieldnames(T))

for T in (KanbanBoard, KanbanColumn, KanbanCard, KanbanChecklistItem)
    _SAFE_CONSTRUCTORS[nameof(T)] = T
end

function _kanban_snapshot(board, name::AbstractString)
    columns = [KanbanColumn(
        id=String(c["id"]), name=String(c["name"]), wip=Int(get(c, "wip", 0)),
        cards=[_kanban_card_snapshot(card) for card in get(c, "cards", Any[])],
    ) for c in get(board, "columns", Any[])]
    return KanbanBoard(
        name=String(name), columns=columns,
        archive=[_kanban_card_snapshot(card) for card in get(board, "archive", Any[])],
        auto_archive_days=Int(get(board, "auto_archive_days", 0)),
    )
end

# Share the portable string-field list between both dictionary conversions.
const _KANBAN_CARD_STRINGS = (:body, :done_at, :by, :at, :assignee, :due,
                              :project, :task, :col, :archived_at)

function _kanban_card_snapshot(card)
    checklist = [KanbanChecklistItem(
        id=String(item["id"]), text=String(item["text"]), done=Bool(get(item, "done", false)),
    ) for item in get(card, "checklist", Any[])]
    strings = (field => String(get(card, String(field), "")) for field in _KANBAN_CARD_STRINGS)
    return KanbanCard(;
        id=String(card["id"]), text=String(card["text"]),
        done=Bool(get(card, "done", false)), checklist=checklist,
        images=String.(get(card, "images", String[])), strings...,
    )
end

function _kanban_text(text, label; required=false, cap=_TEXT_CAP)
    required && isempty(strip(text)) && throw(ArgumentError("Perth: $label must not be empty"))
    length(text) <= cap || throw(ArgumentError("Perth: $label is too long"))
end

function _kanban_unique_id!(seen, id, label)
    _kanban_text(id, "$label id"; required=true)
    id in seen && throw(ArgumentError("Perth: duplicate $label id $(repr(id))"))
    push!(seen, id)
end

function _validate_kanban(board::KanbanBoard)
    board.format_version == 1 || throw(ArgumentError(
        "Perth: unsupported Kanban format version $(board.format_version)"))
    _kanban_text(board.name, "board name"; required=true)
    0 <= board.auto_archive_days <= 36500 || throw(ArgumentError(
        "Perth: auto-archive days must be between 0 and 36500"))
    isempty(board.columns) && throw(ArgumentError("Perth: a Kanban board needs at least one column"))
    column_ids, card_ids = Set{String}(), Set{String}()
    for column in board.columns
        _kanban_unique_id!(column_ids, column.id, "column")
        _kanban_text(column.name, "column name"; required=true)
        0 <= column.wip <= 1_000_000 || throw(ArgumentError("Perth: invalid WIP limit"))
        for card in column.cards
            _validate_kanban_card!(card, card_ids; archived=false)
        end
    end
    for card in board.archive
        _validate_kanban_card!(card, card_ids; archived=true)
    end
    return board
end

function _validate_kanban_card!(card, ids; archived)
    _kanban_unique_id!(ids, card.id, "card")
    _kanban_text(card.text, "card text"; required=true)
    for field in _KANBAN_CARD_STRINGS
        cap = field == :body ? _BODY_CAP : _TEXT_CAP
        _kanban_text(getfield(card, field), "card $field"; cap)
    end
    length(card.images) <= _ASSET_MAX_PER_CARD || throw(ArgumentError("Perth: too many card images"))
    all(name -> occursin(_ASSET_NAME_RE, name), card.images) ||
        throw(ArgumentError("Perth: invalid image reference on card $(card.id)"))
    allunique(card.images) || throw(ArgumentError("Perth: duplicate image reference on card $(card.id)"))
    if archived
        _kanban_text(card.col, "archived card origin"; required=true)
        _kanban_text(card.archived_at, "archive timestamp"; required=true)
    end
    # Checklist operations are scoped to a card, so IDs need only be unique
    # within that card (copied cards may retain their checklist IDs).
    checklist_ids = Set{String}()
    for item in card.checklist
        _kanban_unique_id!(checklist_ids, item.id, "checklist")
        _kanban_text(item.text, "checklist text"; required=true)
    end
end

function _kanban_dict(board::KanbanBoard)
    _validate_kanban(board)
    result = Dict{String,Any}(
        "columns" => Any[_kanban_col_dict(column) for column in board.columns],
        "archive" => Any[_kanban_card_dict(card) for card in board.archive],
    )
    board.auto_archive_days > 0 && (result["auto_archive_days"] = board.auto_archive_days)
    return result
end

function _kanban_col_dict(column)
    result = Dict{String,Any}(
        "id" => column.id, "name" => column.name,
        "cards" => Any[_kanban_card_dict(card) for card in column.cards],
    )
    column.wip > 0 && (result["wip"] = column.wip)
    return result
end

function _kanban_card_dict(card)
    result = Dict{String,Any}("id" => card.id, "text" => card.text, "done" => card.done)
    for field in _KANBAN_CARD_STRINGS
        value = getfield(card, field)
        isempty(value) || (result[String(field)] = value)
    end
    if !isempty(card.checklist)
        result["checklist"] = Any[Dict{String,Any}(
            "id" => item.id, "text" => item.text, "done" => item.done,
        ) for item in card.checklist]
    end
    isempty(card.images) || (result["images"] = Any[card.images...])
    return result
end

# Field order is the file order. Required fields are always written; optional
# defaults are omitted. The same writer handles all four interchange types.
_kanban_defaults(b::KanbanBoard) = KanbanBoard()
_kanban_defaults(c::KanbanColumn) = KanbanColumn(id=c.id, name=c.name)
_kanban_defaults(c::KanbanCard) = KanbanCard(id=c.id, text=c.text)
_kanban_defaults(c::KanbanChecklistItem) = KanbanChecklistItem(id=c.id, text=c.text)

function _kanban_source(io, value::_KanbanValue, indent=0)
    padding = " "^indent
    defaults = _kanban_defaults(value)
    println(io, nameof(typeof(value)), "(")
    for field in fieldnames(typeof(value))
        item = getfield(value, field)
        required = field in (:format_version, :name, :id, :text, :columns)
        required || item != getfield(defaults, field) || continue
        print(io, padding, "    ", field, " = ")
        if item isa AbstractVector && !(item isa Vector{String})
            println(io, "[")
            for child in item
                print(io, padding, "        ")
                _kanban_source(io, child, indent + 8)
                println(io, ",")
            end
            print(io, padding, "    ]")
        else
            print(io, repr(item))
        end
        println(io, ",")
    end
    print(io, padding, ")")
end

function _to_julia_source(b::KanbanBoard)
    _validate_kanban(b)
    io = IOBuffer()
    println(io, "# Perth Kanban board — portable, safely parsed interchange")
    _kanban_source(io, b)
    source = String(take!(io))
    _guard_source(source)  # Never export a file our parser cannot read.
    return source
end

function _parse_kanban_source(src::AbstractString)
    _guard_source(src)
    expressions = filter(x -> !(x isa LineNumberNode), Meta.parseall(String(src)).args)
    length(expressions) == 1 || throw(ArgumentError(
        "Perth: Kanban file must contain exactly one expression"))
    board = try
        _eval_safe(only(expressions))
    catch err
        err isa InterruptException && rethrow()
        throw(ArgumentError("Perth: invalid Kanban source: $(sprint(showerror, err))"))
    end
    board isa KanbanBoard || throw(ArgumentError("Perth: expected a KanbanBoard"))
    return _validate_kanban(board)
end

"""
    parse_kanban(source::AbstractString) -> KanbanBoard

Parse and validate a snapshot without executing Julia code or registering a
board. Image references are checked here; image bytes are checked on import.
"""
parse_kanban(source::AbstractString) = _parse_kanban_source(source)

function _kanban_atomic_write(path, data)
    tmp, io = mktemp(dirname(path))
    try
        write(io, data)
        close(io)
        mv(tmp, path; force=true)
    finally
        isopen(io) && close(io)
        isfile(tmp) && rm(tmp; force=true)
    end
    return String(path)
end

"""
    save(board::KanbanBoard, path::AbstractString)

Write validated source to exactly `path`. Use [`kanban_save`](@ref) to resolve
file extensions and export referenced images from the runtime asset store.
"""
save(b::KanbanBoard, path::AbstractString) =
    _kanban_atomic_write(path, _to_julia_source(b))

function _resolve_kanban_path(raw::AbstractString, name::AbstractString)
    input = strip(raw)
    isempty(input) && throw(ArgumentError("Kanban path must not be empty"))
    path = abspath(expanduser(input))
    if isdir(path) || endswith(input, '/') || endswith(input, '\\')
        path = joinpath(path, "$(_slugify(name)).kanban.perth.jl")
    end
    endswith(lowercase(path), ".kanban.perth.jl") || (path *= ".kanban.perth.jl")
    isdir(dirname(path)) || throw(ArgumentError("directory does not exist: $(dirname(path))"))
    return path
end

function _kanban_bundle(path)
    # Also support importing source saved with the low-level save API.
    stem = replace(path, r"\.kanban\.perth\.jl$"i => "")
    return stem * ".kanban.assets"
end

function _kanban_image_names(board)
    cards = Iterators.flatten((Iterators.flatten(c.cards for c in board.columns), board.archive))
    return unique([name for card in cards for name in card.images])
end

function _kanban_asset_bytes(dir, name)
    occursin(_ASSET_NAME_RE, name) || throw(ArgumentError("invalid Kanban asset name $name"))
    path = joinpath(dir, name)
    isfile(path) || throw(ArgumentError("missing Kanban asset $name"))
    # Bound the read too: a size check alone races with a concurrent writer.
    bytes = open(io -> read(io, _ASSET_MAX_BYTES + 1), path)
    length(bytes) <= _ASSET_MAX_BYTES || throw(ArgumentError("Kanban asset $name is too large"))
    mime = _bg_sniff(bytes)
    mime === nothing && throw(ArgumentError("Kanban asset $name is not a supported image"))
    expected = bytes2hex(SHA.sha256(bytes)) * "." * _ASSET_EXT[mime]
    expected == name || throw(ArgumentError("Kanban asset hash or extension mismatch: $name"))
    return bytes
end

_kanban_asset_matches(path, bytes) =
    isfile(path) && open(io -> read(io, length(bytes) + 1) == bytes, path)

function _export_assets!(board, path, data_dir)
    names = _kanban_image_names(board)
    isempty(names) && return nothing
    dest = _kanban_bundle(path)
    mkpath(dest)
    for name in names
        bytes = _kanban_asset_bytes(_asset_dir(data_dir), name)
        target = joinpath(dest, name)
        # Keep already-correct blobs and all unreferenced files untouched.
        _kanban_asset_matches(target, bytes) && continue
        _kanban_atomic_write(target, bytes)
    end
    return nothing
end

function _validate_import_assets!(board, path, data_dir)
    dest = _asset_dir(data_dir)
    staged = Pair{String,Vector{UInt8}}[]
    total = _asset_total_bytes(dest)
    for name in _kanban_image_names(board)
        bytes = _kanban_asset_bytes(_kanban_bundle(path), name)
        target = joinpath(dest, name)
        total += length(bytes) - (isfile(target) ? filesize(target) : 0)
        total <= _ASSET_MAX_TOTAL || throw(ArgumentError("Kanban image store would exceed its size limit"))
        push!(staged, name => bytes)
    end
    # Validate every blob before writing any. Board state changes only after
    # all copies succeed; existing damaged blobs are repaired on import.
    isempty(staged) && return nothing
    mkpath(dest)
    for (name, bytes) in staged
        target = joinpath(dest, name)
        _kanban_asset_matches(target, bytes) && continue
        _kanban_atomic_write(target, bytes)
    end
    return nothing
end
