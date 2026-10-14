// Phase 2: customer on the bill, spice choice, note hints, kitchen history, richer menu editing.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { io } = require("socket.io-client");
const { pool, migrate, startServer, createTenant, client } = require("./helpers");

let server, base, A, B, a;

before(async () => {
  await migrate();
  ({ server, base } = await startServer());
  A = await createTenant({ name: "P2A" });
  B = await createTenant({ name: "P2B" });
  a = Object.fromEntries(Object.entries(A.tokens).map(([r, t]) => [r, client(base, t)]));
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

const connect = async (token) => {
  const s = io(base, { transports: ["websocket"], auth: { token } });
  await new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
  return s;
};
const FULL = [["PREPARING", "KITCHEN"], ["READY", "KITCHEN"], ["DELIVERED", "FOH"]];
async function walk(orderId, itemId, steps = FULL) {
  for (const [to, who] of steps) {
    const r = await a[who]("PATCH", `/orders/${orderId}/items/${itemId}`, { status: to });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
}

test("customer name and phone: saved, validated, added later, and never sent to the kitchen", async () => {
  const bad = await a.FOH("POST", "/orders", { tableId: A.tables.T1, customerPhone: "call me", items: [{ menuItemId: A.menu.nasi }] });
  assert.equal(bad.status, 400);
  assert.equal((await a.FOH("POST", "/orders", { tableId: A.tables.T1, customerName: "x".repeat(61), items: [{ menuItemId: A.menu.nasi }] })).status, 400);

  const kitchenSock = await connect(A.tokens.KITCHEN);
  const fohSock = await connect(A.tokens.FOH);
  const kGot = new Promise((r) => kitchenSock.on("order:created", r));
  const fGot = new Promise((r) => fohSock.on("order:created", r));

  const r = await a.FOH("POST", "/orders", { tableId: A.tables.T1, customerName: " Budi ", items: [{ menuItemId: A.menu.nasi }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual(r.data.customer, { name: "Budi", phone: null });

  // a second round adds the phone; the name stays
  const more = await a.FOH("POST", "/orders", { tableId: A.tables.T1, customerPhone: "+62 812-3456", items: [{ menuItemId: A.menu.odd }] });
  assert.equal(more.data.id, r.data.id);
  assert.deepEqual(more.data.customer, { name: "Budi", phone: "+62 812-3456" });

  const fohView = (await a.FOH("GET", "/orders/open")).data.find((o) => o.id === r.data.id);
  const kitView = (await a.KITCHEN("GET", "/orders/open")).data.find((o) => o.id === r.data.id);
  assert.equal(fohView.customer.phone, "+62 812-3456");
  assert.equal(kitView.customer.phone, null, "kitchen never sees the phone");
  assert.equal(kitView.customer.name, "Budi");

  const kAdded = new Promise((res) => kitchenSock.on("order:items-added", res));
  const fAdded = new Promise((res) => fohSock.on("order:items-added", res));
  await a.FOH("POST", "/orders", { tableId: A.tables.T1, items: [{ menuItemId: A.menu.nasi }] });
  assert.equal((await kAdded).order.customer.phone, null);
  assert.equal((await fAdded).order.customer.phone, "+62 812-3456");
  assert.equal((await kGot).customer.name, "Budi");
  assert.equal((await fGot).customer.name, "Budi");
  kitchenSock.close();
  fohSock.close();
});

test("spice: only dishes that offer it, only Spicy / Not spicy, shown on the line", async () => {
  const no = await a.FOH("POST", "/orders", { tableId: A.tables.T2, items: [{ menuItemId: A.menu.nasi, spice: "SPICY" }] });
  assert.equal(no.status, 400);
  assert.match(no.data.error, /no spice choice/);

  assert.equal((await a.ADMIN("PATCH", `/menu/items/${A.menu.nasi}`, { spiceOption: "yes" })).status, 400);
  assert.equal((await a.ADMIN("PATCH", `/menu/items/${A.menu.nasi}`, { spiceOption: true })).status, 200);
  assert.equal((await a.FOH("POST", "/orders", { tableId: A.tables.T2, items: [{ menuItemId: A.menu.nasi, spice: "VERY" }] })).status, 400);

  const ok = await a.FOH("POST", "/orders", {
    tableId: A.tables.T2,
    items: [{ menuItemId: A.menu.nasi, spice: "SPICY", notes: "no onion" }, { menuItemId: A.menu.nasi, spice: "NOT_SPICY" }],
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.items.map((i) => [i.spice, i.notes]), [["SPICY", "no onion"], ["NOT_SPICY", null]]);
  const cat = (await a.FOH("GET", "/menu/categories")).data[0].menuItems.find((m) => m.id === A.menu.nasi);
  assert.equal(cat.spiceOption, true);
});

test("history: who made each dish, how long it took, who served it", async () => {
  const o = (await a.FOH("POST", "/orders", { tableId: A.tables.T3, items: [{ menuItemId: A.menu.odd }, { menuItemId: A.menu.tea }] })).data;
  await walk(o.id, o.items[0].id); // made and served
  await walk(o.id, o.items[1].id, FULL.slice(0, 2)); // ready, not served yet

  const open = (await a.FOH("GET", "/orders/open")).data.find((x) => x.id === o.id);
  assert.equal(open.items[0].readyBy, "KITCHEN user");
  assert.equal(open.items[0].deliveredBy, "FOH user");
  assert.ok(open.items[1].readyAt && !open.items[1].deliveredAt);

  assert.equal((await a.FOH("GET", "/orders/history")).status, 403);
  assert.equal((await a.KITCHEN("GET", "/orders/history")).status, 403);
  assert.equal((await a.SUPERVISOR("GET", "/orders/history?station=GRILL")).status, 400);
  assert.equal((await a.SUPERVISOR("GET", "/orders/history?date=2026-02-31")).status, 400);

  const h = await a.SUPERVISOR("GET", "/orders/history");
  assert.equal(h.status, 200, JSON.stringify(h.data));
  const mine = h.data.lines.filter((l) => l.table === "T3");
  assert.equal(mine.length, 2);
  const served = mine.find((l) => l.status === "DELIVERED");
  assert.equal(served.readyBy, "KITCHEN user");
  assert.equal(served.deliveredBy, "FOH user");
  assert.ok(served.minutes >= 0);
  assert.ok(h.data.stats.waitingToServe >= 1);
  assert.equal(h.data.stats.lines, h.data.lines.length);

  const bar = await a.COORDINATOR("GET", "/orders/history?station=BAR");
  assert.ok(bar.data.lines.every((l) => l.station === "BAR"));
  const other = await client(base, B.tokens.SUPERVISOR)("GET", "/orders/history");
  assert.equal(other.data.lines.length, 0, "another company sees none of it");
  const yesterday = await a.ADMIN("GET", "/orders/history?date=2020-01-01");
  assert.equal(yesterday.data.lines.length, 0);
});

test("menu editing: note hint, move a whole category to the bar, switched-off dishes can come back", async () => {
  const catId = (await a.ADMIN("GET", "/menu/categories")).data[0].id;
  assert.equal((await a.ADMIN("PATCH", `/menu/categories/${catId}`, { noteHint: "x".repeat(81) })).status, 400);
  assert.equal((await a.ADMIN("PATCH", `/menu/categories/${catId}`, { noteHint: " Sugar & ice level " })).status, 200);
  assert.equal((await a.FOH("GET", "/menu/categories")).data[0].noteHint, "Sugar & ice level");
  assert.equal((await a.ADMIN("PATCH", `/menu/categories/${catId}`, { noteHint: "" })).status, 200);
  assert.equal((await a.FOH("GET", "/menu/categories")).data[0].noteHint, "");

  assert.equal((await a.COORDINATOR("PATCH", `/menu/categories/${catId}`, { station: "bar" })).status, 200);
  const items = (await a.FOH("GET", "/menu/categories")).data[0].menuItems;
  assert.ok(items.length > 0 && items.every((m) => m.station === "BAR"));
  assert.equal((await a.FOH("PATCH", `/menu/categories/${catId}`, { station: "KITCHEN" })).status, 403);
  await a.ADMIN("PATCH", `/menu/categories/${catId}`, { station: "KITCHEN" });

  // switch a dish off: waiters no longer see it, editors still do (to switch it back on)
  assert.equal((await a.ADMIN("PATCH", `/menu/items/${A.menu.odd}`, { active: false })).status, 200);
  const waiterView = (await a.FOH("GET", "/menu/categories?all=1")).data[0].menuItems;
  assert.ok(!waiterView.some((m) => m.id === A.menu.odd), "?all=1 is ignored for waiters");
  const editorView = (await a.ADMIN("GET", "/menu/categories?all=1")).data[0].menuItems;
  assert.equal(editorView.find((m) => m.id === A.menu.odd).active, false);
  assert.equal((await a.ADMIN("PATCH", `/menu/items/${A.menu.odd}`, { active: true, name: "Odd Price Renamed", price: 34000 })).status, 200);
  const back = (await a.FOH("GET", "/menu/categories")).data[0].menuItems.find((m) => m.id === A.menu.odd);
  assert.equal(back.name, "Odd Price Renamed");
  assert.equal(Number(back.price), 34000);
});
