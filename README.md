# Smart Allocate

A platform that helps NGOs share relief stock during disasters. An NGO asks for what it needs at a location,
and the system finds the nearest warehouses that have it — across every NGO on the platform — and routes the
request to the NGOs that own that stock for approval.

**Live:** https://smart-allocate.duckdns.org

---

## Features

- **NGO onboarding** — NGOs register with their documents; a super admin verifies them before they go live.
- **Teams and roles** — the person who registers an NGO owns it. Owners add admins and workers; any admin of an
  NGO can manage its stock and approvals. One person can belong to several NGOs.
- **Warehouses and stock** — each NGO tracks stock per warehouse, can send stock out, and can *protect* part of it
  so other NGOs can't request it.
- **Allocation engine** — a request is matched to the nearest warehouses (by distance), optionally split across
  several, or all-or-nothing from a single warehouse.
- **Approval flow** — stock from your own warehouses is held immediately; stock from another NGO waits for that
  NGO to approve, then their team marks it dispatched. Holds are atomic, so stock is never double-booked.
- **Audit ledger** — every restock, hold, release and dispatch is recorded.
- **Background jobs** — bulk NGO verification/deletion and bulk user deletion run in workers.

## Architecture

```
                 browser
                    │ https
              ┌─────▼──────┐
              │   Caddy    │  automatic HTTPS (production)
              └─────┬──────┘
              ┌─────▼──────┐
              │  gateway   │  nginx: React app + routes /api/* (internal routes blocked)
              └─────┬──────┘
   ┌────────────┬───┴────────┬──────────────┐
 auth_svc     ngo_svc   res_manage_svc  allocation_svc
  :8000        :8001        :8002           :8003
 + worker     + worker
   └────────────┴──── Redis (cache, geo, BullMQ) ────┘
                     MongoDB Atlas
```

| Service | Stack | Responsibility |
|---|---|---|
| `auth_svc` | Bun, Express, TypeScript | Accounts, JWT access/refresh tokens, roles and NGO memberships |
| `ngo_svc` | Bun, Express, TypeScript | NGO registration, verification, teams, ownership |
| `res_manage_svc` | Bun, Express, TypeScript | Resource catalogue, warehouse inventory, holds/dispatch, ledger (MongoDB transactions) |
| `allocation_svc` | Python, FastAPI | Nearest-warehouse allocation, request lines and the approval workflow |
| `frontend` | React, Vite | Web app (plain CSS, no UI kit), served by nginx in production |

Services trust each other through a shared internal API key; per-NGO permissions travel in the user's JWT.

## Getting started (local development)

**Prerequisites:** [Bun](https://bun.sh), Python 3.12+, Redis on `localhost:6379` (e.g. `docker run -p 6379:6379 redis:7`),
and a MongoDB replica set (MongoDB Atlas works out of the box — transactions need a replica set).

1. Create a `.env` in each service from its template and fill in the values:
   ```bash
   cp auth_svc/.env.example auth_svc/.env
   cp ngo_svc/.env.example ngo_svc/.env
   cp res_manage_svc/.env.example res_manage_svc/.env
   cp allocation_svc/.env.example allocation_svc/.env
   ```
   `JWT_ACCESS_SECRET` and `INTERNAL_API_KEY` must be identical in all four.

2. Start the services (one terminal each):
   ```bash
   cd auth_svc && bun install && bun run dev
   cd ngo_svc && bun install && bun run dev
   cd res_manage_svc && bun install && bun run dev
   cd allocation_svc && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt && .venv/Scripts/python index.py
   ```
   Optional workers for bulk jobs: `bun run dev:worker` in `auth_svc` and `ngo_svc`.
   (On macOS/Linux use `.venv/bin/` instead of `.venv/Scripts/`.)

3. Start the frontend:
   ```bash
   cd frontend && bun install && bun run dev
   ```
   Open http://localhost:5173. The Vite dev server proxies API calls to the services.

4. **Super admin:** register a normal account, then set its `role` to `SUPER_ADMIN` in MongoDB.

## Running with Docker

The whole stack (gateway, four services, two workers, Redis) runs with one command:

```bash
docker compose up -d --build
```

Open http://localhost. See [DEPLOY.md](DEPLOY.md) for production settings, HTTPS with Caddy and AWS EC2 deployment.

## Project structure

```
auth_svc/          authentication service
ngo_svc/           NGO service
res_manage_svc/    resource & inventory service
allocation_svc/    allocation engine (FastAPI)
frontend/          React app + nginx gateway config
scripts/           one-off maintenance scripts
docker-compose.yml           full stack
docker-compose.https.yml     adds Caddy for HTTPS on a server
DEPLOY.md                    deployment guide
```

## Author

Kaushlendra Pratap Singh — [GitHub](https://github.com/kaushlendra-pt-singh)
