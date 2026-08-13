# Exportação iCalendar (RFC 5545): os compromissos do projeto no calendário
# de quem toca a obra. Só marcos e prazos — tarefa de duas semanas vira um
# bloco inútil na agenda; ponto no tempo e compromisso, não.
#
# Sem dependência nova: o formato é texto, e o que ele exige de verdade
# (CRLF, dobra em 75 octetos, escape de TEXT, DTEND exclusivo) cabe aqui.

# TEXT do RFC 5545 §3.3.11: contrabarra, ponto-e-vírgula, vírgula e quebras
# de linha são escapados. A barra invertida vem primeiro; `replace` com
# vários pares faz UMA varredura, então não há reaplicação em cascata.
_ics_text(s::AbstractString) = replace(String(s),
    "\\" => "\\\\", ";" => "\\;", "," => "\\,",
    "\r\n" => "\\n", "\n" => "\\n", "\r" => "\\n")

# Dobra de linha (§3.1): nenhuma linha passa de 75 OCTETOS, e a continuação
# começa com um espaço — que conta no limite, daí o orçamento de 74 depois
# da primeira. A conta é em octetos, mas o corte anda de caractere em
# caractere: partir um UTF-8 no meio produziria lixo (nomes de tarefa vão
# até 2000 caracteres, então isto não é hipotético).
function _ics_fold(line::AbstractString)
    ncodeunits(line) <= 75 && return line
    io = IOBuffer()
    limit, used = 75, 0
    for c in line
        w = ncodeunits(c)
        if used + w > limit
            print(io, "\r\n ")
            limit, used = 74, 0
        end
        print(io, c)
        used += w
    end
    return String(take!(io))
end

_ics_date(d::Date) = Dates.format(d, "yyyymmdd")

function _ics_stamp(dt::DateTime)
    return string(Dates.format(dt, "yyyymmdd"), "T", Dates.format(dt, "HHMMSS"), "Z")
end

# SEQUENCE (§3.8.7.4) precisa CRESCER a cada alteração para o cliente
# aceitar o evento reimportado como atualização do mesmo UID, em vez de
# ignorá-lo. Minutos desde 2020 dão um inteiro monotônico e pequeno o
# bastante para qualquer cliente (~3,5 milhões hoje).
# (a subtração dá Millisecond; converter para Minute exigiria divisão exata
# e estoura no primeiro projeto salvo com segundos quebrados)
_ics_sequence(p::Project) =
    max(0, Dates.value(p.updated_at - DateTime(2020, 1, 1)) ÷ 60_000)

function _ics_event!(lines, p::Project, t::GanttTask, kind::Symbol, day::Date,
                     summary::AbstractString, desc::Vector{String}, seq::Int,
                     stamp::AbstractString)
    push!(lines, "BEGIN:VEVENT")
    # UID estável por (tarefa, tipo, projeto): reimportar atualiza o evento
    # em vez de criar um segundo
    push!(lines, "UID:$(t.id)-$(kind)@$(p.id).perth.jl")
    push!(lines, "DTSTAMP:$(stamp)")
    push!(lines, "SEQUENCE:$(seq)")
    push!(lines, "DTSTART;VALUE=DATE:$(_ics_date(day))")
    # DTEND de evento de dia inteiro é EXCLUSIVO: um dia só termina no dia
    # seguinte. Sem o +1 o evento some de vários clientes.
    push!(lines, "DTEND;VALUE=DATE:$(_ics_date(day + Dates.Day(1)))")
    push!(lines, "SUMMARY:$(_ics_text(summary))")
    isempty(desc) || push!(lines, "DESCRIPTION:$(_ics_text(join(desc, "\n")))")
    # marco/prazo não ocupam o dia de ninguém: não entram como "ocupado"
    push!(lines, "TRANSP:TRANSPARENT")
    push!(lines, "END:VEVENT")
    return lines
end

"""
    icalendar(p::Project) -> String
    icalendar(p::Project, path::AbstractString) -> String

The project's *commitments* as an iCalendar (`.ics`) document: one
all-day event per milestone and one per task [`deadline`](@ref
GanttTask), ready to import into any calendar app. Ordinary tasks are
left out on purpose — a two-week bar is noise in a calendar; a point in
time and a promise are not.

Milestone events are named after the task; deadline events are prefixed
with `Deadline:` and carry the planned finish (and how late it is) in
the description. Summary tasks are containers, not work, so they are
skipped. Events are `TRANSP:TRANSPARENT` — they do not mark the day
busy — and their UIDs are stable, so re-importing an updated file
updates the events instead of duplicating them.

With `path`, writes the document there and returns the path; otherwise
returns the document as a `String`.
"""
function icalendar(p::Project)
    stamp = _ics_stamp(Dates.now(Dates.UTC))
    seq = _ics_sequence(p)
    lines = String[
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Perth.jl//Perth $(pkgversion(@__MODULE__))//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:$(_ics_text(p.name))",
    ]
    for t in p.tasks
        _has_children(p, t.id) && continue        # resumo é contêiner
        if t.milestone
            desc = String[]
            isempty(strip(t.assignee)) || push!(desc, "Assignee: $(t.assignee)")
            isempty(strip(t.notes)) || push!(desc, t.notes)
            push!(desc, "Project: $(p.name)")
            _ics_event!(lines, p, t, :milestone, t.start, t.name, desc, seq, stamp)
        end
        if t.deadline !== nothing
            fin = end_date(p, t)
            late = Dates.value(fin - t.deadline)
            desc = String["Planned finish: $(fin)" *
                          (late > 0 ? " ($(late) day$(late == 1 ? "" : "s") late)" : "")]
            isempty(strip(t.assignee)) || push!(desc, "Assignee: $(t.assignee)")
            push!(desc, "Progress: $(t.progress)%")
            push!(desc, "Project: $(p.name)")
            _ics_event!(lines, p, t, :deadline, t.deadline,
                        "Deadline: $(t.name)", desc, seq, stamp)
        end
    end
    push!(lines, "END:VCALENDAR")
    # CRLF é obrigatório (§3.1), inclusive na última linha
    return join((_ics_fold(l) for l in lines), "\r\n") * "\r\n"
end

function icalendar(p::Project, path::AbstractString)
    write(path, icalendar(p))
    return String(path)
end
