const express = require("express");
const crypto = require("crypto");
const { query, pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { emitToLocation } = require("../socket");

const router = express.Router();
router.use(requireAuth);

// Shapes a flat SQL join result (one row per order item) into the nested
// { order, table, items: [{ menuItem }] } structure the frontend expects.
function groupOrders(rows) {
  const byOrder = new Map();
  for (const r of rows) {
    if (!byOrder.has(r.order_id)) {
      byOrder.set(r.order_id, {
        id: r.order_id,
        locationId: r.location_id,
        status: r.order_status,
        openedAt: r.opened_at,
        closedAt: r.closed_at,
        table: { id: r.table_id, label: r.table_label },
        items: [],
      });
    }
    if (r.item_id) {
      byOrder.get(r.order_id).items.push({
        id: r.item_id,
        quantity: r.quantity,
        unitPrice: r.unit_price,
        taxRate: r.item_tax_rate,
        notes: r.notes,
        status: r.item_status,
        menuItem: { id: r.menu_item_id, name: r.menu_item_name },
      });
    }
  }
  return Array.from(byOrder.values());
}

const OPEN_ORDERS_SQL = `
  SELECT
    o.id AS order_id, o.location_id, o.status AS order_status, o.opened_at, o.closed_at,
    t.id AS table_id, t.label AS table_label,
    oi.id AS item_id, oi.quantity, oi.unit_price, oi.tax_rate AS item_tax_rate,
    oi.notes, oi.status AS item_status,
    mi.id AS menu_item_id, mi.name AS menu_item_name
  FROM orders o
  JOIN restaurant_tables t ON t.id = o.table_id
  LEFT JOIN order_items oi ON oi.order_id = o.id
  LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
  WHERE o.location_id = $1 AND o.status = 'OPEN'
  ORDER BY o.opened_at ASC
`;

// GET /orders/open — every open order + items for this location.
// Backs both the Kitchen Display and the Coordinator live board.
router.get("/open", async (req, res) => {
  const { rows } = await query(OPEN_ORDERS_SQL, [req.user.locationId]);
  res.json(groupOrders(rows));
});

// GET /orders/outstanding-summary — per-menu-item ordered vs delivered
// counts, computed live from order_item status (not a separately
// maintained counter, so it can't drift out of sync). This backs the
// Coordinator's "8x Nasi Goreng outstanding" view.
router.get("/outstanding-summary", async (req, res) => {
  const { rows } = await query(
    `SELECT mi.id AS menu_item_id, mi.name,
            SUM(oi.quantity) AS ordered,
            SUM(CASE WHEN oi.status = 'DELIVERED' THEN oi.quantity ELSE 0 END) AS delivered
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN menu_items mi ON mi.id = oi.menu_item_id
     WHERE o.location_id = $1 AND o.status = 'OPEN' AND oi.status != 'CANCELLED'
     GROUP BY mi.id, mi.name`,
    [req.user.locationId]
  );
  const result = rows.map((r) => ({
    menuItemId: r.menu_item_id,
    name: r.name,
    ordered: Number(r.ordered),
    delivered: Number(r.delivered),
    outstanding: Number(r.ordered) - Number(r.delivered),
  }));
  res.json(result);
});

// POST /orders — open a new order for a table with initial items.
router.post("/", async (req, res) => {
  if (!["FOH", "COORDINATOR", "ADMIN"].includes(req.user.role)) {
    return res.status(403).json({ error: "Requires FOH, COORDINATOR, or ADMIN" });
  }
  const { tableId, items } = req.body || {};
  if (!tableId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "tableId and a non-empty items[] are required" });
  }

  const { rows: tableRows } = await query(
    "SELECT * FROM restaurant_tables WHERE id = $1 AND location_id = $2",
    [tableId, req.user.locationId]
  );
  if (tableRows.length === 0) return res.status(404).json({ error: "Table not found for this location" });

  const menuItemIds = items.map((i) => i.menuItemId);
  const { rows: menuItems } = await query(
    "SELECT * FROM menu_items WHERE id = ANY($1::text[]) AND location_id = $2",
    [menuItemIds, req.user.locationId]
  );
  const menuItemById = new Map(menuItems.map((m) => [m.id, m]));

  for (const i of items) {
    if (!menuItemById.has(i.menuItemId)) {
      return res.status(400).json({ error: `Unknown menuItemId ${i.menuItemId} for this location` });
    }
  }

  const client = await pool.connect();
  const orderId = crypto.randomUUID();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO orders (id, location_id, table_id, opened_by_id) VALUES ($1, $2, $3, $4)`,
      [orderId, req.user.locationId, tableId, req.user.sub]
    );
    for (const i of items) {
      const menuItem = menuItemById.get(i.menuItemId);
      await client.query(
        `INSERT INTO order_items (id, order_id, menu_item_id, quantity, unit_price, tax_rate, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          crypto.randomUUID(),
          orderId,
          i.menuItemId,
          i.quantity || 1,
          menuItem.price,
          menuItem.tax_rate,
          i.notes || null,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const { rows } = await query(
    `${OPEN_ORDERS_SQL.replace("o.status = 'OPEN'", "o.id = $2")}`,
    [req.user.locationId, orderId]
  );
  const [order] = groupOrders(rows);

  emitToLocation(req.user.locationId, "order:created", order);
  res.status(201).json(order);
});

// PATCH /orders/:orderId/items/:itemId — update a single item's kitchen status.
router.patch("/:orderId/items/:itemId", async (req, res) => {
  if (!["KITCHEN", "FOH", "COORDINATOR", "ADMIN"].includes(req.user.role)) {
    return res.status(403).json({ error: "Requires KITCHEN, FOH, COORDINATOR, or ADMIN" });
  }
  const { orderId, itemId } = req.params;
  const { status } = req.body || {};
  const validStatuses = ["PENDING", "PREPARING", "READY", "DELIVERED", "CANCELLED"];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${validStatuses.join(", ")}` });
  }

  // Confirm the item belongs to this location before mutating — do not
  // trust orderId/itemId alone.
  const { rows: existing } = await query(
    `SELECT oi.* FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE oi.id = $1 AND oi.order_id = $2 AND o.location_id = $3`,
    [itemId, orderId, req.user.locationId]
  );
  if (existing.length === 0) return res.status(404).json({ error: "Order item not found for this location" });

  const { rows } = await query(
    `UPDATE order_items SET status = $1, updated_at = now() WHERE id = $2
     RETURNING *, (SELECT name FROM menu_items WHERE id = order_items.menu_item_id) AS menu_item_name`,
    [status, itemId]
  );
  const updated = {
    id: rows[0].id,
    quantity: rows[0].quantity,
    unitPrice: rows[0].unit_price,
    notes: rows[0].notes,
    status: rows[0].status,
    menuItem: { id: rows[0].menu_item_id, name: rows[0].menu_item_name },
  };

  emitToLocation(req.user.locationId, "order-item:updated", { orderId, item: updated });
  res.json(updated);
});

// POST /orders/:orderId/close — closes a table's order once everything's delivered.
router.post("/:orderId/close", async (req, res) => {
  if (!["FOH", "COORDINATOR", "ADMIN"].includes(req.user.role)) {
    return res.status(403).json({ error: "Requires FOH, COORDINATOR, or ADMIN" });
  }
  const { orderId } = req.params;
  const { rows: existing } = await query(
    "SELECT * FROM orders WHERE id = $1 AND location_id = $2",
    [orderId, req.user.locationId]
  );
  if (existing.length === 0) return res.status(404).json({ error: "Order not found for this location" });

  const { rows } = await query(
    "UPDATE orders SET status = 'CLOSED', closed_at = now() WHERE id = $1 RETURNING *",
    [orderId]
  );

  emitToLocation(req.user.locationId, "order:closed", { orderId });
  res.json(rows[0]);
});

module.exports = router;
