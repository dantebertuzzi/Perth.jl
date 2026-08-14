# Changelog

All notable changes to Perth.jl are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This file starts at 0.2.4 — earlier releases were not retroactively documented.

## [Unreleased]

### Added
- Kanban: cards created **today** are marked `new`, next to the creator
  stamp in the card footer. No new data — the server has always stamped
  `at` on creation, and restoring a card from the archive keeps the
  original stamp, so an old card never comes back looking new. The mark
  is deliberately quiet: a single word in the accent colour, no border,
  no background, not clickable (the card footer already carries up to
  three bordered pills — assignee, due date, archive — and a fourth box
  would turn it into a row of buttons). It disappears the moment the
  card is done, and each browser can switch it off in the settings panel
  (*hide new-card badges*), like the cursors and the background image.

### Fixed
- Kanban: the board now redraws just after midnight. Everything derived
  from *today* — the due-date pills going `soon`/`overdue`, and now the
  `new` mark — was only ever built inside `render()`, which runs on
  board operations, not on the clock: a board left open overnight kept
  showing yesterday's "today" until somebody touched it.

## [0.7.0] - 2026-08-13

### Security
- The access key (`key = "…"`) now also protects `/background`. It was
  the one route outside `/api/` serving bytes from outside the frontend
  — the image `Perth.background!` points at — so any machine on the
  network could fetch the picture without the key, while
  `/api/background` (its metadata) was refused. Both frontends now send
  the key with the image URL.

### Added
- **The access key is now a live setting**, like sharing already was:
  `Perth.key!("…")` on the gantt and `Perth.kanban_key!("…")` on the
  board set it, change it or drop it (`key!()`) with the server up — no
  restart, no lost port. The same control sits in the Share / QR dialog,
  for the machine running the server only, next to the transmit switch:
  the warning about running open on the network is finally something you
  can act on without stopping everything. Changing the key disconnects
  the machines holding the old one, each landing on the "access key"
  dialog to type the new one; dropping it disconnects nobody. The links
  and the QR code in the dialog update with the key.
- Gantt: the access key can be typed in the UI. Opening a keyed server
  without `?key=` used to end in `startup error: access key required`
  in the status bar and nothing else — the link with the key in it was
  the only way in, so a bookmark, the PWA's `start_url` or a link
  passed on without the query left you stuck. It now asks for the key
  (the dialog the kanban already had) and keeps it in `sessionStorage`,
  so a reload without the query still works. Typing a key also clears
  `?key=` from the address bar — on load the URL wins over the session,
  so a stale one would come back on the next reload.

### Fixed
- Kanban: the WebSocket refusal for a missing key now carries
  `reason: "key"`, like the gantt's and like the protocol documented in
  `presence.jl` (it was sent bare, and the client only picked the right
  dialog by falling through the `share_off` branch).

## [0.6.0] - 2026-08-12

### Added
- **Deadlines**: `GanttTask` gains `deadline` — a *commitment*, not a
  plan. It never moves the task; it caps the late finish in the CPM
  backward pass, so busting one turns the slack of that task **and of
  every task feeding it** negative, by exactly the number of days it is
  late. That is what the CPM alone could not say: it told you whether a
  task was critical, never whether it broke a promise. A deadline later
  than the project finish is inert — the late finish is already capped
  by the project end for every task. `deadline_slip(p)` lists what is
  late (calendar days, like `slippage`); the UI puts a flag on the day
  and counts the misses in the status bar.
- **Pinned start dates**: `pinned` marks a start as contractual and
  `schedule!` leaves it alone while pushing everything else. The engine
  still computes where the task *would* go, so a pin the plan can no
  longer honour shows up as `slack`'s `early_start` being later than
  the task's `start` (amber pin on the chart) instead of the date
  moving silently. Deliberately not a change to the forward pass —
  that would open the door to the full SNET/SNLT/MSO/ALAP set.
- A task's own start date has always acted as *start-no-earlier-than*
  (`schedule!` only pushes forward); that is now documented rather than
  being folklore in a comment.
- Both fields travel through `.perth.jl`, `tasktable`, `add_tasks!` and
  the CSV export (new `deadline` and `pinned` columns, after `duration`
  and before `progress`).

- **Resource panel** (gantt): *View → Resources*, or `R`, docks a band
  per person under the chart, on the same time scale as the bars —
  green for one task that day, amber for two, red for three or more,
  with the day's tasks named in the tooltip. Clicking a band spotlights
  that person's tasks in the chart above (the same highlight the
  toolbar selector already had), and the last band is the leaf work
  with nobody on it. Horizontal scrolling is synced both ways: the two
  scales are the same one, so drifting apart would be a visual lie.
- `workload(p)` returns the same thing as Tables.jl rows — one per
  (person, day) with work on it, carrying `tasks`, `effort` (`cost`
  when set, otherwise person-days, the same weight the S-curve uses)
  and `task_ids`. Days with no work produce no row.
- `GET /api/projects/{id}/workload` serves it densified over a
  contiguous day window, per person, for the panel to draw. 409 when
  the project uses a business-day calendar and `BusinessDays` is not
  loaded on the server, like `/cpm`.

  The load is computed in Julia rather than in the browser because only
  the engine knows the calendar: a 2-business-day task starting Friday
  loads Friday and Monday, and the weekend in between loads no one. The
  frontend can't know that — it ignores holidays and only patches bar
  widths with the CPM's `early_finish`.
- **iCalendar export**: `icalendar(p)` (and *File → Export calendar
  (.ics)*, `GET /api/projects/{id}/export.ics`) turns the project's
  commitments into an `.ics` document — one all-day event per milestone
  and one per deadline, with the planned finish and how late it is in
  the description. Ordinary tasks are left out deliberately: a two-week
  bar is noise in a calendar. No new dependency — the format is text,
  and what it actually demands is handled: CRLF everywhere, folding at
  75 *octets* without splitting a UTF-8 character (task names go up to
  2000 of them), TEXT escaping, and the exclusive `DTEND` that all-day
  events need or they vanish in several clients. UIDs are stable per
  (task, kind, project) and `SEQUENCE` grows with the project's
  `updated_at`, so re-importing updates events instead of duplicating
  them; events are `TRANSP:TRANSPARENT` and never mark a day busy.
- Docs: `overallocations` was documented nowhere; it and `workload` are
  now in the Gantt reference.

### Changed
- **Critical is now `slack ≤ 0`**, not `slack == 0`, in
  `critical_path`, in `slack(p)`'s `critical` column and in the gantt's
  `C` highlight. Slack only goes negative when a deadline is already
  missed, and those tasks are *more* critical than the zero-slack ones
  — the old test dropped them, hiding exactly the chain that is late.
  Projects without deadlines are unaffected: their slack is never
  negative.

## [0.5.1] - 2026-08-11

### Fixed
- The project finish date no longer depends on the current date.
  `maximum(ef; init = Dates.today())` looks like "use today when there
  are no tasks", but `init` seeds the reduction, so the finish came out
  as `max(today, last task finish)`. Any project that had already ended
  reported a finish of today, slack the size of the elapsed time, and an
  empty critical path — a project from 2020 showed 2400 days of float and
  no critical chain. `critical_path`, `slack`, `project_finish`,
  `GET /api/projects/{id}/cpm` and the critical-path highlight in the
  gantt (`C`) were all affected.
- Tests: the CPM and calendar cases pinned dates in 2026-08 that were in
  the future when written, which is why the bug above went unnoticed
  until the calendar caught up with them; the regression added for it
  uses dates in the past by construction. The splash test also expected
  `~/.perth` where Windows abbreviates to `~\.perth`.

## [0.5.0] - 2026-08-11

### Added
- **Background image**: `Perth.background!("~/foto.jpg")` puts a local
  image behind the UI on both apps and every connected browser, live —
  `opacity` (default 0.18) controls how strongly it shows through, and
  `Perth.background_clear!()` drops it. The path lives in `settings.json`
  in the data directory; the file is served at `/background` with a
  version in the URL so a replaced image is not served from cache. There
  is deliberately no upload endpoint: the servers listen on `0.0.0.0`, so
  an upload would be a write surface on the LAN, whereas pointing at a
  path grants nothing that the REPL does not already have. Images are
  validated by content (PNG/JPEG/GIF/WebP, 12 MB cap), not by extension.
  Each browser can hide it locally from the settings panel, alongside
  *Hide other cursors*.
- **Live sharing switch** (gantt and kanban): sharing to the local
  network now turns on and off with the server running — no
  `Perth.stop()` / `Perth.kanban_stop()` in between. From the REPL,
  `Perth.share!(on)` and `kanban_share!(on)`; in the UI, the
  *Share / QR…* dialog carries the switch next to the links and the QR
  code (kanban: *Board* menu; gantt: *File* menu, where the dialog is
  new — the gantt had no share dialog at all before).
- A broadcast button in both menubars flips it in one click without
  opening the dialog: lit green and pulsing while transmitting, dim
  otherwise. It is hidden for anyone who cannot flip the switch — a
  remote machine, or a server pinned to an explicit `host`.
- Gantt: `GET /api/share` and `POST /api/share` (`{"on": true|false}`),
  mirroring the kanban's. Both are answered before the router, where the
  connection's real peer IP is known, so the host check can't be faked
  with a header.

### Changed
- **Breaking** — both servers now bind `0.0.0.0` regardless of
  `share`, and every connection is checked against the current sharing
  state instead: a bind address can't change once the socket is open,
  so the gate had to move from the socket to the handler for the
  switch to exist. With sharing off, other machines get a 403
  (previously the port was not reachable at all) — the port is
  therefore visible to a network scan while sharing is off. Passing
  `host` explicitly still pins the reach in the socket and disables
  the switch, which is the way to keep the old socket-level behaviour.
- Turning sharing off disconnects remote machines immediately instead of
  waiting for them to leave: the connection gate only stops *new*
  connections, so live WebSockets are closed with a `denied` message
  carrying `reason: "share_off"`, and the UI offers a "try again" button
  instead of retrying forever.
- The share dialog CSS (`.share-url`, `.qr-wrap`) and the modal note
  styles (`.empty-note`, `.alias-hint`) moved from the kanban stylesheet
  to `frontend/shared/ui.css`, now that the gantt uses them too.

### Fixed
- `?Perth.run` showed nothing: a blank line between the docstring and the
  function left it unattached, which also broke the documentation build
  (`@docs` could not find it, and every `Perth.run` cross-reference on the
  page dangled). `GanttTask`, `Project` and `slippage` were referenced by
  the docs without being listed anywhere, and are now in the reference.

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
