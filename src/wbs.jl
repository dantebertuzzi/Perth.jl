# WBS (Work Breakdown Structure): tarefas podem ter um pai; uma tarefa com
# filhos vira um *resumo* cujo start/duration/progress são derivados dos
# descendentes. A materialização acontece a cada _save! — assim o REPL show,
# o span(), o .perth.jl exportado e a UI enxergam sempre valores coerentes.
# O motor CPM opera só nas folhas (resumos são contêineres, não trabalho).

"""
    subtasks(p::Project, id::AbstractString) -> Vector{GanttTask}

Direct children of the task with the given `id` in the WBS hierarchy.
"""
subtasks(p::Project, id::AbstractString) =
    [t for t in p.tasks if t.parent == id]

"""
    is_summary(p::Project, t::GanttTask) -> Bool

Whether `t` has children — i.e. it is a WBS summary whose dates and
progress roll up from its descendants.
"""
is_summary(p::Project, t::GanttTask) = any(o -> o.parent == t.id, p.tasks)
_has_children(p::Project, id::String) = any(o -> o.parent == id, p.tasks)

# Conjunto de ids dos descendentes (filhos, netos, …) de `id`
function _descendants(p::Project, id::AbstractString)
    kids = Dict{String,Vector{String}}()
    for t in p.tasks
        isempty(t.parent) && continue
        push!(get!(kids, t.parent, String[]), t.id)
    end
    out = Set{String}()
    stack = copy(get(kids, String(id), String[]))
    while !isempty(stack)
        c = pop!(stack)
        c in out && continue
        push!(out, c)
        append!(stack, get(kids, c, String[]))
    end
    return out
end

"""
    set_parent!(p::Project, id, parent) -> GanttTask

Move the task `id` under `parent` in the WBS (pass `nothing` or `""`
to promote it to top level). Throws `ArgumentError` when the parent is
a milestone or when the move would create a cycle. Persists — the
parent becomes a summary and rolls up on save.
"""
function set_parent!(p::Project, id::AbstractString,
                     parent::Union{Nothing,AbstractString})
    i = findfirst(t -> t.id == id, p.tasks)
    i === nothing && throw(KeyError(String(id)))
    t = p.tasks[i]
    pid = parent === nothing ? "" : String(strip(parent))
    if !isempty(pid)
        j = findfirst(o -> o.id == pid, p.tasks)
        j === nothing && throw(KeyError(pid))
        pid == t.id && throw(ArgumentError("a task cannot be its own parent"))
        p.tasks[j].milestone &&
            throw(ArgumentError("a milestone cannot have subtasks"))
        pid in _descendants(p, t.id) &&
            throw(ArgumentError("cannot move a task under its own descendant"))
    end
    t.parent = pid
    _with_state(st -> _save!(st, p))
    return t
end

"""
    move_task!(p::Project, id; parent = missing, position = nothing) -> GanttTask

Put the task `id` where you want it in the WBS: `parent` changes whose
child it is (`nothing` or `""` promotes it to top level; `missing`, the
default, leaves it where it is) and `position` is its 1-based place among
its siblings (`nothing` keeps it last). This is what dragging a row up or
down in the web UI does.

Positioning renumbers the whole sibling group, so the result is always a
clean `1, 2, 3, …`: no gaps to run out of, and the group can never end up
half by hand and half by date. Siblings elsewhere are untouched — a
manual order is a statement about one group, not about the plan.

Throws the same `ArgumentError`s as [`set_parent!`](@ref) (a milestone
cannot have subtasks; a task cannot move under its own descendant).

```julia
move_task!(p, "a3f"; position = 1)              # primeira do grupo
move_task!(p, "a3f"; parent = "b12")            # vira subtarefa de b12
move_task!(p, "a3f"; parent = "", position = 2) # sobe ao topo, em 2º
```
"""
function move_task!(p::Project, id::AbstractString;
                    parent = missing,
                    position::Union{Nothing,Integer} = nothing)
    i = findfirst(t -> t.id == id, p.tasks)
    i === nothing && throw(KeyError(String(id)))
    t = p.tasks[i]
    if parent !== missing
        pid = parent === nothing ? "" : String(strip(parent))
        if !isempty(pid)
            j = findfirst(o -> o.id == pid, p.tasks)
            j === nothing && throw(KeyError(pid))
            pid == t.id && throw(ArgumentError("a task cannot be its own parent"))
            p.tasks[j].milestone &&
                throw(ArgumentError("a milestone cannot have subtasks"))
            pid in _descendants(p, t.id) &&
                throw(ArgumentError("cannot move a task under its own descendant"))
        end
        t.parent = pid
    end
    _reorder_siblings!(p, t, position)
    _with_state(st -> _save!(st, p))
    return t
end

# Renumera o grupo de irmãos de `t` (1, 2, 3, …) com `t` na posição pedida.
# A ordem de partida é a que se vê na tela — a mesma regra de
# ordered_tasks —, então mover uma tarefa não embaralha as outras.
function _reorder_siblings!(p::Project, t::GanttTask,
                            position::Union{Nothing,Integer})
    irmaos = [o for o in p.tasks if o.parent == t.parent]
    sort!(irmaos; by = o -> (o.order == 0 ? typemax(Int) : o.order,
                             o.start, o.name))
    filter!(o -> o.id != t.id, irmaos)
    pos = position === nothing ? length(irmaos) + 1 :
          clamp(Int(position), 1, length(irmaos) + 1)
    insert!(irmaos, pos, t)
    for (k, o) in enumerate(irmaos)
        o.order = k
    end
    return p
end

# Poda pais inválidos: id inexistente, auto-referência, pai marco, ou elo
# que fecha ciclo na cadeia de pais. Cada membro de um ciclo tem a própria
# caminhada de subida voltando a si mesmo, então pelo menos um elo de cada
# ciclo é cortado — e um corte já abre a cadeia para os demais.
function _prune_parents!(p::Project)
    byid = Dict(t.id => t for t in p.tasks)
    for t in p.tasks
        isempty(t.parent) && continue
        pa = get(byid, t.parent, nothing)
        (pa === nothing || pa.id == t.id || pa.milestone) && (t.parent = "")
    end
    n = length(p.tasks)
    for t in p.tasks
        steps = 0
        cur = t
        while !isempty(cur.parent) && steps <= n
            cur = byid[cur.parent]
            steps += 1
            if cur === t
                t.parent = ""
                break
            end
        end
    end
    return p
end

# Materializa os resumos (pós-ordem): start = menor início dos filhos,
# fim = maior fim (ciente do calendário), duration = extensão em dias
# corridos, progress = média dos descendentes-folha ponderada pela duração.
# Assume cadeia de pais acíclica (_prune_parents! roda antes no _save!),
# mas mantém um guarda de revisita por segurança.
function _rollup_summaries!(p::Project)
    kids = Dict{String,Vector{GanttTask}}()
    for t in p.tasks
        isempty(t.parent) && continue
        push!(get!(kids, t.parent, GanttTask[]), t)
    end
    isempty(kids) && return p
    visiting = Set{String}()
    # devolve (start, fim, progresso, peso-folha) do nó
    function roll!(t::GanttTask)
        cs = get(kids, t.id, nothing)
        if cs === nothing
            w = _effdur(t)
            prog = t.milestone ? (t.progress >= 100 ? 100 : 0) : t.progress
            return (t.start, end_date(p, t), prog, w)
        end
        t.id in visiting && return (t.start, end_date(p, t), t.progress, 0)
        push!(visiting, t.id)
        s = nothing; e = nothing; wsum = 0; psum = 0
        for c in cs
            cs_, ce, cp, cw = roll!(c)
            s = s === nothing ? cs_ : min(s, cs_)
            e = e === nothing ? ce : max(e, ce)
            wsum += cw
            psum += cp * cw
        end
        pop!(visiting, t.id)
        t.milestone = false                       # resumo nunca é marco
        t.start = s
        t.duration = Dates.value(e - s) + 1       # extensão visual, dias corridos
        t.progress = wsum == 0 ? 0 : round(Int, psum / wsum)
        return (s, e, t.progress, wsum)
    end
    for t in p.tasks
        haskey(kids, t.id) && roll!(t)
    end
    return p
end

"""
    ordered_tasks(p::Project) -> Vector{Tuple{GanttTask,Int}}

Tasks in WBS display order — depth-first, children under their parent
— paired with their depth (0 = top level). This is the row order used by
the web UI and the Makie figure.

Siblings come out in the order someone put them in (`order`, see
[`move_task!`](@ref)); the ones with no manual position come after, by
`(start, name)`. A plan nobody reordered is therefore ordered by date,
exactly as before the field existed.
"""
function ordered_tasks(p::Project)
    ids = Set(t.id for t in p.tasks)
    kids = Dict{String,Vector{GanttTask}}()
    roots = GanttTask[]
    for t in p.tasks
        if isempty(t.parent) || !(t.parent in ids)
            push!(roots, t)
        else
            push!(get!(kids, t.parent, GanttTask[]), t)
        end
    end
    out = Tuple{GanttTask,Int}[]
    seen = Set{String}()
    function walk(ts::Vector{GanttTask}, d::Int)
        # order == 0 é "sem posição", não "posição zero": vai para o fim,
        # senão toda tarefa nova entraria na frente de um grupo arrumado
        for t in sort(ts; by = o -> (o.order == 0 ? typemax(Int) : o.order,
                                     o.start, o.name))
            t.id in seen && continue    # defesa contra ciclos ainda não podados
            push!(seen, t.id)
            push!(out, (t, d))
            haskey(kids, t.id) && walk(kids[t.id], d + 1)
        end
    end
    walk(roots, 0)
    return out
end
