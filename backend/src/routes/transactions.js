const Router = require("../lib/asyncRouter");
const { query } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { ROLES } = require("../lib/roles");
const { resolvePeriod } = require("../lib/period");

const router = Router();
router.use(requireAuth);
router.use(requireRole(...ROLES.OVERSEE));

// GET /transactions?date=YYYY-MM-DD — every payment (paid and voided) taken
// that local day, with who/what/how much, plus totals.
router.get("/", async (req, res) => {
  const d = await resolvePeriod(req.user.locationId, "day", req.query.date);
  if (d.error) return res.status(400).json({ error: d.error });

  const { rows } = await query(
    `SELECT p.id, p.receipt_no, p.order_id, p.paid_at, p.method, p.subtotal, p.tax, p.total, p.status,
            p.void_reason, p.voided_at, t.label AS table_label, u.name AS cashier, vu.name AS voided_by,
            (SELECT string_agg(oi.quantity || 'x ' || mi.name, ', ' ORDER BY oi.created_at, oi.id)
               FROM order_items oi JOIN menu_items mi ON mi.id = oi.menu_item_id
              WHERE oi.order_id = p.order_id AND oi.status <> 'CANCELLED') AS items
     FROM payments p
     JOIN orders o ON o.id = p.order_id
     JOIN restaurant_tables t ON t.id = o.table_id
     JOIN users u ON u.id = p.paid_by_id
     LEFT JOIN users vu ON vu.id = p.voided_by_id
     WHERE p.location_id = $1 AND p.paid_at >= $2 AND p.paid_at < $3
     ORDER BY p.paid_at DESC`,
    [req.user.locationId, d.start, d.end]
  );
  const payments = rows.map((r) => ({
    id: r.id,
    receiptNo: String(r.receipt_no),
    orderId: r.order_id,
    tableLabel: r.table_label,
    paidAt: r.paid_at,
    cashier: r.cashier,
    method: r.method,
    subtotal: Number(r.subtotal),
    tax: Number(r.tax),
    total: Number(r.total),
    status: r.status,
    items: r.items || "",
    voidReason: r.void_reason,
    voidedBy: r.voided_by,
  }));

  const { rows: t } = await query(
    `SELECT COUNT(*) FILTER (WHERE status = 'PAID') AS paid_count,
            COALESCE(SUM(subtotal) FILTER (WHERE status = 'PAID'), 0) AS subtotal,
            COALESCE(SUM(tax) FILTER (WHERE status = 'PAID'), 0) AS tax,
            COALESCE(SUM(total) FILTER (WHERE status = 'PAID'), 0) AS total,
            COUNT(*) FILTER (WHERE status = 'VOIDED') AS voided_count,
            COALESCE(SUM(total) FILTER (WHERE status = 'VOIDED'), 0) AS voided_total
     FROM payments WHERE location_id = $1 AND paid_at >= $2 AND paid_at < $3`,
    [req.user.locationId, d.start, d.end]
  );
  res.json({
    date: d.startDate,
    timezone: d.timezone,
    totals: {
      paidCount: Number(t[0].paid_count),
      subtotal: Number(t[0].subtotal),
      tax: Number(t[0].tax),
      total: Number(t[0].total),
      voidedCount: Number(t[0].voided_count),
      voidedTotal: Number(t[0].voided_total),
    },
    payments,
  });
});

// GET /transactions/activity?limit=100 — newest-first activity feed
// (orders sent, status changes, payments, voids).
router.get("/activity", async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const { rows } = await query(
    `SELECT e.id, e.order_id, e.type, e.message, e.detail, e.created_at, u.name AS actor_name
     FROM order_events e LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.location_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT $2`,
    [req.user.locationId, limit]
  );
  res.json(
    rows.map((r) => ({
      id: r.id,
      orderId: r.order_id,
      type: r.type,
      message: r.message,
      detail: r.detail,
      actorName: r.actor_name,
      createdAt: r.created_at,
    }))
  );
});

module.exports = router;
