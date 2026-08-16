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

### Smaller things

- **Duplicate a project** — `duplicate_task!` copies a subtree; a whole plan as
  a template has no equivalent.
- **"My tasks"** — with the collaborator registry, saying who you are and
  highlighting your own work by default is nearly free (the highlight filter
  already takes `assignee:<name>`).
- **Jump to a marked day or band** — with `Marker` and `Band` on screen, a
  "go to" list would beat scrolling to find them.
