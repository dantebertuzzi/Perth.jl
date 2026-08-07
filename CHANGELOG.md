# Changelog

All notable changes to Perth.jl are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This file starts at 0.2.4 — earlier releases were not retroactively documented.

## [Unreleased]

### Changed
- Gantt: the 2.5s data-polling loop now skips itself while the presence
  WebSocket is connected, since the server already pushes a "rev" event
  the instant something changes — the periodic check was pure redundant
  traffic whenever the socket was live. Still runs as a fallback while
  the socket is down or reconnecting.

### Security
- Kanban: free-text fields coming from the network (card text, column
  name, checklist items, assignee, machine alias, due date) are now
  capped at 2000 characters, same as chat already was. Previously any
  connected peer could grow `kanban.json` without bound with a single
  oversized field.

### Fixed
- Kanban: `setPermissions` no longer reports a change (log entry, disk
  write, broadcast) when every entry in the batch was invalid (empty IP
  or an action outside the gated list) — it was a no-op that looked like
  one.
- Kanban: `Ctrl+Z`/`Ctrl+Shift+Z` no longer silently overwrite a
  colleague's edit made after yours. Undo/redo of a field-overwrite
  action (card text, column name/WIP, due date, assignee, machine
  alias) now checks whether the field still holds the value your own
  action set; if someone else changed it since, the undo/redo is
  skipped with a toast instead of clobbering their edit. Structural
  actions (create/delete/move) were already safe and are unaffected.

## [0.2.4] - 2026-08-04

### Added
- Kanban: host-only permissions matrix (`Board → Permissions…`) to restrict
  any of the 19 card/column actions individually per connecting IP.
  Enforced server-side (not just in the UI) and persisted with the board,
  so it survives reconnects and server restarts. Defaults to unrestricted,
  so existing boards are unaffected.
- Local "hide other cursors" preference in both the gantt and the kanban
  (menubar settings), persisted per browser and translated in all 5 UI
  languages. Only hides remote cursor rendering locally — presence for
  others is unaffected.

### Fixed
- Menubar no longer breaks when many machines are connected: peer chips
  are capped, with a "+N" chip that lists everyone who doesn't fit.
- Kanban: the client no longer loses its own "host" status after changing
  its display name — a stale `state.me` replacement was silently
  disabling host-only UI (including the new permissions matrix) after any
  `hello` message.
