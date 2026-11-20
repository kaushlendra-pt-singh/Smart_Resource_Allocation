# Frontend

React + Vite (no Next). Plain CSS in `src/styles.css`, no UI library.

## Run

Start the four backend services first (auth 8000, ngo 8001, res_manage 8002, allocation 8003), then:

```bash
cd frontend
bun install
bun run dev
```

Open http://localhost:5173.

The Vite dev server proxies `/api/auth`, `/api/ngo`, `/api/resources`, `/api/inventory` and `/allocation`
to the services, so the browser only talks to one origin and the httpOnly refresh cookie works without CORS.
To point at other ports set `AUTH_URL`, `NGO_URL`, `RES_URL`, `ALLOC_URL` before `bun run dev`.

For production, serve `dist/` (from `bun run build`) behind a reverse proxy (nginx etc.) with the same path rules.

## Layout

- `src/api.js` – fetch wrapper (token in memory, auto refresh on 401), small caches
- `src/auth.jsx` – session, memberships, "current NGO" and permission helpers
- `src/components/` – layout, shared UI bits, request line actions
- `src/pages/` – one file per screen

Roles and NGO memberships live in the access token. After anything that changes them (NGO approved,
added to a team, ownership moved) the app calls `/refresh-token` to get a fresh one.
