# Perth.jl

Gantt-chart project management with a Julia backend and a local web UI,
in the spirit of Pluto.jl — plus a collaborative kanban board with
real-time labelled cursors for every machine on your network.

```julia
using Perth
Perth.run()                 # Gantt at http://localhost:8123
Perth.kanban(share = true)  # Kanban shared on your LAN, with a QR code
```

## Highlights

- **REPL-first**: the browser and the REPL edit the same data, live.
- **Multiplayer**: `share = true` (Gantt and Kanban) shows every connected
  machine as a labelled cursor with its name and IP, pair-programming style.
- **Real scheduling**: CPM, critical path, slack, dependency lag and
  SS/FF link types, business-day calendars via BusinessDays.jl.
- **Gantt ↔ Kanban bridge**: [`kanban_from_project!`](@ref) turns a project
  into cards; dragging a linked card to *done* completes the task, live.
- **Analytics**: S-curve (planned vs. earned), kanban flow metrics,
  activity log, CSV and PNG/PDF export.
- **Five UI languages**: English, Português, Español, Français, 中文.
