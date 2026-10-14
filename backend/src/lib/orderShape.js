// Shapes flat SQL join rows (one per order item) into the nested structure the
// frontend uses, and holds the shared SELECT so every route returns the same
// order shape.
const ORDER_SELECT = `
  SELECT
    o.id AS order_id, o.location_id, o.status AS order_status, o.opened_at, o.closed_at,
    o.opened_by_id, o.void_reason AS order_void_reason, o.customer_name, o.customer_phone,
    t.id AS table_id, t.label AS table_label,
    oi.id AS item_id, oi.quantity, oi.unit_price, oi.tax_rate AS item_tax_rate,
    oi.notes, oi.status AS item_status, oi.void_reason AS item_void_reason, oi.station AS item_station,
    oi.spice, oi.created_at AS item_created_at, oi.ready_at, oi.delivered_at,
    ru.name AS ready_by_name, du.name AS delivered_by_name,
    mi.id AS menu_item_id, mi.name AS menu_item_name
  FROM orders o
  JOIN restaurant_tables t ON t.id = o.table_id
  LEFT JOIN order_items oi ON oi.order_id = o.id
  LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
  LEFT JOIN users ru ON ru.id = oi.ready_by_id
  LEFT JOIN users du ON du.id = oi.delivered_by_id`;

function formatItem(r) {
  return {
    id: r.item_id,
    quantity: Number(r.quantity),
    unitPrice: Number(r.unit_price),
    taxRate: Number(r.item_tax_rate),
    notes: r.notes,
    status: r.item_status,
    station: r.item_station,
    spice: r.spice || null,
    createdAt: r.item_created_at,
    readyAt: r.ready_at || null,
    readyBy: r.ready_by_name || null,
    deliveredAt: r.delivered_at || null,
    deliveredBy: r.delivered_by_name || null,
    voidReason: r.item_void_reason || null,
    menuItem: { id: r.menu_item_id, name: r.menu_item_name },
  };
}

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
        openedById: r.opened_by_id,
        voidReason: r.order_void_reason || null,
        table: { id: r.table_id, label: r.table_label },
        customer: { name: r.customer_name || null, phone: r.customer_phone || null },
        items: [],
      });
    }
    if (r.item_id) byOrder.get(r.order_id).items.push(formatItem(r));
  }
  return Array.from(byOrder.values());
}

async function getOpenOrders(db, locationId) {
  const { rows } = await db.query(
    `${ORDER_SELECT} WHERE o.location_id = $1 AND o.status = 'OPEN'
     ORDER BY o.opened_at ASC, oi.created_at ASC, oi.id ASC`,
    [locationId]
  );
  return groupOrders(rows);
}

async function getOrder(db, locationId, orderId) {
  const { rows } = await db.query(
    `${ORDER_SELECT} WHERE o.location_id = $1 AND o.id = $2
     ORDER BY oi.created_at ASC, oi.id ASC`,
    [locationId, orderId]
  );
  return groupOrders(rows)[0] || null;
}

// Kitchen-only screens never receive the customer's phone number (they don't need it).
const { seesPhone } = require("./permissions");
function withoutPhone(order) {
  if (!order || !order.customer) return order;
  return { ...order, customer: { ...order.customer, phone: null } };
}
function forUser(order, user) {
  return seesPhone(user.permissions || []) ? order : withoutPhone(order);
}

module.exports = { ORDER_SELECT, formatItem, groupOrders, getOpenOrders, getOrder, withoutPhone, forUser };
