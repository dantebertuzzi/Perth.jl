"""
    Perth

Gantt-chart project management with a Julia backend and a local web UI,
in the spirit of Pluto.jl: `Perth.run()` starts a localhost server and
opens the app in your browser, while the REPL stays free for
programmatic manipulation of the same projects.

```julia
using Perth
Perth.run()

p = create_project("Obra do cartório")
add_task!(p, "Digitalização do acervo"; start = Date(2026, 8, 1), duration = 15)
tasks(p)          # Tables.jl-compatible rows
Perth.stop()
```
"""
module Perth

using Dates
using FileWatching
using Random
using Sockets
using Unicode
using UUIDs

import HTTP
import JSON3
import StructTypes
import Tables

export GanttTask, Project,
    create_project, delete_project, project, projects,
    add_task!, update_task!, remove_task!, duplicate_task!, tasks,
    set_file_path!,
    Person, people, person, people!, add_person!, remove_person!,
    end_date, span,
    schedule!, critical_path, slack, project_finish, has_cycle, set_calendar!,
    deadline_slip,
    set_parent!, subtasks, is_summary, ordered_tasks,
    set_baseline!, clear_baseline!, has_baseline, slippage,
    set_estimate!, clear_estimate!, has_estimate, expected_duration,
    pert, pert!, pert_finish, finish_probability, pert_date, pert_simulate,
    tasktable, add_tasks!, overallocations, workload, icalendar,
    people_stats, team_stats,
    ganttplot, save_chart,
    kanban_columns, kanban_cards,
    kanban_add_card!, kanban_move_card!, kanban_remove_card!,
    kanban_alias!, kanban_aliases, kanban_log,
    kanban_chat!, kanban_chat_log, kanban_share!, kanban_key!,
    kanban_from_project!, kanban_boards, kanban_board!, kanban_reset!

# Re-exporta o vocabulário de datas que a API do Perth usa o tempo todo,
# para `using Perth` bastar no REPL
export Date, DateTime, Day, Week, Month, today

"""
    ganttplot(p::Project; kwargs...)

Render `p` as a static Makie figure. Requires a Makie backend
(e.g. CairoMakie) to be loaded — the method is provided by the
`PerthMakieExt` package extension.
"""
function ganttplot end

"""
    save_chart(p::Project, path; kwargs...) -> String

Render `p` with [`ganttplot`](@ref) and save the figure to `path`
(`.png`, `.svg`, `.pdf`) at `px_per_unit = 2`. Requires a Makie backend
(e.g. CairoMakie) — provided by the `PerthMakieExt` package extension.
"""
function save_chart end

include("types.jl")
include("storage.jl")
include("juliafile.jl")
include("watch.jl")
include("icalendar.jl")
include("schedule.jl")
include("wbs.jl")
include("insights.jl")
include("pert.jl")
include("show.jl")
include("splash.jl")
include("api.jl")
include("presence.jl")
include("server.jl")
include("kanban.jl")
include("background.jl")

# Dica de entrada. Guardas, em ordem: precompilação (jl_generating_output),
# sessão não-interativa (script, teste, pacote que depende deste) e, dentro
# de _hint, o mesmo PERTH_SPLASH que silencia o resto da decoração. Nunca
# deixa uma exceção escapar: falhar aqui impediria o `using` de terminar.
function __init__()
    ccall(:jl_generating_output, Cint, ()) == 0 || return nothing
    isinteractive() || return nothing
    try
        _pick()          # navegável, mas desiste sozinha (ver _pick)
    catch
    end
    return nothing
end

end # module
