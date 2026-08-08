# Changelog

All notable changes to Perth.jl are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This file starts at 0.2.4 — earlier releases were not retroactively documented.

## [0.4.0] - 2026-08-08

### Added
- **Presentation mode**: a new menubar icon (both gantt and kanban),
  `P`, or *View → Presentation mode* hides the menubar — and, on the
  gantt, the toolbar and task table too — and requests browser
  fullscreen, leaving just the timeline/board for showing the plan on
  a projector. A small floating button in the corner (plus `Esc`)
  exits; leaving fullscreen by any other means (`Esc`'s native
  behavior, F11, window manager) is caught via the `fullscreenchange`
  event so the UI chrome comes back in sync either way.

### Changed
- Kanban: swapped `alert.mp3`, the notification sound played on new
  board activity, for a new clip.

## [0.3.0] - 2026-08-07

### Added
- Gantt: general chat (`Board` menu icon in the kanban already had this —
  now the gantt page does too), sharing the same presence WebSocket used
  for cursors. Persisted append-only per data dir (`chat.jsonl`), capped
  at 2000 characters per message, with a typing indicator and an unread
  badge on the toggle button. `Perth.chat!(text)` / `Perth.chat_log()`
  post/read from the REPL, same as `kanban_chat!`/`kanban_chat_log`.
  The kanban and gantt chat panels now share one CSS definition
  (`frontend/shared/ui.css`) instead of two copies.
- Chat panel (both apps) redesigned as a small floating, draggable
  widget instead of a full-height edge panel: rounded corners,
  translucent/blurred background, default bottom-right position.
  Drag it by the header to anywhere on the page — position is
  remembered per browser (`frontend/shared/draggable.js`, a new small
  shared helper, clamped to the viewport). The border highlights in
  the same purple as a selected kanban card while the panel has focus.

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
- Gantt: task name/assignee/notes and the project name are now capped
  at 2000 characters too (same limit, now shared between gantt and
  kanban). A single `PUT /api/projects/{id}` with an oversized field —
  from `share = true` or just a large paste — used to grow the project
  file on disk without bound.

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
- `using BusinessDays` alongside Perth could never precompile: the
  BusinessDays extension overrode a base-package method with the exact
  same signature, which Julia disallows during precompilation. It still
  worked (falling back to just-in-time compilation every session), but
  printed a scary `ERROR: Method overwriting is not permitted...` on
  every fresh session and never benefited from the precompile cache.
  The base package now declares the function with zero methods instead
  of a same-signature fallback, so the extension adds the only method
  and precompiles cleanly.
- Gantt: `Ctrl+Z`/`Ctrl+Shift+Z` no longer silently discard a colleague's
  concurrent work. Undo/redo restored a full-project snapshot taken
  before your edit, and the undo/redo stacks were never invalidated
  when the page reloaded data from elsewhere (REPL, another tab, the
  2.5s poll) — so undoing your own edit after any such reload could
  wipe out whatever changed in the meantime, including entire tasks
  someone else had just added. Undo/redo now reconcile task by task:
  only the tasks (and the project name) your own action actually
  touched are reverted/reapplied, and only if nothing else changed them
  since; anything added, removed or edited concurrently — by the REPL,
  another tab, or a teammate — is left alone. This directly affects the
  package's core pitch (REPL and UI over the same data, side by side).

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
