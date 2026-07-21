# Renderização nativa do Project, sem o app web:
#   - show text/plain  -> Gantt em Unicode no REPL (na linha do
#                         MissingPatterns.jl: meio-blocos e densidade)
#   - show text/html   -> SVG gerado em Julia; um Project vira figura
#                         inline em Pluto/Jupyter/Documenter
# O HTML aqui é um *artefato de exibição produzido pelo Julia*, não um app.

const _JULIA_COLORS = ("#9558b2", "#389826", "#4063d8", "#b58900", "#cb3c33")

# ---------------------------------------------------------------------------
# REPL (text/plain)
# ---------------------------------------------------------------------------

# Forma compacta (dentro de vetores, Dicts etc.)
Base.show(io::IO, p::Project) =
    print(io, "Project(\"", p.name, "\", ", length(p.tasks), " tasks)")

Base.show(io::IO, t::GanttTask) =
    print(io, "GanttTask(\"", t.name, "\", ", t.start,
          t.milestone ? ", milestone)" : " +$(t.duration)d)")

function Base.show(io::IO, ::MIME"text/plain", p::Project)
    printstyled(io, "Project"; bold = true)
    print(io, " \"", p.name, "\" — ", length(p.tasks), " task",
          length(p.tasks) == 1 ? "" : "s")
    isempty(p.tasks) && return

    a, b = span(p)
    total = Dates.value(b - a) + 1
    width = min(total, 60)               # colunas disponíveis para as barras
    scale = width / total
    crit = has_cycle(p) ? Set{String}() : Set(critical_path(p))
    namew = min(maximum(length(t.name) for t in p.tasks), 24)

    println(io)
    for t in sort(p.tasks; by = t -> t.start)
        off = floor(Int, Dates.value(t.start - a) * scale)
        len = max(1, round(Int, _effdur(t) * scale))
        bar = if t.milestone
            "◆"
        else
            done = clamp(round(Int, len * t.progress / 100), 0, len)
            "█"^done * "░"^(len - done)
        end
        name = rpad(first(t.name, namew), namew)
        print(io, "  ", name, "  ", t.start, "  ", " "^off)
        color = t.id in crit ? :red : :default
        printstyled(io, bar; color)
        println(io)
    end
    print(io, "  ", " "^(namew + 14), a, repeat(" ", max(width - 20, 1)), b)
end

# ---------------------------------------------------------------------------
# Pluto / Jupyter (text/html): SVG gerado em Julia
# ---------------------------------------------------------------------------

_esc(s::AbstractString) = replace(s,
    "&" => "&amp;", "<" => "&lt;", ">" => "&gt;", "\"" => "&quot;")

function Base.show(io::IO, ::MIME"text/html", p::Project)
    rowh, namew, pad = 26, 170, 8
    a, b = span(p)
    total = Dates.value(b - a) + 1
    chartw = 560
    ppd = chartw / total
    ts = sort(p.tasks; by = t -> t.start)
    n = length(ts)
    h = n * rowh + 34
    w = namew + chartw + 2pad
    crit = has_cycle(p) ? Set{String}() : Set(critical_path(p))

    print(io, """<svg xmlns="http://www.w3.org/2000/svg" width="$w" height="$h"
        font-family="system-ui,sans-serif" font-size="12">
        <rect width="$w" height="$h" fill="#fcf9f2" rx="8"/>
        <text x="$pad" y="18" font-weight="700">$(_esc(p.name))</text>""")

    for (i, t) in enumerate(ts)
        y = 26 + i * rowh
        x0 = namew + Dates.value(t.start - a) * ppd
        color = isempty(t.color) ? _JULIA_COLORS[mod1(i, length(_JULIA_COLORS))] : t.color
        print(io, """<text x="$pad" y="$(y - 6)" fill="#3d3a45">$(_esc(first(t.name, 24)))</text>""")
        if t.milestone
            cy = y - rowh / 2 + 2
            print(io, """<path d="M $(x0) $(cy - 7) l 7 7 l -7 7 l -7 -7 Z" fill="$color"/>""")
        else
            bw = _effdur(t) * ppd
            print(io, """<rect x="$(x0)" y="$(y - rowh + 8)" width="$bw" height="$(rowh - 12)"
                rx="4" fill="$color" opacity="0.35"/>""")
            t.progress > 0 && print(io, """<rect x="$(x0)" y="$(y - rowh + 8)"
                width="$(bw * t.progress / 100)" height="$(rowh - 12)" rx="4" fill="$color"/>""")
            t.id in crit && print(io, """<rect x="$(x0)" y="$(y - rowh + 8)" width="$bw"
                height="$(rowh - 12)" rx="4" fill="none" stroke="#cb3c33" stroke-width="1.5"/>""")
        end
    end

    if a <= Dates.today() <= b
        tx = namew + (Dates.value(Dates.today() - a) + 0.5) * ppd
        print(io, """<line x1="$tx" y1="24" x2="$tx" y2="$(h - 6)"
            stroke="#cb3c33" stroke-width="1" stroke-dasharray="3 3"/>""")
    end
    print(io, "</svg>")
end
