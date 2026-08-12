# HTTP API

The Gantt server exposes a small REST API (all under `/api/`); the
frontend is just another client. `GET /api/rev` returns a monotonic
revision for cheap change polling; project CRUD lives under
`/api/projects`. Analytics endpoints: `/api/activity`,
`/api/projects/{id}/scurve`, `/api/projects/{id}/export.csv` and
`/api/projects/{id}/chart?fmt=png|pdf|svg` (needs a Makie backend).

With `Perth.run(share = true, key = "...")`, non-host machines must
append `?key=...` to API calls and the `/ws` presence socket.

`GET /api/share` reports the current sharing state — the URLs to hand
out, a QR matrix for the LAN link, and whether the caller is the host.
`POST /api/share` with `{"on": true|false}` flips it live; only the
machine running the server may call it (403 otherwise, 409 if the server
was started with an explicit `host`). While sharing is off, every other
route answers 403 to any machine but this one. The kanban server exposes
the same two endpoints on its own port.
