# Restaurant Checker — Code Guide

Written for the owner of this code, so that if something happens (a developer leaves, a laptop dies,
you want to change something yourself) you can understand how the system works and where to look.

How to read it:

1. **Part 1** — what languages and tools are used, and how the pieces connect.
2. **Part 2** — a map of every folder and file, one line each.
3. **Part 3** — the life of one order, from the waiter's tap to the receipt.
4. **Part 4** — the core code explained **line by line**: the database tables, signing in,
   permissions, taking an order, the kitchen, payment, and live updates.
5. **Part 5** — how to make common changes, run the tests, and where data is kept.

The explanations match the code as of **15 October 2026** (after Phases 1–3). When code changes,
the quoted lines here may drift; the file names and the ideas stay the same. The code files
themselves also carry comments (lines starting with `//` or `--`) that explain the *why*.

**The real backup is the code itself.** Keep it in GitHub (`git add -A`, `git commit`, `git push`).
This guide helps you read it; it does not replace it.

---

## Part 1 — Languages, tools and how the pieces connect

### Two separate products

| | Live demo (online) | Restaurant Checker (the real app, offline-capable) |
|---|---|---|
| Where | `Website File/application-example-group/index.html` | this folder (`Restaurant Checker`) |
| Screens | HTML + CSS + JavaScript in **one file** | **React** (JavaScript, `.jsx` files) + CSS, built with **Vite** |
| Server | none of its own — talks to **Supabase** (a hosted database service) | **Node.js** with **Express** (web server) and **Socket.IO** (live updates) |
| Database | PostgreSQL on Supabase; logic in **SQL / PL/pgSQL** functions (`demo-schema.sql`) | **PostgreSQL**, tables in `backend/sql/schema.sql` |
| Runs | only with internet | on a laptop / mini PC in the restaurant (no internet needed) or on your VPS |

The demo was the prototype. The real app is what you sell. They share ideas, not code.

### The words used in this guide

- **JavaScript** — the programming language of both the screens and the server.
- **Node.js** — runs JavaScript outside a browser; here it runs the server.
- **Express** — a small library that turns "a request for `/orders`" into "run this function".
- **React** — a library for building screens out of components (`OrderEntry`, `KitchenDisplay`...).
  A component is a JavaScript function that returns what to show.
- **JSX** — the HTML-like syntax inside React files (`<button>Pay</button>`).
- **Vite** — the tool that turns the React files into the small files a browser downloads (`npm run build`).
- **PostgreSQL** — the database. **SQL** is its language. **PL/pgSQL** is its built-in programming language
  (used for a few safety rules inside the database).
- **Socket.IO** — keeps a live connection open between each screen and the server, so the kitchen sees a
  new order instantly without refreshing.
- **JWT (token)** — after signing in, the server gives the screen a signed "ticket". Every request carries it.
- **Container** (Podman/Docker) — a sealed box that holds one program and everything it needs. The app,
  the database and the HTTPS front each run in their own container.
- **Caddy** — the HTTPS front door. It holds the certificate and passes requests to the app.

### How a request travels

```
 Tablet / PC browser
        │  https://192.168.x.x  (or https://localhost on the server itself)
        ▼
 ┌──────────────┐   Caddy: HTTPS, its own certificate authority (works offline)
 │    Caddy     │
 └──────┬───────┘
        │  http://app:4000  (inside the server only)
        ▼
 ┌──────────────┐   Node.js + Express: checks who you are and what you may do,
 │     App      │   reads/writes the database, sends live updates (Socket.IO).
 │  (backend)   │   Also serves the screens (the built React files).
 └──────┬───────┘
        │  SQL
        ▼
 ┌──────────────┐   PostgreSQL: all data. Its own rules refuse impossible data
 │  PostgreSQL  │   (wrong branch, negative quantities, two open bills on one table).
 └──────────────┘
```

Every request from a screen is checked **by the server** (who is it, are they still allowed, may their role do
this). Hiding a button on screen is only for convenience; the server is the real guard.

---

## Part 2 — Map of every folder and file

### Top level

| Path | What it is |
|---|---|
| `README.md` | How to run it for development; overview. |
| `HOW_IT_WORKS.md` | Plain-language description of the screens, roles and rules. |
| `ARCHITECTURE.md` | Big design decisions and known limits. |
| `AUDIT.md` | Security review: what was found, what was fixed, what risks remain. |
| `CODE_GUIDE.md` | This file. |
| `onsite/` | Offline version: installs on a laptop (Windows + Podman) or a mini PC (Ubuntu). |
| `deploy/` | Cloud version: one stack per company on your VPS. |
| `backend/` | The server (Node.js). |
| `frontend/` | The screens (React). |
| `offline-architecture.png/.svg` | Diagram of the offline setup. |
| `docker-compose.yml` | For development on your own computer only. |
| `.gitattributes`, `.gitignore`, `.dockerignore` | Housekeeping for Git and container builds. |

### `backend/` — the server

| File | What it does |
|---|---|
| `sql/schema.sql` | Every database table and rule. Runs at every start; safe to run again (only adds what is missing). Sections v1…v7 show how it grew. |
| `src/index.js` | Starts the server: web + live updates, and a clean shutdown. |
| `src/app.js` | Builds the web server: security headers, which addresses may call it, the list of routes, serving the screens, error handling. |
| `src/config.js` | Reads settings (secrets, addresses) and **refuses to start** in production with weak or default values. |
| `src/db.js` | Connection to PostgreSQL; `query()` for one statement, `withTransaction()` for "all or nothing". |
| `src/socket.js` | Live updates: who may connect, which "rooms" each screen joins, how events are sent. |
| `src/migrate.js` | Applies `schema.sql` (run before the server starts). |
| `src/provision.js` | Creates a company's first branch, tables and first Admin (with a temporary password). |
| `src/create-user.js` | Command-line way to add a staff account (built-in roles). |
| `src/import-menu.js` | Loads a whole menu from a JSON file (`menus/application-example.json`). |
| `src/seed.js` | Fake demo data for development only (refuses to run in production). |
| `src/middleware/auth.js` | **Sign-in check on every request**: is the token real, is the person still active, what may their role do. |
| `src/lib/permissions.js` | **The list of permissions** and the five built-in roles; reading a company's own roles. |
| `src/lib/orderShape.js` | Turns database rows into the "order" object the screens use; hides phone numbers from kitchen-only screens. |
| `src/lib/billing.js` | **The bill maths**: food − member discount + service charge + tax, rounded to whole rupiah; phone-number matching for members. |
| `src/lib/stock.js` | Stock counting (a ledger of +/− movements), live stock updates. |
| `src/lib/events.js` | The activity log ("Table 4: new order — 2x Nasi Goreng") and sending it to dashboards. |
| `src/lib/period.js` | Works out "this day" / "this week" in the restaurant's own time zone. |
| `src/lib/reportData.js`, `reportWorkbook.js` | Collect the numbers for the Excel report, and write the Excel file. |
| `src/lib/password.js` | Password rules and temporary-password generation. |
| `src/lib/rateLimit.js` | Slows down someone guessing passwords or flooding the server. |
| `src/lib/audit.js` | Records sign-ins, failures, password changes, staff and role changes. |
| `src/lib/http.js`, `asyncRouter.js` | Small helpers: a typed error (`HttpError(409, "...")`), and making sure errors in async code are caught. |
| `src/routes/auth.js` | Sign in, "who am I", change password. |
| `src/routes/users.js` | Staff accounts and **roles** (Admin only). |
| `src/routes/menu.js` | Menu categories and dishes. |
| `src/routes/locations.js` | Tables and restaurant settings (kitchen mode; tax name/rate, service charge — Admin only). |
| `src/routes/orders.js` | **Orders**: open orders, send dishes, kitchen status changes, voids, kitchen history. |
| `src/routes/payments.js` | **Bill and payment** (with member discount, service charge, tax), receipts. |
| `src/routes/members.js` | The member list (discounts); the cashier's "find member by phone". |
| `src/routes/transactions.js` | Day's payments and the activity feed for the dashboard. |
| `src/routes/stock.js` | Stock levels, receiving deliveries, adjustments. |
| `src/routes/reports.js` | The Excel download. |
| `src/routes/public.js` | One public endpoint that only says "this is a Restaurant Checker server, name X". |
| `test/*.test.js` | Automatic tests against a real PostgreSQL (`flow`, `security`, `migrate`, `phase1`–`phase3`, `billing`). |

### `frontend/src/` — the screens

| File | What it does |
|---|---|
| `main.jsx` | Starts the app in the browser. |
| `App.jsx` | The list of pages (routes) and **who may open which page**; the landing page per role. |
| `index.css` | All styling (colours, sizes, layout). |
| `context/AuthContext.jsx` | Who is signed in; sign in/out; keeps the role's permissions up to date. |
| `lib/api.js` | Every call to the server in one place (`api.createOrder(...)`, `api.pay(...)`...). |
| `lib/server.js` | Which server address to use (same address, or a saved company address for the future apps). |
| `lib/socket.js` | The live connection. |
| `lib/permissions.js` | `can(user, "PAY")` and which page to land on. |
| `lib/stations.js` | Hot / Cold / Bar names and which screen shows which dishes. |
| `lib/sound.js`, `lib/money.js` | Alert sounds; showing money as "Rp 45.000". |
| `hooks/useLiveOrders.js` | Keeps the list of open orders live (used by order, kitchen, dashboard screens). |
| `hooks/useSettings.js` | Restaurant settings (kitchen mode), live. |
| `hooks/useAlerts.js`, `useWakeLock.js` | On-screen banners; keeping the screen awake. |
| `components/Topbar.jsx` | The dark bar at the top with the menu of screens. |
| `components/AlertBanner.jsx`, `ReasonDialog.jsx`, `SoundControl.jsx`, `LineExtras.jsx` | Banners, the "reason for void" box, the sound switch, spice/note under a dish. |
| `pages/Login.jsx`, `ChangePassword.jsx`, `Connect.jsx` | Sign in; choose own password; company code (for the future apps). |
| `pages/OrderEntry.jsx` | Waiter screen: tables, menu, cart with notes/spice/customer, open bills, deliver, pay. |
| `pages/KitchenDisplay.jsx` | Hot kitchen / cold kitchen / bar screens. |
| `pages/Pos.jsx` | Bill (subtotal, member discount, service, tax), find member by phone, payment, receipt. |
| `pages/CoordinatorDashboard.jsx` | Dashboard: live, transactions, kitchen history, activity, stock, report. |
| `pages/Admin.jsx` | Staff, roles, billing (tax & service), members, menu, tables, kitchen setup. |
| `test/*.test.jsx` | Automatic screen tests (run without a server; the server is imitated). |

### `onsite/` — the offline version

| File | What it does |
|---|---|
| `compose.yml` | The three containers: database, app, Caddy. |
| `caddy/Caddyfile`, `caddy/Dockerfile` | HTTPS with Caddy's own certificate authority; serves `rc-root.crt` for tablets. |
| `laptop/start.cmd` / `start.ps1` | Windows: build, start, first company + Admin, firewall, forwarding, certificate. |
| `laptop/stop`, `backup`, `restore`, `diagnose` (`.cmd` + `.ps1`) | Stop; copy the database to a file; put a copy back; collect troubleshooting info. |
| `laptop/common.ps1` | Shared helpers for the laptop scripts. |
| `minipc/rc.sh` | Ubuntu: install, start at boot, follow address changes, nightly backup, update, restore. |
| `README.md` | Step-by-step for laptop, tablets and mini PC. |

### `deploy/` — the cloud (VPS) version

One stack per company (`new-company.sh`), a shared HTTPS front (`docker-compose.edge.yml`, `Caddyfile`),
backups, restores and rolling updates. Read `deploy/README.md` before using it; it has not yet been run on a real VPS.

---

## Part 3 — The life of one order

Follow one table from the first tap to the receipt. File names show where each step lives.

1. **The waiter signs in** — `pages/Login.jsx` sends e-mail + password to `POST /auth/login`
   (`routes/auth.js`). The server checks the password and returns a **token** plus the person's
   **permissions**. The screen stores them (`context/AuthContext.jsx`) and opens the first screen the
   role may use (`lib/permissions.js` → `homePath`).
2. **The waiter builds the order** — `pages/OrderEntry.jsx`: pick a table, tap dishes, add notes /
   spice, optional customer name and phone. Nothing is sent yet; it lives in the screen's memory (the "cart").
3. **Send** — `api.createOrder(...)` (`lib/api.js`) calls `POST /orders` (`routes/orders.js`). The server:
   checks the person may take orders (`ORDER`), checks every value, then in **one transaction**
   locks the table, checks stock, finds the table's open bill or opens a new one, writes each dish with
   its price, tax, station and spice **frozen at this moment**, takes stock off, and writes the activity log.
4. **Everyone sees it at once** — the server sends `order:created` (new bill) or `order:items-added`
   (another round) over Socket.IO (`socket.js`). Kitchen-only screens receive it **without** the phone number.
   `hooks/useLiveOrders.js` on every screen updates its list; `pages/KitchenDisplay.jsx` shows only the
   dishes for its station and rings.
5. **The kitchen works** — tapping "Mark PREPARING" then "Mark READY" calls
   `PATCH /orders/:id/items/:itemId`. The server checks the cook's role has the right **screen permission**
   for that dish's station, records who finished it and when (`ready_at`, `ready_by_id`), and tells every
   screen. The dish leaves the kitchen board; the waiter's screen rings "Ready to serve".
6. **The waiter serves** — "Mark delivered" (same route, status `DELIVERED`, needs `ORDER`); who/when is
   recorded for the kitchen history.
7. **Payment** — when every dish is served, "Pay this table" opens `pages/Pos.jsx`, which asks
   `GET /payments/bill/:orderId` for the bill. If the guest is a member, the cashier types their phone
   (`GET /members/lookup`) and the bill is asked for again with the member. **The server calculates the bill**
   from the frozen prices: food − member discount + service charge + tax (`lib/billing.js`); the screen never
   sends an amount. `POST /payments` charges, closes the order, saves the numbers and rates used, and returns the receipt.
8. **Afterwards** — the payment appears in Dashboard > Transactions; the dishes in Dashboard >
   Kitchen history; everything in Activity; and in the Excel report.

---

## Part 4 — The core code, line by line

Each block shows the real code, then explains it line by line. `$1`, `$2` in SQL are placeholders: the
values are sent separately, which is what makes the queries safe against "SQL injection" (someone
typing SQL into a form).

### 4.1 The database tables that matter most (`backend/sql/schema.sql`)

The file grew in sections (v1 … v7); later sections *add* columns to earlier tables
(`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`). Below, each important table is shown **as it is now**,
with every column explained.

**`locations`** — one restaurant branch. Everything else belongs to a location.

| Column | Meaning |
|---|---|
| `id` | Unique code of the branch (a random UUID). |
| `organization_id` | Which company owns it (`organizations` table). |
| `name` | e.g. "Main Branch". |
| `timezone` | e.g. `Asia/Jakarta`; decides what "today" means in reports and history. |
| `disabled_roles` | Built-in roles this company switched off (v4). |
| `kitchen_mode` | `ONE` = one kitchen screen for hot and cold; `SPLIT` = separate screens (v5). |
| `tax_label`, `tax_rate` | The restaurant tax as printed (e.g. "PB1") and its rate, e.g. 0.10 (v8). PBJT is at most 10%; each city sets its rate. |
| `service_rate`, `tax_on_service` | Service charge rate (e.g. 0.05) and whether tax is also charged on it (v8). |

**`users`** — staff accounts.

| Column | Meaning |
|---|---|
| `id`, `location_id` | The person, and the branch they belong to. |
| `name`, `email` | Name shown on screens; e-mail used to sign in (unique, case-insensitive). |
| `password_hash` | The password, scrambled with **bcrypt** (one-way: it cannot be turned back into the password). |
| `role` | The role's key: a built-in (`ADMIN`, `FOH`…) or the company's own (`FOOD_RUNNER`) (v7: plain text). |
| `active` | `false` = disabled; they can no longer sign in. |
| `must_change_password` | `true` after a temporary password; they must choose their own first. |
| `token_version` | Goes up on password change/reset, role change or disable — **old tokens stop working at once**. |
| `failed_logins`, `locked_until` | Lockout after too many wrong passwords. |
| `last_login_at` | For the Staff list. |

**`roles`** (v7) — the company's own roles, and changed tick-boxes of built-in roles.

```sql
CREATE TABLE IF NOT EXISTS roles (
  location_id TEXT NOT NULL REFERENCES locations(id),
  key TEXT NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9_]{1,29}$'),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 2 AND 40),
  permissions TEXT[] NOT NULL DEFAULT '{}',
  builtin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, key)
);
```

1. `CREATE TABLE IF NOT EXISTS roles (` — make the table only if it isn't there yet (safe to re-run).
2. `location_id ... REFERENCES locations(id)` — each role belongs to one branch; must be a real branch.
3. `key ... CHECK (key ~ '^[A-Z]...')` — the role's code, e.g. `FOOD_RUNNER`: capitals, digits, `_`, 2–30 long.
4. `label ... CHECK (length(label) BETWEEN 2 AND 40)` — the name people see, e.g. "Food runner".
5. `permissions TEXT[]` — a list of permission codes, e.g. `{ORDER,PAY}`.
6. `builtin BOOLEAN` — `true` when this row only changes the tick-boxes of a built-in role.
7. `created_at` — when it was made (used to keep the list in creation order).
8. `PRIMARY KEY (location_id, key)` — the same key can exist once per branch; branches never share roles.

**`orders`** — one bill for one table.

| Column | Meaning |
|---|---|
| `id`, `location_id`, `table_id` | The bill, its branch, its table. |
| `status` | `OPEN` (running bill), `CLOSED` (paid), `CANCELLED` (voided). |
| `opened_by_id`, `opened_at`, `closed_at` | Who opened it and when; when it was paid. |
| `customer_name`, `customer_phone` | Optional (v6). The phone is never sent to kitchen-only screens. |
| `voided_at`, `voided_by_id`, `void_reason` | Set when a supervisor voids the whole order. |

A special index (v5) makes the database itself refuse a **second open bill for the same table**:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_order_per_table ON orders(table_id) WHERE status = 'OPEN';
```

1. `UNIQUE INDEX` — no two rows may have the same value…
2. `ON orders(table_id)` — …for `table_id`…
3. `WHERE status = 'OPEN'` — …among open orders only. Paid/voided orders for that table are fine.

**`order_items`** — one line on the bill ("2x Nasi Goreng, spicy, no onion").

| Column | Meaning |
|---|---|
| `id`, `order_id`, `menu_item_id` | The line, its bill, the dish. |
| `quantity` | How many (1–99; the database refuses 0 or less). |
| `unit_price`, `tax_rate` | **Copied from the menu when ordered** — changing the menu later never changes old bills. |
| `notes`, `spice` | Waiter's note; `SPICY` / `NOT_SPICY` / empty (v6). |
| `station` | `KITCHEN` / `COLD` / `BAR`, copied from the dish when ordered (v5). |
| `status` | `PENDING` → `PREPARING` → `READY` → `DELIVERED`; or `CANCELLED` (voided). |
| `created_at`, `updated_at` | When ordered; last change. |
| `ready_at`, `ready_by_id`, `delivered_at`, `delivered_by_id` | Who finished and who served it, and when (v6, for history). |
| `voided_at`, `voided_by_id`, `void_reason` | Set when a supervisor voids the line. |

**`payments`** — one per paid bill. `UNIQUE(order_id)` means a bill can never be charged twice. Each payment
keeps `subtotal`, `discount`, `service`, `tax`, `total` **and** the rates and member used (`member_name`,
`discount_rate`, `service_rate`, `tax_rate`, `tax_label`), so changing rates later never changes an old bill.
The rule `CHECK (total = subtotal - discount + service + tax)` means the numbers always add up.

**`members`** (v8) — regulars with a discount: `name`, `phone` (as typed), `phone_key` (digits only, so
"+62 812…" and "0812…" are the same person; unique per branch), `discount_rate` (0.10 = 10%), `active`.
Members are switched off, never deleted, because old receipts point at them.

**`order_events`** — the activity log (append-only). **`stock_movements`** — stock as a ledger: on-hand is
the sum of all `+` and `−` movements; nothing is overwritten. **`auth_events`** — sign-ins, failures,
password and staff/role changes.

**Safety rules inside the database** — a PL/pgSQL function `rc_check_same_location()` runs before rows are
added to orders, order lines, payments and stock, and refuses anything that mixes two branches (for
example an order line pointing at another branch's dish), even if the app had a bug.

### 4.2 Signing in (`backend/src/routes/auth.js`, `POST /auth/login`)

```js
router.post("/login", loginLimiter, async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  const password = req.body && req.body.password;
  if (!email || typeof password !== "string" || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  if (password.length > 200 || email.length > 200) return res.status(400).json({ error: "Invalid credentials" });

  const { rows } = await query("SELECT * FROM users WHERE lower(email) = $1", [email]);
  const user = rows[0];

  if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.max(1, Math.ceil((new Date(user.locked_until) - Date.now()) / 60000));
    await logAuth({ locationId: user.location_id, userId: user.id, type: "LOGIN_BLOCKED", email, ip: req.ip });
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.` });
  }

  const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !user.active || !valid) {
    if (user) {
      const fails = user.failed_logins + 1;
      const lock = fails >= config.loginMaxFailures;
      await query(
        `UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END WHERE id = $1`,
        [user.id, lock ? 0 : fails, lock, String(config.loginLockMinutes)]
      );
      await logAuth({ locationId: user.location_id, userId: user.id, type: lock ? "LOCKED" : "LOGIN_FAIL", email, ip: req.ip });
    } else {
      await logAuth({ type: "LOGIN_FAIL", email, ip: req.ip, detail: { unknownEmail: true } });
    }
    return res.status(401).json({ error: "Invalid credentials" });
  }

  await query("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1", [user.id]);
  await logAuth({ locationId: user.location_id, userId: user.id, type: "LOGIN_OK", email, ip: req.ip });
  const token = signToken({ id: user.id, role: user.role, locationId: user.location_id, tokenVersion: user.token_version });
  res.json({ token, user: await publicUser(user), mustChangePassword: user.must_change_password });
});
```

1. `router.post("/login", loginLimiter, async (req, res) => {` — when a screen sends to `/auth/login`, first
   `loginLimiter` (too many attempts from one device are slowed down), then run this function.
   `req` is the incoming request, `res` the reply.
2. `normalizeEmail(...)` — trims spaces and makes the e-mail lower-case, so `Budi@X.com` = `budi@x.com`.
3. `password = ...` — the typed password (only in memory, never stored as typed).
4–6. If either is missing, answer **400** (bad request) with a message.
7. Very long inputs are refused (bcrypt only reads 72 bytes; long input is also a way to slow servers).
9. Look up the account by e-mail. `$1` is filled with `email` safely.
10. `user` is the row found, or `undefined`.
12–16. If the account is **locked** (too many wrong passwords), log it and answer **429** "try again in N minutes".
18. `bcrypt.compare` checks the password against the scrambled one. If there is no such user it compares
    with a dummy, so "unknown e-mail" and "wrong password" take the same time — an attacker can't tell which.
19. Fail if: no user, account disabled, or wrong password.
20–27. If the account exists: count one more failure; at the limit (5 by default) set `locked_until` to
    now + 5 minutes and reset the counter; log `LOCKED` or `LOGIN_FAIL`.
28–29. Unknown e-mail: just log it.
31. Answer **401** "Invalid credentials" — the same message for every failure.
34. Success: clear failures and lock, remember the time.
35. Log `LOGIN_OK`.
36. Make the **token**: a signed note "this is user X, role Y, branch Z, token version N", valid 12 hours.
37. Reply with the token, the person (name, role, **permissions**) and whether they must change password.

### 4.3 The check on every request (`backend/src/middleware/auth.js`, `requireAuth`)

```js
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing bearer token" });
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    const user = await loadUser(payload.sub);
    if (!user || !user.active || (payload.tv || 0) !== user.token_version) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    // Role, its permissions and the location come from the database, never from the token.
    const permissions = await permissionsFor(user.location_id, user.role);
    req.user = { sub: user.id, role: user.role, locationId: user.location_id, name: user.name, permissions };
    if (user.must_change_password && !ALLOWED_WHILE_MUST_CHANGE.has(req.baseUrl + req.path)) {
      return res.status(403).json({ error: "You must choose a new password first", code: "PASSWORD_CHANGE_REQUIRED" });
    }
    next();
  } catch (err) {
    next(err);
  }
}
```

1. A "middleware": runs before the real route. `next()` means "carry on to the route".
3. Read the `Authorization` header the screen sends.
4. It must look like `Bearer <token>`; take the part after `Bearer `.
5. No token → **401**.
7–11. `jwt.verify` checks the token was signed with **our secret** and is not expired; otherwise **401**.
   (Someone editing the token breaks the signature.)
12. Load the person **from the database** (cached for 3 seconds to stay fast).
13–15. Refuse if the person no longer exists, is disabled, or the token's version is old (password changed,
    role changed, disabled) — this is what signs people out **immediately**.
17. Look up what the person's **current** role may do (also cached 3 s; cleared at once when a role changes).
18. Attach who they are and what they may do to the request, for the route to use.
19–21. Someone on a temporary password may only change it (or ask "who am I"); everything else → **403**.
22. All good: go on to the route.
23–25. Any unexpected error goes to the central error handler (`app.js`), which answers **500** without details.

### 4.4 Permissions (`backend/src/lib/permissions.js`)

```js
const PERMISSIONS = {
  ORDER: "Take orders and serve dishes (Order Entry)",
  PAY: "Take payment (POS)",
  BOARD_KITCHEN: "Hot kitchen screen (in one-kitchen mode: hot and cold dishes)",
  BOARD_COLD: "Cold kitchen screen",
  BOARD_BAR: "Bar screen",
  DASHBOARD: "Dashboard: live tables, payments, activity and stock",
  HISTORY: "Kitchen and bar history",
  VOID: "Void dishes, orders and paid sales",
  EXPORT: "Download the Excel report",
  MENU: "Edit the menu, tables and kitchen setup",
  STAFF: "Manage staff and roles (Admin only)",
};
const ALL = Object.keys(PERMISSIONS);
const GRANTABLE = ALL.filter((p) => p !== "STAFF");

const BUILTIN = {
  ADMIN: { label: "Admin", permissions: ALL },
  COORDINATOR: { label: "Coordinator", permissions: ["ORDER", "PAY", "BOARD_KITCHEN", "BOARD_COLD", "BOARD_BAR", "DASHBOARD", "HISTORY", "EXPORT", "MENU"] },
  SUPERVISOR: { label: "Supervisor", permissions: ["ORDER", "PAY", "BOARD_KITCHEN", "BOARD_COLD", "BOARD_BAR", "DASHBOARD", "HISTORY", "VOID"] },
  FOH: { label: "Waiter (front of house)", permissions: ["ORDER", "PAY"] },
  KITCHEN: { label: "Kitchen / bar", permissions: ["BOARD_KITCHEN", "BOARD_COLD", "BOARD_BAR"] },
};
```

1–13. The complete list of things a role can be allowed to do, each with the sentence shown in Admin > Roles.
   **To add a new kind of permission, add a line here**, then check it in the route that needs it.
14. `ALL` — just the codes: `["ORDER", "PAY", ...]`.
15. `GRANTABLE` — every code except `STAFF`. Only the built-in Admin can manage staff and roles, because
    whoever can create accounts can effectively make themselves Admin.
17–23. The five built-in roles and their starting tick-boxes. Admin always gets `ALL`.

```js
async function rolesOf(locationId) {
  const hit = cache.get(locationId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.roles;
  const roles = new Map();
  for (const key of BUILTIN_KEYS) roles.set(key, { key, label: BUILTIN[key].label, permissions: [...BUILTIN[key].permissions], builtin: true });
  const { rows } = await query("SELECT key, label, permissions, builtin FROM roles WHERE location_id = $1 ORDER BY created_at", [locationId]);
  for (const r of rows) {
    if (r.key === "ADMIN") continue; // ADMIN can never lose anything
    const base = roles.get(r.key);
    roles.set(r.key, {
      key: r.key,
      label: base ? base.label : r.label,
      permissions: r.permissions.filter((p) => GRANTABLE.includes(p)),
      builtin: !!base,
    });
  }
  cache.set(locationId, { roles, at: Date.now() });
  if (cache.size > 2000) cache.clear();
  return roles;
}
```

1. "Give me all roles of this branch."
2–3. If we looked them up less than 3 seconds ago, reuse that answer (fast).
4–5. Start with the five built-in roles and their default tick-boxes.
6. Read the branch's rows from the `roles` table.
7–8. Ignore any row for `ADMIN` — Admin always has everything.
9–15. For each row: if it is a built-in key, it **replaces that role's tick-boxes** (the name stays);
    otherwise it is the company's own role. `STAFF` is filtered out even if someone put it in the database.
17–19. Remember the answer for 3 seconds and return it.

`requirePerm("PAY")` (same file) is used by routes: "the person needs at least one of these permissions,
otherwise answer **403** Not allowed". `seesPhone(...)`: only roles with `ORDER`, `PAY` or `DASHBOARD` see
customers' phone numbers.

### How to read the numbered listings below

From here on, code is shown with **line numbers on the left** (`12 | ...`). The numbers are only for this
guide (they are not in the file). Explanations refer to them: "12–15" means lines 12 to 15.

### 4.5 Taking an order (`backend/src/routes/orders.js`, `POST /orders`)

```js
  1 | router.post("/", async (req, res) => {
  2 |   needs(req.user, ["ORDER"], "take orders");
  3 |   const { tableId, items } = req.body || {};
  4 |   const customer = cleanCustomer(req.body || {});
  5 |   if (typeof tableId !== "string" || !tableId || !Array.isArray(items) || items.length === 0) {
  6 |     return res.status(400).json({ error: "tableId and a non-empty items[] are required" });
  7 |   }
  8 |   if (items.length > 100) return res.status(400).json({ error: "Too many items in one order" });
  9 |   for (const i of items) {
 10 |     if (!i || typeof i !== "object" || typeof i.menuItemId !== "string" || !i.menuItemId) {
 11 |       return res.status(400).json({ error: "Each item needs a menuItemId" });
 12 |     }
 13 |     const q = i.quantity === undefined ? 1 : i.quantity;
 14 |     if (!Number.isInteger(q) || q < 1 || q > 99) {
 15 |       return res.status(400).json({ error: "Each quantity must be a whole number from 1 to 99" });
 16 |     }
 17 |     if (i.notes !== undefined && i.notes !== null && (typeof i.notes !== "string" || i.notes.length > 200)) {
 18 |       return res.status(400).json({ error: "notes must be text of 200 characters or fewer" });
 19 |     }
 20 |     if (i.spice !== undefined && i.spice !== null && !SPICES.includes(i.spice)) {
 21 |       return res.status(400).json({ error: "spice must be SPICY or NOT_SPICY" });
 22 |     }
 23 |   }
 24 | 
 25 |   const locationId = req.user.locationId;
 26 |   const { order, activity, stockIds, added, addedIds } = await withTransaction(async (client) => {
 27 |     // Locking the table row makes two waiters sending to the same table at the
 28 |     // same moment take turns, so the second one finds (and adds to) the first's order.
 29 |     const { rows: tableRows } = await client.query(
 30 |       "SELECT * FROM restaurant_tables WHERE id = $1 AND location_id = $2 AND active = true FOR UPDATE",
 31 |       [tableId, locationId]
 32 |     );
 33 |     if (tableRows.length === 0) throw new HttpError(404, "Table not found for this location");
 34 | 
 35 |     const ids = [...new Set(items.map((i) => i.menuItemId))];
 36 |     // Lock tracked menu rows in a stable order so two orders for the same
 37 |     // low-stock item queue up instead of both seeing "1 left".
 38 |     const { rows: menuItems } = await client.query(
 39 |       `SELECT * FROM menu_items WHERE id = ANY($1::text[]) AND location_id = $2 AND active = true
 40 |        ORDER BY id FOR UPDATE`,
 41 |       [ids, locationId]
 42 |     );
 43 |     const byId = new Map(menuItems.map((m) => [m.id, m]));
 44 |     for (const i of items) {
 45 |       if (!byId.has(i.menuItemId)) throw new HttpError(400, `Unknown or inactive menuItemId ${i.menuItemId} for this location`);
 46 |       if (i.spice && !byId.get(i.menuItemId).spice_option) throw new HttpError(400, `${byId.get(i.menuItemId).name} has no spice choice`);
 47 |     }
 48 | 
 49 |     const demand = new Map();
 50 |     for (const i of items) demand.set(i.menuItemId, (demand.get(i.menuItemId) || 0) + (i.quantity || 1));
 51 |     const trackedIds = menuItems.filter((m) => m.track_stock).map((m) => m.id);
 52 |     const onHand = await onHandMap(client, trackedIds);
 53 |     for (const id of trackedIds) {
 54 |       if (demand.get(id) > onHand.get(id)) {
 55 |         throw new HttpError(409, `Not enough stock: ${byId.get(id).name} (${onHand.get(id)} left)`);
 56 |       }
 57 |     }
 58 | 
 59 |     // The table's running bill, if any. Locked so a payment can't close it while we add to it.
 60 |     const { rows: openRows } = await client.query(
 61 |       `SELECT id FROM orders WHERE table_id = $1 AND location_id = $2 AND status = 'OPEN'
 62 |        ORDER BY opened_at LIMIT 1 FOR UPDATE`,
 63 |       [tableId, locationId]
 64 |     );
 65 |     const isNew = openRows.length === 0;
 66 |     const orderId = isNew ? crypto.randomUUID() : openRows[0].id;
 67 |     if (isNew) {
 68 |       await client.query(
 69 |         "INSERT INTO orders (id, location_id, table_id, opened_by_id, customer_name, customer_phone) VALUES ($1, $2, $3, $4, $5, $6)",
 70 |         [orderId, locationId, tableId, req.user.sub, customer.name, customer.phone]
 71 |       );
 72 |     } else if (customer.name || customer.phone) {
 73 |       // a later round may add (or correct) the customer's details; empty fields keep what was there
 74 |       await client.query(
 75 |         "UPDATE orders SET customer_name = COALESCE($2, customer_name), customer_phone = COALESCE($3, customer_phone) WHERE id = $1",
 76 |         [orderId, customer.name, customer.phone]
 77 |       );
 78 |     }
 79 |     const newItemIds = [];
 80 |     for (const i of items) {
 81 |       const m = byId.get(i.menuItemId);
 82 |       const qty = i.quantity || 1;
 83 |       const orderItemId = crypto.randomUUID();
 84 |       await client.query(
 85 |         // clock_timestamp() (not now()) so lines keep the order they were sent
 86 |         // in: now() is identical for every statement in a transaction.
 87 |         // station is copied from the dish so the ticket stays on its screen even if the menu changes later
 88 |         `INSERT INTO order_items (id, order_id, menu_item_id, quantity, unit_price, tax_rate, notes, station, spice, created_at, updated_at)
 89 |          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, clock_timestamp(), clock_timestamp())`,
 90 |         [orderItemId, orderId, m.id, qty, m.price, m.tax_rate, i.notes && i.notes.trim() ? i.notes.trim() : null, m.station, i.spice || null]
 91 |       );
 92 |       newItemIds.push(orderItemId);
 93 |       if (m.track_stock) {
 94 |         await addMovement(client, {
 95 |           locationId, menuItemId: m.id, delta: -qty, reason: "SALE", orderItemId, userId: req.user.sub,
 96 |         });
 97 |       }
 98 |     }
 99 | 
100 |     const summary = [...demand].map(([id, q]) => `${q}x ${byId.get(id).name}`).join(", ");
101 |     const ev = await logEvent(client, {
102 |       locationId, orderId, type: isNew ? "ORDER_CREATED" : "ITEMS_ADDED", actorId: req.user.sub,
103 |       message: isNew ? `${tableRows[0].label}: new order — ${summary}` : `${tableRows[0].label}: added — ${summary}`,
104 |       detail: { table: tableRows[0].label },
105 |     });
106 |     return {
107 |       order: await getOrder(client, locationId, orderId),
108 |       activity: [ev], stockIds: trackedIds, added: !isNew, addedIds: newItemIds,
109 |     };
110 |   });
111 | 
112 |   if (added) {
113 |     // screens replace their copy of this order and ring only for the new lines
114 |     emitOrder(locationId, "order:items-added", { order, addedItemIds: addedIds, addedById: req.user.sub });
115 |   } else {
116 |     emitOrder(locationId, "order:created", order);
117 |   }
118 |   emitActivity(locationId, activity);
119 |   await emitStock(locationId, stockIds);
120 |   res.status(added ? 200 : 201).json({ ...order, added });
121 | });
```

- **1** — When a screen sends to `POST /orders`, run this. (Before it, `requireAuth` from 4.3 already checked who it is.)
- **2** — The person's role must have the `ORDER` permission, otherwise **403**. `needs()` is a small helper at the top of the file.
- **3** — Take `tableId` and `items` from what the screen sent.
- **4** — Clean the optional customer name/phone (trim spaces; name ≤ 60 letters; phone only digits, spaces, `+ - ( )`).
- **5–7** — A table and at least one dish are required.
- **8** — At most 100 lines in one send (protects the server from silly or malicious requests).
- **9–23** — Check every line: it has a dish id (**10–12**); the quantity is a whole number 1–99, default 1 (**13–16**);
  the note is text ≤ 200 characters (**17–19**); spice, if given, is `SPICY` or `NOT_SPICY` (**20–22**).
  Any problem → **400** with a clear message, and nothing is saved.
- **25** — The branch comes from the signed-in person, **never** from what the screen sent. This is what keeps
  companies and branches apart.
- **26** — Everything inside `withTransaction(...)` (up to line 110) happens **all or nothing**: if anything fails,
  the database is left exactly as before.
- **29–33** — Find the table in this branch, still in service, and **lock** it (`FOR UPDATE`). If two waiters press
  Send for the same table at the same moment, the second waits for the first to finish — so it finds the
  bill the first one opened instead of opening a second one. Unknown table → **404**.
- **35** — The distinct dish ids in this send.
- **38–42** — Load those dishes (this branch, still on the menu), locked in a fixed order so two orders for a
  dish with little stock left queue up instead of both seeing "1 left".
- **43** — Put them in a lookup table by id.
- **44–47** — Every dish must exist and be on; spice may only be chosen for dishes that offer it.
- **49–50** — Add up how many of each dish is wanted in this send.
- **51–57** — For dishes whose stock is counted, compare wanted vs on hand; not enough → **409** "Not enough stock".
- **59–64** — Look for the table's **running bill** (an `OPEN` order), locked so a cashier can't close it while
  we add to it.
- **65–66** — No running bill → a new order with a new random id; otherwise use the running bill.
- **67–71** — New bill: create the order with who opened it and the optional customer details.
- **72–78** — Existing bill: if a name/phone was typed this time, save it; empty fields keep what was there (`COALESCE`).
- **79–98** — For each line: create its id (**83**) and save it (**84–91**) with the dish, quantity, the **price and tax
  copied from the menu now**, the note, the **station** (where it is made) and spice. `clock_timestamp()` gives each
  line its own exact time so they stay in the order sent. Remember the new ids (**92**). If the dish's stock is
  counted, write a `SALE` movement of −quantity (**93–97**).
- **100–105** — Write the activity log line: "Table 4: new order — 2x Nasi Goreng" or "Table 4: added — …".
- **106–109** — Read the whole order back in the shape the screens use, and hand back what the code after the
  transaction needs.
- **112–117** — Tell every screen of the branch: `order:items-added` for another round (with which lines are new,
  so screens ring only for those), or `order:created` for a new bill. `emitOrder` sends kitchen-only screens a
  copy **without the phone number**.
- **118–119** — Update dashboards' activity feed and live stock counts.
- **120** — Reply to the waiter's screen: **201** (created) for a new bill, **200** for an added round, with
  `added: true/false` so the screen can say "Added to Table 4's bill".

### 4.6 The kitchen marks a dish (`PATCH /orders/:orderId/items/:itemId`)

```js
  1 | router.patch("/:orderId/items/:itemId", async (req, res) => {
  2 |   const { orderId, itemId } = req.params;
  3 |   const { status } = req.body || {};
  4 |   const locationId = req.user.locationId;
  5 | 
  6 |   const result = await withTransaction(async (client) => {
  7 |     const order = await lockOrder(client, locationId, orderId);
  8 |     const { rows } = await client.query(
  9 |       "SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE",
 10 |       [itemId, orderId]
 11 |     );
 12 |     if (rows.length === 0) throw new HttpError(404, "Order item not found for this location");
 13 |     const item = rows[0];
 14 | 
 15 |     if (item.status === status) return { changed: false, order, item }; // double-tap: no-op
 16 |     if (order.status !== "OPEN") throw new HttpError(409, `Order is ${order.status}; items can no longer change`);
 17 |     const rule = TRANSITIONS[item.status];
 18 |     if (!rule || rule.to !== status) {
 19 |       throw new HttpError(409, `Cannot move an item from ${item.status} to ${status}`);
 20 |     }
 21 |     if (rule.by === "board") {
 22 |       const { rows: loc } = await client.query("SELECT kitchen_mode FROM locations WHERE id = $1", [locationId]);
 23 |       needs(req.user, boardPermsFor(item.station, loc[0].kitchen_mode), `mark ${status}`);
 24 |     } else {
 25 |       needs(req.user, [rule.by], `mark ${status}`);
 26 |     }
 27 | 
 28 |     // remember who finished / served the dish and when (kitchen history)
 29 |     await client.query(
 30 |       `UPDATE order_items SET status = $1::order_item_status, updated_at = now(),
 31 |               ready_at = CASE WHEN $1::order_item_status = 'READY' THEN now() ELSE ready_at END,
 32 |               ready_by_id = CASE WHEN $1::order_item_status = 'READY' THEN $3 ELSE ready_by_id END,
 33 |               delivered_at = CASE WHEN $1::order_item_status = 'DELIVERED' THEN now() ELSE delivered_at END,
 34 |               delivered_by_id = CASE WHEN $1::order_item_status = 'DELIVERED' THEN $3 ELSE delivered_by_id END
 35 |        WHERE id = $2`,
 36 |       [status, itemId, req.user.sub]
 37 |     );
 38 |     const { rows: nameRows } = await client.query("SELECT name FROM menu_items WHERE id = $1", [item.menu_item_id]);
 39 |     const ev = await logEvent(client, {
 40 |       locationId, orderId, type: "ITEM_STATUS", actorId: req.user.sub,
 41 |       message: `${order.table_label}: ${item.quantity}x ${nameRows[0].name} → ${status}`,
 42 |       detail: { table: order.table_label, status },
 43 |     });
 44 |     const fresh = await getOrder(client, locationId, orderId);
 45 |     return { changed: true, order, item: fresh.items.find((i) => i.id === itemId), activity: [ev] };
 46 |   });
 47 | 
 48 |   if (!result.changed) {
 49 |     const fresh = await getOrder({ query }, locationId, orderId);
 50 |     return res.json(fresh.items.find((i) => i.id === itemId));
 51 |   }
 52 |   emitToLocation(locationId, "order-item:updated", {
 53 |     orderId,
 54 |     orderOpenedById: result.order.opened_by_id,
 55 |     tableLabel: result.order.table_label,
 56 |     item: result.item,
 57 |   });
 58 |   emitActivity(locationId, result.activity);
 59 |   res.json(result.item);
 60 | });
```

- **1–4** — Which order and line, the requested new status, and the branch (from the signed-in person).
- **6** — All or nothing (transaction).
- **7** — Lock the order (and check it belongs to this branch); `lockOrder` is defined near the top of the file.
- **8–13** — Lock the line itself; unknown → **404**.
- **15** — Already at that status (someone double-tapped) → change nothing, no error.
- **16** — A paid or voided order can't change any more → **409**.
- **17–20** — Only the next step is allowed: `PENDING → PREPARING → READY → DELIVERED` (the `TRANSITIONS`
  table above the function). Anything else (going back, skipping) → **409**. Cancelling is only possible
  through the separate **void** routes, which need the `VOID` permission and a written reason.
- **21–26** — Who may do the step: PREPARING/READY need the **screen permission for that dish's station**
  (`BOARD_KITCHEN`, `BOARD_COLD` or `BOARD_BAR`; in one-kitchen mode cold dishes may also be done from the hot
  kitchen screen — `boardPermsFor`). DELIVERED needs `ORDER` (the waiter). Not allowed → **403**.
- **29–37** — Save the new status. When it becomes READY also record **when and by whom** (`ready_at`,
  `ready_by_id`); when DELIVERED, `delivered_at`, `delivered_by_id`. This feeds Dashboard > Kitchen history.
- **38–43** — Activity log: "Table 4: 2x Nasi Goreng → READY".
- **44–45** — Read the updated line back for the screens.
- **48–51** — The double-tap case: just reply with the current line.
- **52–57** — Tell every screen of the branch (`order-item:updated`): the kitchen board removes the dish when
  READY; the waiter who opened the table hears "Ready to serve".
- **58–59** — Update the activity feed; reply.

### 4.7 Payment (`backend/src/routes/payments.js`, `POST /payments`, and `lib/billing.js`)

**The bill maths** (`backend/src/lib/billing.js`):

```js
  1 | const toCents = (v) => Math.round(Number(v) * 100);
  2 | const fromCents = (c) => c / 100;
  3 | const basisPoints = (rate) => Math.round(Number(rate || 0) * 10000); // 0.10 -> 1000
  4 | // amount x rate, rounded ONCE to whole rupiah (returned in cents). cents x basis points is an
  5 | // exact whole number for any real bill, so the only rounding is the final one, like the database's round().
  6 | const shareRupiah = (cents, bp) => Math.round((cents * bp) / 1000000) * 100;
  7 | 
  8 | // subtotal: food total (number). rates are fractions (0.10 = 10%).
  9 | function billTotals({ subtotal, discountRate = 0, serviceRate = 0, taxRate = 0, taxOnService = true }) {
 10 |   const sub = toCents(subtotal);
 11 |   const discount = shareRupiah(sub, basisPoints(discountRate));
 12 |   const afterDiscount = sub - discount;
 13 |   const service = shareRupiah(afterDiscount, basisPoints(serviceRate));
 14 |   const taxBase = afterDiscount + (taxOnService ? service : 0);
 15 |   const tax = shareRupiah(taxBase, basisPoints(taxRate));
 16 |   return {
 17 |     subtotal: fromCents(sub),
 18 |     discount: fromCents(discount),
 19 |     afterDiscount: fromCents(afterDiscount),
 20 |     service: fromCents(service),
 21 |     taxBase: fromCents(taxBase),
 22 |     tax: fromCents(tax),
 23 |     total: fromCents(afterDiscount + service + tax),
 24 |   };
 25 | }
```

- **1–2** — Money is converted to whole **cents** (integers) and back, so there are no floating-point surprises.
- **3** — A rate as "basis points": 0.10 (10%) → 1000.
- **4–6** — `shareRupiah`: amount × rate, **rounded once** to whole rupiah. Rounding only once matters: rounding to
  cents first and then to rupiah can be off by Rp 1 (a test checks this), and the demo's database also rounds once.
- **9** — Inputs: the food subtotal and the rates (fractions: 0.05 = 5%).
- **10** — Food subtotal in cents.
- **11** — Member discount = subtotal × member's rate (0 if no member).
- **12** — Food after the discount.
- **13** — Service charge = food after discount × service rate.
- **14** — What the tax is charged on: food after discount, plus the service charge if `taxOnService` is on.
- **15** — Tax = tax base × tax rate.
- **16–24** — Return every part in rupiah. `total` = food after discount + service + tax.

Example (10% PB1 on food + service, 5% service, member 10%): food 100,000 → discount 10,000 → 90,000 →
service 4,500 → tax 10% of 94,500 = 9,450 → **total 103,950**.

`computeBill` (top of `payments.js`) adds up the frozen line prices in SQL (voided lines left out), reads the
restaurant's billing settings and the member (if any — it must be active and of **this** branch), and calls
`billTotals`. The screen never sends an amount to charge.

```js
  1 | router.post("/", async (req, res) => {
  2 |   if (!can(req.user, "PAY")) {
  3 |     return res.status(403).json({ error: "Not allowed to take payment (needs permission PAY)" });
  4 |   }
  5 |   const { orderId, method, amountTendered, memberId } = req.body || {};
  6 |   if (!orderId) return res.status(400).json({ error: "orderId is required" });
  7 |   if (!METHODS.includes(method)) return res.status(400).json({ error: `method must be one of ${METHODS.join(", ")}` });
  8 |   let tenderedCents = null;
  9 |   if (method === "CASH") {
 10 |     if (typeof amountTendered !== "number" || !Number.isFinite(amountTendered) || amountTendered < 0) {
 11 |       return res.status(400).json({ error: "amountTendered (a number) is required for cash" });
 12 |     }
 13 |     tenderedCents = Math.round(amountTendered * 100);
 14 |   }
 15 |   const locationId = req.user.locationId;
 16 | 
 17 |   const { paymentId, events } = await withTransaction(async (client) => {
 18 |     const { rows: orows } = await client.query(
 19 |       `SELECT o.*, t.label AS table_label FROM orders o JOIN restaurant_tables t ON t.id = o.table_id
 20 |        WHERE o.id = $1 AND o.location_id = $2 FOR UPDATE OF o`,
 21 |       [orderId, locationId]
 22 |     );
 23 |     if (orows.length === 0) throw new HttpError(404, "Order not found for this location");
 24 |     const order = orows[0];
 25 |     if (order.status === "CLOSED") throw new HttpError(409, "This order has already been paid");
 26 |     if (order.status !== "OPEN") throw new HttpError(409, `Order is ${order.status}`);
 27 | 
 28 |     const bill = await computeBill(client, locationId, orderId, memberId);
 29 |     if (bill.lines.length === 0) throw new HttpError(409, "Nothing to charge — every item was voided");
 30 |     const undelivered = bill.lines.filter((l) => !l.delivered);
 31 |     if (undelivered.length > 0) {
 32 |       throw new HttpError(409, `Not all items are delivered yet: ${undelivered.map((l) => `${l.quantity}x ${l.name}`).join(", ")}`);
 33 |     }
 34 |     if (method === "CASH" && tenderedCents < Math.round(bill.total * 100)) {
 35 |       throw new HttpError(400, `Cash received (${amountTendered}) is less than the total (${bill.total})`);
 36 |     }
 37 |     const change = method === "CASH" ? (tenderedCents - Math.round(bill.total * 100)) / 100 : null;
 38 | 
 39 |     const id = crypto.randomUUID();
 40 |     await client.query(
 41 |       `INSERT INTO payments (id, location_id, order_id, subtotal, discount, service, tax, total, method, amount_tendered, change_given, paid_by_id,
 42 |                              member_id, member_name, discount_rate, service_rate, tax_rate, tax_label)
 43 |        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
 44 |       [id, locationId, orderId, bill.subtotal, bill.discount, bill.service, bill.tax, bill.total, method,
 45 |        method === "CASH" ? amountTendered : null, change, req.user.sub,
 46 |        bill.member ? bill.member.id : null, bill.member ? bill.member.name : null,
 47 |        bill.discountRate, bill.serviceRate, bill.taxRate, bill.taxLabel]
 48 |     );
 49 |     await client.query("UPDATE orders SET status = 'CLOSED', closed_at = now() WHERE id = $1", [orderId]);
 50 |     const ev = await logEvent(client, {
 51 |       locationId, orderId, type: "PAID", actorId: req.user.sub,
 52 |       message: `${order.table_label}: paid ${bill.total} by ${method}${bill.member ? ` (member ${bill.member.name}, -${bill.discount})` : ""}`,
 53 |       detail: { table: order.table_label, total: bill.total, method, member: bill.member ? bill.member.name : null, discount: bill.discount },
 54 |     });
 55 |     return { paymentId: id, events: [ev] };
 56 |   });
 57 | 
 58 |   const receipt = await buildReceipt({ query }, locationId, paymentId);
 59 |   emitToLocation(locationId, "order:closed", { orderId });
 60 |   emitToPerms(locationId, ["DASHBOARD"], "payment:changed", { orderId, paymentId });
 61 |   emitActivity(locationId, events);
 62 |   res.status(201).json(receipt);
 63 | });
```

- **2–4** — The role needs the `PAY` permission.
- **5–7** — The order, a payment method (`CASH`, `CARD`, `QRIS`, `OTHER`), and optionally the member found by phone.
- **8–14** — For cash, the amount received must be a number ≥ 0; it is converted to cents so comparisons are exact.
- **17** — All or nothing.
- **18–24** — Load and **lock** the order (this branch only). The lock plus `UNIQUE(order_id)` on payments mean two
  cashiers pressing Pay at once can never charge twice.
- **25–26** — Already paid → **409**; voided → **409**.
- **28** — Calculate the bill on the server, with the member's discount. An unknown or switched-off member → **404**.
- **29–33** — Nothing left to charge, or something not yet served → **409**.
- **34–37** — Cash must cover the total; work out the change.
- **39–48** — Save the payment with **every part and the rates used**, the member, and who took it.
- **49** — Close the order (the table is free; the next order starts a new bill).
- **50–54** — Activity log: "Table 4: paid 103950 by CASH (member Sari, -10000)".
- **58–62** — Build the receipt, tell screens the table closed, tell dashboards a payment happened, reply **201** with the receipt.

Setting the rates: `PATCH /locations/settings` with `taxLabel`, `taxPercent`, `servicePercent`, `taxOnService`
(`routes/locations.js`) — Admin only, because they change what every customer pays; each change is logged.

### 4.8 Live updates (`backend/src/socket.js`)

```js
  1 |   io.use(async (socket, next) => {
  2 |     try {
  3 |       const token = socket.handshake.auth && socket.handshake.auth.token;
  4 |       if (!token) return next(new Error("Missing token"));
  5 |       const user = await authenticateToken(token);
  6 |       if (!user) return next(new Error("Invalid or expired token"));
  7 |       socket.data.user = user;
  8 |       next();
  9 |     } catch {
 10 |       next(new Error("Invalid or expired token"));
 11 |     }
 12 |   });
 13 | 
 14 |   io.on("connection", (socket) => {
 15 |     const { sub, locationId, role, permissions } = socket.data.user;
 16 |     socket.join(`location:${locationId}`);
 17 |     socket.join(`location:${locationId}:role:${role}`);
 18 |     for (const p of permissions) socket.join(`location:${locationId}:perm:${p}`);
 19 |     socket.join(`location:${locationId}:${seesPhone(permissions) ? "phone" : "nophone"}`);
 20 |     socket.join(`user:${sub}`);
 21 |   });
 22 | 
 23 |   return io;
```

- **1–12** — Every screen that opens a live connection must show its **token**; it is checked exactly like a web
  request (4.3: exists, active, current token version, password not temporary). Otherwise the connection is refused.
- **14** — A screen connected.
- **15** — Who it is: person, branch, role, permissions.
- **16** — Room for **every** screen of this branch (orders, kitchen updates).
- **17** — Room per role, so all screens of a role can be signed out when its tick-boxes change (they reconnect
  with the new permissions).
- **18** — One room per permission: e.g. payment totals go only to the `DASHBOARD` room, never to kitchen tablets.
- **19** — "phone" or "nophone" room: who may receive customers' phone numbers.
- **20** — A room for this person only (used to sign them out everywhere when disabled or their password changes).

Sending is done by small functions at the bottom of `socket.js`: `emitToLocation` (everyone in the branch),
`emitToPerms` (only screens with a permission), `emitOrderEvent` (phone / no-phone copies),
`disconnectUser`, `disconnectRole`. A screen can never join another branch's rooms: the rooms come from its
verified token, not from anything it asks for.

### 4.9 The screens: talking to the server (`frontend/src/lib/api.js`, `request`)

```js
  1 | async function request(path, { method = "GET", body } = {}) {
  2 |   const headers = { "Content-Type": "application/json" };
  3 |   const token = getToken();
  4 |   if (token) headers.Authorization = `Bearer ${token}`;
  5 | 
  6 |   const res = await fetch(`${base()}${path}`, {
  7 |     method,
  8 |     headers,
  9 |     body: body ? JSON.stringify(body) : undefined,
 10 |   });
 11 | 
 12 |   const data = await res.json().catch(() => ({}));
 13 |   if (res.status === 401) handleUnauthorized(path);
 14 |   if (!res.ok) {
 15 |     if (res.status === 403 && data.code === "PASSWORD_CHANGE_REQUIRED") {
 16 |       localStorage.setItem("mustChange", "1");
 17 |       if (typeof window !== "undefined") window.location.assign(window.location.hash ? "#/change-password" : "/change-password");
 18 |     }
 19 |     const err = new Error(data.error || `Request failed: ${res.status}`);
 20 |     err.status = res.status;
 21 |     err.code = data.code;
 22 |     throw err;
 23 |   }
 24 |   return data;
 25 | }
```

- **1** — Every call to the server goes through this one function, e.g. `request("/orders", { method: "POST", body })`.
- **2–4** — Say "I'm sending JSON" and attach the token (`Bearer ...`) if signed in.
- **6–10** — Send it to the server address (`base()` = this server, or the saved company address in the future apps).
- **12** — Read the reply (or an empty object if there is none).
- **13** — **401** means the session is no longer valid (expired, disabled, password changed): clear it and go to
  sign-in (`handleUnauthorized`, above the function).
- **14–23** — Any other error: if it is "you must choose a new password", go to that page; otherwise throw an error
  carrying the server's message, which the screen shows to the user.
- **24** — Success: return the data.

### 4.10 The screens: what a kitchen board shows (`frontend/src/pages/KitchenDisplay.jsx`)

```js
  1 |   const stations = boardStations(board, kitchenMode);
  2 |   const mine = (item) => stations.includes(stationOf(item));
  3 |   const describe = (items) => items.map((i) => `${i.quantity}x ${i.menuItem.name}`).join(", ");
  4 |   // ...
  5 |   // Tickets with something still to make here (or a dish voided in the last minute),
  6 |   // showing only this station's lines.
  7 |   const tickets = orders
  8 |     .map((order) => ({
  9 |       order,
 10 |       lines: order.items.filter((i) => mine(i) && (TODO.includes(i.status) || i.status === "CANCELLED")),
 11 |     }))
 12 |     .filter((t) => t.lines.some((i) => TODO.includes(i.status) || recentVoids.has(i.id)))
 13 |     .map((t) => ({ ...t, lines: t.lines.filter((i) => TODO.includes(i.status) || recentVoids.has(i.id)) }));
```

- **1** — Which stations this board shows: Bar → `BAR`; Cold Kitchen → `COLD`; Hot (& Cold) Kitchen → `KITCHEN`,
  plus `COLD` in one-kitchen mode (`lib/stations.js`).
- **2** — Is a dish line for this board?
- **3** — Text like "2x Nasi Goreng, 1x Sate" for the alert banner.
- **7–11** — For every open order, keep only this board's lines that are still to make (`PENDING`/`PREPARING`) or voided.
- **12** — Show a ticket only if something is still to make (or a dish was voided in the last minute, so the cook notices).
- **13** — On that ticket, show the lines still to make and any just-voided line. A dish marked READY therefore
  disappears from the board; supervisors find it later in Dashboard > Kitchen history.

The list `orders` itself comes from `hooks/useLiveOrders.js`: it loads the open orders once, then listens for
`order:created`, `order:items-added`, `order-item:updated`, `order-item:voided`, `order:closed` and
`order:voided` and updates the list on screen, and reloads everything whenever the live connection comes back
(so a tablet that slept catches up).

---

## Part 5 — Changing things, testing, and where data lives

### Reply codes you will see in messages and logs

| Code | Meaning |
|---|---|
| 200 / 201 | OK / created. |
| 400 | The request was wrong (missing or invalid value). The message says what. |
| 401 | Not signed in, or the session is no longer valid → back to sign-in. |
| 403 | Signed in, but the role is not allowed to do this (or must change password first). |
| 404 | Not found **in this branch** (other branches' data is invisible on purpose). |
| 409 | Not possible right now (already paid, not enough stock, not all served, role still in use…). |
| 429 | Too many attempts; wait a few minutes. |
| 500 | Unexpected error; details are in the server log only. |

### Common changes and where to make them

| I want to… | Where |
|---|---|
| Change a role's tick-boxes, add a role | No code: **Admin > Roles**. |
| Change prices, dishes, stations, spice, stock counting | No code: **Admin > Menu**. |
| Add a new kind of permission | `backend/src/lib/permissions.js` (add to `PERMISSIONS` and built-in roles), check it in the route with `needs(...)`/`can(...)`/`requirePerm(...)`, mirror it in `frontend/src/lib/permissions.js` (built-ins + short name), and use `can(user, "...")` on screens. Add a test. |
| Add a column to a table | Append to the **end** of `backend/sql/schema.sql`: `ALTER TABLE x ADD COLUMN IF NOT EXISTS ...`. Never edit or delete earlier sections — existing restaurants upgrade by running the file again. |
| Change tax / service rates | No code: **Admin > Billing**. |
| Change how the bill is calculated | `billTotals` in `backend/src/lib/billing.js` (and the demo's `demo_pay_order` if the demo must match). Update `test/billing.test.js`. |
| Change what a screen shows | The page in `frontend/src/pages/`; styling in `frontend/src/index.css`. |
| Change a server address / secret | Not in code: settings files (`%LOCALAPPDATA%\RestaurantChecker\settings.env` on the laptop, `/etc/restaurant-checker/settings.env` on the mini PC, per-company `.env` on the VPS). |

**Golden rules**

1. Every new or changed rule on the server gets a test.
2. Never trust a value from the screen for money, branch or permissions — the server works them out.
3. Only add to `schema.sql` (at the end); don't rewrite history.
4. Keep `locationId` from `req.user`, never from the request.

### Running the tests

Backend (needs a PostgreSQL you can throw away):

```
cd backend
npm install
set TEST_DATABASE_URL=postgresql://user:password@localhost:5432/rc_test
npm test
```

Frontend (no database needed):

```
cd frontend
npm install
npm test
npm run build
```

At the time of writing: **44 backend tests** and **54 frontend tests**, all passing. If a test fails after a change,
the change broke a rule the test protects — read the test's name; it says which rule.

### Where the data lives

| Version | Database | Settings / secrets | Backups |
|---|---|---|---|
| Laptop (Windows + Podman) | inside the Podman machine (volume `rc_onsite_db_data`) | `%LOCALAPPDATA%\RestaurantChecker\settings.env` | `%LOCALAPPDATA%\RestaurantChecker\backups` (`backup.cmd`) |
| Mini PC (Ubuntu) | container volume on the mini PC | `/etc/restaurant-checker/settings.env` | `/var/backups/restaurant-checker` nightly + optional off-site copy |
| VPS (cloud) | one volume per company | `/srv/rc/companies/<slug>/.env` | `/srv/rc/backups/<slug>` |

Deleting the Podman machine (laptop) or the volume deletes the database. **Back up first.** A backup on the same
machine does not survive losing that machine: copy backups somewhere else too.

### If something goes wrong

1. Laptop: run `onsite\laptop\diagnose.cmd`; it writes `diagnose-output.txt` (no passwords) next to it.
2. Look at the server log: `podman logs --tail 50 rc_onsite_app` (laptop) or `sudo docker logs ...` / `podman logs ...` on the mini PC.
3. The `AUDIT.md` file lists known limits; `onsite/README.md` has a troubleshooting table.
4. If the database looks wrong, **stop and restore from a backup** rather than editing it by hand.

### Known limits (summary)

- The server is one machine: if it breaks, orders stop until it is fixed and the backup restored.
- Android/Windows apps are not built yet (the browser works on every device).
- Not a certified tax / e-invoice system; no thermal-printer link; no payment-gateway link.
- The laptop/mini PC install scripts were tested on your laptop; the mini PC installer has not yet been run on real hardware.
