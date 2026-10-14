const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const { io } = require("socket.io-client");
const { pool, uid, migrate, startServer, createTenant, client } = require("./helpers");
const { loadConfig } = require("../src/config");
const { passwordProblem } = require("../src/lib/password");

let server, base, A, B, adminA, adminB, anon;

before(async () => {
  await migrate();
  ({ server, base } = await startServer());
  A = await createTenant({ name: "SecA" });
  B = await createTenant({ name: "SecB" });
  adminA = client(base, A.tokens.ADMIN);
  adminB = client(base, B.tokens.ADMIN);
  anon = client(base, null);
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

const GOOD = "Tr4veling-Fox-9";
async function makeStaff(adm, role, name = "Staff " + uid().slice(0, 4)) {
  const email = `${uid()}@Example.COM`;
  const r = await adm("POST", "/users", { name, email, role });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { email, id: r.data.user.id, temp: r.data.temporaryPassword };
}
// Creates a staff member who has already chosen their own password; returns a client + token.
async function readyStaff(adm, role) {
  const s = await makeStaff(adm, role);
  const l = await anon("POST", "/auth/login", { email: s.email, password: s.temp });
  assert.equal(l.status, 200, JSON.stringify(l.data));
  const c = await client(base, l.data.token)("POST", "/auth/change-password", { currentPassword: s.temp, newPassword: GOOD });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  return { ...s, token: c.data.token, call: client(base, c.data.token) };
}

test("no open signup, no public company list; /public/info is minimal", async () => {
  const su = await anon("POST", "/auth/signup", { name: "x", email: "x@y.zz", password: GOOD, locationId: A.locationId, role: "FOH" });
  assert.equal(su.status, 404);
  const pl = await anon("GET", "/public/locations");
  assert.equal(pl.status, 404);
  const info = await anon("GET", "/public/info");
  assert.equal(info.status, 200);
  assert.deepEqual(Object.keys(info.data).sort(), ["apiVersion", "app", "name"]);
});

test("security headers, JSON 404/400, readiness", async () => {
  const r = await anon("GET", "/health/ready", null, { raw: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-powered-by"), null);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const nf = await anon("GET", "/nope");
  assert.equal(nf.status, 404);
  const bad = await fetch(base + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "Invalid JSON body" });
});

test("production config refuses weak secrets, wildcard CORS and default DB password", () => {
  const ok = { NODE_ENV: "production", JWT_SECRET: "x".repeat(8) + "Zk3!pQ9vLm2#Rt7wYb5@Hd8nUc4$Fg6j", CORS_ORIGIN: "https://acme.example.com", DATABASE_URL: "postgresql://rc:Strong-pw-1@db:5432/rc" };
  assert.doesNotThrow(() => loadConfig(ok));
  assert.throws(() => loadConfig({ ...ok, JWT_SECRET: "short" }), /at least 32/);
  assert.throws(() => loadConfig({ ...ok, JWT_SECRET: "change-this-to-a-long-random-string-before-any-real-deployment" }), /at least 32/);
  assert.throws(() => loadConfig({ ...ok, CORS_ORIGIN: "*" }), /not allowed in production/);
  assert.throws(() => loadConfig({ ...ok, DATABASE_URL: "postgresql://restaurant:restaurant@db:5432/x" }), /default restaurant/);
  assert.throws(() => loadConfig({ ...ok, JWT_SECRET: "" }), /JWT_SECRET is not set/);
  assert.doesNotThrow(() => loadConfig({ JWT_SECRET: "dev", CORS_ORIGIN: "*" })); // development stays easy
  assert.deepEqual(loadConfig({ ...ok, CORS_ORIGIN: "https://a.example.com, capacitor://localhost" }).corsOrigins, ["https://a.example.com", "capacitor://localhost"]);
});

test("password policy", () => {
  assert.match(passwordProblem("short"), /at least 8/);
  assert.match(passwordProblem("aaaaaaaaaa"), /too simple/);
  assert.match(passwordProblem("Password123"), /too common/);
  assert.match(passwordProblem("a".repeat(80)), /72/);
  assert.match(passwordProblem("me@acme.com", { email: "me@acme.com" }), /e-mail/);
  assert.equal(passwordProblem(GOOD), null);
});

test("staff management is ADMIN-only; temp password forces a change; old sessions die", async () => {
  for (const role of ["COORDINATOR", "SUPERVISOR", "FOH", "KITCHEN"]) {
    const c = client(base, A.tokens[role]);
    assert.equal((await c("GET", "/users")).status, 403, role + " must not list staff");
    assert.equal((await c("POST", "/users", { name: "Nope", email: `${uid()}@t.example`, role: "FOH" })).status, 403);
  }
  const s = await makeStaff(adminA, "FOH");
  assert.equal(s.temp.length, 12);
  // e-mail is case-insensitive and unique
  const dup = await adminA("POST", "/users", { name: "Dup", email: s.email.toLowerCase(), role: "FOH" });
  assert.equal(dup.status, 409);
  // a temporary-password login may only change the password
  const l = await anon("POST", "/auth/login", { email: s.email.toLowerCase(), password: s.temp });
  assert.equal(l.status, 200);
  assert.equal(l.data.mustChangePassword, true);
  const t0 = client(base, l.data.token);
  assert.equal((await t0("GET", "/menu/categories")).status, 403);
  assert.equal((await t0("GET", "/menu/categories")).data.code, "PASSWORD_CHANGE_REQUIRED");
  assert.equal((await t0("GET", "/auth/me")).status, 200);
  assert.equal((await t0("POST", "/auth/change-password", { currentPassword: "wrong-one-1", newPassword: GOOD })).status, 401);
  assert.equal((await t0("POST", "/auth/change-password", { currentPassword: s.temp, newPassword: "short" })).status, 400);
  assert.equal((await t0("POST", "/auth/change-password", { currentPassword: s.temp, newPassword: s.temp })).status, 400);
  const ch = await t0("POST", "/auth/change-password", { currentPassword: s.temp, newPassword: GOOD });
  assert.equal(ch.status, 200);
  // the token from before the change no longer works; the new one does
  assert.equal((await t0("GET", "/menu/categories")).status, 401);
  assert.equal((await client(base, ch.data.token)("GET", "/menu/categories")).status, 200);
  assert.equal((await anon("POST", "/auth/login", { email: s.email, password: s.temp })).status, 401);
  assert.equal((await anon("POST", "/auth/login", { email: s.email, password: GOOD })).status, 200);
});

test("disabling or re-roling staff takes effect on the very next request, and kicks live screens", async () => {
  const foh = await readyStaff(adminA, "FOH");
  assert.equal((await foh.call("GET", "/orders/open")).status, 200);
  const sock = io(base, { transports: ["websocket"], auth: { token: foh.token }, reconnection: false });
  await new Promise((res, rej) => { sock.on("connect", res); sock.on("connect_error", rej); });
  const dropped = new Promise((res) => sock.on("disconnect", res));

  // role change: FOH -> KITCHEN loses the POS immediately
  assert.equal((await adminA("PATCH", `/users/${foh.id}`, { role: "KITCHEN" })).status, 200);
  assert.equal((await foh.call("GET", "/orders/open")).status, 401, "old token is revoked when the role changes");
  await Promise.race([dropped, new Promise((_, rej) => setTimeout(() => rej(new Error("socket not disconnected")), 3000))]);

  const l = await anon("POST", "/auth/login", { email: foh.email, password: GOOD });
  assert.equal(l.data.user.role, "KITCHEN");
  const kitchen = client(base, l.data.token);
  assert.equal((await kitchen("GET", "/payments/bill/" + uid())).status, 403);

  // disable: token dies at once, login refused
  assert.equal((await adminA("PATCH", `/users/${foh.id}`, { active: false })).status, 200);
  assert.equal((await kitchen("GET", "/orders/open")).status, 401);
  assert.equal((await anon("POST", "/auth/login", { email: foh.email, password: GOOD })).status, 401);
  assert.equal((await adminA("PATCH", `/users/${foh.id}`, { active: true })).status, 200);
  assert.equal((await anon("POST", "/auth/login", { email: foh.email, password: GOOD })).status, 200);
});

test("admin password reset revokes old sessions and forces a new password", async () => {
  const k = await readyStaff(adminA, "KITCHEN");
  const r = await adminA("POST", `/users/${k.id}/reset-password`);
  assert.equal(r.status, 200);
  assert.equal(r.data.temporaryPassword.length, 12);
  assert.equal((await k.call("GET", "/orders/open")).status, 401);
  assert.equal((await anon("POST", "/auth/login", { email: k.email, password: GOOD })).status, 401);
  const l = await anon("POST", "/auth/login", { email: k.email, password: r.data.temporaryPassword });
  assert.equal(l.data.mustChangePassword, true);
  assert.equal((await adminB("POST", `/users/${k.id}/reset-password`)).status, 404, "another company's admin cannot reset");
});

test("the last active ADMIN cannot be removed; other companies' staff are untouchable", async () => {
  const C = await createTenant({ name: "SecC" }); // own company so revoking its admin cannot disturb other tests
  const adminC = client(base, C.tokens.ADMIN);
  const list = (await adminC("GET", "/users")).data;
  const first = list.find((u) => u.role === "ADMIN");
  assert.equal((await adminC("PATCH", `/users/${first.id}`, { role: "FOH" })).status, 409);
  assert.equal((await adminC("PATCH", `/users/${first.id}`, { active: false })).status, 409);

  // company B can neither see nor touch company C's staff
  const target = list.find((u) => u.role === "KITCHEN");
  assert.ok(!(await adminB("GET", "/users")).data.some((u) => u.id === target.id));
  assert.equal((await adminB("PATCH", `/users/${target.id}`, { active: false })).status, 404);

  // with a second active admin the first may be demoted - and the demoted person's session ends at once
  const second = await readyStaff(adminC, "ADMIN");
  assert.equal((await second.call("PATCH", `/users/${first.id}`, { role: "COORDINATOR" })).status, 200);
  assert.equal((await adminC("GET", "/users")).status, 401, "a demoted admin's old token is revoked");
  // and now the remaining admin is the last one
  assert.equal((await second.call("PATCH", `/users/${second.id}`, { active: false })).status, 409);
});

test("failed logins lock the account for a few minutes; unknown e-mail looks the same; events are logged", async () => {
  const s = await readyStaff(adminA, "FOH");
  const bad = [];
  for (let i = 0; i < 5; i++) bad.push(await anon("POST", "/auth/login", { email: s.email, password: "Wrong-pass-" + i }));
  assert.ok(bad.every((r) => r.status === 401 && r.data.error === "Invalid credentials"));
  const locked = await anon("POST", "/auth/login", { email: s.email, password: GOOD });
  assert.equal(locked.status, 429, "even the right password is refused while locked");
  assert.match(locked.data.error, /Try again in/);
  const ghost = await anon("POST", "/auth/login", { email: `${uid()}@nowhere.example`, password: "Whatever-1" });
  assert.equal(ghost.status, 401);
  assert.equal(ghost.data.error, "Invalid credentials");
  // unlock (as time would) and confirm a good login resets the counter
  await pool.query("UPDATE users SET locked_until = now() - interval '1 second' WHERE id = $1", [s.id]);
  assert.equal((await anon("POST", "/auth/login", { email: s.email, password: GOOD })).status, 200);
  const { rows } = await pool.query("SELECT type, count(*)::int AS n FROM auth_events WHERE user_id = $1 GROUP BY type", [s.id]);
  const by = Object.fromEntries(rows.map((r) => [r.type, r.n]));
  assert.ok(by.LOCKED >= 1 && by.LOGIN_FAIL >= 4 && by.LOGIN_OK >= 1 && by.LOGIN_BLOCKED >= 1, JSON.stringify(by));
  assert.equal((await pool.query("SELECT failed_logins FROM users WHERE id = $1", [s.id])).rows[0].failed_logins, 0);
});

test("menu and table editing: validated, role-gated, tenant-scoped, history keeps its prices", async () => {
  const coord = client(base, A.tokens.COORDINATOR);
  const foh = client(base, A.tokens.FOH);
  assert.equal((await foh("POST", "/menu/items", { name: "x", price: 1 })).status, 403);
  for (const bad of [{ name: "A", price: -5 }, { name: "A", price: "10" }, { name: "A", price: 1e12 }, { name: "A", price: 5, taxRate: 1.5 }, { name: "", price: 5 }, { name: "A", price: 5, station: "" }]) {
    assert.equal((await coord("POST", "/menu/items", bad)).status, 400, JSON.stringify(bad));
  }
  const cat = (await coord("POST", "/menu/categories", { name: "Specials", sortOrder: 9 })).data;
  const item = (await coord("POST", "/menu/items", { name: "Rendang", price: 60000, taxRate: 0.1, categoryId: cat.id, trackStock: false })).data;
  assert.equal(item.category_id, cat.id);
  // category of another company is refused (API) and impossible even by raw SQL (trigger)
  const catB = (await adminB("POST", "/menu/categories", { name: "B cat" })).data;
  assert.equal((await coord("POST", "/menu/items", { name: "Sneaky", price: 1, categoryId: catB.id })).status, 400);
  assert.equal((await coord("PATCH", `/menu/items/${item.id}`, { categoryId: catB.id })).status, 400);
  await assert.rejects(pool.query("INSERT INTO menu_items (id, location_id, category_id, name, price) VALUES ($1, $2, $3, 'raw', 1)", [uid(), A.locationId, catB.id]), /another location/);
  // company B cannot touch company A's dish
  assert.equal((await adminB("PATCH", `/menu/items/${item.id}`, { price: 1 })).status, 404);
  // sell it, then change the price: the sold line keeps 60000
  const order = (await foh("POST", "/orders", { tableId: A.tables.T1, items: [{ menuItemId: item.id, quantity: 1 }] })).data;
  assert.equal(order.items[0].unitPrice, 60000);
  assert.equal((await coord("PATCH", `/menu/items/${item.id}`, { price: 75000 })).data.price, "75000.00");
  const open = (await foh("GET", "/orders/open")).data.find((o) => o.id === order.id);
  assert.equal(open.items[0].unitPrice, 60000, "price edits never rewrite history");
  // switching a dish off hides it and blocks new orders
  assert.equal((await coord("PATCH", `/menu/items/${item.id}`, { active: false })).status, 200);
  const cats = (await foh("GET", "/menu/categories")).data;
  assert.ok(!cats.flatMap((c) => c.menuItems).some((m) => m.id === item.id));
  assert.equal((await foh("POST", "/orders", { tableId: A.tables.T2, items: [{ menuItemId: item.id }] })).status, 400);
  // categories: cannot delete while it holds an active dish
  const item2 = (await coord("POST", "/menu/items", { name: "Soto", price: 30000, categoryId: cat.id })).data;
  assert.equal((await coord("DELETE", `/menu/categories/${cat.id}`)).status, 409);
  await coord("PATCH", `/menu/items/${item2.id}`, { active: false });
  assert.equal((await coord("DELETE", `/menu/categories/${cat.id}`)).status, 200);
  assert.equal((await adminB("DELETE", `/menu/categories/${catB.id}`)).status, 200);

  // tables
  assert.equal((await coord("POST", "/locations/tables", { label: "" })).status, 400);
  const t = (await coord("POST", "/locations/tables", { label: "Patio 1" })).data;
  assert.equal((await coord("POST", "/locations/tables", { label: "patio 1" })).status, 409, "duplicate name, any case");
  assert.equal((await adminB("PATCH", `/locations/tables/${t.id}`, { label: "stolen" })).status, 404);
  const o2 = (await foh("POST", "/orders", { tableId: t.id, items: [{ menuItemId: A.menu.nasi }] })).data;
  assert.equal((await coord("PATCH", `/locations/tables/${t.id}`, { active: false })).status, 409, "open order blocks");
  await adminA("POST", `/orders/${o2.id}/void`, { reason: "test cleanup" }); // ADMIN may void
  assert.equal((await coord("PATCH", `/locations/tables/${t.id}`, { active: false })).status, 200);
  assert.ok(!(await foh("GET", "/locations/tables")).data.some((x) => x.id === t.id));
  assert.equal((await foh("POST", "/orders", { tableId: t.id, items: [{ menuItemId: A.menu.nasi }] })).status, 404, "inactive table cannot take orders");
});

test("database refuses cross-company rows even if a query forgets to filter", async () => {
  // order on another company's table
  await assert.rejects(pool.query("INSERT INTO orders (id, location_id, table_id, opened_by_id) VALUES ($1, $2, $3, $4)", [uid(), A.locationId, B.tables.T1, A.users.FOH]), /another location/);
  // order line pointing at another company's dish
  const oid = uid();
  await pool.query("INSERT INTO orders (id, location_id, table_id, opened_by_id) VALUES ($1, $2, $3, $4)", [oid, A.locationId, A.tables.T3, A.users.FOH]);
  await assert.rejects(pool.query("INSERT INTO order_items (id, order_id, menu_item_id, quantity, unit_price, tax_rate) VALUES ($1, $2, $3, 1, 1, 0)", [uid(), oid, B.menu.nasi]), /another location/);
  // stock movement for another company's dish
  await assert.rejects(pool.query("INSERT INTO stock_movements (id, location_id, menu_item_id, delta, reason) VALUES ($1, $2, $3, 1, 'RECEIVE')", [uid(), A.locationId, B.menu.tea]), /another location/);
  // money sanity
  await assert.rejects(pool.query("UPDATE menu_items SET price = -1 WHERE id = $1", [A.menu.nasi]), /menu_items_price_nonneg/);
  await assert.rejects(pool.query("UPDATE menu_items SET tax_rate = 2 WHERE id = $1", [A.menu.nasi]), /menu_items_tax_rate_range/);
  await pool.query("UPDATE orders SET status = 'CANCELLED' WHERE id = $1", [oid]);
});

test("provisioning: empty database -> one company + ADMIN with a temporary password; refuses a second company", async () => {
  const backendDir = path.join(__dirname, "..");
  const dbName = "rc_prov_" + uid().slice(0, 8).replace(/-/g, "");
  const baseUrl = new URL(process.env.DATABASE_URL);
  await pool.query(`CREATE DATABASE ${dbName}`);
  try {
    baseUrl.pathname = "/" + dbName;
    const env = { ...process.env, DATABASE_URL: baseUrl.toString(), BCRYPT_COST: "4", NODE_ENV: "test" };
    const run = (file, args = []) => spawnSync(process.execPath, [path.join(backendDir, "src", file), ...args], { env, encoding: "utf8", cwd: backendDir });
    assert.equal(run("migrate.js").status, 0);
    const bad = run("provision.js", ["--company", "Acme", "--admin-email", "not-an-email"]);
    assert.notEqual(bad.status, 0);
    const ok = run("provision.js", ["--company", "Acme Foods", "--location", "Main", "--admin-email", "Owner@Acme.com", "--tables", "3", "--timezone", "Asia/Jakarta"]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const temp = /TEMPORARY_PASSWORD=(\S+)/.exec(ok.stdout)[1];
    assert.equal(temp.length, 12);
    const { Client } = require("pg");
    const c = new Client({ connectionString: baseUrl.toString() });
    await c.connect();
    const u = (await c.query("SELECT * FROM users")).rows;
    assert.equal(u.length, 1);
    assert.equal(u[0].email, "owner@acme.com");
    assert.equal(u[0].role, "ADMIN");
    assert.equal(u[0].must_change_password, true);
    assert.ok(await bcrypt.compare(temp, u[0].password_hash));
    assert.equal((await c.query("SELECT count(*)::int AS n FROM restaurant_tables")).rows[0].n, 3);
    await c.end();
    const again = run("provision.js", ["--company", "Other Co", "--admin-email", "x@other.com"]);
    assert.notEqual(again.status, 0);
    assert.match(again.stdout + again.stderr, /already has a company/);
  } finally {
    await pool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  }
});

test("web app is served with the API when a build is present; API paths never fall through to HTML", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-static-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>RC</title><div id=root></div>");
  fs.writeFileSync(path.join(dir, "app.js"), "console.log(1)");
  process.env.STATIC_DIR = dir;
  const s = await startServer();
  delete process.env.STATIC_DIR;
  try {
    const page = await fetch(s.base + "/dashboard");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<div id=root>/);
    assert.match(page.headers.get("content-security-policy"), /media-src 'self' blob: data:/);
    assert.equal((await fetch(s.base + "/app.js")).status, 200);
    const api = await fetch(s.base + "/orders/open");
    assert.equal(api.status, 401);
    assert.match(api.headers.get("content-type"), /json/);
    const nf = await fetch(s.base + "/auth/nothing");
    assert.match(nf.headers.get("content-type"), /json/);
    assert.equal(nf.status, 404);
  } finally {
    await new Promise((r) => s.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a company can remove built-in roles it does not use (and bring them back)", async () => {
  const T = await createTenant({ name: "RolesCo" });
  const adm = client(base, T.tokens.ADMIN);

  const list = await adm("GET", "/users/roles");
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 5);
  assert.ok(list.data.every((r) => r.enabled));
  assert.equal(list.data.find((r) => r.role === "ADMIN").removable, false);

  // ADMIN can never be removed
  assert.equal((await adm("PATCH", "/users/roles/ADMIN", { enabled: false })).status, 400);
  assert.equal((await adm("PATCH", "/users/roles/NOPE", { enabled: false })).status, 404);
  assert.equal((await adm("PATCH", "/users/roles/SUPERVISOR", { enabled: "no" })).status, 400);

  // blocked while an active person holds it
  const sup = await makeStaff(adm, "SUPERVISOR");
  const blocked = await adm("PATCH", "/users/roles/SUPERVISOR", { enabled: false });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /2 active staff members have/); // the new one + the tenant's seeded one

  // move them away, then it can go
  assert.equal((await adm("PATCH", `/users/${sup.id}`, { role: "FOH" })).status, 200);
  assert.equal((await adm("PATCH", `/users/${T.users.SUPERVISOR}`, { role: "FOH" })).status, 200);
  assert.equal((await adm("PATCH", "/users/roles/SUPERVISOR", { enabled: false })).status, 200);
  const after = await adm("GET", "/users/roles");
  assert.equal(after.data.find((r) => r.role === "SUPERVISOR").enabled, false);

  // nobody can be created in, or moved into, a removed role
  const create = await adm("POST", "/users", { name: "Nope Person", email: `${uid()}@example.com`, role: "SUPERVISOR" });
  assert.equal(create.status, 409);
  assert.equal((await adm("PATCH", `/users/${sup.id}`, { role: "SUPERVISOR" })).status, 409);

  // a disabled person can't be re-enabled into a role that was removed meanwhile
  const kit = await makeStaff(adm, "KITCHEN");
  assert.equal((await adm("PATCH", `/users/${kit.id}`, { active: false })).status, 200);
  assert.equal((await adm("PATCH", `/users/${T.users.KITCHEN}`, { active: false })).status, 200);
  assert.equal((await adm("PATCH", "/users/roles/KITCHEN", { enabled: false })).status, 200);
  assert.equal((await adm("PATCH", `/users/${kit.id}`, { active: true })).status, 409);

  // removal is per company: another company still has every role
  const other = await adminB("GET", "/users/roles");
  assert.ok(other.data.every((r) => r.enabled));

  // restoring works and allows use again
  assert.equal((await adm("PATCH", "/users/roles/SUPERVISOR", { enabled: true })).status, 200);
  assert.equal((await adm("PATCH", `/users/${sup.id}`, { role: "SUPERVISOR" })).status, 200);

  // only ADMIN may manage roles
  const fohToken = T.tokens.FOH;
  assert.equal((await client(base, fohToken)("PATCH", "/users/roles/KITCHEN", { enabled: true })).status, 403);
});
