# HTTP API

The Gantt server exposes a small REST API (all under `/api/`); the
frontend is just another client. `GET /api/rev` returns a monotonic
revision for cheap change polling; project CRUD lives under
`/api/projects`. Analytics endpoints: `/api/activity`,
`/api/projects/{id}/scurve`, `/api/projects/{id}/export.csv` and
`/api/projects/{id}/chart?fmt=png|pdf|svg` (needs a Makie backend).

With `Perth.run(share = true, key = "...")`, non-host machines must
append `?key=...` to API calls and the `/ws` presence socket.
