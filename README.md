# Restaurant Checker — v1 (Order → Kitchen → Coordinator)

Read `ARCHITECTURE.md` first — it covers what this does and does not do, and the reasoning behind the local-network-first design. This README is just setup steps.

## What's in this release

- **Order Entry** (front-of-house tablet): pick a table, tap menu items, send to kitchen.
- **Kitchen Display** (screen in kitchen): replaces the paper ticket, updates live, kitchen staff advance item status.
- **Coordinator Dashboard**: every open table's status + live "ordered vs. delivered" count per menu item.

Not included yet: inventory, purchasing, finance/tax, HR. See the roadmap table in `ARCHITECTURE.md`.

## Quick start (local development, one machine)

Requires Node.js 20+ and either a local PostgreSQL install or Docker.

### 1. Database

Easiest path — start Postgres with Docker:

```bash
docker run -d --name restaurant-db -e POSTGRES_USER=restaurant -e POSTGRES_PASSWORD=restaurant -e POSTGRES_DB=restaurant_checker -p 5432:5432 postgres:16-alpine
```

### 2. Backend

```bash
cd backend
cp .env.example .env      # then edit JWT_SECRET to something random
npm install
npx prisma migrate dev --name init
npm run seed               # creates sample org, 2 locations, menu, tables, staff logins
npm run dev                 # starts on http://localhost:4000
```

### 3. Frontend

In a second terminal:

```bash
cd frontend
cp .env.example .env
npm install
npm run dev -- --host       # starts on http://localhost:5173, reachable from other devices on the LAN
```

### 4. Log in

Sample accounts seeded (password for all: `password123`):

| Location | Role | Email |
|---|---|---|
| Downtown Branch | Front-of-house | foh@downtown.example |
| Downtown Branch | Kitchen | kitchen@downtown.example |
| Downtown Branch | Coordinator | coordinator@downtown.example |
| Uptown Branch | Front-of-house | foh@uptown.example |
| Uptown Branch | Kitchen | kitchen@uptown.example |
| Uptown Branch | Coordinator | coordinator@uptown.example |

Open the app on two browser tabs (or two devices) — log in as `foh@downtown.example` on one, `kitchen@downtown.example` on the other. Send an order from the FOH screen and watch it appear instantly on the Kitchen Display.

**Delete or change these accounts before any real deployment** — they're seeded for demo purposes with a shared known password.

## Deploying to an actual restaurant (recommended: local server on-site)

1. Get a small always-on machine on the restaurant's LAN (a mini PC or NUC; a Raspberry Pi 4/5 also works for low order volume).
2. Install Docker on it.
3. Copy this whole project to that machine.
4. Edit `docker-compose.yml`: change `JWT_SECRET` to a real random value, and set `CORS_ORIGIN` to the tablets' actual origin once you know it (or leave `*` for LAN-only use where this isn't public-facing).
5. `docker compose up -d --build`
6. Build the frontend for production (`cd frontend && npm run build`) and serve the `dist/` folder from any static file server on the same machine (nginx, Caddy, or even `npx serve dist`), or point tablets' browsers at the Vite dev server's LAN IP for a quick pilot.
7. On each tablet, open the machine's local IP in the browser (e.g. `http://192.168.1.50:5173`) and add it to the home screen so it launches like an app.
8. **Pilot this on one shift with a supervisor present before relying on it for a real service night.** See "Known limitations" in `ARCHITECTURE.md`.

## Multi-location note

Each location runs its own local server today (this is the local-network-first design — a location's order flow shouldn't depend on another location's uptime or on the internet). If you want a central view across locations (e.g. an owner dashboard showing all branches), that's a phase-2 addition: either a lightweight sync job pushing closed-order summaries to a central cloud database, or a cloud-hosted reporting layer that reads from each location's Postgres on a schedule. Not built in this release — flag it if it's a near-term priority, since it changes how `docker-compose.yml` and networking should be set up now versus later.
