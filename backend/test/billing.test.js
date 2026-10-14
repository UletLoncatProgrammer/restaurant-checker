// Billing: restaurant tax (PBJT), service charge and member discount.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { pool, migrate, startServer, createTenant, client } = require("./helpers");
const { billTotals, phoneKey } = require("../src/lib/billing");
const { resolvePeriod } = require("../src/lib/period");
const { getReportData } = require("../src/lib/reportData");

let server, base, A, B, a;

before(async () => {
  await migrate();
  ({ server, base } = await startServer());
  A = await createTenant({ name: "BillA" });
  B = await createTenant({ name: "BillB" });
  a = Object.fromEntries(Object.entries(A.tokens).map(([r, t]) => [r, client(base, t)]));
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

const FULL = [["PREPARING", "KITCHEN"], ["READY", "KITCHEN"], ["DELIVERED", "FOH"]];
async function servedOrder(table, lines) {
  const o = (await a.FOH("POST", "/orders", { tableId: A.tables[table], items: lines.map(([k, q]) => ({ menuItemId: A.menu[k], quantity: q })) })).data;
  for (const it of o.items) for (const [to, who] of FULL) await a[who]("PATCH", `/orders/${o.id}/items/${it.id}`, { status: to });
  return o;
}

test("the bill maths: discount, then service, then tax - each to whole rupiah", () => {
  assert.deepEqual(billTotals({ subtotal: 100000, serviceRate: 0.05, taxRate: 0.1, taxOnService: true }),
    { subtotal: 100000, discount: 0, afterDiscount: 100000, service: 5000, taxBase: 105000, tax: 10500, total: 115500 });
  assert.deepEqual(billTotals({ subtotal: 100000, discountRate: 0.1, serviceRate: 0.05, taxRate: 0.1, taxOnService: true }),
    { subtotal: 100000, discount: 10000, afterDiscount: 90000, service: 4500, taxBase: 94500, tax: 9450, total: 103950 });
  // tax on food only
  assert.equal(billTotals({ subtotal: 100000, serviceRate: 0.05, taxRate: 0.1, taxOnService: false }).tax, 10000);
  // rounding: 33,333 x 5% = 1,666.65 -> 1,667 ; tax 10% of 35,000 = 3,500
  const r = billTotals({ subtotal: 33333, serviceRate: 0.05, taxRate: 0.1, taxOnService: true });
  assert.deepEqual([r.service, r.tax, r.total], [1667, 3500, 38500]);
  // rounded ONCE, like the database: 10% of 12,344.99 = 1,234.499 -> 1,234 (rounding to cents
  // first would give 1,234.50 -> 1,235); exact halves round up: 10% of 12,345 = 1,234.5 -> 1,235
  assert.equal(billTotals({ subtotal: 12344.99, taxRate: 0.1 }).tax, 1234);
  assert.equal(billTotals({ subtotal: 12345, taxRate: 0.1 }).tax, 1235);
  // the parts always add up
  for (const sub of [1, 999, 45000, 123457, 9999999]) {
    const t = billTotals({ subtotal: sub, discountRate: 0.125, serviceRate: 0.075, taxRate: 0.1 });
    assert.equal(t.total, t.subtotal - t.discount + t.service + t.tax);
  }
  assert.equal(phoneKey("+62 812-3456-789"), "08123456789");
  assert.equal(phoneKey("0812 3456 789"), "08123456789");
  assert.equal(phoneKey("812 3456 789"), "08123456789");
});

test("billing settings: new restaurants start at PB1 10% + 5% service; only Admin changes them", async () => {
  // a brand-new restaurant (not the test helper's) gets the defaults
  const { rows } = await pool.query("SELECT tax_label, tax_rate, service_rate, tax_on_service FROM locations WHERE id = $1", [A.locationId]);
  assert.equal(rows[0].tax_label, "PB1");
  assert.equal(Number(rows[0].tax_rate), 0.1);
  assert.equal(rows[0].tax_on_service, true);
  const def = (await pool.query("SELECT column_default FROM information_schema.columns WHERE table_name = 'locations' AND column_name = 'service_rate'")).rows[0];
  assert.match(def.column_default, /0\.05/);

  const s = await a.FOH("GET", "/locations/settings");
  assert.deepEqual(s.data.billing, { taxLabel: "PB1", taxPercent: 10, servicePercent: 0, taxOnService: true });

  assert.equal((await a.COORDINATOR("PATCH", "/locations/settings", { servicePercent: 5 })).status, 403, "money rules: Admin only");
  assert.equal((await a.COORDINATOR("PATCH", "/locations/settings", { kitchenMode: "SPLIT" })).status, 200, "kitchen mode still MENU");
  await a.COORDINATOR("PATCH", "/locations/settings", { kitchenMode: "ONE" });
  assert.equal((await a.ADMIN("PATCH", "/locations/settings", { taxPercent: 30 })).status, 400);
  assert.equal((await a.ADMIN("PATCH", "/locations/settings", { servicePercent: -1 })).status, 400);
  assert.equal((await a.ADMIN("PATCH", "/locations/settings", { taxLabel: "x".repeat(21) })).status, 400);
  assert.equal((await a.ADMIN("PATCH", "/locations/settings", { taxOnService: "yes" })).status, 400);
  const ok = await a.ADMIN("PATCH", "/locations/settings", { servicePercent: 5, taxPercent: 10, taxLabel: "PB1" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.billing, { taxLabel: "PB1", taxPercent: 10, servicePercent: 5, taxOnService: true });
  const other = await client(base, B.tokens.ADMIN)("GET", "/locations/settings");
  assert.equal(other.data.billing.servicePercent, 0, "another company is not affected");
});

let memberId;
test("member list: managed with MEMBERS, found by any phone format, per company", async () => {
  assert.equal((await a.FOH("GET", "/members")).status, 403);
  assert.equal((await a.FOH("POST", "/members", { name: "Sari", phone: "0812345678", discountPercent: 10 })).status, 403);
  assert.equal((await a.SUPERVISOR("POST", "/members", { name: "Sari", phone: "12", discountPercent: 10 })).status, 400);
  assert.equal((await a.SUPERVISOR("POST", "/members", { name: "Sari", phone: "0812345678", discountPercent: 0 })).status, 400);
  assert.equal((await a.SUPERVISOR("POST", "/members", { name: "Sari", phone: "0812345678", discountPercent: 101 })).status, 400);

  const m = await a.SUPERVISOR("POST", "/members", { name: " Sari ", phone: "+62 812-345-678", discountPercent: 12.5, note: "regular" });
  assert.equal(m.status, 201, JSON.stringify(m.data));
  assert.equal(m.data.discountPercent, 12.5);
  memberId = m.data.id;
  assert.equal((await a.COORDINATOR("POST", "/members", { name: "Copy", phone: "0812 345 678", discountPercent: 5 })).status, 409, "same phone, other format");

  const found = await a.FOH("GET", `/members/lookup?phone=${encodeURIComponent("0812-345-678")}`);
  assert.equal(found.status, 200);
  assert.equal(found.data.name, "Sari");
  assert.equal((await a.FOH("GET", "/members/lookup?phone=0899999999")).status, 404);
  assert.equal((await a.KITCHEN("GET", "/members/lookup?phone=0812345678")).status, 403);
  assert.equal((await client(base, B.tokens.ADMIN)("GET", "/members/lookup?phone=0812345678")).status, 404, "other company");

  const list = await a.ADMIN("GET", "/members?q=sar");
  assert.equal(list.data.length, 1);
  assert.equal((await a.ADMIN("GET", "/members?q=345678")).data.length, 1, "search by phone digits");
});

test("paying with a member: discount, service and tax on the bill, receipt and reports", async () => {
  const o = await servedOrder("T1", [["nasi", 2], ["odd", 1]]); // 90,000 + 33,333 = 123,333
  const plain = await a.FOH("GET", `/payments/bill/${o.id}`);
  assert.equal(plain.data.subtotal, 123333);
  assert.equal(plain.data.discount, 0);
  assert.equal(plain.data.service, 6167); // 6,166.65
  assert.equal(plain.data.taxLabel, "PB1");
  assert.equal(plain.data.tax, 12950); // 10% of 129,500
  assert.equal(plain.data.total, 142450);

  assert.equal((await a.FOH("GET", `/payments/bill/${o.id}?memberId=nope`)).status, 404);
  const bill = await a.FOH("GET", `/payments/bill/${o.id}?memberId=${memberId}`);
  assert.equal(bill.status, 200);
  assert.equal(bill.data.member.name, "Sari");
  assert.equal(bill.data.discountPercent, 12.5);
  assert.equal(bill.data.discount, 15417); // 12.5% of 123,333 = 15,416.6
  assert.equal(bill.data.service, 5396); // 5% of 107,916 = 5,395.8
  assert.equal(bill.data.tax, 11331); // 10% of 113,312 = 11,331.2
  assert.equal(bill.data.total, 107916 + 5396 + 11331);

  const pay = await a.FOH("POST", "/payments", { orderId: o.id, method: "CASH", amountTendered: 150000, memberId });
  assert.equal(pay.status, 201, JSON.stringify(pay.data));
  assert.equal(pay.data.total, bill.data.total);
  assert.equal(pay.data.discount, 15417);
  assert.equal(pay.data.memberName, "Sari");
  assert.equal(pay.data.service, 5396);
  assert.equal(pay.data.servicePercent, 5);
  assert.equal(pay.data.taxLabel, "PB1");
  assert.equal(pay.data.changeGiven, 150000 - bill.data.total);

  // changing rates later never changes a paid bill
  await a.ADMIN("PATCH", "/locations/settings", { servicePercent: 10 });
  const again = await a.FOH("GET", `/payments/${pay.data.id}/receipt`);
  assert.equal(again.data.total, bill.data.total);
  assert.equal(again.data.servicePercent, 5);
  await a.ADMIN("PATCH", "/locations/settings", { servicePercent: 5 });

  const ev = (await pool.query("SELECT message FROM order_events WHERE order_id = $1 AND type = 'PAID'", [o.id])).rows[0];
  assert.match(ev.message, /member Sari/);

  const tx = await a.SUPERVISOR("GET", "/transactions");
  assert.equal(tx.data.totals.discount, 15417);
  assert.equal(tx.data.totals.service, 5396);
  assert.equal(tx.data.payments.find((p) => p.id === pay.data.id).memberName, "Sari");

  const d = await getReportData(A.locationId, await resolvePeriod(A.locationId, "day"));
  assert.equal(d.summary.gross, d.summary.net - d.summary.discount + d.summary.service + d.summary.tax);
  assert.equal(d.summary.discount, 15417);

  // a switched-off member can't be used any more; another company's member never
  await a.ADMIN("PATCH", `/members/${memberId}`, { active: false });
  const o2 = await servedOrder("T2", [["nasi", 1]]);
  assert.equal((await a.FOH("POST", "/payments", { orderId: o2.id, method: "CARD", memberId })).status, 404);
  const bm = await client(base, B.tokens.ADMIN)("POST", "/members", { name: "Bea", phone: "0811111111", discountPercent: 50 });
  assert.equal((await a.FOH("POST", "/payments", { orderId: o2.id, method: "CARD", memberId: bm.data.id })).status, 404);
  assert.equal((await a.FOH("POST", "/payments", { orderId: o2.id, method: "CARD" })).status, 201);

  // the database itself refuses a payment whose parts don't add up
  await assert.rejects(pool.query("UPDATE payments SET total = total + 1 WHERE id = $1", [pay.data.id]), /payments_total_matches/);
});
