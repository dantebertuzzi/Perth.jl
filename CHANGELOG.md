# Changelog

All notable changes to Perth.jl are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This file starts at 0.2.4 — earlier releases were not retroactively documented.

## [0.9.2] - 2026-08-17

### Added
- **The version, on the right end of the status bar.** Which Perth is running
  was the REPL banner's answer, and whoever opened the link never saw it — yet
  that is exactly the question that comes up when something is not where it was
  expected to be ("does this one have marked months yet?"). A tag icon with the
  number at the end of the footer, in both tools, dimmed like the rest of the
  bar and lighting up on hover: true all the time, urgent never.
- The answer comes from the **server**, through `/api/apps` — the route that
  already describes what is up in this process — and not from the static file:
  the `app.js` the browser holds may come from a service worker's cache of an
  earlier version, and a label that lies about the version is worse than no
  label. Asked once, at boot; if the answer does not arrive, the tag simply
  does not appear.

## [0.9.1] - 2026-08-16

### Fixed
- **The read-only menus no longer end in a gap.** Opening a plan through a
  read-only link hides every item that writes, but the separators between them
  stayed: the Edit menu came down to a single "View selected task" with three
  orphan rules stacked underneath it, and File left one dangling where "Delete
  project…" used to be. A rule only earns its place *between* two visible
  items, so the menus recompute which ones survive whenever the mode changes —
  and get them all back the moment editing is allowed again.

## [0.9.0] - 2026-08-16

### Added
- **Marked months.** A whole month painted in the ruler at the top of the
  chart (File → Marked months…, or `add_month_mark!`). Where a marked *day*
  draws a line across the plan, a marked *month* colours the strip that already
  writes its name — said once, at the top, instead of repeated on every task
  inside it. The name joins the month in the cell when it fits and in the
  tooltip either way, and it is optional: the cell already says which month it
  is, so the colour alone is allowed to be the whole message. It never touches
  the body of the chart — shading the work behind a stretch is what a `Band` is
  for, and painting both would say the same thing twice with two different
  meanings.
- **Markdown in a task's notes, and a note you can actually read.** The red dot
  said "this task has a note" and the text arrived in a native browser tooltip:
  no formatting, no decent line breaks, gone if the pointer wavers. The dot now
  *opens* the note, in an HTML popover that renders `**bold**`, `*italic*`,
  `` `code` ``, `~~strike~~` and links — the same one-line subset the kanban
  card speaks, which moved to `shared/inline.js` so two screens with the same
  meaning stop having two parsers.
- The formatting stops at the notes, on purpose. A task's **name** sorts its
  siblings, is what the search matches, and is what goes into CSV, iCalendar,
  `.perth.jl`, the PNG and the REPL — markdown there would either leak as
  punctuation into all of them or need a stripping step remembered in eight
  places, and the day one is forgotten an asterisk lands in a client's
  spreadsheet. The note is the one text field in Perth that is prose and
  travels nowhere as an identifier.
- **What you folded survives the reload.** Collapsing the phases *is* how you
  work a plan of a hundred-odd tasks, and it was thrown away on every reload,
  every trip to the kanban and back, every project switch. It now lives in the
  browser next to the zoom, the theme and the lanes — one key per project,
  because "Ana" folded here does not mean "Ana" folded in the next plan, and
  ids that no longer exist are dropped on the way back in.
- **Walking the plan from the keyboard.** The selection existed but only the
  mouse moved it — and moving the selection is the thing you do most. `↑`/`↓`
  walk the *visible* rows (a folded phase counts as one row, not as the twenty
  it hides), `←` closes a summary and, on a leaf, goes up to its parent, `→`
  opens it, `Home`/`End` jump to the ends and `PageUp`/`PageDown` move a
  screenful. The scrolling is `revealTask`'s, so it opens what is closed on the
  way and only touches the horizontal axis when the bar has left the view.
- **Ctrl+wheel zooms**, keeping the date under the pointer where it is.

### Changed
- **Changing the zoom no longer teleports you to today.** It ended in
  `scrollToToday()` every time: you would scroll out to November, zoom in to
  read the detail, and land back on today. Now the date you were looking at —
  the middle of the screen, or the pointer when the zoom comes from the wheel —
  stays where it is, the way any map behaves. Going back to today is still one
  key away: that is what `T` and the Hoje button are for.
- **The interface is monospaced end to end.** The menubar, the table headers and
  the numbers were already; task names and bar labels were not, which made a
  name look like it came from a different application than the header right
  above it. Perth looks like the REPL it comes from.

### Fixed
- **A programmatic scroll no longer leaves the ruler behind.** Mirroring the
  day ruler waited for the scroll *event*, which arrives later; in between,
  header and chart disagreed, and a click on the ruler in that window marked a
  day other than the one under the finger. All horizontal scrolling now goes
  through one function that scrolls instantly (the timeline animates by
  default, and an animation is eaten by the next redraw) and mirrors the ruler
  on the spot.

## [0.8.9] - 2026-08-16

### Added
- **A test that measures what the screen is doing.** The three overlap fixes of
  this release were all found by eye, one at a time. The audit that found the
  rest now runs in CI: in a real browser (jsdom has no layout engine, and
  without real text widths there is no collision to find) it seeds a project
  built to collide and crosses the box of every text, shape and line against
  every other, at four zooms, both densities, with lanes and with the critical
  path on. The geometry underneath — cutting a line around a box, finding a
  free height for a sideways name — is unit-tested without a browser, so the
  logic stays covered even where Chrome is not installed.
- The four languages are level again: **every string the interface can show is
  translated in all of them**. The glossary shipped in 0.8.8 in Portuguese
  only, which the i18n suite had been calling out — 54 keys × 3 languages.

### Fixed
- **Nothing on the chart is written on top of anything else any more.** An
  audit that measures the box of every text, shape and line and crosses all of
  them against each other found 11 to 17 collisions per view (worst at month
  zoom, present in every density): the sideways names of calendar bands and
  marked days written across task names, and the full-height lines — today,
  marked day, band edge — drawn straight through them. Only the dependency
  arrows knew how to get out of the way.
- The machine the arrows use is now shared. **Lines open a gap** wherever they
  cross a label, and **sideways names look for a free stretch** instead of
  always starting at the top, which is where almost every plan has its first
  bars. `label_at`, set by hand on the slider, still wins over the automatic
  choice. Measured after: **zero collisions** at day, week, month and fit zoom,
  in both densities, with lanes on and with the critical path on.
- **The Share dialog no longer breaks on a payload without `view_urls`.** The
  read-only link added the field in 0.8.8 and the dialog iterated it without a
  guard, so a server from an earlier version — or any response that omits it —
  threw and took the whole dialog down.
- Two bugs found by measuring rather than by looking: the box of a sideways
  name was six pixels off (the glyphs sit from `x-3` to `x+11`, not centred on
  the anchor), which is why a marked day's line still clipped its own name; and
  a label's box was estimated from its baseline rather than measured, missing
  the four pixels the tallest letters reach — exactly the sliver a vertical line
  was still eating.

## [0.8.8] - 2026-08-16

### Added
- **A read-only share link.** Sharing was all-or-nothing: whoever opened the
  link could edit, and that is what stopped a plan from being sent to a client,
  a director, the whole site. `view_key` (`Perth.run(view_key = "…")`,
  `Perth.view_key!`, or the Share / QR dialog) is a *second* key that grants
  reading and refuses writing. It is independent of the access key: with one
  set, one link edits and the other only shows; with none, the plain link still
  edits and only the read-only link is restricted. The two cannot be the same
  string — one link cannot mean both things.
- The refusal is the **server's**, not the interface's: every write comes back
  403, decided by the method rather than by a list of routes, so a route added
  tomorrow is refused by default. That includes the door the interface does not
  use — the **presence socket**: the chat persists to disk and reaches everyone,
  so it is writing, and refusing the `PUT` while leaving the socket open would
  be changing the lock and leaving the window open.
- The UI stops offering what the link cannot do — the editing menus, the drag
  gestures and the chat composer are gone rather than left there to fail — and
  says what the tab is where the save status would be. Viewers appear in the
  connected machines as a **hollow ring**: present, not writing.
- Changing either key now disconnects **only the machines it invalidated**:
  changing the access key leaves the read-only viewers alone, and changing the
  read-only key leaves the editors alone. Dropping the read-only key does
  disconnect its viewers — without it the link becomes an ordinary one, and
  nobody decided that they should start editing.
- **Order the plan by hand: drag a row up or down.** Row order was derived —
  children under their parent, siblings by `(start, name)` — and stayed a good
  order right up to the day three tasks start together and the sequence on site
  is not alphabetical. Tasks now carry `order`, and dropping a row in the gap
  between two rows gives it a position; dropping it *on top of* a task makes it
  a subtask of that task. One gesture, two destinations, decided by where you
  let go — the convention of every file tree, and one gesture fewer than making
  the WBS a separate operation.
- `order` is `0` until someone drags: **a plan nobody reordered still comes out
  by date**, exactly as before. A drop renumbers the whole sibling group
  `1, 2, 3, …`, so a group is never half by hand and half by date, and the
  statement is about one group only — the siblings elsewhere do not move. In the
  REPL: `move_task!(p, id; parent, position)`.
- A **`#` column** at the left of the table, in Perth's purple: the row order
  written down, so it can be read and checked after a drag instead of counted
  with a finger. Its tooltip carries the task **id** — the thing you type in the
  REPL, which until now had to be fished out of an export.
- **A new warning: "starts before its dependencies allow."** A dependency
  never moves anything on its own in Perth — that is `schedule!`'s job — so a
  plan can hold a task that starts before its predecessors let it, and until
  now the only sign of it was an arrow drawn backwards on the chart. The
  warnings list says it out loud, with the earliest date the task could start
  and how many days early it is; when the start is **pinned** the row says so,
  because that is precisely the case auto-schedule will not fix.
- **Telling whose baseline a ghost bar is.** The ghost lives on its task's own
  row, but a task that moved a long way leaves it far from its bar, and "same
  row" becomes guesswork on a busy chart. Hovering it now names the task and
  gives the promised dates (and the slippage, when there is any); selecting the
  task lights its ghost up and joins the two with a dotted line — which is the
  slippage drawn at actual size. Neither adds anything to the chart at rest.
- **A slider for where a marked day's name sits.** The name lies along the
  line it names, so it always lands on *something* — and which bar it lands on
  depends on the plan. `label_at` (0–100 percent of the chart height, a slider
  per row in *File → Marked days…*, or the keyword on `add_marker!`) slides it
  down to open sky. A percentage rather than pixels: the chart grows with the
  plan, and "a third of the way down" should stay a third of the way down.
  Dragging redraws live and saves once, when you let go.
- **Help → What the words mean**: a glossary of the vocabulary the interface
  speaks — task, summary, WBS, dependency, slack, critical path, baseline,
  S-curve, PERT, P80, overallocation, band, marked day. `⚠ 4 overallocations ·
  ⚠ 1 past deadline` is only a warning to someone who already knows the words,
  and the only place they were explained was the package documentation, which
  whoever opens the browser does not read.

### Fixed
- **The link dot no longer eats the first letter of the task's name.** The dot
  you drag a dependency from is born at the end of the bar, which is exactly
  where the label starts. The label now cedes it room — and only while the dot
  is there, since only the selected bar has one: moving every label away from
  every bar, because of a dot that exists on one row, would be paying for it
  across the whole chart. (Raising the dot was the other way out, and it works
  in cozy; in compact the row is shorter, the name sits higher, and the dot
  would touch it again — besides, a dot level with the middle of the bar is
  what says "drag from its *finish*".)
- **An error Perth raised for a human to read no longer arrives as "internal
  error."** A project on a business-day calendar opened without
  `using BusinessDays` failed every calendar-aware route with a generic 500,
  hiding the one sentence that solved it. Messages the package raises itself
  now reach the screen (409, with the text); anything else stays a 500 with no
  detail, because that is a bug of ours and not the browser's business.
- **A dependency arrow no longer strikes through a task's name.** The arrow
  leaves the end of the bar, which is exactly where the label starts, so every
  link to the right cut the word in half. The line now opens a gap wherever it
  crosses a label — every label, on any row it passes, not just the one it
  leaves from. The click target stays whole: what disappears is the stroke, not
  the sensitive area, so double-clicking an arrow to remove it still works
  anywhere along it.
- **The dotted line of a marked day no longer runs through its own name.** The
  label lies along the line it names, and the dots crossed the letters. Pushing
  the text aside would detach it from the line, so the *line* opens a gap the
  size of the name instead — measured after it is in the document, which is the
  only moment the browser knows how long it is.

## [0.8.7] - 2026-08-15

### Added
- **Link two tasks by dragging.** A dependency was the only relation *drawn*
  on the chart that could still only be declared in a form. Select a bar and
  it grows a dot at each end: drag from the right one to the task that
  follows, or from the left one to the task that comes before — both create
  the same finish-to-start link, what changes is which end of the chain you
  are building from. Lag, start-to-start and finish-to-finish stay in the
  modal: they are the exception, and an exception does not need a gesture.
- The dots appear **only on the selected bar**. A dot that appears on hover
  would fight the bar drag and the resize grip, which live in the same pixels;
  selecting is already the gesture that says *this one*.
- Four refusals, each saying why on screen instead of quietly doing nothing:
  the pair is already linked; the drop would close a **loop** (refused before
  saving — the engine reports a cycle only after the plan is stored, and then
  it stops scheduling); the target is a **summary** (its subtasks are what get
  scheduled, so the link would promise what it cannot keep); or the two are in
  the same block, where a summary already waits for its children by
  definition. A summary may still be the *predecessor*: its finish is the
  finish of the block.
- **Double-click an arrow to remove it**, with a fat invisible hit area over
  the 1px stroke. Creating a link with the mouse and having to open a modal to
  undo it would be giving the outward trip without the return.
- **Zoom: fit** (`4`, or the Fit button): the step is computed so the whole
  project lands on screen, instead of being one of three sizes chosen by hand
  — none of which suits a two-year plan. It is clamped at both ends (never
  larger than day zoom, never so small the chart becomes a smear), the ruler
  switches between days and weeks by the **space available** rather than by
  the name of the zoom, and fitting does not scroll to today: that would undo
  what the button just did. The chosen zoom is remembered per browser.

## [0.8.6] - 2026-08-15

### Added
- **Collapsible WBS summaries.** The `▾` on a summary row was decoration: the
  chart could group tasks into lanes and fold those, but a category — the
  thing the WBS exists to create — could not be closed. Clicking the arrow now
  folds the whole subtree, not just the direct children, and the summary
  bracket stays on the chart, so a folded block still says when it happens.
  The arrow does not select the task: a click on the arrow is about the tree,
  a click on the row is about the task. Searching a task inside a folded
  summary opens it, the same way it opens a folded lane.
- **Drag the divider** between the task table and the timeline. The width was
  already a preference with a slider in settings, but nobody opens a
  preferences panel to read a task name that is cut off. The handle takes its
  bounds *and its step* from that same slider — two places with the same limit
  written by hand is one place that falls behind — and moves it live, so the
  two never disagree. Double-click resets to the default; the arrows move it
  one step when the handle has focus.

### Changed
- The kanban no longer pops a **"Transmission on"** toast when sharing is
  switched on: whoever turned it on just clicked the button, and the button
  already changes colour and label. The gantt never announced it, and the
  difference between the two was only inheritance.
- **Marked days** (`Marker`, `markers`, `markers!`, `add_marker!`,
  `remove_marker!`, File → Marked days…, and a **double-click on the day**
  ruler): a named day drawn as a vertical line across the whole chart, the way
  the *today* line is drawn and for the same reason — some dates matter to
  every task at once. A delivery, an audit, the day the scaffolding comes
  down.
- The gesture is the short one: the day is already under the cursor, so
  double-clicking its column opens the panel with the date filled in and the
  caret in the name — the only field the computer cannot guess. Typing the
  date into a form would be repeating to the computer something it just saw.
- Like a band, a marker is **annotation**: it never moves a task and never
  enters the CPM engine. When a date must actually bind a task, that is the
  task's `deadline`, which does change its slack. A nameless marker is
  dropped — a line that does not say what it marks is a stroke on the screen.
- Each column of the day ruler now carries its own date (`data-date`), so the
  ruler describes itself instead of being read back through pixel arithmetic.

## [0.8.5] - 2026-08-15

### Added
- **Calendar bands** (`Band`, `bands`, `bands!`, `add_band!`, `remove_band!`,
  and File → Calendar bands…): a named stretch of calendar shaded behind the
  chart, with the name written along its left edge — a sprint, a shutdown, the
  rainy season, the fortnight the crane is on site. The colour is yours to
  pick (the swatch starts on the next colour of the palette, so two bands in a
  row are never the same by accident), and bands may overlap: a crunch week
  inside a sprint is a real thing to say.
- A band is **annotation**, not scheduling: it never moves a task, constrains
  a date or enters the CPM engine. It answers "why is this stretch different?",
  which until now had to live in someone's head or in a note nobody opens.
  Inverted ranges are swapped on save, the way a negative duration is clamped,
  and a nameless band is dropped — shading that does not say why is noise.

- **Statistics by person and by team** (`people_stats`, `team_stats`, and
  View → Statistics…). The engine already knew all of it and never added it
  up: how much each person carries, how much of that is done, how many days
  they are double-booked, how many of their tasks are past their deadline.
  The weight is the same one the S-curve uses (`cost` when set, otherwise
  person-days) — two screens telling different stories about the same work
  would be worse than one screen fewer.
- Overloaded days are a *person* fact: two people from the same team working
  the same day is normal, and only an individual can be double-booked, so a
  team row sums its members' overloaded days rather than recomputing them.
  Team `busy_days`, in contrast, counts days on which anything in the team was
  running.
- WBS summaries are never counted — adding them would count their children's
  work twice — and work with no assignee gets its own row instead of being
  dropped: unowned work is a fact about the plan, not a gap to hide.

- **Swimlanes** (`Lanes:` in the toolbar): group the chart by assignee or by
  team. The lane header is a row like any other — same height, same grid — so
  the table and the timeline stay one drawing; a header one pixel taller would
  slide every bar below it. Collapsing a lane hides the tasks, not the person:
  what is left is a single bar from the first day of their work to the last,
  because whoever collapses wants less detail, not to lose the fact that they
  are busy from March to May.
- Lanes come from the collaborator registry, which is why the names had to be
  clean first: with `assignee` fragmenting silently, the same "Ana" would have
  shown up as three separate lanes.
- WBS summaries are left out while lanes are on. A summary is the bracket over
  children who may belong to different people, and hanging it in someone's
  lane would claim they own the whole block — the CPM engine already treats
  them that way, scheduling leaves only. For the same reason the search does
  not count them while grouping: the counter promises every hit is reachable.
- Grouping never repaints: a bar's automatic color comes from its position in
  the *project*, not on screen. Dependency arrows are drawn only between
  visible rows — an arrow into a collapsed lane points at nothing. And finding
  a task inside a collapsed lane **opens** the lane.
- **A collaborator registry** (`people`, `person`, `people!`, `add_person!`,
  `remove_person!`, and File → Collaborators…). `assignee` was — and stays —
  free text, and free text *fragments in silence*: `"Ana"`, `"Ana "` and
  `"ana"` become three different people to the workload, the overallocation
  check and the highlight, with nothing on screen explaining why. Now every
  save trims the name (ends and middle) and unifies spellings that differ only
  in case, adopting the first one the project already knows — the registry
  first, then task order. Accents are deliberately **not** unified: `"Ana"`
  and `"Âna"` may be two real people, and the computer cannot know they are
  not.
- Registering a name is therefore how you **fix a spelling everywhere**:
  because the registry is consulted first, `add_person!(p, "Ana Paula")`
  re-spells every `"ana paula"` on the tasks. Typing a registered name with a
  different case in the panel does the same — doing nothing there would be the
  worst of both worlds, the user typing the correction and the screen not
  moving.
- Each collaborator is a `Person`: **name, role, team, email and notes**. A
  name alone in a plan needs a side channel to be understood; the role and
  team ride along in the assignee autocomplete, where they pay for themselves
  at the moment of choosing. Only `name` matters to the schedule.
- The assignee field is now an autocomplete fed by the registry **plus every
  name already used by a task**. Offering only the registry would hide names
  that already exist and invite retyping them — and retyping is what
  fragments. Names used but not registered are listed at the foot of the
  panel, where the fragmentation is visible, with one button to absorb them.
- Removing someone from the registry **keeps their name on their tasks**: they
  leave the list, not the work.
- **A warnings panel** — one place for everything wrong with the plan. The
  engine already knew all of it, scattered: a dependency cycle surfaced as an
  exception when scheduling, a blown deadline as a `+8d` on the bar, an
  overload only in the resource pane, and drift against the baseline only from
  `slippage()` in the REPL. Nothing new is computed; it is gathered. The chip
  in the toolbar sits next to the zoom buttons and appears **only when there is
  something to report** — a permanent counter reading zero is furniture — and
  turns red when a problem stops the plan from being scheduled at all, rather
  than merely squeezing it. At rest it is just the symbol and the count; the
  frame appears on hover, like the path box and the kanban's filter. A boxed
  chip competed with the Day/Week/Month group beside it, reading as one more
  view mode.
  Clicking a row closes the panel and takes you to the task: naming a problem
  without going to it is half an answer.
- The route returns **fields, not sentences**. A sentence composed in Julia
  would arrive in English in the middle of a translated screen — the very
  defect the i18n scan prevents on the other side — so the browser builds the
  wording from `task`, `days`, `at`, `who`, and the kind label carries the
  meaning.
- **Tests that run in a real browser** (`test/browser`), covering what jsdom
  cannot see: layout geometry and the real input-event chain. Every case in
  there is a defect that shipped and was caught by eye, not by the 342 jsdom
  checks — the PERT band changing width as you type, a double-click on a bar
  that never became a double-click, a search that lit up a name whose bar was
  months off screen, a locked field that did not look locked. No new
  dependency: headless Chrome driven over the DevTools protocol through Node's
  built-in WebSocket. With no browser on the machine the file declares itself
  skipped and exits 0 — a test that says it did not run, rather than one that
  pretends to be green.

### Changed
- The WBS summary bracket is no longer a solid block in the text colour: a
  black bar among pastel ones pulled the eye to the container instead of the
  work. It is now a thin neutral rail whose filled part is the progress that
  already rolls up from the children — a number the summary had and showed
  nowhere on the chart.

### Fixed
- The collaborator panel could **lose an edit**: it reloaded the whole project
  after saving, and a second edit made during that reload was overwritten when
  the older response landed. Both panels now adopt the answer to their own
  `PUT`, which is already the normalized state, and never reload underneath
  themselves.
- Four translation keys were defined twice with **different** wording in the
  same dictionary, where the last one silently wins; 27 duplicate definitions
  in total were removed. The suite now fails on any repeated key, and on any
  key that is missing from one of the four languages.

## [0.8.4] - 2026-08-15

### Fixed
- The test suite now fails on a file with **mixed line endings**. The
  repository is CRLF (`.gitattributes` keeps it as stored), and any tool that
  reads and rewrites a file in text mode converts it silently — the diff
  becomes the whole file, or worse, half of it turns LF and nobody notices. It
  happened four times in one working day, once reaching the published
  repository. `file` is no guard: it reports "CRLF line terminators" with
  dozens of LF lines in the middle. Counting bytes is.

### Added
- **Find a task by name in the gantt** — the box sits in the task table's own
  header, in place of the column label, since it is that column it filters and
  the placeholder says so; `/` focuses it, the same key the kanban uses. Non-matching tasks dim, in the table and in
  the chart, because search reuses the highlight machinery that was already
  there. Accents and case do not matter: typing `integracao` finds
  *Integração por partes*, which is the point in a 141-task project — needing
  the right accent means needing to already know what you are looking for.
- **Enter walks the matches**, one at a time, wrapping at the end; Shift+Enter
  walks back. The counter reads position over total, like a find box in an
  editor (`4/13`), and each step *selects* the task rather than only scrolling
  to it — on a screen of 141 rows, "somewhere in view" still leaves you
  hunting with your eyes. The timeline follows too: a task lives in time, not
  in the list, so scrolling the rows alone would light up a name whose bar sits
  months off screen. It only moves horizontally when the bar is actually out
  of view, so walking through neighbouring matches does not shake the
  timeline. Search and Highlight compose instead of cancelling
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
