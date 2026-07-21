using Documenter
using Perth

makedocs(
    sitename = "Perth.jl",
    modules = [Perth],
    format = Documenter.HTML(
        prettyurls = get(ENV, "CI", "false") == "true",
        canonical = "https://dantebertuzzi.github.io/Perth.jl",
    ),
    pages = [
        "Home" => "index.md",
        "Gantt" => "gantt.md",
        "Kanban" => "kanban.md",
        "API" => "api.md",
    ],
    warnonly = [:missing_docs],   # docstrings internas não quebram o build
)

deploydocs(repo = "github.com/dantebertuzzi/Perth.jl", push_preview = true)
