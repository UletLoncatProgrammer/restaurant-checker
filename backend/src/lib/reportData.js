const { query } = require("../db");

const n = (v) => Number(v);

// Gathers everything the Excel report shows. Kept separate from the workbook
// writer so tests can assert the numbers without parsing a .xlsx.
//
// Definitions (also printed on the Summary sheet):
//  - Sales = payments with status PAID whose paid_at falls in the window
//    (location-local calendar). Sales later voided are excluded and listed
//    on the Voids/Transactions sheets instead.
//  - Net = pre-tax subtotal; Tax = per-line rounded tax; Gross = Net + Tax.
//  - Stock "Sold" = units deducted when an order was sent (not when paid);
//    voids of not-yet-started items are returned via "Void restock".
async function getReportData(locationId, win) {
  const { start, end, timezone: tz } = win;
  const base = [locationId, start, end];

  const { rows: loc } = await query("SELECT name FROM locations WHERE id = $1", [locationId]);

  const { rows: sum } = await query(
    `SELECT COUNT(*) FILTER (WHERE status = 'PAID') AS sales_count,
            COALESCE(SUM(subtotal) FILTER (WHERE status = 'PAID'), 0) AS net,
            COALESCE(SUM(tax) FILTER (WHERE status = 'PAID'), 0) AS tax,
            COALESCE(SUM(total) FILTER (WHERE status = 'PAID'), 0) AS gross,
            COUNT(*) FILTER (WHERE status = 'VOIDED') AS voided_sales_count,
            COALESCE(SUM(total) FILTER (WHERE status = 'VOIDED'), 0) AS voided_sales_total
     FROM payments WHERE location_id = $1 AND paid_at >= $2 AND paid_at < $3`,
    base
  );
  const { rows: byMethod } = await query(
    `SELECT method, COUNT(*) AS count, SUM(total) AS gross
     FROM payments WHERE location_id = $1 AND paid_at >= $2 AND paid_at < $3 AND status = 'PAID'
     GROUP BY method ORDER BY method`,
    base
  );

  const { rows: byDay } = await query(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            COUNT(p.id) AS sales_count,
            COALESCE(SUM(p.subtotal), 0) AS net, COALESCE(SUM(p.tax), 0) AS tax, COALESCE(SUM(p.total), 0) AS gross
     FROM generate_series($4::date, $5::date - 1, interval '1 day') AS d(day)
     LEFT JOIN payments p ON p.location_id = $1 AND p.status = 'PAID'
          AND p.paid_at >= $2 AND p.paid_at < $3
          AND (p.paid_at AT TIME ZONE $6)::date = d.day::date
     GROUP BY d.day ORDER BY d.day`,
    [locationId, start, end, win.startDate, win.endDate, tz]
  );

  const { rows: byItem } = await query(
    `SELECT mi.name, COALESCE(c.name, '') AS category,
            SUM(oi.quantity) AS qty,
            SUM(oi.quantity * oi.unit_price) AS net,
            SUM(ROUND(oi.quantity * oi.unit_price * oi.tax_rate, 0)) AS tax
     FROM order_items oi
     JOIN payments p ON p.order_id = oi.order_id AND p.status = 'PAID'
     JOIN menu_items mi ON mi.id = oi.menu_item_id
     LEFT JOIN menu_categories c ON c.id = mi.category_id
     WHERE p.location_id = $1 AND p.paid_at >= $2 AND p.paid_at < $3 AND oi.status <> 'CANCELLED'
     GROUP BY mi.id, mi.name, c.name ORDER BY SUM(oi.quantity * oi.unit_price) DESC, mi.name`,
    base
  );

  const { rows: txns } = await query(
    `SELECT p.receipt_no, to_char(p.paid_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI:SS') AS paid_local,
            t.label AS table_label, u.name AS cashier, p.method, p.subtotal, p.tax, p.total, p.status,
            COALESCE(p.void_reason, '') AS void_reason, COALESCE(vu.name, '') AS voided_by,
            COALESCE((SELECT string_agg(oi.quantity || 'x ' || mi.name, ', ' ORDER BY oi.created_at, oi.id)
                        FROM order_items oi JOIN menu_items mi ON mi.id = oi.menu_item_id
                       WHERE oi.order_id = p.order_id AND oi.status <> 'CANCELLED'), '') AS items
     FROM payments p
     JOIN orders o ON o.id = p.order_id
     JOIN restaurant_tables t ON t.id = o.table_id
     JOIN users u ON u.id = p.paid_by_id
     LEFT JOIN users vu ON vu.id = p.voided_by_id
     WHERE p.location_id = $1 AND p.paid_at >= $2 AND p.paid_at < $3
     ORDER BY p.paid_at, p.receipt_no`,
    [...base, tz]
  );

  const { rows: stock } = await query(
    `SELECT mi.name,
            COALESCE(SUM(sm.delta) FILTER (WHERE sm.created_at < $2), 0) AS opening,
            COALESCE(SUM(sm.delta) FILTER (WHERE sm.created_at >= $2 AND sm.created_at < $3 AND sm.reason IN ('OPENING','RECEIVE')), 0) AS received,
            COALESCE(-SUM(sm.delta) FILTER (WHERE sm.created_at >= $2 AND sm.created_at < $3 AND sm.reason = 'SALE'), 0) AS sold,
            COALESCE(SUM(sm.delta) FILTER (WHERE sm.created_at >= $2 AND sm.created_at < $3 AND sm.reason = 'VOID_RESTOCK'), 0) AS void_restock,
            COALESCE(SUM(sm.delta) FILTER (WHERE sm.created_at >= $2 AND sm.created_at < $3 AND sm.reason = 'ADJUST'), 0) AS adjust,
            COALESCE(SUM(sm.delta) FILTER (WHERE sm.created_at < $3), 0) AS closing
     FROM menu_items mi
     LEFT JOIN stock_movements sm ON sm.menu_item_id = mi.id
     WHERE mi.location_id = $1 AND mi.track_stock = true
     GROUP BY mi.id, mi.name ORDER BY mi.name`,
    base
  );

  const { rows: voids } = await query(
    `SELECT to_char(e.created_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI:SS') AS at_local,
            e.type, COALESCE(e.detail->>'table', '') AS table_label, COALESCE(u.name, '') AS actor,
            e.message, COALESCE((e.detail->>'amount')::numeric, 0) AS amount,
            COALESCE(e.detail->>'reason', '') AS reason
     FROM order_events e LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.location_id = $1 AND e.created_at >= $2 AND e.created_at < $3
       AND e.type IN ('ITEM_VOIDED', 'ORDER_VOIDED', 'SALE_VOIDED')
     ORDER BY e.created_at, e.id`,
    [...base, tz]
  );

  return {
    locationName: loc[0].name,
    timezone: tz,
    period: win.period,
    startDate: win.startDate,
    endDate: win.endDate, // exclusive
    summary: {
      salesCount: n(sum[0].sales_count),
      net: n(sum[0].net),
      tax: n(sum[0].tax),
      gross: n(sum[0].gross),
      voidedSalesCount: n(sum[0].voided_sales_count),
      voidedSalesTotal: n(sum[0].voided_sales_total),
    },
    byMethod: byMethod.map((r) => ({ method: r.method, count: n(r.count), gross: n(r.gross) })),
    byDay: byDay.map((r) => ({ day: r.day, salesCount: n(r.sales_count), net: n(r.net), tax: n(r.tax), gross: n(r.gross) })),
    byItem: byItem.map((r) => ({ name: r.name, category: r.category, qty: n(r.qty), net: n(r.net), tax: n(r.tax) })),
    transactions: txns.map((r) => ({
      receiptNo: String(r.receipt_no), paidLocal: r.paid_local, table: r.table_label, cashier: r.cashier,
      method: r.method, subtotal: n(r.subtotal), tax: n(r.tax), total: n(r.total), status: r.status,
      items: r.items, voidReason: r.void_reason, voidedBy: r.voided_by,
    })),
    stock: stock.map((r) => ({
      name: r.name, opening: n(r.opening), received: n(r.received), sold: n(r.sold),
      voidRestock: n(r.void_restock), adjust: n(r.adjust), closing: n(r.closing),
    })),
    voids: voids.map((r) => ({
      at: r.at_local, type: r.type, table: r.table_label, actor: r.actor, amount: n(r.amount),
      reason: r.reason, message: r.message,
    })),
  };
}

module.exports = { getReportData };
