<p align="center"><img src="frontend/logo.png" alt="Perth.jl" width="280"></p>

<h1 align="center">Perth.jl</h1>

<p align="center">
  <em>Project schedules, from the REPL to the browser — over the same data, live.</em>
</p>

<p align="center">
  <a href="https://github.com/dantebertuzzi/Perth.jl/actions/workflows/CI.yml"><img alt="CI" src="https://github.com/dantebertuzzi/Perth.jl/actions/workflows/CI.yml/badge.svg"></a>
  <a href="https://github.com/dantebertuzzi/Perth.jl/actions/workflows/Frontend.yml"><img alt="Frontend" src="https://github.com/dantebertuzzi/Perth.jl/actions/workflows/Frontend.yml/badge.svg"></a>
  <a href="https://dantebertuzzi.github.io/Perth.jl/stable/"><img alt="Docs" src="https://img.shields.io/badge/docs-stable-9558b2.svg"></a>
  <a href="https://github.com/dantebertuzzi/Perth.jl/releases"><img alt="Release" src="https://img.shields.io/github/v/release/dantebertuzzi/Perth.jl?color=9558b2&label=release"></a>
  <img alt="Julia" src="https://img.shields.io/badge/julia-%E2%89%A5%201.10-9558b2.svg">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-389826.svg"></a>
</p>

<p align="center">
  <b>English</b> ·
  <a href="README.pt-BR.md">Português</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.zh-CN.md">中文</a>
</p>

<p align="center"><img src="docs/src/assets/screenshot-en.jpg" alt="Perth.jl" width="900"></p>

```julia
using Perth
Perth.run()          # opens http://localhost:8123 — the REPL stays free
```

---

## Install

```julia
using Pkg
Pkg.add("Perth")
```

Optional, and picked up automatically when loaded **before** `Perth.run()`:

| Package | What it adds |
|---|---|
| `BusinessDays` | business-day calendars (`set_calendar!(p, "Brazil")`) |
| `QRCoders` | a QR code for the LAN link, in the terminal and in the UI |
| `CairoMakie` (any Makie backend) | `ganttplot` / `save_chart` for static figures |

---

## Sixty seconds

```julia
using Perth

p = create_project("Water treatment plant — expansion")

survey  = add_task!(p, "Topographic survey"; start = Date(2026, 9, 1), duration = 5,
                    assignee = "Ana", progress = 100)
design  = add_task!(p, "Hydraulic design"; start = Date(2026, 9, 8), duration = 8,
                    assignee = "Ana", dependencies = [survey.id],
                    notes = "Check **NBR 12216** before sizing.")
approve = add_task!(p, "Design approved"; start = Date(2026, 9, 29), milestone = true,
                    dependencies = [design.id])

# a commitment, not a plan: a deadline never moves the task, it turns slack negative
add_task!(p, "Pipework and valves"; start = Date(2026, 11, 12), duration = 10,
          deadline = Date(2026, 11, 20))

schedule!(p)                 # CPM: pushes successors to their earliest date
critical_path(p)             # the chain with no slack
tasks(p)                     # Tables.jl rows — pipe straight into a DataFrame

Perth.run()                  # and now look at it
```

Everything above is also a gesture in the browser, and the two directions are
live: the open page notices REPL-side changes and reloads on its own.

> **One wrinkle worth knowing.** A variable you bound earlier is a snapshot. After
> editing in the browser, ask for the project again — `project(id)` hands you what
> the UI just saved, while `p` still holds what it held when you assigned it.

---

## Why a Gantt package *in Julia*?

Because the browser is only one of the views. The model and the engine are
ordinary Julia, so a plan is something you can compute with:

```julia
using DataFrames

df = DataFrame(tasks(p))
combine(groupby(df, :assignee), :duration => sum => :days)

# the schedule reacts to your data, not the other way round
for row in eachrow(measurements)
    update_task!(p, row.id; progress = row.done_pct)
end
schedule!(p)
```

A spreadsheet cannot do that, and a desktop Gantt makes you export first.

---

## What you get

### Planning

| | |
|---|---|
| **CPM engine** | `schedule!`, `critical_path`, `slack`, `project_finish` |
| **Dependencies** | finish-to-start by default; `"SS:id"`, `"FF:id"`, and lag `"id+3"` |
| **Business days** | `set_calendar!(p, "Brazil")` — weekends and holidays stop counting |
| **WBS** | give a task a parent; the parent becomes a summary that rolls up dates and progress |
| **Deadlines** | a *commitment*: never moves a task, turns its slack (and its feeders') negative |
| **Pinned starts** | a contract date `schedule!` leaves alone — and says so when the plan no longer fits it |
| **Baseline** | freeze the plan; the ghost bars are what you promised, the gap is the slippage |
| **Manual order** | `move_task!(p, id; parent, position)` — `order` beats the date where someone chose |

### The chart

- **Drag a bar** to move a task, its right edge to resize, and **drag between bars**
  to link them: the dot on the right end links to what follows, the left one to what
  comes before. Double-click an arrow to remove it.
- **Drag a row up or down to order the plan by hand.** Dropped *in the gap* between
  two rows it takes that position; dropped *on top of* a task it becomes a subtask
  of it — one gesture, two destinations. The **`#` column** is that order written
  down; hover it for the task id.
- **Zoom day / week / month / fit** (`1`–`4`) and **Ctrl+wheel**, which keeps the
  date under the pointer where it is. Changing zoom never teleports you to today.
- **Marked days** — double-click a column in the day ruler and name it: a vertical
  line across the whole chart, for a date that matters to every task at once.
- **Marked months** — a whole month painted in the ruler at the top. Said once, up
  there, instead of repeated on every task inside it.
- **Calendar bands** — shade a named stretch behind the chart: a sprint, a shutdown,
  the rainy season. Annotation, never scheduling.
- **Swimlanes** by person or team, **collapsible WBS summaries** (and what you
  folded survives the reload), a **highlight filter**, and **presentation mode**.
- **Notes with markdown**: the red dot opens the note, rendering `**bold**`,
  `*italic*`, `` `code` ``, `~~strike~~` and links.
- Nothing on the chart is written on top of anything else: lines open a gap where
  they cross a label, and sideways names look for a free stretch. A test measures
  it, in a real browser, at four zooms and two densities.

### Reading the plan

| | |
|---|---|
| **S-curve** | planned vs. earned — the gap is the delay measured in work, not days |
| **Workload** | how much each person has on each day (`workload`, `overallocations`) |
| **Capacity** | `add_person!(p, "Ana"; capacity = 8)` and `effort` on the task: overload becomes *more work than the day holds*, not *two tasks on the same day* |
| **Statistics** | per person and per team: effort, done, days busy, days over capacity |
| **Warnings** | dependency cycle · past deadline · overdue · overallocation · over capacity · behind the baseline · *starts before its dependencies allow* |
| **Glossary** | Help → *What the words mean*: slack, critical path, baseline, P80, the lot |

### Getting it out

Export the project (`.perth.jl`), the tasks (**CSV**), the milestones and deadlines
(**iCalendar**), the chart (**PNG**), or a static figure through Makie
(`ganttplot`, `save_chart`). And a **file mirror**: point a project at a path and
every save also rewrites the `.perth.jl` there, so `git diff` shows what changed in
the plan.

---

## Sharing a plan

By default `Perth.run()` is reachable from this machine only. Sharing is a **live
switch**, not a startup-only decision — from the REPL, from the broadcast button in
the menubar, or from *File → Share / QR…*:

```julia
Perth.run(share = true)          # prints the LAN links (+ a QR code with QRCoders)
Perth.share!()                   # start transmitting, server already up
Perth.share!(false)              # stop; remote browsers drop immediately
Perth.key!("obra-2026")          # require an access key from the network
```

Every connected machine shows up as a labelled cursor with its name and IP,
pair-programming style, and there is a chat in the corner.

### A link that only shows

Sharing used to be all-or-nothing: whoever opened the link could edit. `view_key`
is a **second key** that grants reading and refuses writing — the link you hand to
a client, a director, the whole site:

```julia
Perth.run(share = true, key = "obra-2026", view_key = "obra-2026-view")
Perth.view_key!("just-looking")   # change it, live
Perth.view_key!()                 # end it
```

The refusal is the **server's**, decided by the method rather than by a list of
routes, so a route added tomorrow is refused by default. That includes the door the
interface does not use — the chat on the presence socket persists to disk and
reaches everyone, so it is writing, and leaving it open would be changing the lock
and leaving the window open. Viewers show up among the connected machines as a
hollow ring: present, not writing.

> **Security.** Without a key, anyone on the network who knows the port can open and
> edit every project. A read-only link limits what a browser may do; it is not a
> login, and it is as private as the network it is on. Never expose the port to the
> internet.

<details>
<summary><b>Opening the firewall port (Windows, corporate networks)</b></summary>

Sharing only helps if the machine accepts inbound connections on the port (8123 for
the Gantt, 8150 for the kanban). In order of effort:

1. **First-run prompt** — Windows Defender asks about `julia.exe`; tick **Private
   networks** and *Allow access*. It needs administrator rights, so on a locked-down
   machine it may be greyed out or never appear.
2. **If it was dismissed** — Start menu → "Allow an app through Windows Firewall" →
   *Change settings* → *Allow another app…* → browse to `julia.exe` (run `Sys.BINDIR`
   in the REPL to find it) and tick *Private*.
3. **An explicit rule**, which is what IT usually prefers — PowerShell as
   administrator:
   ```powershell
   New-NetFirewallRule -DisplayName "Perth" -Direction Inbound `
     -Protocol TCP -LocalPort 8123 -Action Allow -Profile Domain,Private
   ```
4. **Check the network profile.** A *Private* rule does nothing if Windows filed the
   office network as *Public*. On domain-joined machines the office network is
   usually *Domain*, which the rule above already covers.
5. **No admin at all** — send IT one line: *"Please allow inbound TCP on port 8123
   for `julia.exe` (Domain/Private, LAN only — an internal plan at
   `http://<my-ip>:8123`; nothing is exposed to the internet)."*
6. **Firewall open and still unreachable?** Guest Wi-Fi often has *client isolation*.
   Test with `Test-NetConnection <ip> -Port 8123`; if it fails with the firewall
   open, use the wired or staff network.

On Linux: `sudo ufw allow 8123/tcp`. macOS prompts on first run, like Windows.

</details>

---

## Estimating under uncertainty (PERT)

One number for a duration is a guess wearing a suit. Give three:

```julia
set_estimate!(p, foundations.id, 9, 12, 22)   # optimistic, most likely, pessimistic

pert(p)                                       # expected duration and σ, per task
pert_finish(p)                                # finish: expected, σ, P10/P50/P80/P90
finish_probability(p, Date(2026, 12, 10))     # odds of the date you promised
pert_date(p, 0.8)                             # the date you are right 4 times out of 5
pert!(p)                                      # apply (o + 4m + p)/6 as the duration
```

The estimates never move anything on their own — `pert!` is what writes them into
the plan, the same way `schedule!` is what moves dates.

### The number the formula won't tell you

Analytic PERT assumes one critical chain. When several chains are nearly the same
length, whichever runs late becomes critical, and the finish drifts later than any
formula predicts. `pert_simulate` runs the whole engine thousands of times:

```julia
sim = pert_simulate(p; n = 10_000)
sim.p80        # the date that survives 80% of the futures
```

The gap between `pert_finish(p).p80` and `sim.p80` is the cost of pretending there
is only one critical path.

---

## Kanban: a shared board for the office

`Perth.kanban()` starts a second, independent app. It does not touch the Gantt data
model — the board is its own entity, persisted as `kanban.json` in the data
directory.

```julia
Perth.kanban()                         # this machine only, like Perth.run()
Perth.kanban(share = true)             # prints the LAN links
Perth.kanban(share = true, key = "…")  # …and requires the key from them
Perth.kanban_share!(false)             # stop transmitting, board still running
Perth.kanban_key!("…")                 # set/change the key with the board up

kanban_from_project!(p)                # turn a plan into cards
```

WebSocket-authoritative end to end: every change is broadcast live, dragging a card
animates on everyone's screen, and each machine shows up as a labelled cursor
anchored to a *card*, not to a pixel — so it survives different window sizes and
zoom levels. Cards carry `#tags`, `**markdown**`, checklists, due dates, assignees,
per-column **WIP limits** and an archive; a linked card dragged to *done* completes
the task in the Gantt, and back. `Ctrl+Z` / `Ctrl+Shift+Z` undo your own actions
without reverting what a colleague did afterwards.

The **host** can restrict what a given machine may do — *Board → Permissions…* is a
matrix of 19 card and column actions against every IP that has connected. It is
enforced **server-side**: a client cannot get around it by talking to the WebSocket
directly, and the UI merely hides what is denied.

And the REPL operates on the same board, broadcasting live to every open browser:

```julia
kanban_add_card!("backlog", "Ship v1.0")
kanban_move_card!(id, "doing")
kanban_alias!("192.168.0.23", "Paulo")   # a name for a machine, on everyone's screen
kanban_cards() |> DataFrame              # (column, id, text) rows
kanban_log()                             # who changed what, and when
kanban_chat!("board is ready")           # the chat panel, from the REPL
Perth.kanban_stop()
```

> **Security.** The permission matrix restricts what a *connected* machine can do;
> it does not gate the connection, and identity is just an IP address (spoofable on
> an untrusted LAN). Treat it as reducing blast radius, not as authentication.

<details>
<summary><b>Resetting the board</b></summary>

The whole board lives in two files, so a full reset is: stop the server, delete
them, start again.

```julia
Perth.kanban_stop()                       # stop first — the server keeps the board
                                          # in memory and rewrites the file on
                                          # every operation
datadir = joinpath(homedir(), ".perth")   # or your PERTH_DATA_DIR / data_dir
rm(joinpath(datadir, "kanban.json"); force = true)        # the board
rm(joinpath(datadir, "kanban-log.jsonl"); force = true)   # the activity log
Perth.kanban(share = true)                # fresh board: backlog / doing / done
```

Deleting the log is optional — but if you keep it, the Activity panel will show
history that refers to the old board. To **keep** the old board instead of deleting
it, rename the file and rename it back whenever you want it again; to start a
**separate** board without touching this one, point the server at another folder:
`Perth.kanban(share = true, data_dir = "/path/to/new-board")`.

</details>

---

## Keyboard

| | |
|---|---|
| `↑` `↓` | move the selection through the visible rows |
| `←` `→` | collapse a summary / open it — on a leaf, `←` goes up to the parent |
| `Home` `End` · `PageUp` `PageDown` | ends of the plan · one screenful |
| `N` · `Enter` · `Del` · `Ctrl+D` | new · edit · delete · duplicate the selection |
| `Ctrl+click` · `Shift+click` · `Shift+↑` `↓` | add one to the selection · take the range · extend it |
| `Ctrl+A` · `Ctrl+E` | select every visible task · edit the selection (dates, assignee, colour) |
| `Ctrl+Z` · `Ctrl+Shift+Z` | undo · redo |
| `S` · `C` · `R` | auto-schedule · critical path · resource load |
| `1` `2` `3` `4` · `Ctrl+wheel` | zoom day / week / month / fit · zoom under the pointer |
| `T` · `/` · `D` · `P` | go to today · find a task · dark mode · presentation |

---

## Where things live

Each project is a JSON file under `~/.perth` (or `$PERTH_DATA_DIR`, or
`Perth.run(data_dir = ...)`). JSON is the machine format; **`.perth.jl` is the
interchange format for humans and version control**:

```julia
Perth.save(p, "plans/plant.perth.jl")        # readable, diffable Julia source
q = Perth.load("plans/plant.perth.jl")
set_file_path!(p, "plans/plant.perth.jl")    # mirror: every save rewrites it
```

`Perth.load` uses a **restricted parser**, not `eval`: only `Project`, `GanttTask`,
`Person`, `Band`, `Marker`, `MonthMark`, `Date` and `DateTime` may be constructed,
and any other call is refused. A plan you received by e-mail cannot run code.

---

## Architecture

```
REPL  ──►  AppState (in-memory projects + revision counter)  ◄──  HTTP API
                     │                                              │
               JSON on disk                            browser (vanilla JS)
               .perth.jl mirror                        + WebSocket presence
```

No framework, no build step, no `node_modules`: the frontend is plain JS and CSS
served by the same Julia process. Three suites keep it honest — Julia
(`Pkg.test()`), jsdom for DOM logic, and a real headless Chrome for geometry, event
chains and overlap measurement.

---

## Known limitations

- **Not multi-user by identity.** Everyone on the network shares the same projects;
  the access key is a door, not a login.
- **Local-first by design.** No cloud, no accounts, no sync between machines beyond
  the LAN — the file is the sync.
- **Resource levelling is not automatic.** Perth reports overallocation; it does not
  resolve it for you.

What comes next lives in [ROADMAP.md](ROADMAP.md), with the reasoning for each item.
Issues and contributions are welcome — including telling me that a plan of yours
broke something.

---

<p align="center">
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="ROADMAP.md">Roadmap</a> ·
  <a href="https://dantebertuzzi.github.io/Perth.jl/stable/">Documentation</a> ·
  MIT
</p>
