# Deploying Smart Allocate

Everything runs as containers from `docker-compose.yml`:

```
                 internet
                    │  :80 (:443 via load balancer or certbot)
              ┌─────▼──────┐
              │  gateway   │  nginx: React build + routes /api/* to services
              └─────┬──────┘  blocks /api/*/internal/* from outside
   ┌────────────┬───┴────────┬──────────────┐
 auth:8000   ngo:8001     res:8002      alloc:8003      ← private network only
 auth-worker ngo-worker                                    (BullMQ jobs)
   └────────────┴─────── redis:6379 ───────┘
                    MongoDB Atlas (external)
```

Only the gateway publishes a port. Services, workers and Redis are not reachable from outside.

---

## 1. Run the production stack on your own machine

Needs Docker Desktop (or Docker Engine + compose plugin).

```bash
# once: each service needs a .env (your existing dev .env files work as-is)
cp auth_svc/.env.example auth_svc/.env            # skip if you already have one
cp ngo_svc/.env.example ngo_svc/.env
cp res_manage_svc/.env.example res_manage_svc/.env
cp allocation_svc/.env.example allocation_svc/.env

docker compose up -d --build
```

Open http://localhost (set `HTTP_PORT=8080` in a root `.env` file, or in your shell, if port 80 is taken).

Useful commands:

```bash
docker compose ps                 # all should be "healthy"
docker compose logs -f auth       # follow one service
docker compose restart ngo
docker compose down               # stop (Redis data is kept in a volume)
```

Notes:
- `NODE_ENV=production` makes the refresh cookie `Secure`. Browsers allow that on `http://localhost`,
  but on a real domain **the site must be served over HTTPS** or sessions won't survive a page reload.
- Redis/service addresses in your `.env` files are overridden by compose, so the same `.env` works locally and in Docker.

---

## 2. Before going live (one-time checklist)

- [ ] **New secrets.** Generate fresh values and put the same ones in all four `.env` files:
      `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `INTERNAL_API_KEY` (`openssl rand -hex 64`).
- [ ] **Rotate credentials that lived in plain files during development:** MongoDB Atlas user password,
      Cloudinary API secret, SMTP login. Use a real SMTP provider (e.g. AWS SES) instead of the Mailtrap sandbox.
- [ ] **Atlas network access:** allow the server's public IP (Elastic IP) instead of `0.0.0.0/0`.
- [ ] **Backfill older users** once against the production DB (users promoted before the ngoId fix):
      `python -I scripts/backfill_ngo_membership.py` (dry run), then add `--apply`.
- [ ] **Super admin:** create a normal account, then set `role: "SUPER_ADMIN"` on it in Atlas.
- [ ] **Domain** pointing at the server, and HTTPS (see 3.4).

---

## 3. AWS: simplest setup (one EC2 instance)

Good for a first launch; the same files move to ECS later (section 5).

### 3.1 Create the instance
- EC2 → Launch instance: **Ubuntu 24.04**, `t3.small` (2 GB RAM) or bigger, 20 GB disk.
- Security group inbound: **22** (your IP only), **80** and **443** (anywhere). Nothing else.
- Allocate an **Elastic IP** and attach it (stable IP for DNS and the Atlas allowlist).

### 3.2 Install Docker
```bash
ssh ubuntu@<elastic-ip>
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && exit     # log in again afterwards
```

### 3.3 Get the code and start it
```bash
git clone https://github.com/<you>/Smart_Resource_Allocation.git
cd Smart_Resource_Allocation
for s in auth_svc ngo_svc res_manage_svc allocation_svc; do cp $s/.env.example $s/.env; done
nano auth_svc/.env    # fill in real values (repeat for each service)
docker compose up -d --build
docker compose ps
```

### 3.4 HTTPS — pick one
**A. Application Load Balancer + ACM (recommended on AWS)**
- Request a free certificate in **ACM** for your domain.
- Create an **ALB** (HTTPS :443 with the certificate, HTTP :80 → redirect to 443), target group = the EC2 instance on port 80, health check path `/healthz`.
- Point your domain (Route 53 alias) at the ALB. Restrict the instance's port 80 to the ALB's security group.
- Set `TRUST_PROXY_HOPS=2` (ALB + nginx) in a root `.env` file next to `docker-compose.yml`, then `docker compose up -d`.

**B. Certbot on the instance (cheapest, no load balancer)**
- Point the domain's A record at the Elastic IP.
- Add a TLS server block to `frontend/nginx.conf` and mount Let's Encrypt certificates into the gateway
  (or put Caddy in front, which handles certificates automatically). Keep `TRUST_PROXY_HOPS=1`.

### 3.5 Updating
```bash
cd Smart_Resource_Allocation
git pull
docker compose up -d --build      # rebuilds changed images, restarts only what changed
docker image prune -f
```

### 3.6 Logs, restarts, backups
- Containers restart automatically (`restart: unless-stopped`), including after a reboot.
- Logs: `docker compose logs -f <service>` (rotated at 10 MB × 3 per container).
- Data lives in **Atlas** (turn on its backups). Redis only holds caches and job queues.

---

## 4. Environment variables

Each service reads `<service>/.env` (template: `<service>/.env.example`). Compose additionally sets:

| Variable | Value in compose | Why |
|---|---|---|
| `NODE_ENV` | `production` (override with root `.env`) | secure cookies, stricter rate limit |
| `REDIS_HOST` / `REDIS_URL` | `redis` / `redis://redis:6379` | in-network Redis |
| `AUTH_SERVICE_URL`, `NGO_SERVICE_URL`, `RES_SERVICE_URL`, `RES_MANAGE_SERVICE_URL` | `http://auth:8000` … | service-to-service calls |
| `TRUST_PROXY_HOPS` | `1` (2 behind an ALB) | real client IPs for rate limiting |
| `PORT` | per service | |

Root `.env` (optional, next to `docker-compose.yml`): `HTTP_PORT`, `NODE_ENV`, `TRUST_PROXY_HOPS`.

`JWT_ACCESS_SECRET` and `INTERNAL_API_KEY` must be identical across all services.

---

## 5. Later: AWS ECS (Fargate)

When one server is no longer enough, the same images move over:

| Compose | ECS / AWS |
|---|---|
| `build:` | images pushed to **ECR** (e.g. by GitHub Actions on merge to `main`) |
| each service | one ECS **service** (Fargate task); workers as services without a load balancer |
| `redis` | **ElastiCache** for Redis |
| `gateway` nginx routing | **ALB** path rules (`/api/auth/*` → auth, …) plus the gateway (or S3 + CloudFront) for the React app |
| `.env` files | **Secrets Manager / SSM Parameter Store** injected as task env vars |
| compose network | services in private subnets; internal calls via **Service Connect** / Cloud Map names |

If the ALB routes API paths directly, add rules that **deny `/api/*/internal/*` and `/api/internal/*`** —
in this setup nginx is what blocks them.
