# Extensão BusinessDays do Perth: durações passam a ser dias ÚTEIS.
# Um projeto com calendar = "Brazil" pula fins de semana e feriados
# nacionais em todo o motor: schedule!, caminho crítico, folga,
# project_finish e end_date(p, t). Carregada automaticamente com
# `using BusinessDays` no ambiente (weakdep).

module PerthBusinessDaysExt

using Perth
using BusinessDays
using Dates

struct BDay <: Perth.AbstractCalendar
    cal::BusinessDays.HolidayCalendar
end

# Cache de calendários já inicializados (initcache dá consultas O(1))
const _CACHE = Dict{String,BDay}()

function Perth._business_calendar(name::String)
    get!(_CACHE, name) do
        cal = try
            BusinessDays.symtocalendar(Symbol(name))
        catch
            error("Perth: unknown BusinessDays calendar $(repr(name)). " *
                  "Try \"Brazil\", \"BRSettlement\", \"USSettlement\" or \"WeekendsOnly\".")
        end
        BusinessDays.initcache(cal)
        BDay(cal)
    end
end

Perth._snap(c::BDay, d::Date) = BusinessDays.tobday(c.cal, d; forward = true)

Perth._end_of(c::BDay, s::Date, dur::Int) =
    BusinessDays.advancebdays(c.cal, Perth._snap(c, s), dur - 1)

Perth._start_of(c::BDay, e::Date, dur::Int) =
    BusinessDays.advancebdays(c.cal, BusinessDays.tobday(c.cal, e; forward = false),
                              -(dur - 1))

Perth._day_after(c::BDay, d::Date) =
    BusinessDays.tobday(c.cal, d + Dates.Day(1); forward = true)

Perth._day_before(c::BDay, d::Date) =
    BusinessDays.tobday(c.cal, d - Dates.Day(1); forward = false)

# Folga medida em dias úteis
Perth._gap(c::BDay, a::Date, b::Date) = BusinessDays.bdayscount(c.cal, a, b)

end # module
