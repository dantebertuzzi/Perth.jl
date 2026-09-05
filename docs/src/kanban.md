# Kanban

```@docs
Perth.kanban
Perth.kanban_stop
kanban_share!
kanban_key!
kanban_add_card!
kanban_move_card!
kanban_remove_card!
kanban_cards
kanban_columns
kanban_from_project!
kanban_board!
kanban_boards
kanban_delete_board!
kanban_alias!
kanban_log
kanban_reset!
kanban_save
kanban_load
parse_kanban
KanbanBoard
KanbanColumn
KanbanCard
KanbanChecklistItem
set_kanban_file_path!
```

## Version-controlled board files

Perth continues to use `kanban*.json` as machine-local runtime storage. For a
portable, reviewable snapshot, export a board with
`kanban_save("plan/thesis")`; this writes `plan/thesis.kanban.perth.jl`.
Import it with `kanban_load("plan/thesis.kanban.perth.jl")`.

To keep the file synchronized in both directions, call
`set_kanban_file_path!("plan/thesis.kanban.perth.jl")`. Perth rewrites the
mirror after board changes and reloads valid edits made by an editor. Call
`set_kanban_file_path!(nothing)` to unlink it. Link paths are stored only in
the local `.kanban-links.json` registry.

Referenced images are copied to the sibling `thesis.kanban.assets/`
directory. Commit that directory together with the Julia file. Activity
logs, chat, aliases, permissions, sharing keys, clients, revisions, and mirror
paths are deliberately excluded from the portable source.

Linking exports the current runtime board and replaces any file at that path.
To start from a checked-out file, import it before linking:

```julia
kanban_load("plan/thesis.kanban.perth.jl"; name="thesis")
set_kanban_file_path!("plan/thesis.kanban.perth.jl"; board="thesis")
```

`kanban_load(...; switch=false)` imports without selecting a different board.
If the imported board is already active, its memory and connected browsers
still update. Imports retain that board's machine-local policy and history.
Use `parse_kanban(read(path, String))` for a snapshot without registration;
`Perth.save(snapshot, path)` writes source only, while `kanban_save` also
exports images from Perth's runtime store.

Linked inactive boards are watched too. Links are restored on startup, so
valid edits made while Perth was stopped are imported. Invalid source or
assets leave the board unchanged; missing files are retried. Synchronization
uses last-write-wins semantics, without merging concurrent edits. A failed
mirror write produces a warning while the runtime JSON save remains valid.
Unlinking or deleting a board preserves its exported source and assets.
The earlier extension's `kanban-links.json` registry is migrated automatically
to `.kanban-links.json`, leaving `links` available as a board name.
