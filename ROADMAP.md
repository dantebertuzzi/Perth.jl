# Roadmap

Ideas that are **not built yet**. The CHANGELOG says what Perth does; this file
says what it does not, and why each gap is worth closing. When an item ships it
leaves this file and shows up there instead — a roadmap that also lists finished
work stops being a to-do list and becomes a second changelog.

Order is by value, not by effort. Each entry carries the reasoning that is
expensive to rediscover: what in the app already *implies* the feature, and the
piece of code it should lean on.

## Next up

### Multi-select and bulk actions

Everything is one task at a time. With collaborators and lanes in place,
"push these six by three days" and "hand these four to Bruno" became obvious
operations that do not exist. Shift-click a range, Ctrl-click to add; then
move, recolour, reassign, delete.

*Lean on:* `state.selected` becomes a set (careful: `selectTask` toggles, and
several places read `state.selected` as an id — `revealTask`, the modal, the
chart's `bar-sel`). `pushUndo()` already snapshots the whole project, so a bulk
edit is one undo entry for free.

### Capacity per person

"Overallocated" means *two tasks on the same day*, which is crude: two one-hour
tasks are not an overload. With `capacity` on `Person` and effort in hours on
the task, load, overallocation, warnings and statistics would all describe real
work.

*Lean on:* `_workload_rows` in `src/insights.jl` is the single place that spreads
a task's weight across its days — it already picks `cost` when set and
person-days otherwise, so capacity is a third input to the same function. But
four readings agree with each other today (workload, overallocations, warnings,
`people_stats`); changing the unit under them is a release of its own, not an
item in a mixed one.

## Also worth doing

### Hide what does not match, not just dim it

The highlight select and the search *dim* the rows that do not match, which is
the right answer for a plan of thirty tasks: you keep seeing where Ana's work
sits among everyone else's. At a hundred and forty it stops working — the
matches are three rows scattered down a screen of grey, and scrolling past what
you asked to ignore is most of the reading. A "only these" switch next to the
select is the same question asked with the other answer.

*Lean on:* `taskMatchesHighlight` in `frontend/app.js` is already the single
predicate the table, the bars and the resource panel consult — hiding is that
same predicate applied one step earlier, where rows are built. The care is in
what a hidden row does to what is drawn *between* rows: dependency arrows to a
task that is no longer on screen, and a summary whose children all vanished
(hide the parent too, or it becomes a bar with nothing under it).

### Recording progress without opening a task

`progress` is the field that changes most often — it is what a weekly meeting
*is* — and it is the one field with no gesture. Dates come from dragging the
bar, order from dragging the row, links from dragging a dot; percentage
complete needs the modal, eight times in a row. A handle on the filled part of
the bar, and `0`-`9` on the selected task for the round tenths, would make the
Monday pass a minute instead of ten.

*Lean on:* the bar's own `pointerdown` machinery already converts pixels to
days and back; here it converts pixels to a percentage of the bar's width, and
snaps to 5. Summaries derive their progress from the children (`app.js` around
the WBS roll-up) — the handle must refuse to appear on them, the way the date
drag already does.

### Print / PDF

PNG export exists, but a plan ends up as an attachment in a report and as paper
on a meeting table. A print stylesheet — landscape, page breaks between row
groups, legend, no menubar — is cheap and changes where Perth can go.

### CSV import

CSV export exists; import does not. That is the missing half, and a spreadsheet
is where almost every plan is born. Name, start, duration, assignee, parent:
five columns and the project walks in.

*Lean on:* `_import_project` in `src/api.jl` already sniffs JSON vs `.perth.jl`;
CSV is a third branch. Reuse `add_tasks!`, which already validates rows.

### What the S-curve already knows, said as numbers

`_scurve` in `src/insights.jl` computes planned and earned work per day, with
`cost` when it is set and person-days otherwise. Two divisions on numbers that
are already there — earned over planned, earned over the cost so far — are the
two readings every report asks for: are we ahead or behind, and is it costing
what we said. Today the curve says it in a shape, which is honest but has to be
read; a plan that is 12% behind schedule and 4% under cost deserves the
sentence, next to the shape.

*Lean on:* `_scurve` returns the whole series, so the tile is derived on the
client from a payload it already fetches — no new route, no new arithmetic in
Julia. The unit trap is the one the roadmap's capacity item names: "under cost"
means nothing when `cost` is zero and the weight is person-days, so the tile
has to say which of the two it is measuring.

### The plan as it was last Monday

`activity.jsonl` records who did what, and a baseline records one snapshot,
chosen by hand, drawn as ghost bars. Between them there is nothing: no way to
open the plan as it stood before the reorganisation, and no way to answer "what
moved this week", which is the first question in every status meeting. A
snapshot per day (or per session) is a few kilobytes of JSON in the same
directory.

*Lean on:* `_save!` in `src/storage.jl` is the single write path, and the
project is already serialised whole by `JSON3.write` — a snapshot is that
string under a dated name. The ghost-bar renderer that draws a baseline is
already the "here is another version of this bar" drawing, so *comparing* to a
snapshot needs a source, not a new picture.

### Smaller things

- **Duplicate a project** — `duplicate_task!` copies a subtree; a whole plan as
  a template has no equivalent.
- **"My tasks"** — with the collaborator registry, saying who you are and
  highlighting your own work by default is nearly free (the highlight filter
  already takes `assignee:<name>`).
- **A task's own thread** — a task carries `notes`, which is one person's text
  edited over the top of the last person's. The kanban already has a
  conversation that persists and reaches everyone; a note that answers "why did
  this slip?" wants that shape, not a text field. (`src/presence.jl` for the
  channel, `shared/inline.js` for the same one-line markdown the note popover
  now renders.)
- **Undo that survives a reload, and other machines** — the stack lives in the
  browser (`pushUndo`), so it is emptied by F5 and knows nothing about the
  change the other machine just made. With sharing on, "undo that" is about
  someone else's action as often as your own.
- **Jump to a marked day or band** — with `Marker` and `Band` on screen, a
  "go to" list would beat scrolling to find them.
