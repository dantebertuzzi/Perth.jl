# Changelog

All notable changes to Perth.jl are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This file starts at 0.2.4 — earlier releases were not retroactively documented.

## [Unreleased]

### Fixed
- The test suite now fails on a file with **mixed line endings**. The
  repository is CRLF (`.gitattributes` keeps it as stored), and any tool that
  reads and rewrites a file in text mode converts it silently — the diff
  becomes the whole file, or worse, half of it turns LF and nobody notices. It
  happened four times in one working day, once reaching the published
  repository. `file` is no guard: it reports "CRLF line terminators" with
  dozens of LF lines in the middle. Counting bytes is.

### Added
- **Find a task by name in the gantt** — the box next to *Highlight*, or `/`,
  the same key the kanban uses. Non-matching tasks dim, in the table and in
  the chart, because search reuses the highlight machinery that was already
  there. Accents and case do not matter: typing `integracao` finds
  *Integração por partes*, which is the point in a 141-task project — needing
  the right accent means needing to already know what you are looking for.
- **Enter walks the matches**, one at a time, wrapping at the end; Shift+Enter
  walks back. The counter reads position over total, like a find box in an
  editor (`4/13`), and each step *selects* the task rather than only scrolling
  to it — on a screen of 141 rows, "somewhere in view" still leaves you
  hunting with your eyes. Search and Highlight compose instead of cancelling
  each other, so you can filter to one person and search within that.
- **The mirrored `.perth.jl` file now flows back.** Mirroring already went one
  way: every save rewrote the file at `file_path`. Edit that file in your
  editor and the browser follows on its own — no REPL round trip, and no more
  losing your edit to the next save from the UI. This is the workflow for
  people who read code faster than they drag bars: keep the file open in VS
  Code, keep the chart open in the browser, and let the two agree.
- The reload is deliberately conservative. Our own writes are recognised by
  content, not by timestamp, so mirroring cannot loop; a file caught
  half-written (editors save in stages) fails to parse and is ignored until
  the next event; and the file carries content, never identity — the project's
  id, `created_at` and mirror path stay put, so a pasted file cannot hijack
  another project. The project object is mutated in place rather than
  replaced, so a `p = project("obra")` you are holding in the REPL stays
  valid instead of silently detaching.
- `Perth.run(watch = false)` turns it off.
- **`using Perth` now offers the doors, and you pick one with the arrows.**
  The package exports the data API, but the two doors into the UI —
  `Perth.run()` and `Perth.kanban()` — are not exported (`run` would clash
  with `Base.run`), so nothing on screen pointed at them. Loading the package
  in an interactive terminal now draws them as a list you can move through:
  ↑↓ to move, Enter to open, any other key to dismiss.
- That list **gives up on its own after six seconds** without a keypress,
  repainting itself as a plain three-line pointer, and this is the part that
  makes it safe to run from `__init__`. The same `using Perth` also happens
  inside `julia -i script.jl`, inside `include("script.jl")` and inside any
  package that depends on this one; a prompt that waits forever would hang
  all of those with no way out. Waiting a few seconds and stepping aside
  costs nothing to whoever was not looking. Non-interactive sessions —
  scripts, tests, precompilation — print nothing and wait for nothing, and
  `PERTH_SPLASH=0` silences it along with the rest of the decoration.
- **`Perth.menu()`** brings the picker back after it has been dismissed, and
  is what the static pointer's third line advertises. Outside an interactive
  terminal it prints the pointer and returns instead of blocking.
- The picker only takes the keyboard when the keyboard is idle. If anything is
  already feeding the session — VS Code's *Execute File in REPL*, `julia -i`
  behind a pipe, a batch `include` — those bytes are the caller's **code**,
  not keystrokes, and reading the first one corrupts it: before this guard,
  `using Perth` followed by `println(…)` arriving together had the picker
  swallow the `p`, and the REPL received `rintln(…)`. Pending input, and the
  known embedded front ends (VS Code, Pluto), get the plain pointer instead.

## [0.8.3] - 2026-08-15

### Security
- **What reaches the host machine is now host-only.** With sharing on, any
  guest on the network could set a project's mirror path, browse the host's
  directory tree and start the kanban process. The mirror is the worst of the
  three: `_resolve_save_path` accepts any path ending in `.jl` verbatim, so a
  guest could point it at `~/.julia/config/startup.jl` and have the host
  overwrite that file on its next save — the `.jl` requirement, which looks
  like a guard, is exactly what puts the most sensitive target in reach.
  These three are not project edits, they are access to the machine, and they
  now answer 403 to anyone but the machine running Perth, like the sharing
  toggle and the access key already did. Editing projects is untouched: that
  is a different question, and a read-only switch is the right shape for it.
  The path box disappears for guests rather than sitting there to fail — it
  also displayed a host path, which is the same thing `/api/fs` stopped
  handing out.
- **A project file could overwrite an unrelated file on disk.** `file_path` is
  the mirror path of *this* machine, and the writer never puts it in a
  `.perth.jl` — the format's own comment says so. The reader did not enforce
  it: a hand-written or hostile file that declared the field had it accepted,
  and the first save wrote the project over whatever it pointed at —
  `~/.ssh/authorized_keys`, a source file, a document — silently. Reachable
  through `Perth.load`, which is exactly the documented way to open a file
  somebody sent you. The parser now refuses such a file outright, which covers
  every reader at once. Confirmed as an actual attack, not by inspection: the
  regression test writes a hostile file, loads it and asserts the target is
  untouched.
- **A few kilobytes of `[[[[[` killed the server process.** Julia's own parser
  is recursive and dies on deeply nested brackets — not a catchable exception,
  a core dump — so `Meta.parseall` never returned. Project source arrives over
  HTTP (`/api/import`, and the source panel), so any client that could reach
  the API could take the server down. Source is now checked before parsing:
  4 MB and 32 levels of nesting, against the four levels a real file uses.
  Brackets inside strings and comments do not count, so a task named
  `Coleta [campo] (fase 1)` is still just a name.

### Added
- The UI background accepts **AVIF**, still or animated (`avif` and `avis`
  brands). It is the same risk class as the WebP already accepted — a raster
  codec the browser decodes — unlike SVG, which stays out for the reason
  documented next to the sniffer. The check is still by content: an `ftyp`
  box with any other brand, MP4 included, is refused. Verified with a real
  240-frame sequence: it is served as `image/avif` and animates as the
  background.

### Notes
- Animated backgrounds, as measured in Chrome: GIF, animated WebP and animated
  AVIF all play. APNG is accepted — it carries the PNG signature, so the
  sniffer reads it as `image/png` — and it animates when the file is opened on
  its own, but it stayed on the first frame as a CSS background in every
  sample we took, including with a file whose first frame lasts one second and
  whose second lasts thirty. A GIF with that same timing, in the same place,
  advanced normally, so this is not a measurement artefact. Nothing in Perth
  touches the frames — a single background is applied as a plain `url(...)`,
  with no canvas or preload in that path — so if animation matters, prefer
  GIF, WebP or AVIF.

## [0.8.2] - 2026-08-15

### Fixed
- Clicking a bar to select it no longer touches the undo history. `attachDrag`
  called `pushUndo()` from `pointerdown`, so merely touching a bar pushed an
  entry with a "before" and no "after" — `markDirty()`, which closes the pair,
  only runs on a real edit — and, worse, cleared the redo stack: edit, undo,
  click a bar, and the redo was gone. Undoing one of those half entries also
  fell back to a raw restore, which overwrites whatever arrived from outside
  meanwhile. `pushUndo()` now runs on the first movement of the gesture, which
  is when an edit actually begins and while the snapshot is still the original
  state.
- **Double-clicking a bar in the chart opens the task again.** It had two
  independent causes stacked on top of each other, both in `attachDrag`.
  First, `pointerdown` called `preventDefault()`, which suppresses the
  compatibility mouse events — with no `mousedown` the browser never forms a
  `click`, so it never forms a `dblclick` either, and the `dblclick` listener
  sitting right there was dead code. Second, a click that did not drag
  selected the task from `pointerup`, which runs *before* `mouseup`: the
  re-render destroyed the node mid-gesture, so the `mousedown`/`mouseup` pair
  no longer shared an element. Selecting now happens in a real `click`
  listener, and text selection during a drag is held off by `user-select:
  none` on the chart instead of by cancelling the event. The task table never
  had either problem, which is why double-clicking a row always worked.

- Seventeen more strings in the kanban were stuck in English, this time in
  `title` and `placeholder`: `double-click to rename`, `WIP limit exceeded`,
  `move to the archive`, `delete forever (cannot be undone)`, the card
  composer's `type and press Enter — #tags, **bold**, [links](url)…` and the
  rest. A tooltip that explains how something works is screen text, not
  decoration, so the scan now covers `title`, `placeholder` and `aria-label`
  alongside `textContent` and `innerHTML`.
- The scan also stopped letting a literal off because a translation for it
  happens to exist: `chip.title = "due " + …` passed while shipping English,
  since `due` was a dictionary key. The question it asks now is whether the
  string goes through `T()`, which is the thing that actually matters — and
  that caught two more.
- Twenty-three labels built in JavaScript were stuck in English in every
  language: the gantt's `copy` / `copied!` / `loading…` / `no subfolders` /
  `no project open` and the empty dependency list, and the kanban's `+ card`,
  `+ new column`, `by`, `archive`, `due`, `assignee`, `restore`, `delete`,
  `current`, `switch`, `create` and its board-list error. They are written
  after `PerthI18n` has swept the DOM — the sweep runs once, on `set()` — so
  a bare literal there never gets translated. All of them now go through
  `T()`, with the seventeen distinct strings added to all four dictionaries.

### Changed
- **Every failed action reports in a toast, not an `alert()`.** Ten alerts —
  nine in the gantt, one in the kanban — froze the whole page until someone
  clicked, carried no theme, and put untranslated browser buttons on screen.
  What `alert()` did get right was making a failure impossible to miss, so an
  error toast lasts twice as long as an informational one and carries a close
  button instead of blinking away. It announces itself through `aria-live`
  without stealing focus, which is the opposite of what the alert did.
- The toast is **one** component now, not two. The kanban already had its own
  — `showToast`, the `#toasts` stack, the presence notification tinted with
  each machine's colour — while the gantt had nothing. Rather than ship two
  notification systems in one product, the kanban's moved to `shared/toast.js`
  and both apps use it; `showToast` still exists there as a thin adapter. Its
  stack also moved from the bottom right to the bottom left, because the chat
  panel opens bottom right in both apps and the two overlapped. The kanban's
  three errors, which used the informational styling and timing, now read as
  errors.
- **Keyboard shortcuts and About are dialogs now, not `alert()`.** Both were
  plain-text browser alerts: no formatting, no translation, and they freeze the
  page while open. They use the same overlay as Activity and the S-curve, with
  the keys as `<kbd>` chips in a column and the descriptions translated. The
  About box shows its Julia snippet as code.
- The read-only overlay's button says *Close*, not *Cancel* — its English
  fallback always said `Close`, so the `Cancel` key was picked up by mistake.
  Activity and the S-curve get the correction too.
- `Import failed`, `Auto-schedule failed` and the kanban's
  `could not open the gantt` were raw English inside otherwise translated
  alerts.
- The kanban's card filter box is drawn like the gantt's save-to path box: at
  rest it is just text in the menubar, and the frame appears on hover and
  focus. The two menubars are the same component, and one field carrying a
  permanent box while the other carried none looked unintentional. Same font,
  size, height, colour, radius and padding — the computed styles now match
  exactly. It still widens on focus, which is the kanban's own behaviour.
- The kanban declared the same one-line `T` helper eight times, once per
  function. It is now a single module-level constant, like the gantt's.

### Added
- **The kanban has a Help menu with its keyboard shortcuts**, alongside Board
  and View where the gantt keeps its own. It had eight
  global keys — undo/redo, `/`, N, D, P, Del, Enter, Esc — and nowhere to
  discover them; the only advertised one was `/`, buried in the filter's
  placeholder. The gantt had the entry, the kanban did not, and both menubars
  are otherwise the same component.
- `shared/shortcuts.js`, which draws the shortcut list for both apps. What is
  shared is the drawing only: each app passes its own keys and opens it in its
  own container, which differ for good reasons. The list inherits each app's
  typeface — the kanban is a mono UI and the gantt is not — because a dialog
  should look like the app it belongs to.
- A test that closes this class of bug rather than another instance of it:
  it scans `app.js`, `kanban/app.js` and `presence.js` for string literals
  assigned to `textContent` / `innerHTML` and fails unless each goes through
  `T()` or has a translation. The bug had already shipped four times. The
  scan carries a self-test, so a regex that stops matching fails loudly
  instead of passing silently, and a short exempt list for strings that are
  identical across languages.
- The kanban's labels are also rendered for real in a test — the eight-into-one
  `T` refactor would otherwise fail as a blank screen, not a syntax error.

## [0.8.1] - 2026-08-15

### Fixed
- PERT: the estimate band no longer moves while you type. The result
  (`expected … · σ …`) shared its flex line with the three inputs, so it
  grew a few pixels with every digit and took that width out of the
  fields — and when the line finally ran out of room, the result and the
  *use as duration* button jumped to a line of their own. The result now
  always sits on its own line, pinned to its right edge so it no longer
  slides sideways as the text to its left grows, and the line keeps the
  button's height so the box does not twitch when the button is not
  offered.
- Typing a lag on an unticked dependency row no longer throws the number
  away. Only ticked rows are written on save, so the lag vanished without a
  word; typing one now ticks the row, which is visible and undoable. A lag
  of zero is every row's default, not an intention, so it still ticks
  nothing.
- Marking a task as a **milestone** locks its duration field. A milestone
  occupies its own day — `_effdur` (`schedule.jl`) counts 1 and the table
  already prints `—` in the duration column — so the field invited a number
  that meant nothing. The stored value survives (a disabled field is still
  read on save), so unticking the box brings the old duration back.
- **Esc** and a click on the backdrop now ask before throwing away an edited
  task. They discard everything typed into fifteen fields, which the gesture
  does not advertise, and the modal keeps a snapshot taken when it opened so
  the question only comes up when something actually changed. The *Cancel*
  button does not ask: it says what it does, and it stays the escape hatch
  for a deliberate discard.
- The task modal refuses to save while a number field holds something the
  browser cannot read (`666+6`, `1e`, `--3`). Such a field reports an empty
  `value`, so duration fell back to 1, cost and progress to 0 and the PERT
  estimate to blank — the typed text stayed on screen while a different
  number was stored. Save now focuses the offending field instead, and
  every number field in the modal draws a red border while its content is
  unreadable or out of range.
- The task modal's heading and the parent select's `(top level)` option were
  written in English on every open, after `PerthI18n` had already swept the
  DOM, so they stayed English inside an otherwise translated modal. Neither
  string was in any of the four dictionaries.
- A field the modal locks — every date and number on a summary task, the
  duration on a milestone — now looks locked. The base rule paints colour
  and background over the browser's `:disabled` styling, so the field kept
  an editable face and swallowed the click without explaining itself.
- The save-to path box no longer reserves 480px of the menubar. Its resting
  width is 340px — about 45 characters of the mono field, with longer paths
  ellipsised as before — which closes the gap that sat in the middle of the
  bar even with the field empty. A dead `flex-basis` on `#save-path`, shadowed
  by `.fb-wrap #save-path` since both were introduced, went with it.
- PERT: clicking *use as duration* twice no longer keeps pushing the
  number up. A blank field falls back to the current duration (the same
  rule as `_normalize_estimate!`), so writing te into the duration
  changed the very input te came from, and each click walked the value
  towards `(o + p) / 2` instead of settling. Applying now first writes
  the resolved three numbers into their fields — exactly what the server
  stores on the next save — so te stops depending on the duration, the
  second click is a no-op and the button retracts.

## [0.8.0] - 2026-08-14

### Added
- `.gitattributes` freezing line endings as stored (`* -text`). The
  repository is mostly CRLF, and a clone on a machine with
  `core.autocrlf=true` — Git's default on Windows, which the README
  already documents using — would rewrite every file at checkout. It
  does not stop an editor from writing the wrong ending inside a file;
  that still shows up as a diff, which is where it belongs.

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

- **PERT: three-point estimates and a probabilistic finish** (`pert.jl`).
  Each task can carry `optimistic` / `most_likely` / `pessimistic`
  (`set_estimate!`, or the *Estimate (PERT)* row in the task modal),
  from which come the expected duration `(o + 4m + p)/6` and σ
  `(p − o)/6`. `pert!` (Edit → *Apply PERT estimates*) turns estimates
  into durations; `pert(p)` is the table with σ and variance per task;
  `pert_finish`, `finish_probability(p, date)` and `pert_date(p, 0.8)`
  answer *when does this actually land*. The UI carries the P80 in the
  status bar once anything is estimated, with the expected date and σ in
  the tooltip.

  The design decision is that **PERT feeds `duration` and does not fork
  the engine**: after `pert!`, CPM, critical path, slack, deadlines,
  business-day calendars and the whole UI keep working unchanged. The
  analysis functions write nothing — `_cpm` now accepts a substitute
  duration vector, so they run the real engine on hypothetical numbers.

  No new dependency: the normal CDF is a rational approximation
  (Abramowitz & Stegun 26.2.17) and its inverse is bisection over it —
  cheaper than pulling in SpecialFunctions or Distributions for one
  function.
- `pert_simulate`: Monte Carlo over the whole schedule — draw every
  estimated duration from its Beta-PERT (the distribution `te` is
  exactly the mean of, so it and the formula answer about the *same*
  distribution), re-run the CPM forward pass, ten thousand times.
  This is the answer to believe when it disagrees with `pert_finish`:
  the textbook formula propagates variance along the critical path only,
  so it is systematically optimistic on projects where several fronts
  merge (the classic *merge bias*), and the simulation measures exactly
  that gap. Beta sampling is two Marsaglia–Tsang gamma variates, also
  dependency-free.
- The PERT fields ride along everywhere a task already goes: JSON
  storage, the `.perth.jl` interchange format (written only when the
  three are set), `tasktable` (plus an `expected` column) and
  `add_tasks!`.
- REST: `GET /api/projects/{id}/cpm` gained a `pert` object (`null`
  until something is estimated) so the status bar costs no extra
  round-trip, and `POST /api/projects/{id}/pert` applies the estimates,
  mirroring `/schedule`.

- **The UI background can be a slideshow.** `Perth.background!` now takes
  a folder or a list of files as well as a single image: with more than
  one, the UI cycles through them — the current one fades out, the next
  fades in over the paper colour. `interval` (seconds, default 60) sets
  the pace; `interval = 0` stops on the first image. `Perth.backgrounds()`
  reads the rotation back.

  Which image is showing is derived **from the wall clock** in each
  browser (`floor(now / interval) % n`), not from a local counter and not
  from a server tick: every machine is on the same photo without
  coordination, a tab opened late lands in phase, and a laptop that was
  asleep corrects itself on the first wake-up.

  **A folder is expanded to a list at the moment you point at it, not
  watched live.** Three reasons, in the order that decided it: (1) the
  clock-derived index needs every client to agree on the list and its
  order, and a live scan would let two machines see different lists and
  compute different indices; (2) it preserves this file's stated model,
  where the authorization is the *act of pointing* — a live folder would
  turn that into per-folder authorization, and anything dropped in later
  would be served to the network without anyone pointing at it, in a
  folder that is usually where screenshots land; (3) a frozen list needs
  no cache, no mtime invalidation and no agreed ordering. Files in the
  folder that are not usable images are skipped, and the log line says
  how many were taken and how many were left out.

  One image still writes the old settings key, so the format a previous
  Perth reads is untouched, and a payload without the new `images` field
  still works in an already-open tab.

### Changed
- The background layer moved to `frontend/shared/background.js`, shared
  by both apps — it was duplicated in `app.js` and `kanban/app.js`. Each
  app now passes in only what is its own: the local *hide* preference
  and how the access key goes into the URL.
- `/background` takes an `?i=N` index for the image to serve. Without it
  it serves the first, so old clients and the service worker keep
  working.

- PERT: a tie now rounds **up**, not to the even number. `te = 4.5`
  schedules 5 days; before, Julia's default `RoundNearest` gave 4 for
  `4.5` and 6 for `5.5` — neighbours that disagree in the same table, and
  the `4.5` case shrinking the schedule exactly at the tie, which is the
  wrong direction to err for a duration. The browser's `Math.round`
  already rounded ties up in the modal preview, so the server was the odd
  one out: *use as duration* offered 5 while `pert!` wrote 4, forever.
  Surfaced by rebuilding the canonical PERT example, where activity `f`
  has `te = 4.5` exactly.

### Fixed
- The two settings panels are now the same component. Every row in the
  Gantt's panel got an icon (the kanban already had them), the icon token
  moved to `shared/ui.css` as `.sp-icon` — it was `.snd-icon`, "sound
  icon", named after the single kanban row that had one — and the two
  options both apps share (*hide other cursors*, *hide background*) use
  byte-identical drawings. Row metrics were unified at a 12px gap, which
  the kanban was 4px off from. The kanban's panel button was a person
  glyph titled "your name on the board", describing what is now one row
  out of five; it is the Gantt's sliders icon and title.
- Kanban: the connection label showed `live` where the Gantt showed
  `ao vivo`. `presence.js`, which the Gantt uses, already ran the label
  through `PerthI18n`; the kanban's own `setConn` wrote the raw string.
  The translations existed in all four languages the whole time.

- Kanban: the settings panel now uses the Gantt's toggle
  (`<button class="toggle" aria-pressed>`) instead of checkboxes. A
  checkbox sat immediately after its label, so each one stopped at a
  different column depending on the label's length — worse on the two
  labels that wrap to a second line. The label now absorbs the slack and
  every switch lands on the same right edge.

  Moving `.toggle` into `shared/ui.css` exposed a specificity trap worth
  recording: `.menu-drop button` (0,1,1) beats `.toggle` (0,1,0), so the
  switch inherited `width: 100%` and menu-item padding and rendered as a
  224px bar. The menu-item rule is now `.menu-drop button:not(.toggle)` —
  a switch inside a dropdown is not a menu item.

- Kanban: a column scrolled down no longer jumps back to the top when you
  act on a card. `render()` rebuilds the whole board
  (`boardEl.textContent = ""`), and a fresh element starts at
  `scrollTop = 0` — so completing a card near the bottom of a long column
  scrolled away the very card you had just touched. Scroll positions are
  now captured per column id (columns can be reordered or deleted between
  renders) plus the board's own horizontal offset, and restored *before*
  the FLIP measurement: the `before` rects were taken with the old
  scroll, so measuring `now` at the top would animate every card back
  from a distance nobody travelled.

- **Timestamps written by the browser were UTC**, in fields the server
  fills with local time (`_kanban_now`, `Dates.now()`). The same field
  meant two different things depending on whether the card was born in a
  browser or in the REPL, and in a negative UTC offset the browser's
  stamp landed on the *next day* from late afternoon on. Three places:
  a card's `at`, its `done_at`, and the Gantt's `baseline_at`.

  Consequences it was causing: a card created at 21:00 in UTC−3 was
  stamped tomorrow, so the `new` badge never appeared and the creator
  tooltip was three hours off; `done_at` being ahead made auto-archive
  by age fire early. The kanban already had `localISO()` compensating
  for the offset when comparing due dates — the trap was known in one
  place and missed in the other three. Now `localStamp()` produces
  exactly what the server produces.

- Kanban: the Gantt→kanban bridge now mirrors into **every** board, not
  just the one currently loaded. A card linked to a Gantt task only
  followed the project while its board was the active one: editing the
  task with another board open left the card stale **permanently**, since
  coming back to the board merely re-reads a file that was already out of
  date. With the kanban holding one board at a time, having two boards
  was enough for the bridge to stop meaning anything on the second — and
  the drift was silent, which is the worst part: the board looks fine and
  disagrees with the plan.

  Fixing it needed no multi-board state. Boards that are not loaded have
  no connected clients by definition, so there is nothing to broadcast
  and no activity log to write: the sync reads the file, applies the same
  field rules, and rewrites it atomically. The mirroring rule itself was
  extracted into one function (`_card_task_diff`) used by both paths — as
  two copies it would have diverged on the first change.

  The scan is gated on the raw file text containing the project id, so
  boards with no linked card are never parsed. Measured at 0.43 ms of a
  0.9 ms save with 7 boards and 47 KB of board files; a data directory
  with no kanban at all pays one `readdir`.

  It also applies with the kanban never opened in this session: the cards
  are on disk whether or not anyone looked at them.
- Kanban: an accented board name no longer produces a mangled file name.
  `_slugify` dropped anything outside `[a-z0-9_-]`, so `"cálculo"` became
  the slug `clculo` and `"estatística"` became `estatstica` — typing the
  same name once with and once without the accent silently produced **two
  different boards**. Found as a real pair (`kanban-calculo.json` and
  `kanban-clculo.json`) in a live data directory. Accents are now
  transliterated (`Unicode.normalize(…; stripmark = true)`, stdlib), so
  `"cálculo"` and `"calculo"` are the same board, and names that were
  entirely accented — previously rejected as invalid — work.

  Boards created before the fix are not stranded: a name resolves to the
  new slug unless that file does not exist *and* the old mangled one
  does, in which case the old file keeps answering to the name that
  created it. When both files exist the correctly-spelled one wins.
- An accented project name no longer produces a mangled `.perth.jl` file
  name. `"Análise estatística"` became `an-lise-estat-stica.perth.jl` —
  the same swallowed-accent bug as the kanban board slug, in the path
  the save box builds when you point it at a folder, and a file name you
  see and live with. A name that reduces to nothing still falls back to
  the project id.
- Both apps now redraw just after midnight. Everything derived from
  *today* — the Gantt's today line and `past deadline` highlight, the
  kanban's due-date pills going `soon`/`overdue` and its new `new` mark —
  is built inside `render*()`, which runs when something changes, not
  when the clock moves. A Gantt left open on an office wall overnight
  kept drawing yesterday's today line, and a board left open kept showing
  yesterday's "today", until somebody touched them.
- Tests: the `gantt · prazo e data fixa` block closed its jsdom window
  without letting the async `init()` settle. The orphaned `init()` would
  wake against a destroyed `document` and take the whole process down —
  reported with a stack pointing at whichever block happened to yield
  next, which is a bad afternoon for whoever hits it.

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
