const crypto = require("crypto");
const Router = require("../lib/asyncRouter");
const { query, withTransaction } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { emitToLocation, emitToRoles } = require("../socket");
const { HttpError } = require("../lib/http");
const { ROLES } = require("../lib/roles");
const { logEvent, emitActivity } = require("../lib/events");

const router = Router();
router.use(requireAuth);

const METHODS = ["CASH", "CARD", "QRIS", "OTHER"];

// Bill for an order, computed entirely in SQL from the prices/tax rates that
// were frozen on each order_item when it was ordered. The client never sends
// an amount to charge. Voided (CANCELLED) items are excluded. Tax is rounded
// per line to whole currency units (IDR); prices are treated as tax-exclusive.
async function computeBill(db, locationId, orderId) {
  const { rows: lines } = await db.query(
    `SELECT mi.name, oi.quantity, oi.unit_price, oi.tax_rate, oi.status,
            (oi.quantity * oi.unit_price) AS line_subtotal,
            ROUND(oi.quantity * oi.unit_price * oi.tax_rate, 0) AS line_tax
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN menu_items mi ON mi.id = oi.menu_item_id
     WHERE o.id = $1 AND o.location_id = $2 AND oi.status <> 'CANCELLED'
     ORDER BY oi.created_at, oi.id`,
    [orderId, locationId]
  );
  const { rows: totals } = await db.query(
    `SELECT COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS subtotal,
            COALESCE(SUM(ROUND(oi.quantity * oi.unit_price * oi.tax_rate, 0)), 0) AS tax
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.id = $1 AND o.location_id = $2 AND oi.status <> 'CANCELLED'`,
    [orderId, locationId]
  );
  const subtotal = Number(totals[0].subtotal);
  const tax = Number(totals[0].tax);
  return {
    lines: lines.map((l) => ({
      name: l.name,
      quantity: Number(l.quantity),
      unitPrice: Number(l.unit_price),
      taxRate: Number(l.tax_rate),
      lineSubtotal: Number(l.line_subtotal),
      lineTax: Number(l.line_tax),
      delivered: l.status === "DELIVERED",
    })),
    subtotal,
    tax,
    total: subtotal + tax,
  };
}

async function buildReceipt(db, locationId, paymentId) {
  const { rows } = await db.query(
    `SELECT p.*, o.id AS order_id, t.label AS table_label, l.name AS location_name,
            u.name AS cashier_name, vu.name AS voided_by_name
     FROM payments p
     JOIN orders o ON o.id = p.order_id
     JOIN restaurant_tables t ON t.id = o.table_id
     JOIN locations l ON l.id = p.location_id
     JOIN users u ON u.id = p.paid_by_id
     LEFT JOIN users vu ON vu.id = p.voided_by_id
     WHERE p.id = $1 AND p.location_id = $2`,
    [paymentId, locationId]
  );
  if (rows.length === 0) return null;
  const p = rows[0];
  const { rows: lines } = await db.query(
    `SELECT mi.name, oi.quantity, oi.unit_price, oi.tax_rate,
            (oi.quantity * oi.unit_price) AS line_subtotal,
            ROUND(oi.quantity * oi.unit_price * oi.tax_rate, 0) AS line_tax
     FROM order_items oi JOIN menu_items mi ON mi.id = oi.menu_item_id
     WHERE oi.order_id = $1 AND oi.status <> 'CANCELLED' ORDER BY oi.created_at, oi.id`,
    [p.order_id]
  );
  return {
    id: p.id,
    receiptNo: String(p.receipt_no),
    orderId: p.order_id,
    locationName: p.location_name,
    tableLabel: p.table_label,
    cashierName: p.cashier_name,
    paidAt: p.paid_at,
    method: p.method,
    status: p.status,
    voidedAt: p.voided_at,
    voidReason: p.void_reason,
    voidedByName: p.voided_by_name,
    subtotal: Number(p.subtotal),
    tax: Number(p.tax),
    total: Number(p.total),
    amountTendered: p.amount_tendered === null ? null : Number(p.amount_tendered),
    changeGiven: p.change_given === null ? null : Number(p.change_given),
    lines: lines.map((l) => ({
      name: l.name,
      quantity: Number(l.quantity),
      unitPrice: Number(l.unit_price),
      lineSubtotal: Number(l.line_subtotal),
      lineTax: Number(l.line_tax),
    })),
  };
}

// GET /payments/bill/:orderId — what the POS shows before charging.
router.get("/bill/:orderId", async (req, res) => {
  if (!ROLES.PAY.includes(req.user.role)) {
    return res.status(403).json({ error: `Requires ${ROLES.PAY.join(", ")}` });
  }
  const { rows } = await query(
    `SELECT o.id, o.status, t.label FROM orders o JOIN restaurant_tables t ON t.id = o.table_id
     WHERE o.id = $1 AND o.location_id = $2`,
    [req.params.orderId, req.user.locationId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "Order not found for this location" });
  const bill = await computeBill({ query }, req.user.locationId, req.params.orderId);
  const undelivered = bill.lines.filter((l) => !l.delivered).map((l) => `${l.quantity}x ${l.name}`);
  res.json({
    orderId: rows[0].id,
    orderStatus: rows[0].status,
    tableLabel: rows[0].label,
    ...bill,
    undelivered,
    payable: rows[0].status === "OPEN" && bill.lines.length > 0 && undelivered.length === 0,
  });
});

// POST /payments — take payment and close the table in one atomic step.
// Rules: order must be OPEN, have at least one non-voided item, and every
// non-voided item must be DELIVERED. UNIQUE(order_id) + the row lock make a
// double-tap or two cashiers racing safe: the second attempt gets 409.
router.post("/", async (req, res) => {
  if (!ROLES.PAY.includes(req.user.role)) {
    return res.status(403).json({ error: `Requires ${ROLES.PAY.join(", ")}` });
  }
  const { orderId, method, amountTendered } = req.body || {};
  if (!orderId) return res.status(400).json({ error: "orderId is required" });
  if (!METHODS.includes(method)) return res.status(400).json({ error: `method must be one of ${METHODS.join(", ")}` });
  let tenderedCents = null;
  if (method === "CASH") {
    if (typeof amountTendered !== "number" || !Number.isFinite(amountTendered) || amountTendered < 0) {
      return res.status(400).json({ error: "amountTendered (a number) is required for cash" });
    }
    tenderedCents = Math.round(amountTendered * 100);
  }
  const locationId = req.user.locationId;

  const { paymentId, events } = await withTransaction(async (client) => {
    const { rows: orows } = await client.query(
      `SELECT o.*, t.label AS table_label FROM orders o JOIN restaurant_tables t ON t.id = o.table_id
       WHERE o.id = $1 AND o.location_id = $2 FOR UPDATE OF o`,
      [orderId, locationId]
    );
    if (orows.length === 0) throw new HttpError(404, "Order not found for this location");
    const order = orows[0];
    if (order.status === "CLOSED") throw new HttpError(409, "This order has already been paid");
    if (order.status !== "OPEN") throw new HttpError(409, `Order is ${order.status}`);

    const bill = await computeBill(client, locationId, orderId);
    if (bill.lines.length === 0) throw new HttpError(409, "Nothing to charge — every item was voided");
    const undelivered = bill.lines.filter((l) => !l.delivered);
    if (undelivered.length > 0) {
      throw new HttpError(409, `Not all items are delivered yet: ${undelivered.map((l) => `${l.quantity}x ${l.name}`).join(", ")}`);
    }
    if (method === "CASH" && tenderedCents < Math.round(bill.total * 100)) {
      throw new HttpError(400, `Cash received (${amountTendered}) is less than the total (${bill.total})`);
    }
    const change = method === "CASH" ? (tenderedCents - Math.round(bill.total * 100)) / 100 : null;

    const id = crypto.randomUUID();
    await client.query(
      `INSERT INTO payments (id, location_id, order_id, subtotal, tax, total, method, amount_tendered, change_given, paid_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, locationId, orderId, bill.subtotal, bill.tax, bill.total, method,
       method === "CASH" ? amountTendered : null, change, req.user.sub]
    );
    await client.query("UPDATE orders SET status = 'CLOSED', closed_at = now() WHERE id = $1", [orderId]);
    const ev = await logEvent(client, {
      locationId, orderId, type: "PAID", actorId: req.user.sub,
      message: `${order.table_label}: paid ${bill.total} by ${method}`,
      detail: { table: order.table_label, total: bill.total, method },
    });
    return { paymentId: id, events: [ev] };
  });

  const receipt = await buildReceipt({ query }, locationId, paymentId);
  emitToLocation(locationId, "order:closed", { orderId });
  emitToRoles(locationId, ROLES.OVERSEE, "payment:changed", { orderId, paymentId });
  emitActivity(locationId, events);
  res.status(201).json(receipt);
});

// GET /payments/:id/receipt — reprint a receipt.
router.get("/:id/receipt", async (req, res) => {
  if (!ROLES.PAY.includes(req.user.role)) {
    return res.status(403).json({ error: `Requires ${ROLES.PAY.join(", ")}` });
  }
  const receipt = await buildReceipt({ query }, req.user.locationId, req.params.id);
  if (!receipt) return res.status(404).json({ error: "Receipt not found for this location" });
  res.json(receipt);
});

module.exports = router;
