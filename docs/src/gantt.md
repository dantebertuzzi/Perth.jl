# Gantt

```@docs
GanttTask
Project
Person
Perth.run
Perth.stop
Perth.check_update
Perth.share!
Perth.key!
Perth.view_key!
Perth.background!
Perth.background
Perth.backgrounds
Perth.background_clear!
create_project
add_task!
update_task!
schedule!
level!
critical_path
slack
deadline_slip
set_baseline!
clear_baseline!
has_baseline
slippage
set_estimate!
clear_estimate!
has_estimate
expected_duration
pert
pert!
pert_finish
finish_probability
pert_date
pert_simulate
set_calendar!
set_parent!
move_task!
ordered_tasks
people
person
people!
add_person!
remove_person!
Band
bands
bands!
add_band!
remove_band!
Marker
markers
markers!
add_marker!
remove_marker!
MonthMark
month_marks
month_marks!
add_month_mark!
remove_month_mark!
tasktable
add_tasks!
icalendar
overallocations
workload
people_stats
team_stats
ganttplot
save_chart
```

## Primavera P6 through MK Perth

[MK Perth](https://github.com/morrisonkuhlsen/mkperth) is Perth's sibling in
Rust: it reads and writes Primavera P6 XML and schedules with P6's options.
Perth reaches it through its command line, with no extra dependency: install
`mkperth-cli` on `PATH` (or point `ENV["MKPERTH_CLI"]` at it) and these work;
without it, they say so.

```@docs
mkperth_cli
import_p6xml
export_p6xml
schedule_p6
```
