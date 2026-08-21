# Roadmap

Ideas that are **not built yet**. The CHANGELOG says what Perth does; this file
says what it does not, and why each gap is worth closing. When an item ships it
leaves this file and shows up there instead — a roadmap that also lists finished
work stops being a to-do list and becomes a second changelog.

Order is by value, not by effort. Each entry carries the reasoning that is
expensive to rediscover: what in the app already *implies* the feature, and the
piece of code it should lean on.

## Next up

### The note the card already got

A kanban card opens as a document: a description that takes lists and fenced
code blocks, a pasted screenshot shrunk in the browser and stored by its own
hash, a dialog that saves on every way out of it. A Gantt task has `notes` —
one line of inline markdown in a popover — and no way to hold a picture at
all. That is the wrong way round as often as not: the screenshot of the broken
build, the paragraph explaining why a task slipped and the three lines of
config that explain the estimate are about *the plan*, and the plan is the side
that cannot hold them.

*Lean on:* almost none of this is new work. `renderBlocks` in
`frontend/shared/inline.js` is already shared code — it is the block layer over
the very tokeniser the note popover calls, and the popover calls `render`
instead only because nothing asked it not to. `src/assets.jl` addresses blobs
by content under `_state().data_dir`, which is the same directory the Gantt
already writes projects into, so the bytes need no second home and no second
garbage collector. The cap is the one real widening: `t.notes` goes through
`_cap_text` (2 000 characters, the cap of every field that is also an
identifier) and would have to reach `_cap_body`'s 20 000, which is the number
the card's dialog counts down to.

*Careful:* the routes are the genuinely kanban-only part. `POST /api/asset` and
`GET /asset/<name>` are registered by the kanban server, behind the kanban's
share gate and its per-IP permission matrix; the Gantt server has a gate and a
matrix of its own. The header of `src/background.jl` says why this is not a
copy-paste: these servers listen on 0.0.0.0, and an upload is a write surface
on the LAN, so the question is which gate guards the store when two doors reach
it — not which handler to duplicate.

## Also worth doing

### Print / PDF

PNG export exists, but a plan ends up as an attachment in a report and as paper
on a meeting table. A print stylesheet — landscape, page breaks between row
groups, legend, no menubar — is cheap and changes where Perth can go.

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
  this slip?" wants that shape, not a text field. Giving the note a document
  (see *The note the card already got* above) does not answer this and should
  not be mistaken for it: a field with room for thirty lines is still one
  person's text overwriting the last person's. (`src/presence.jl` for the
  channel, `frontend/shared/inline.js` for the markdown both ends render.)
- **Undo that survives a reload, and other machines** — the stack lives in the
  browser (`pushUndo`), so it is emptied by F5 and knows nothing about the
  change the other machine just made. With sharing on, "undo that" is about
  someone else's action as often as your own.
- **Jump to a marked day or band** — with `Marker` and `Band` on screen, a
  "go to" list would beat scrolling to find them.
