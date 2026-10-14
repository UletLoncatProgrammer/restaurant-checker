const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const { io } = require("socket.io-client");
const { pool, uid, migrate, startServer, createTenant, client } = require("./helpers");
const { resolvePeriod } = require("../src/lib/period");
const { getReportData } = require("../src/lib/reportData");

let server, base, A, B, a;

before(async () => {
  await migrate();
  ({ server, base } = await startServer());
  A = await createTenant({ name: "A" });
  B = await createTenant({ name: "B" });
  a = Object.fromEntries(Object.entries(A.tokens).map(([r, t]) => [r, client(base, t)]));
  a.b = client(base, B.tokens.SUPERVISOR);
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

const onHand = async (T, item) =>
  Number((await pool.query("SELECT COALESCE(SUM(delta),0) AS n FROM stock_movements WHERE menu_item_id=$1", [T.menu[item]])).rows[0].n);

async function newOrder(table, lines, who = "FOH") {
  const r = await a[who]("POST", "/orders", { tableId: A.tables[table], items: lines.map(([k, q]) => ({ menuItemId: A.menu[k], quantity: q })) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
async function deliverAll(order) {
  for (const it of order.items.filter((i) => i.status !== "CANCELLED")) {
    for (const [to, who] of [["PREPARING", "KITCHEN"], ["READY", "KITCHEN"], ["DELIVERED", "FOH"]]) {
      const cur = (await pool.query("SELECT status FROM order_items WHERE id=$1", [it.id])).rows[0].status;
      if (cur === to) continue;
      const r = await a[who]("PATCH", `/orders/${order.id}/items/${it.id}`, { status: to });
      assert.equal(r.status, 200, JSON.stringify(r.data));
    }
  }
}

test("order validation: bad quantities and unknown items are rejected", async () => {
  for (const q of [0, -1, 1.5, 100, "2"]) {
    const r = await a.FOH("POST", "/orders", { tableId: A.tables.T1, items: [{ menuItemId: A.menu.nasi, quantity: q }] });
    assert.equal(r.status, 400, `quantity ${JSON.stringify(q)} should be rejected`);
  }
  const r = await a.FOH("POST", "/orders", { tableId: A.tables.T1, items: [{ menuItemId: B.menu.nasi, quantity: 1 }] });
  assert.equal(r.status, 400); // other tenant's menu item
  assert.equal((await a.KITCHEN("POST", "/orders", { tableId: A.tables.T1, items: [{ menuItemId: A.menu.nasi }] })).status, 403);
});

test("full flow: order -> kitchen -> deliver -> pay (money math exact) -> receipt", async () => {
  const order = await newOrder("T1", [["nasi", 2], ["odd", 1]]);
  // Cannot pay before delivery
  let r = await a.FOH("POST", "/payments", { orderId: order.id, method: "CARD" });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /Not all items are delivered/);

  const [n1] = order.items;
  // Illegal moves
  assert.equal((await a.KITCHEN("PATCH", `/orders/${order.id}/items/${n1.id}`, { status: "READY" })).status, 409); // skip PREPARING
  assert.equal((await a.FOH("PATCH", `/orders/${order.id}/items/${n1.id}`, { status: "PREPARING" })).status, 403); // not FOH's step
  assert.equal((await a.FOH("PATCH", `/orders/${order.id}/items/${n1.id}`, { status: "CANCELLED" })).status, 409); // cancel only via void
  assert.equal((await a.KITCHEN("PATCH", `/orders/${order.id}/items/${n1.id}`, { status: "DELIVERED" })).status, 409);

  await deliverAll(order);

  const bill = (await a.FOH("GET", `/payments/bill/${order.id}`)).data;
  assert.equal(bill.subtotal, 123333); // 2*45000 + 33333
  assert.equal(bill.tax, 12333); // 9000 + round(3333.3)=3333
  assert.equal(bill.total, 135666);
  assert.equal(bill.payable, true);

  // Cash validation
  assert.equal((await a.FOH("POST", "/payments", { orderId: order.id, method: "CASH" })).status, 400);
  r = await a.FOH("POST", "/payments", { orderId: order.id, method: "CASH", amountTendered: 100000 });
  assert.equal(r.status, 400);
  assert.equal((await a.FOH("POST", "/payments", { orderId: order.id, method: "BITCOIN" })).status, 400);

  r = await a.FOH("POST", "/payments", { orderId: order.id, method: "CASH", amountTendered: 150000 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.total, 135666);
  assert.equal(r.data.changeGiven, 14334);
  assert.equal(r.data.lines.length, 2);
  assert.equal(r.data.status, "PAID");

  // Second payment attempt is refused; order is closed.
  assert.equal((await a.FOH("POST", "/payments", { orderId: order.id, method: "CARD" })).status, 409);
  const rec = await a.FOH("GET", `/payments/${r.data.id}/receipt`);
  assert.equal(rec.status, 200);
  assert.equal(rec.data.receiptNo, r.data.receiptNo);
  // Other tenant cannot read the receipt, bill, or pay
  assert.equal((await a.b("GET", `/payments/${r.data.id}/receipt`)).status, 404);
});

test("concurrent payment attempts: exactly one succeeds", async () => {
  const order = await newOrder("T2", [["nasi", 1]]);
  await deliverAll(order);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => a.FOH("POST", "/payments", { orderId: order.id, method: "CARD" }))
  );
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [201, 409, 409, 409, 409]);
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM payments WHERE order_id=$1", [order.id]);
  assert.equal(rows[0].n, 1);
});

test("stock: deducted on order, rejected when insufficient, restocked on void of untouched item only", async () => {
  const before0 = await onHand(A, "tea");
  const over = await a.FOH("POST", "/orders", { tableId: A.tables.T3, items: [{ menuItemId: A.menu.tea, quantity: before0 + 1 }] });
  assert.equal(over.status, 409);
  assert.match(over.data.error, /Not enough stock/);

  const order = await newOrder("T3", [["tea", 2], ["tea", 1], ["nasi", 1]]);
  assert.equal(await onHand(A, "tea"), before0 - 3);
  const [t1, t2, nasi] = order.items;

  // Authorization on void: only SUPERVISOR/ADMIN
  for (const who of ["FOH", "KITCHEN", "COORDINATOR"]) {
    assert.equal((await a[who]("POST", `/orders/${order.id}/items/${t1.id}/void`, { reason: "wrong order" })).status, 403, who);
  }
  assert.equal((await a.SUPERVISOR("POST", `/orders/${order.id}/items/${t1.id}/void`, {})).status, 400); // reason required
  assert.equal((await a.SUPERVISOR("POST", `/orders/${order.id}/items/${t1.id}/void`, { reason: "  " })).status, 400);
  assert.equal((await a.b("POST", `/orders/${order.id}/items/${t1.id}/void`, { reason: "other tenant" })).status, 404);

  // Void untouched (PENDING) tea x2 -> restocked
  let r = await a.SUPERVISOR("POST", `/orders/${order.id}/items/${t1.id}/void`, { reason: "customer changed mind" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.item.status, "CANCELLED");
  assert.equal(r.data.orderCancelled, false);
  assert.equal(await onHand(A, "tea"), before0 - 1);
  assert.equal((await a.SUPERVISOR("POST", `/orders/${order.id}/items/${t1.id}/void`, { reason: "again please" })).status, 409);

  // Kitchen starts tea x1 -> void is waste, NOT restocked
  assert.equal((await a.KITCHEN("PATCH", `/orders/${order.id}/items/${t2.id}`, { status: "PREPARING" })).status, 200);
  r = await a.SUPERVISOR("POST", `/orders/${order.id}/items/${t2.id}/void`, { reason: "dropped on floor" });
  assert.equal(r.status, 200);
  assert.equal(await onHand(A, "tea"), before0 - 1);
  // A voided item cannot be advanced
  assert.equal((await a.KITCHEN("PATCH", `/orders/${order.id}/items/${t2.id}`, { status: "READY" })).status, 409);

  // Voiding the last live item cancels the whole order
  r = await a.ADMIN("POST", `/orders/${order.id}/items/${nasi.id}/void`, { reason: "walked out" });
  assert.equal(r.data.orderCancelled, true);
  const ord = (await pool.query("SELECT status, void_reason FROM orders WHERE id=$1", [order.id])).rows[0];
  assert.equal(ord.status, "CANCELLED");
  // Cancelled order can't be paid
  assert.equal((await a.FOH("POST", "/payments", { orderId: order.id, method: "CARD" })).status, 409);
});

test("void whole open order restocks pending items; paid sale void marks payment VOIDED", async () => {
  const t0 = await onHand(A, "tea");
  const o1 = await newOrder("T1", [["tea", 2], ["nasi", 1]]);
  assert.equal(await onHand(A, "tea"), t0 - 2);
  assert.equal((await a.COORDINATOR("POST", `/orders/${o1.id}/void`, { reason: "test" })).status, 403);
  const v = await a.SUPERVISOR("POST", `/orders/${o1.id}/void`, { reason: "table left" });
  assert.equal(v.status, 200);
  assert.equal(await onHand(A, "tea"), t0);
  assert.equal((await a.SUPERVISOR("POST", `/orders/${o1.id}/void`, { reason: "double void" })).status, 409);
  const open = (await a.FOH("GET", "/orders/open")).data;
  assert.ok(!open.some((o) => o.id === o1.id));

  // paid sale void
  const o2 = await newOrder("T2", [["nasi", 1]]);
  await deliverAll(o2);
  const pay = (await a.FOH("POST", "/payments", { orderId: o2.id, method: "QRIS" })).data;
  const pv = await a.SUPERVISOR("POST", `/orders/${o2.id}/void`, { reason: "wrong table charged" });
  assert.equal(pv.status, 200);
  assert.equal(pv.data.wasPaid, true);
  const p = (await pool.query("SELECT status, void_reason FROM payments WHERE id=$1", [pay.id])).rows[0];
  assert.equal(p.status, "VOIDED");
  assert.equal(p.void_reason, "wrong table charged");
});

test("transactions + activity feed are role-gated, tenant-scoped, and reflect events", async () => {
  assert.equal((await a.FOH("GET", "/transactions")).status, 403);
  assert.equal((await a.KITCHEN("GET", "/transactions/activity")).status, 403);
  const tx = await a.COORDINATOR("GET", "/transactions");
  assert.equal(tx.status, 200);
  assert.ok(tx.data.payments.length >= 2);
  assert.ok(tx.data.totals.paidCount >= 2 && tx.data.totals.voidedCount >= 1);
  assert.equal((await a.COORDINATOR("GET", "/transactions?date=2026-13-45")).status, 400);
  assert.equal((await a.COORDINATOR("GET", "/transactions?date=2026-02-31")).status, 400);
  const bTx = await a.b("GET", "/transactions");
  assert.equal(bTx.data.payments.length, 0);

  const feed = (await a.SUPERVISOR("GET", "/transactions/activity?limit=500")).data;
  const types = new Set(feed.map((e) => e.type));
  for (const t of ["ORDER_CREATED", "ITEM_STATUS", "PAID", "ITEM_VOIDED", "ORDER_VOIDED", "SALE_VOIDED"]) assert.ok(types.has(t), `missing ${t}`);
  assert.ok(feed.every((e) => e.actorName));
  assert.equal((await a.b("GET", "/transactions/activity")).data.length, 0);
});

test("stock endpoints: receive/adjust rules", async () => {
  assert.equal((await a.FOH("GET", "/stock")).status, 403);
  const list = (await a.COORDINATOR("GET", "/stock")).data;
  assert.equal(list.length, 1);
  const cur = list[0].onHand;
  assert.equal((await a.COORDINATOR("POST", "/stock/movements", { menuItemId: A.menu.tea, delta: -1, reason: "RECEIVE" })).status, 400);
  assert.equal((await a.COORDINATOR("POST", "/stock/movements", { menuItemId: A.menu.tea, delta: -1, reason: "ADJUST" })).status, 400); // note needed
  assert.equal((await a.COORDINATOR("POST", "/stock/movements", { menuItemId: A.menu.tea, delta: -(cur + 1), reason: "ADJUST", note: "recount" })).status, 409);
  assert.equal((await a.COORDINATOR("POST", "/stock/movements", { menuItemId: A.menu.nasi, delta: 5, reason: "RECEIVE" })).status, 404); // untracked
  const ok = await a.COORDINATOR("POST", "/stock/movements", { menuItemId: A.menu.tea, delta: 10, reason: "RECEIVE", note: "delivery" });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.onHand, cur + 10);
});

test("Excel report: access control, ranges, and numbers reconcile", async () => {
  assert.equal((await a.FOH("GET", "/reports/export?period=day", null, { raw: true })).status, 403);
  assert.equal((await a.SUPERVISOR("GET", "/reports/export?period=day", null, { raw: true })).status, 403);
  assert.equal((await a.COORDINATOR("GET", "/reports/export?period=month", null, { raw: true })).status, 400);
  assert.equal((await a.COORDINATOR("GET", "/reports/export?period=day&date=nope", null, { raw: true })).status, 400);

  const res = await a.COORDINATOR("GET", "/reports/export?period=week", null, { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /spreadsheetml/);
  assert.match(res.headers.get("content-disposition"), /report-.*-week-\d{4}-\d{2}-\d{2}\.xlsx/);
  const buf = Buffer.from(await res.arrayBuffer());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["Summary", "Sales by day", "Sales by item", "Transactions", "Stock", "Voids"]);

  // Reconcile via structured data
  const win = await resolvePeriod(A.locationId, "week");
  const d = await getReportData(A.locationId, win);
  // Exactly one PAID sale remains (the 135666 one) + the concurrent-test card sale (49500)
  const paid = (await pool.query("SELECT COALESCE(SUM(subtotal),0) AS s, COALESCE(SUM(tax),0) AS t, COALESCE(SUM(total),0) AS g, COUNT(*)::int AS n FROM payments WHERE location_id=$1 AND status='PAID'", [A.locationId])).rows[0];
  assert.equal(d.summary.net, Number(paid.s));
  assert.equal(d.summary.tax, Number(paid.t));
  assert.equal(d.summary.gross, Number(paid.g));
  assert.equal(d.summary.salesCount, paid.n);
  assert.equal(d.summary.gross, d.summary.net - d.summary.discount + d.summary.service + d.summary.tax);
  assert.equal(d.byDay.length, 7);
  assert.equal(d.byDay.reduce((s, r) => s + r.gross, 0), d.summary.gross);
  assert.equal(d.byItem.reduce((s, r) => s + r.net, 0), d.summary.net); // by-item reconciles to payments
  assert.equal(d.summary.voidedSalesCount, 1);
  assert.ok(d.voids.length >= 4);
  for (const s of d.stock) assert.equal(s.opening + s.received - s.sold + s.voidRestock + s.adjust, s.closing, "stock identity");
  assert.equal(d.stock.length, 1);

  // And the workbook matches the data
  const sum = wb.getWorksheet("Summary");
  const cell = (label) => {
    let v;
    sum.eachRow((row) => { if (row.getCell(1).value === label) v = row.getCell(2).value; });
    return v;
  };
  assert.equal(cell("Gross sales (what customers paid)"), d.summary.gross);
  assert.equal(cell("Paid sales (count)"), d.summary.salesCount);
});

test("period windows follow the location's timezone and ISO weeks", async () => {
  const w = await resolvePeriod(A.locationId, "week", "2026-10-08"); // a Thursday
  assert.equal(w.startDate, "2026-10-05"); // Monday
  assert.equal(w.endDate, "2026-10-12");
  assert.equal(new Date(w.start).toISOString(), "2026-10-04T17:00:00.000Z"); // Jakarta = UTC+7
  const sunday = await resolvePeriod(A.locationId, "week", "2026-10-11");
  assert.equal(sunday.startDate, "2026-10-05");
  const day = await resolvePeriod(A.locationId, "day", "2026-10-08");
  assert.equal(day.endDate, "2026-10-09");
});

test("a sale at 00:30 local belongs to the local day, not the UTC day", async () => {
  const T = await createTenant({ name: "TZ" });
  const orderId = uid();
  await pool.query("INSERT INTO orders (id, location_id, table_id, status, opened_by_id, closed_at) VALUES ($1,$2,$3,'CLOSED',$4, now())", [orderId, T.locationId, T.tables.T1, T.users.FOH]);
  await pool.query("INSERT INTO order_items (id, order_id, menu_item_id, quantity, unit_price, tax_rate, status) VALUES ($1,$2,$3,1,45000,0.1,'DELIVERED')", [uid(), orderId, T.menu.nasi]);
  // 2026-10-07 17:30 UTC == 2026-10-08 00:30 Asia/Jakarta
  await pool.query("INSERT INTO payments (id, location_id, order_id, subtotal, tax, total, method, paid_by_id, paid_at) VALUES ($1,$2,$3,45000,4500,49500,'CARD',$4,'2026-10-07T17:30:00Z')", [uid(), T.locationId, orderId, T.users.FOH]);
  const c = client(base, T.tokens.COORDINATOR);
  assert.equal((await c("GET", "/transactions?date=2026-10-08")).data.totals.paidCount, 1);
  assert.equal((await c("GET", "/transactions?date=2026-10-07")).data.totals.paidCount, 0);
  const win = await resolvePeriod(T.locationId, "day", "2026-10-08");
  const d = await getReportData(T.locationId, win);
  assert.equal(d.summary.gross, 49500);
  assert.equal(d.byDay[0].day, "2026-10-08");
  assert.equal(d.transactions[0].paidLocal, "2026-10-08 00:30:00");
});

test("sockets: auth required, location-isolated, money events role-scoped", async () => {
  const connect = (token) =>
    new Promise((resolve, reject) => {
      const s = io(base, { auth: token ? { token } : {}, transports: ["websocket"], reconnection: false });
      s.on("connect", () => resolve(s));
      s.on("connect_error", (e) => { s.close(); reject(e); });
    });
  await assert.rejects(connect(null), /Missing token/);
  await assert.rejects(connect("garbage"), /Invalid/);

  const kitchen = await connect(A.tokens.KITCHEN);
  const coord = await connect(A.tokens.COORDINATOR);
  const other = await connect(B.tokens.KITCHEN);
  const got = { kitchen: [], coord: [], other: [] };
  for (const [name, s] of [["kitchen", kitchen], ["coord", coord], ["other", other]]) {
    s.onAny((ev) => got[name].push(ev));
  }
  const order = await newOrder("T1", [["nasi", 1]]);
  await deliverAll(order);
  await a.FOH("POST", "/payments", { orderId: order.id, method: "CARD" });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(got.kitchen.includes("order:created"));
  assert.ok(got.kitchen.includes("order-item:updated"));
  assert.ok(got.kitchen.includes("order:closed"));
  assert.ok(!got.kitchen.includes("activity:new"), "kitchen must not receive money/audit events");
  assert.ok(!got.kitchen.includes("payment:changed"));
  assert.ok(got.coord.includes("activity:new"));
  assert.ok(got.coord.includes("payment:changed"));
  assert.deepEqual(got.other, [], "another location hears nothing");
  [kitchen, coord, other].forEach((s) => s.close());
});
