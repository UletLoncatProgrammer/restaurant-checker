# Restaurant Checker — v2 (Order → Kitchen → POS → Coordinator/Supervisor)

Read `ARCHITECTURE.md` first — it covers what this does and does not do, and the reasoning behind the local-network-first design. This README is just setup steps.

## What's in this release

- **Order Entry** (front-of-house tablet): pick a table, tap menu items, send to kitchen; hear/see when food is ready.
- **Kitchen Display** (screen in kitchen): replaces the paper ticket, updates live, rings on every new order.
- **POS** (waiters): bill a fully-served table, take cash/card/QRIS/other, print a receipt.
- **Coordinator Dashboard**: live open tables + outstanding counts, **all transactions** by day, activity feed, stock, and the **Excel report** (sales + stock in one file, daily or weekly).
- **Supervisor** role: the only role (besides Admin) that can **void** an item, an order, or a paid sale, with a mandatory reason.
- **Sound alerts**: kitchen on new order; waiters when their food is ready. Right-click / long-press menu is disabled app-wide.

Not included yet: ingredient-level inventory, purchasing, tax filing, HR. (Payments are *recorded*, not processed through a card/QRIS gateway.) See the roadmap table in `ARCHITECTURE.md`.

## Testing on your actual tablet (same wifi as your computer)

This is the fastest way to see it working on real hardware — no hosting, no Docker, just your computer and your tablet on the same wifi network.

1. **Find your computer's local IP address.** Windows: open Command Prompt, run `ipconfig`, look for "IPv4 Address" under your wifi adapter (something like `192.168.1.23`).
2. **Backend `.env`**: set `CORS_ORIGIN=*` for this test (tightened later for real deployment — see ARCHITECTURE.md).
3. **Frontend `.env`**: set `VITE_API_URL=http://<your-computer's-IP>:4000` — not `localhost`, because "localhost" on the tablet means the tablet itself, not your computer.
4. Run both servers as in Quick Start below (`npm run dev` in each folder — the frontend's `--host` flag is already set, which is what lets other devices on the network reach it).
5. **Windows Firewall**: the first time each server starts, Windows will likely prompt to allow it on private networks — click Allow. If the tablet still can't connect, check Windows Defender Firewall settings for Node.js and allow it on "Private" networks.
6. On the tablet's browser, go to `http://<your-computer's-IP>:5173`. You should see the login screen.
7. Try it as two different roles at once: sign in as one seeded account on the tablet, and a different account on your computer's browser at the same URL — actions on one show up live on the other, since both are talking to the same backend.

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
npm run migrate             # applies sql/schema.sql — plain SQL, no ORM binary download needed
npm run seed                # creates sample org, 2 locations, menu, tables, staff logins
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

There is no self-service sign-up: a company's ADMIN creates staff accounts (Admin screen, or `npm run create-user`). Each new account gets a temporary password and must choose its own at first sign-in.

For local development, `npm run seed` creates sample accounts (development only; the seed refuses to run in production) (password for all: `password123`):

| Location | Role | Email |
|---|---|---|
| Downtown Branch | Front-of-house | foh@downtown.example |
| Downtown Branch | Kitchen | kitchen@downtown.example |
| Downtown Branch | Coordinator | coordinator@downtown.example |
| Downtown Branch | Supervisor | supervisor@downtown.example |
| Uptown Branch | Front-of-house | foh@uptown.example |
| Uptown Branch | Kitchen | kitchen@uptown.example |
| Uptown Branch | Coordinator | coordinator@uptown.example |
| Uptown Branch | Supervisor | supervisor@uptown.example |

**Upgrading an existing database** (you already ran v1)? Don't re-seed. Run `npm install` then `npm run migrate` in `backend/` (safe to repeat), then create a supervisor:

```bash
npm run create-user -- --email sup@yourplace.com --name "Dewi" --role SUPERVISOR --location "Downtown Branch"
```

Leave out `--password` and a random one is generated and printed once. The same command creates COORDINATOR/ADMIN accounts.

Open the app on two browser tabs (or two devices) — log in as `foh@downtown.example` on one, `kitchen@downtown.example` on the other. Send an order from the FOH screen and watch it appear instantly on the Kitchen Display.

**Delete or change these accounts before any real deployment** — they're seeded for demo purposes with a shared known password.

## Tablet setup for alerts (read this — sound is the part most likely to disappoint)

A web page cannot make noise while the tablet is asleep or the browser is in the background. For the alerts to be reliable:

1. **iPad:** Settings → Display & Brightness → Auto-Lock → **Never** (kitchen and waiter tablets), keep them charging. Optionally use Guided Access to pin Safari to the app.
2. Turn the volume up. The sounds use a normal audio player, which on iPad should play even with the silent switch on — but **I could not test that on a real iPad**; check it on yours (tap "Sound: ON" in the top bar to hear a test chime).
3. After any page reload, tap anywhere once (a red/amber bar reminds you) — browsers forbid sound until someone touches the page.
4. The coloured banner on screen is the backup when sound isn't heard.

## Excel report

Dashboard → **Report** tab (Coordinator/Admin) → Daily or Weekly → Download Excel. Or directly: `GET /reports/export?period=day|week&date=YYYY-MM-DD` with a bearer token. Sheets: Summary, Sales by day, Sales by item, Transactions, Stock, Voids. Stock only covers items with stock tracking on: add `"trackStock": true, "openingStock": 40` to an item in your menu JSON and re-run `node src/import-menu.js menus/<file>.json` (opening stock is only written the first time, so re-importing never resets real counts). Receive deliveries / correct counts in the dashboard **Stock** tab.

## Tests

```bash
# backend (needs a Postgres where creating throwaway data is OK)
cd backend && TEST_DATABASE_URL=postgresql://restaurant:restaurant@localhost:5432/restaurant_checker npm test
# frontend
cd frontend && npm test
```

Backend tests cover the order → kitchen → deliver → pay flow with exact money math, double-pay races, voids and restock rules, permissions per role, tenant isolation, Excel totals reconciling to payments, timezone/week boundaries, socket security, and upgrading a v1 database. Frontend tests cover the alerts (who hears what), POS, dashboard permissions, and right-click blocking.

## Deploying for customers (commercial)

Each customer company gets its **own stack** (own database, secrets and address, e.g. `https://acme.yourdomain.com`) on your VPS, behind one HTTPS front door. The same address also serves the browser version; the Android and Windows apps ask staff for the company code once and then talk to that address.

Everything is in `deploy/`: start with **`deploy/README.md`** (VPS setup, adding a company, backups, updates, app build notes, launch checklist). The security/readiness review is in **`AUDIT.md`**.

Version 1 is **cloud only**: if a restaurant's internet goes down, taking orders stops until it returns. Offline mode and an on-site server option are not built (see `AUDIT.md`).

`docker-compose.yml` in the project root is for development on your own computer only.

## Version control (GitHub)

A local git repo with an initial commit is already set up in this folder. To push it:

1. Create an empty repo on GitHub (github.com → New repository — don't initialize it with a README/license, this folder already has one).
2. From this folder: `git remote add origin <the repo URL> && git branch -M main && git push -u origin main`.
3. `.github/workflows/ci.yml` is already committed — GitHub Actions will pick it up automatically on the first push and run a build/smoke-test on every push and PR (spins up Postgres, applies the schema, seeds data, hits the API, builds the frontend).
4. Optional: `scripts/create-roadmap-issues.sh` turns the phase 2–5 roadmap into GitHub issues/milestones. Requires the GitHub CLI (`gh auth login` first), and only needs to run once.

**One caution:** this project folder is inside OneDrive. Git and cloud-sync tools (OneDrive, Dropbox, etc.) don't always get along — OneDrive can interfere with git's file locking mid-operation, which is a known source of a corrupted `.git` folder. It worked fine for the initial commit, but if you hit strange git errors later, the fix is usually to move the repo to a non-synced local folder (e.g. `C:\dev\restaurant-checker`) and treat OneDrive purely as a backup of the working files, not as the git working directory.
