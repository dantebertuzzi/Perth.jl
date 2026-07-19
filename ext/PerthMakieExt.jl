# Extensão Makie do Perth: `ganttplot(p)` renderiza o projeto como figura
# estática de publicação e `save_chart(p, path)` grava em disco com
# px_per_unit = 2 — o mesmo Project que alimenta a UI web e o REPL.
# Carregada automaticamente quando Makie (ou um backend como CairoMakie)
# está no ambiente. Desenha a hierarquia WBS (resumos como colchetes),
# baseline como barras-fantasma, setas de dependência, marcos, caminho
# crítico e a linha de hoje; `theme = :dracula` combina com as demais
# figuras do ecossistema do autor.

module PerthMakieExt

using Perth
using Makie
using Dates

const JULIA_COLORS = ["#9558b2", "#389826", "#4063d8", "#b58900", "#cb3c33"]

# Paletas: (fundo, texto, grade, fantasma, crítico)
const THEMES = Dict(
    :light   => (bg = "#ffffff", fg = "#3d3a45", grid = "#e8e6ee",
                 ghost = "#b9b4c4", crit = "#cb3c33"),
    :dracula => (bg = "#282a36", fg = "#f8f8f2", grid = "#44475a",
                 ghost = "#6272a4", crit = "#ff5555"),
)

"""
    ganttplot(p::Project; kwargs...) -> Figure

Render `p` as a static Gantt figure.

# Keywords
- `theme = :light`: `:light` or `:dracula`.
- `highlight_critical = true`: outline zero-slack tasks.
- `baseline = true`: draw baseline ghost bars (when a baseline exists).
- `dependencies = true`: draw dependency arrows.
- `today_line = true`.
- `size = (960, nothing)`: `nothing` height = auto from task count.
"""
function Perth.ganttplot(p::Perth.Project;
                         theme::Symbol = :light,
                         highlight_critical::Bool = true,
                         baseline::Bool = true,
                         dependencies::Bool = true,
                         today_line::Bool = true,
                         size = (960, nothing))
    haskey(THEMES, theme) ||
        throw(ArgumentError("ganttplot: unknown theme $(repr(theme)); use :light or :dracula"))
    th = THEMES[theme]
    ordered = Perth.ordered_tasks(p)
    n = length(ordered)
    n == 0 && error("ganttplot: project has no tasks")

    a, _ = Perth.span(p)
    day(d::Date) = Dates.value(d - a)          # eixo x em dias desde o início
    crit = highlight_critical && !Perth.has_cycle(p) ?
        Set(Perth.critical_path(p)) : Set{String}()
    rowof = Dict(t.id => i for (i, (t, _)) in enumerate(ordered))

    height = size[2] === nothing ? clamp(90 + 34n, 220, 1600) : size[2]
    fig = Figure(size = (size[1], height), backgroundcolor = th.bg)
    ax = Makie.Axis(fig[1, 1];
        title = p.name,
        titlecolor = th.fg,
        backgroundcolor = th.bg,
        yreversed = true,
        # indentação WBS direto nos rótulos do eixo y
        yticks = (1:n, [repeat("  ", d) * t.name for (t, d) in ordered]),
        xlabel = "data",
        xlabelcolor = th.fg,
        xticklabelcolor = th.fg,
        yticklabelcolor = th.fg,
        xgridcolor = th.grid,
        ygridvisible = false,
        bottomspinecolor = th.grid, topspinecolor = th.grid,
        leftspinecolor = th.grid, rightspinecolor = th.grid,
        xtickcolor = th.grid, ytickcolor = th.grid,
    )

    # Setas de dependência (por baixo das barras), em cotovelo
    if dependencies
        for (t, _) in ordered
            y2 = rowof[t.id]
            x2 = Float64(day(t.start))
            for dep in t.dependencies
                haskey(rowof, dep) || continue
                pred = ordered[rowof[dep]][1]
                x1 = Float64(day(Perth.end_date(p, pred)) + 1)
                y1 = rowof[dep]
                xm = max(x1, x2 - 0.35)
                Makie.lines!(ax, [x1, xm, xm, x2], [y1, y1, y2, y2];
                    color = th.ghost, linewidth = 1)
                Makie.scatter!(ax, [x2], [y2];
                    marker = :rtriangle, markersize = 9, color = th.ghost)
            end
        end
    end

    hasbase = baseline && any(t -> Perth.has_baseline(t), first.(ordered))

    for (i, (t, _)) in enumerate(ordered)
        color = isempty(t.color) ? JULIA_COLORS[mod1(i, length(JULIA_COLORS))] : t.color
        x0 = day(t.start)

        # Barra-fantasma do baseline (plano original), abaixo da barra atual
        if hasbase && Perth.has_baseline(t) && !Perth.is_summary(p, t)
            bx = day(t.baseline_start)
            bw = max(t.baseline_duration, 1)
            Makie.poly!(ax, Makie.Rect2f(bx, i + 0.24, bw, 0.14);
                color = (th.ghost, 0.85), strokewidth = 0)
        end

        if Perth.is_summary(p, t)
            # Colchete de resumo: barra fina com "presilhas" nas pontas
            w = max(t.duration, 1)
            Makie.poly!(ax, Makie.Rect2f(x0, i - 0.38, w, 0.14);
                color = th.fg, strokewidth = 0)
            for cap in (x0, x0 + w - 0.28)
                Makie.poly!(ax, Makie.Rect2f(cap, i - 0.38, 0.28, 0.34);
                    color = th.fg, strokewidth = 0)
            end
        elseif t.milestone
            Makie.scatter!(ax, [x0 + 0.5], [i];
                marker = :diamond, markersize = 18, color = color)
        else
            w = Perth._effdur(t)
            Makie.poly!(ax, Makie.Rect2f(x0, i - 0.34, w, 0.55);
                color = (color, 0.35), strokewidth = 0)
            t.progress > 0 && Makie.poly!(ax,
                Makie.Rect2f(x0, i - 0.34, w * t.progress / 100, 0.55);
                color = color, strokewidth = 0)
            t.id in crit && Makie.poly!(ax, Makie.Rect2f(x0, i - 0.34, w, 0.55);
                color = (:white, 0.0), strokecolor = th.crit, strokewidth = 1.6)
        end
    end

    if today_line && Dates.today() >= a
        Makie.vlines!(ax, [day(Dates.today()) + 0.5];
            color = th.crit, linestyle = :dash, linewidth = 1)
    end

    # Ticks do eixo x como datas reais (uma por semana, no máximo ~12 rótulos)
    _, b = Perth.span(p)
    ndays = day(b) + 1
    step = max(7, 7 * ceil(Int, ndays / (7 * 12)))
    tickpos = 0:step:ndays
    ax.xticks = (collect(tickpos), [string(a + Day(d)) for d in tickpos])
    ax.xticklabelrotation = π / 4

    return fig
end

"""
    save_chart(p::Project, path; kwargs...) -> String

Render `p` with [`ganttplot`](@ref) (all keywords are forwarded) and
save the figure to `path` — `.png`, `.svg` or `.pdf`, depending on the
loaded backend — at `px_per_unit = 2`. Returns the path.
"""
function Perth.save_chart(p::Perth.Project, path::AbstractString; kwargs...)
    fig = Perth.ganttplot(p; kwargs...)
    Makie.save(String(path), fig; px_per_unit = 2)
    return String(path)
end

end # module
