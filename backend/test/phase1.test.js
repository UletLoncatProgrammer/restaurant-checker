// Phase 1: kitchen stations (Hot / Cold / Bar), kitchen mode, and one open bill per table.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { io } = require("socket.io-client");
const { pool, migrate, startServer, createTenant, client } = require("./helpers");

let server, base, A, B, a;

before(async () => {
  await migrate();
  ({ server, base } = await startServer());
  A = await createTenant({ name: "P1A" });
  B = await createTenant({ name: "P1B" });
  a = Object.fromEntries(Object.entries(A.tokens).map(([r, t]) => [r, client(base, t)]));
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

const send = (who, table, lines) =>
  a[who]("POST", "/orders", { tableId: A.tables[table], items: lines.map(([id, q]) => ({ menuItemId: id, quantity: q || 1 })) });

async function walk(order, itemId, steps) {
  for (const [to, who] of steps) {
    const r = await a[who]("PATCH", `/orders/${order.id}/items/${itemId}`, { status: to });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
}
const FULL = [["PREPARING", "KITCHEN"], ["READY", "KITCHEN"], ["DELIVERED", "FOH"]];

test("dishes have a station; order lines keep the station they were ordered with", async () => {
  const mk = (name, station) => a.ADMIN("POST", "/menu/items", { name, price: 20000, station });
  const bar = await mk("Kopi Susu", "bar");
  const cold = await mk("Es Campur", "COLD");
  const hot = await mk("Sate", "hot");
  assert.equal(bar.status, 201);
  assert.equal(bar.data.station, "BAR");
  assert.equal(cold.data.station, "COLD");
  assert.equal(hot.data.station, "KITCHEN");
  assert.equal((await mk("Bad", "grill")).status, 400);
  assert.equal((await a.ADMIN("POST", "/menu/items", { name: "Default", price: 1000 })).data.station, "KITCHEN");

  const r = await send("FOH", "T1", [[bar.data.id], [cold.data.id], [hot.data.id]]);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const byName = Object.fromEntries(r.data.items.map((i) => [i.menuItem.name, i.station]));
  assert.deepEqual(byName, { "Kopi Susu": "BAR", "Es Campur": "COLD", Sate: "KITCHEN" });

  // moving the dish to another station later does not move the ticket already sent
  assert.equal((await a.ADMIN("PATCH", `/menu/items/${bar.data.id}`, { station: "KITCHEN" })).status, 200);
  const open = (await a.FOH("GET", "/orders/open")).data.find((o) => o.id === r.data.id);
  assert.equal(open.items.find((i) => i.menuItem.name === "Kopi Susu").station, "BAR");

  // the database refuses a station outside the three
  await assert.rejects(pool.query("UPDATE menu_items SET station = 'GRILL' WHERE id = $1", [hot.data.id]));
});

test("kitchen mode: everyone can read it, only ADMIN/COORDINATOR can change it, per company", async () => {
  const g = await a.KITCHEN("GET", "/locations/settings");
  assert.equal(g.status, 200);
  assert.equal(g.data.kitchenMode, "ONE");
  assert.equal((await a.FOH("PATCH", "/locations/settings", { kitchenMode: "SPLIT" })).status, 403);
  assert.equal((await a.KITCHEN("PATCH", "/locations/settings", { kitchenMode: "SPLIT" })).status, 403);
  assert.equal((await a.COORDINATOR("PATCH", "/locations/settings", { kitchenMode: "both" })).status, 400);

  // open screens are told at once
  const sock = io(base, { transports: ["websocket"], auth: { token: A.tokens.KITCHEN } });
  await new Promise((res, rej) => { sock.on("connect", res); sock.on("connect_error", rej); });
  const pushed = new Promise((res) => sock.on("settings:updated", res));
  const p = await a.COORDINATOR("PATCH", "/locations/settings", { kitchenMode: "SPLIT" });
  assert.equal(p.status, 200);
  assert.equal(p.data.kitchenMode, "SPLIT");
  assert.equal((await pushed).kitchenMode, "SPLIT");
  sock.close();

  const other = await client(base, B.tokens.ADMIN)("GET", "/locations/settings");
  assert.equal(other.data.kitchenMode, "ONE", "another company is not affected");
  assert.equal((await a.ADMIN("PATCH", "/locations/settings", { kitchenMode: "ONE" })).status, 200);
});

test("a second round for a table goes onto the same open bill", async () => {
  const first = await send("FOH", "T2", [[A.menu.nasi, 1]]);
  assert.equal(first.status, 201);
  assert.equal(first.data.added, false);

  // a kitchen screen hears about the added lines (not a "new order")
  const sock = io(base, { transports: ["websocket"], auth: { token: A.tokens.KITCHEN } });
  await new Promise((res, rej) => { sock.on("connect", res); sock.on("connect_error", rej); });
  let createdEvents = 0;
  sock.on("order:created", () => createdEvents++);
  const addedEvt = new Promise((res) => sock.on("order:items-added", res));

  const second = await send("COORDINATOR", "T2", [[A.menu.odd, 2]]);
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal(second.data.added, true);
  assert.equal(second.data.id, first.data.id, "same order");
  assert.equal(second.data.items.length, 2);
  const e = await addedEvt;
  assert.equal(e.order.id, first.data.id);
  assert.equal(e.addedItemIds.length, 1);
  assert.equal(e.order.items.find((i) => i.id === e.addedItemIds[0]).menuItem.id, A.menu.odd);
  assert.equal(createdEvents, 0);
  sock.close();

  const open = (await a.FOH("GET", "/orders/open")).data.filter((o) => o.table.id === A.tables.T2);
  assert.equal(open.length, 1);

  // the activity log says what happened
  const types = (await pool.query("SELECT type FROM order_events WHERE order_id = $1 ORDER BY created_at", [first.data.id])).rows.map((r) => r.type);
  assert.deepEqual(types, ["ORDER_CREATED", "ITEMS_ADDED"]);

  // the bill covers both rounds; it can be paid only when everything is served
  for (const it of second.data.items) await walk(second.data, it.id, FULL);
  const bill = await a.FOH("GET", `/payments/bill/${first.data.id}`);
  assert.equal(bill.status, 200);
  assert.equal(bill.data.subtotal, 45000 + 2 * 33333);
  const pay = await a.FOH("POST", "/payments", { orderId: first.data.id, method: "CARD" });
  assert.equal(pay.status, 201, JSON.stringify(pay.data));

  // after paying, the next order for that table starts a new bill
  const next = await send("FOH", "T2", [[A.menu.nasi, 1]]);
  assert.equal(next.status, 201);
  assert.notEqual(next.data.id, first.data.id);
});

test("an added round makes an all-served table unpayable until the new dish is served", async () => {
  const o = (await send("FOH", "T3", [[A.menu.nasi, 1]])).data;
  await walk(o, o.items[0].id, FULL);
  const more = (await send("FOH", "T3", [[A.menu.odd, 1]])).data;
  assert.equal(more.id, o.id);
  const pay = await a.FOH("POST", "/payments", { orderId: o.id, method: "CARD" });
  assert.equal(pay.status, 409, "not everything is served yet");
  const newLine = more.items.find((i) => i.menuItem.id === A.menu.odd);
  await walk(more, newLine.id, FULL);
  assert.equal((await a.FOH("POST", "/payments", { orderId: o.id, method: "CARD" })).status, 201);
});

test("waiters sending to the same table at the same moment still end up with one bill", async () => {
  const tableId = A.tables.T1;
  // T1 already has an open order from the first test; use a fresh table
  const t = await a.ADMIN("POST", "/locations/tables", { label: "Race table" });
  assert.equal(t.status, 201);
  const results = await Promise.all(
    [0, 1, 2, 3, 4].map(() => a.FOH("POST", "/orders", { tableId: t.data.id, items: [{ menuItemId: A.menu.nasi, quantity: 1 }] }))
  );
  for (const r of results) assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
  assert.equal(results.filter((r) => r.status === 201).length, 1, "exactly one new order");
  const ids = new Set(results.map((r) => r.data.id));
  assert.equal(ids.size, 1);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM order_items WHERE order_id = $1", [[...ids][0]]);
  assert.equal(rows[0].n, 5);
  assert.ok(tableId);

  // and the database itself refuses a second open order for a table
  await assert.rejects(
    pool.query("INSERT INTO orders (id, location_id, table_id, opened_by_id) VALUES (gen_random_uuid()::text, $1, $2, $3)", [A.locationId, t.data.id, A.users.FOH]),
    /uniq_open_order_per_table/
  );
});
