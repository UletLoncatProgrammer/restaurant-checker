// Phase 3: a company's own roles, with tick-box permissions checked by the server.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { io } = require("socket.io-client");
const { pool, migrate, startServer, createTenant, client } = require("./helpers");
const { signToken } = require("../src/middleware/auth");

let server, base, A, B, a;

before(async () => {
  await migrate();
  ({ server, base } = await startServer());
  A = await createTenant({ name: "P3A" });
  B = await createTenant({ name: "P3B" });
  a = Object.fromEntries(Object.entries(A.tokens).map(([r, t]) => [r, client(base, t)]));
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

// a staff member of company A with the given role, ready to use
async function staffWith(role) {
  const id = crypto.randomUUID();
  await pool.query("INSERT INTO users (id, location_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, 'x', $5)", [
    id, A.locationId, `${role} person`, `${id}@t.example`, role,
  ]);
  return { id, call: client(base, signToken({ id, role, locationId: A.locationId })), token: signToken({ id, role, locationId: A.locationId }) };
}

test("the permission list explains every tick-box; only Admin can manage roles", async () => {
  const p = await a.ADMIN("GET", "/users/permissions");
  assert.equal(p.status, 200);
  const keys = p.data.map((x) => x.key);
  for (const k of ["ORDER", "PAY", "BOARD_KITCHEN", "BOARD_COLD", "BOARD_BAR", "DASHBOARD", "HISTORY", "VOID", "EXPORT", "MENU", "STAFF"]) assert.ok(keys.includes(k), k);
  assert.equal(p.data.find((x) => x.key === "STAFF").grantable, false);
  for (const who of ["COORDINATOR", "SUPERVISOR", "FOH", "KITCHEN"]) {
    assert.equal((await a[who]("GET", "/users/roles")).status, 403, who);
    assert.equal((await a[who]("POST", "/users/roles", { label: "X role", permissions: [] })).status, 403, who);
  }
  const me = await a.SUPERVISOR("GET", "/auth/me");
  assert.equal(me.data.user.roleLabel, "Supervisor");
  assert.ok(me.data.user.permissions.includes("VOID"));
});

test("create an own role; its people can do exactly what is ticked", async () => {
  assert.equal((await a.ADMIN("POST", "/users/roles", { label: "Food runner", permissions: ["STAFF"] })).status, 400, "STAFF is Admin-only");
  assert.equal((await a.ADMIN("POST", "/users/roles", { label: "Food runner", permissions: ["FLY"] })).status, 400);
  assert.equal((await a.ADMIN("POST", "/users/roles", { label: "X", permissions: [] })).status, 400, "name too short");
  const r = await a.ADMIN("POST", "/users/roles", { label: "Food runner", permissions: ["ORDER"] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.key, "FOOD_RUNNER");
  assert.equal((await a.ADMIN("POST", "/users/roles", { label: "food RUNNER", permissions: [] })).status, 409, "duplicate name");

  const list = (await a.ADMIN("GET", "/users/roles")).data;
  const fr = list.find((x) => x.key === "FOOD_RUNNER");
  assert.deepEqual(fr.permissions, ["ORDER"]);
  assert.equal(fr.deletable, true);
  assert.equal(fr.builtin, false);

  // the Admin screen can give someone the role
  const created = await a.ADMIN("POST", "/users", { name: "Rina Runner", email: `${crypto.randomUUID()}@t.example`, role: "FOOD_RUNNER" });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  const runner = await staffWith("FOOD_RUNNER");
  const o = await runner.call("POST", "/orders", { tableId: A.tables.T1, customerPhone: "0812", items: [{ menuItemId: A.menu.nasi }] });
  assert.equal(o.status, 201, "ORDER lets them take orders");
  assert.equal((await runner.call("PATCH", `/orders/${o.data.id}/items/${o.data.items[0].id}`, { status: "PREPARING" })).status, 403, "no kitchen screen");
  await a.KITCHEN("PATCH", `/orders/${o.data.id}/items/${o.data.items[0].id}`, { status: "PREPARING" });
  await a.KITCHEN("PATCH", `/orders/${o.data.id}/items/${o.data.items[0].id}`, { status: "READY" });
  assert.equal((await runner.call("PATCH", `/orders/${o.data.id}/items/${o.data.items[0].id}`, { status: "DELIVERED" })).status, 200, "serves it");
  assert.equal((await runner.call("GET", `/payments/bill/${o.data.id}`)).status, 403, "no PAY");
  assert.equal((await runner.call("GET", "/transactions")).status, 403, "no DASHBOARD");
  assert.equal((await runner.call("GET", "/orders/history")).status, 403, "no HISTORY");
  assert.equal((await runner.call("POST", "/menu/categories", { name: "Nope" })).status, 403, "no MENU");
  assert.equal((await runner.call("GET", "/users")).status, 403, "no STAFF");
  const open = (await runner.call("GET", "/orders/open")).data.find((x) => x.id === o.data.id);
  assert.equal(open.customer.phone, "0812", "ORDER may see the phone");

  // another company does not have this role
  assert.equal((await client(base, B.tokens.ADMIN)("GET", "/users/roles")).data.some((x) => x.key === "FOOD_RUNNER"), false);
  assert.equal((await client(base, B.tokens.ADMIN)("POST", "/users", { name: "Nope Person", email: `${crypto.randomUUID()}@t.example`, role: "FOOD_RUNNER" })).status, 400);
});

test("changing a role's tick-boxes takes effect at once and signs its screens out", async () => {
  const runner = await staffWith("FOOD_RUNNER");
  const sock = io(base, { transports: ["websocket"], auth: { token: runner.token } });
  await new Promise((res, rej) => { sock.on("connect", res); sock.on("connect_error", rej); });
  const kicked = new Promise((res) => sock.on("disconnect", res));

  const p = await a.ADMIN("PATCH", "/users/roles/FOOD_RUNNER", { permissions: ["BOARD_BAR"] });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  await kicked;
  sock.close();

  assert.equal((await runner.call("POST", "/orders", { tableId: A.tables.T2, items: [{ menuItemId: A.menu.nasi }] })).status, 403, "ORDER taken away");

  // a bar dish and a kitchen dish: the runner (now bar) may start only the bar one
  await a.ADMIN("PATCH", `/menu/items/${A.menu.tea}`, { station: "BAR" });
  const o = (await a.FOH("POST", "/orders", { tableId: A.tables.T2, customerPhone: "0899", items: [{ menuItemId: A.menu.tea }, { menuItemId: A.menu.odd }] })).data;
  const tea = o.items.find((i) => i.menuItem.id === A.menu.tea);
  const odd = o.items.find((i) => i.menuItem.id === A.menu.odd);
  assert.equal((await runner.call("PATCH", `/orders/${o.id}/items/${tea.id}`, { status: "PREPARING" })).status, 200);
  assert.equal((await runner.call("PATCH", `/orders/${o.id}/items/${odd.id}`, { status: "PREPARING" })).status, 403);
  const open = (await runner.call("GET", "/orders/open")).data.find((x) => x.id === o.id);
  assert.equal(open.customer.phone, null, "a bar-only role does not see phone numbers");
});

test("built-in roles can be adjusted (not Admin); cold dishes follow the kitchen mode", async () => {
  assert.equal((await a.ADMIN("PATCH", "/users/roles/ADMIN", { permissions: ["ORDER"] })).status, 400);
  assert.equal((await a.ADMIN("PATCH", "/users/roles/NOPE", { permissions: [] })).status, 404);

  // take the bar away from the kitchen role
  assert.equal((await a.ADMIN("PATCH", "/users/roles/KITCHEN", { permissions: ["BOARD_KITCHEN", "BOARD_COLD"] })).status, 200);
  const o = (await a.FOH("POST", "/orders", { tableId: A.tables.T3, items: [{ menuItemId: A.menu.tea }] })).data; // tea is BAR now
  assert.equal((await a.KITCHEN("PATCH", `/orders/${o.id}/items/${o.items[0].id}`, { status: "PREPARING" })).status, 403);
  assert.equal((await a.ADMIN("PATCH", "/users/roles/KITCHEN", { permissions: ["BOARD_KITCHEN", "BOARD_COLD", "BOARD_BAR"] })).status, 200);
  assert.equal((await a.KITCHEN("PATCH", `/orders/${o.id}/items/${o.items[0].id}`, { status: "PREPARING" })).status, 200);
  const list = (await a.ADMIN("GET", "/users/roles")).data;
  assert.equal(list.find((x) => x.key === "KITCHEN").label, "Kitchen / bar", "built-in names stay");

  // a hot-kitchen-only role: may make cold dishes in one-kitchen mode, not in split mode
  assert.equal((await a.ADMIN("POST", "/users/roles", { label: "Hot cook", permissions: ["BOARD_KITCHEN"] })).status, 201);
  const cook = await staffWith("HOT_COOK");
  await a.ADMIN("PATCH", `/menu/items/${A.menu.nasi}`, { station: "COLD" });
  const t = (await a.ADMIN("POST", "/locations/tables", { label: "Cold test" })).data;
  const c1 = (await a.FOH("POST", "/orders", { tableId: t.id, items: [{ menuItemId: A.menu.nasi }, { menuItemId: A.menu.nasi, quantity: 2 }] })).data;
  assert.equal((await cook.call("PATCH", `/orders/${c1.id}/items/${c1.items[0].id}`, { status: "PREPARING" })).status, 200, "ONE mode: hot screen shows cold dishes");
  await a.ADMIN("PATCH", "/locations/settings", { kitchenMode: "SPLIT" });
  assert.equal((await cook.call("PATCH", `/orders/${c1.id}/items/${c1.items[1].id}`, { status: "PREPARING" })).status, 403, "SPLIT: cold kitchen's job");
  await a.ADMIN("PATCH", "/locations/settings", { kitchenMode: "ONE" });
  await a.ADMIN("PATCH", `/menu/items/${A.menu.nasi}`, { station: "KITCHEN" });
});

test("own roles are deleted only when nobody has them; built-ins are switched off instead", async () => {
  assert.equal((await a.ADMIN("DELETE", "/users/roles/KITCHEN")).status, 400);
  assert.equal((await a.ADMIN("DELETE", "/users/roles/NOPE")).status, 404);
  assert.equal((await a.ADMIN("PATCH", "/users/roles/HOT_COOK", { enabled: false })).status, 400, "own roles are deleted, not switched off");

  const blocked = await a.ADMIN("DELETE", "/users/roles/FOOD_RUNNER");
  assert.equal(blocked.status, 409, "people still have it");
  assert.match(blocked.data.error, /still have this role/);
  await pool.query("UPDATE users SET role = 'FOH' WHERE location_id = $1 AND role IN ('FOOD_RUNNER', 'HOT_COOK')", [A.locationId]);
  assert.equal((await a.ADMIN("DELETE", "/users/roles/FOOD_RUNNER")).status, 200);
  assert.equal((await a.ADMIN("DELETE", "/users/roles/HOT_COOK")).status, 200);
  assert.equal((await a.ADMIN("GET", "/users/roles")).data.some((x) => !x.builtin), false);
});
