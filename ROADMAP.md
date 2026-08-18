# Roadmap

Ideas that are **not built yet**. The CHANGELOG says what Perth does; this file
says what it does not, and why each gap is worth closing. When an item ships it
leaves this file and shows up there instead — a roadmap that also lists finished
work stops being a to-do list and becomes a second changelog.

Order is by value, not by effort. Each entry carries the reasoning that is
expensive to rediscover: what in the app already *implies* the feature, and the
piece of code it should lean on.

## Next up

### Levelling: doing something about the overload, not just naming it

`schedule!` pushes successors so the plan respects **dependencies**. Nothing
pushes anything so it respects **capacity** — which now exists, is measured
per day, and is reported in four places. Perth diagnoses the overload
precisely and then leaves the person to drag the bar by hand, which is the
half of "diagnose → act" that never got built.

`level!(p)` would move what it is allowed to move until nobody is over
capacity, and return the project — the same shape `schedule!` and `pert!`
already established, where the engine proposes and the caller decides.

Two decisions come *before* the first line of code, and both are the kind
that is expensive to rediscover:

- **Which priority rule.** Levelling is NP-hard, so every tool picks a
  heuristic and lives with it: least slack first, earliest deadline first,
  longest task first. Perth has to choose one, say which one in the
  docstring, and never pretend it is the optimum. `slack(p)` already computes
  the number the most defensible rule needs.
- **What may move.** `pinned` means a date somebody promised, so it stays —
  and a plan that cannot be levelled without moving a pin should say so
  rather than move it. Dependencies still bind. What is left to give is the
  slack, which is exactly what the CPM already measures.

*Lean on:* `_over_day` in `src/insights.jl` is the single definition of an
overloaded day, and `_workload_rows` already produces them per person per
day — levelling is a loop that asks it, moves one task, and asks again. The
stopping condition is the honest hard part: a plan with more work than
capacity *cannot* be levelled, and the function has to end saying "these
three days still do not fit" instead of looping or lying.

*Careful:* it changes dates, so it is one undo entry and one save, like
auto-schedule. And it only means anything where somebody declared a
capacity — on a plan with none, the old two-tasks-on-a-day rule has nothing
to level against, and the honest answer is to do nothing and say why.

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

## Also worth doing

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

*Lean on:* `_scurve` already returns both series — work and cost, each in one
unit, with `has_cost` saying whether the second means anything — so the tile is
two divisions on a payload the client already fetches. No new route, no new
arithmetic in Julia. The unit trap that used to block this item is gone: it was
"under cost means nothing when `cost` is zero and the weight is person-days",
and there is no longer a series that mixes the two. What is left is the
sentence itself, and the honesty of saying *ahead of schedule in work* and
*under budget in money* as two statements rather than one number.

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

- **Reordering a selection by hand** — the multi-select moves dates, colours,
  assignees and whole blocks, but dragging a *row* (which is about order and
  parenthood, not time) still moves the one row under the cursor and collapses
  the selection to it. "Put these six under that phase" is the same gesture
  asked of the other axis, and the delicate part is what it means when the six
  come from four different parents (`aplicaArrasto` + `reorderSiblings` in
  `frontend/app.js`).
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
