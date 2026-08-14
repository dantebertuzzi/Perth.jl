# HTTP API

The Gantt server exposes a small REST API (all under `/api/`); the
frontend is just another client. `GET /api/rev` returns a monotonic
revision for cheap change polling; project CRUD lives under
`/api/projects`. Analytics endpoints: `/api/activity`,
`/api/projects/{id}/scurve`, `/api/projects/{id}/workload`,
`/api/projects/{id}/export.csv`, `/api/projects/{id}/export.ics`
(milestones and deadlines as an iCalendar document — see
[`icalendar`](@ref)) and `/api/projects/{id}/chart?fmt=png|pdf|svg`
(needs a Makie backend).

`/api/projects/{id}/workload` is [`workload`](@ref) shaped for drawing:
a contiguous day window (`start`, `days`) and, per person, a dense
`load` vector with the number of simultaneous tasks on each day of the
window (plus `effort`, `peak`, `busy_days`, `over_days` and the tasks
themselves). Leaf tasks with no assignee come back under the `""` key.
It answers 409 when the project uses a business-day calendar and
`BusinessDays` is not loaded on the server, like `/cpm`.

With `Perth.run(share = true, key = "...")`, non-host machines must
append `?key=...` to API calls, to `/background` and to the `/ws`
presence socket. The page itself (HTML, JS, CSS) is served without the
key — it is an empty shell until the API answers, and it is what asks
for the key when the link came without one.

`GET /api/share` reports the current sharing state — the URLs to hand
out, a QR matrix for the LAN link, and whether the caller is the host.
`POST /api/share` with `{"on": true|false}` flips it live; only the
machine running the server may call it (403 otherwise, 409 if the server
was started with an explicit `host`). `POST /api/key` with
`{"key": "…"}` sets the access key the same way (`""` drops it) and
answers with the `/api/share` payload, since the links carry the key;
also host-only, 409 with the server down. While sharing is off, every other
route answers 403 to any machine but this one. The kanban server exposes
the same two endpoints on its own port.
