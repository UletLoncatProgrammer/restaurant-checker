const crypto = require("crypto");
const Router = require("../lib/asyncRouter");
const { query, withTransaction } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { emitToLocation, emitToRoles } = require("../socket");
const { HttpError } = require("../lib/http");
const { ROLES } = require("../lib/roles");
const { logEvent, emitActivity } = require("../lib/events");
const { onHandMap, addMovement, emitStock } = require("../lib/stock");
const { getOpenOrders, getOrder } = require("../lib/orderShape");

const router = Router();
router.use(requireAuth);

function cleanReason(raw) {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length < 3) throw new HttpError(400, "A reason (at least 3 characters) is required to void");
  if (reason.length > 200) throw new HttpError(400, "Reason must be 200 characters or fewer");
  return reason;
}

// Locks and returns the order row, scoped to the caller's location. Locking
// serializes concurrent pay / void / status changes on the same order.
async function lockOrder(client, locationId, orderId) {
  const { rows } = await client.query(
    `SELECT o.*, t.label AS table_label FROM orders o
     JOIN restaurant_tables t ON t.id = o.table_id
     WHERE o.id = $1 AND o.location_id = $2 FOR UPDATE OF o`,
    [orderId, locationId]
  );
  if (rows.length === 0) throw new HttpError(404, "Order not found for this location");
  return rows[0];
}

// GET /orders/open — every open order + items for this location.
router.get("/open", async (req, res) => {
  res.json(await getOpenOrders({ query }, req.user.locationId));
});

// GET /orders/outstanding-summary — per-menu-item ordered vs delivered,
// computed live from item status (no separate counter that could drift).
// Cancelled (voided) items are excluded.
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
  res.json(
    rows.map((r) => ({
      menuItemId: r.menu_item_id,
      name: r.name,
      ordered: Number(r.ordered),
      delivered: Number(r.delivered),
      outstanding: Number(r.ordered) - Number(r.delivered),
    }))
  );
});

// POST /orders — send dishes for a table. If the table already has an OPEN order
// (its running bill), the dishes are added to it; otherwise a new order is opened.
// Response: the full order plus "added": true when it went onto an existing bill.
router.post("/", async (req, res) => {
  if (!ROLES.TAKE_ORDER.includes(req.user.role)) {
    return res.status(403).json({ error: `Requires ${ROLES.TAKE_ORDER.join(", ")}` });
  }
  const { tableId, items } = req.body || {};
  if (typeof tableId !== "string" || !tableId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "tableId and a non-empty items[] are required" });
  }
  if (items.length > 100) return res.status(400).json({ error: "Too many items in one order" });
  for (const i of items) {
    if (!i || typeof i !== "object" || typeof i.menuItemId !== "string" || !i.menuItemId) {
      return res.status(400).json({ error: "Each item needs a menuItemId" });
    }
    const q = i.quantity === undefined ? 1 : i.quantity;
    if (!Number.isInteger(q) || q < 1 || q > 99) {
      return res.status(400).json({ error: "Each quantity must be a whole number from 1 to 99" });
    }
    if (i.notes !== undefined && i.notes !== null && (typeof i.notes !== "string" || i.notes.length > 200)) {
      return res.status(400).json({ error: "notes must be text of 200 characters or fewer" });
    }
  }

  const locationId = req.user.locationId;
  const { order, activity, stockIds, added, addedIds } = await withTransaction(async (client) => {
    // Locking the table row makes two waiters sending to the same table at the
    // same moment take turns, so the second one finds (and adds to) the first's order.
    const { rows: tableRows } = await client.query(
      "SELECT * FROM restaurant_tables WHERE id = $1 AND location_id = $2 AND active = true FOR UPDATE",
      [tableId, locationId]
    );
    if (tableRows.length === 0) throw new HttpError(404, "Table not found for this location");

    const ids = [...new Set(items.map((i) => i.menuItemId))];
    // Lock tracked menu rows in a stable order so two orders for the same
    // low-stock item queue up instead of both seeing "1 left".
    const { rows: menuItems } = await client.query(
      `SELECT * FROM menu_items WHERE id = ANY($1::text[]) AND location_id = $2 AND active = true
       ORDER BY id FOR UPDATE`,
      [ids, locationId]
    );
    const byId = new Map(menuItems.map((m) => [m.id, m]));
    for (const i of items) {
      if (!byId.has(i.menuItemId)) throw new HttpError(400, `Unknown or inactive menuItemId ${i.menuItemId} for this location`);
    }

    const demand = new Map();
    for (const i of items) demand.set(i.menuItemId, (demand.get(i.menuItemId) || 0) + (i.quantity || 1));
    const trackedIds = menuItems.filter((m) => m.track_stock).map((m) => m.id);
    const onHand = await onHandMap(client, trackedIds);
    for (const id of trackedIds) {
      if (demand.get(id) > onHand.get(id)) {
        throw new HttpError(409, `Not enough stock: ${byId.get(id).name} (${onHand.get(id)} left)`);
      }
    }

    // The table's running bill, if any. Locked so a payment can't close it while we add to it.
    const { rows: openRows } = await client.query(
      `SELECT id FROM orders WHERE table_id = $1 AND location_id = $2 AND status = 'OPEN'
       ORDER BY opened_at LIMIT 1 FOR UPDATE`,
      [tableId, locationId]
    );
    const isNew = openRows.length === 0;
    const orderId = isNew ? crypto.randomUUID() : openRows[0].id;
    if (isNew) {
      await client.query(
        "INSERT INTO orders (id, location_id, table_id, opened_by_id) VALUES ($1, $2, $3, $4)",
        [orderId, locationId, tableId, req.user.sub]
      );
    }
    const newItemIds = [];
    for (const i of items) {
      const m = byId.get(i.menuItemId);
      const qty = i.quantity || 1;
      const orderItemId = crypto.randomUUID();
      await client.query(
        // clock_timestamp() (not now()) so lines keep the order they were sent
        // in: now() is identical for every statement in a transaction.
        // station is copied from the dish so the ticket stays on its screen even if the menu changes later
        `INSERT INTO order_items (id, order_id, menu_item_id, quantity, unit_price, tax_rate, notes, station, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp(), clock_timestamp())`,
        [orderItemId, orderId, m.id, qty, m.price, m.tax_rate, i.notes ? i.notes.trim() : null, m.station]
      );
      newItemIds.push(orderItemId);
      if (m.track_stock) {
        await addMovement(client, {
          locationId, menuItemId: m.id, delta: -qty, reason: "SALE", orderItemId, userId: req.user.sub,
        });
      }
    }

    const summary = [...demand].map(([id, q]) => `${q}x ${byId.get(id).name}`).join(", ");
    const ev = await logEvent(client, {
      locationId, orderId, type: isNew ? "ORDER_CREATED" : "ITEMS_ADDED", actorId: req.user.sub,
      message: isNew ? `${tableRows[0].label}: new order — ${summary}` : `${tableRows[0].label}: added — ${summary}`,
      detail: { table: tableRows[0].label },
    });
    return {
      order: await getOrder(client, locationId, orderId),
      activity: [ev], stockIds: trackedIds, added: !isNew, addedIds: newItemIds,
    };
  });

  if (added) {
    // screens replace their copy of this order and ring only for the new lines
    emitToLocation(locationId, "order:items-added", { order, addedItemIds: addedIds, addedById: req.user.sub });
  } else {
    emitToLocation(locationId, "order:created", order);
  }
  emitActivity(locationId, activity);
  await emitStock(locationId, stockIds);
  res.status(added ? 200 : 201).json({ ...order, added });
});

// Legal item moves. The only way to CANCEL an item is the supervisor void
// endpoints below — a plain PATCH can no longer cancel or move backwards.
const TRANSITIONS = {
  PENDING: { to: "PREPARING", roles: ROLES.KITCHEN_STATUS },
  PREPARING: { to: "READY", roles: ROLES.KITCHEN_STATUS },
  READY: { to: "DELIVERED", roles: ROLES.DELIVER },
};

// PATCH /orders/:orderId/items/:itemId — advance one item's status.
router.patch("/:orderId/items/:itemId", async (req, res) => {
  const { orderId, itemId } = req.params;
  const { status } = req.body || {};
  const locationId = req.user.locationId;

  const result = await withTransaction(async (client) => {
    const order = await lockOrder(client, locationId, orderId);
    const { rows } = await client.query(
      "SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE",
      [itemId, orderId]
    );
    if (rows.length === 0) throw new HttpError(404, "Order item not found for this location");
    const item = rows[0];

    if (item.status === status) return { changed: false, order, item }; // double-tap: no-op
    if (order.status !== "OPEN") throw new HttpError(409, `Order is ${order.status}; items can no longer change`);
    const rule = TRANSITIONS[item.status];
    if (!rule || rule.to !== status) {
      throw new HttpError(409, `Cannot move an item from ${item.status} to ${status}`);
    }
    if (!rule.roles.includes(req.user.role)) {
      throw new HttpError(403, `Requires ${rule.roles.join(", ")} to mark ${status}`);
    }

    await client.query("UPDATE order_items SET status = $1, updated_at = now() WHERE id = $2", [status, itemId]);
    const { rows: nameRows } = await client.query("SELECT name FROM menu_items WHERE id = $1", [item.menu_item_id]);
    const ev = await logEvent(client, {
      locationId, orderId, type: "ITEM_STATUS", actorId: req.user.sub,
      message: `${order.table_label}: ${item.quantity}x ${nameRows[0].name} → ${status}`,
      detail: { table: order.table_label, status },
    });
    const fresh = await getOrder(client, locationId, orderId);
    return { changed: true, order, item: fresh.items.find((i) => i.id === itemId), activity: [ev] };
  });

  if (!result.changed) {
    const fresh = await getOrder({ query }, locationId, orderId);
    return res.json(fresh.items.find((i) => i.id === itemId));
  }
  emitToLocation(locationId, "order-item:updated", {
    orderId,
    orderOpenedById: result.order.opened_by_id,
    tableLabel: result.order.table_label,
    item: result.item,
  });
  emitActivity(locationId, result.activity);
  res.json(result.item);
});

// POST /orders/:orderId/items/:itemId/void — supervisor/admin voids one item
// on an OPEN order (wrong dish, customer changed mind). Reason is mandatory.
// Restocks only if the kitchen had not started it (PENDING); food already
// being cooked is waste, not stock.
router.post("/:orderId/items/:itemId/void", async (req, res) => {
  if (!ROLES.VOID.includes(req.user.role)) {
    return res.status(403).json({ error: `Only ${ROLES.VOID.join(" or ")} can void` });
  }
  const reason = cleanReason(req.body && req.body.reason);
  const { orderId, itemId } = req.params;
  const locationId = req.user.locationId;

  const out = await withTransaction(async (client) => {
    const order = await lockOrder(client, locationId, orderId);
    if (order.status === "CLOSED") throw new HttpError(409, "Order is already paid — void the whole sale instead");
    if (order.status !== "OPEN") throw new HttpError(409, `Order is already ${order.status}`);

    const { rows } = await client.query(
      `SELECT oi.*, mi.name, mi.track_stock FROM order_items oi
       JOIN menu_items mi ON mi.id = oi.menu_item_id
       WHERE oi.id = $1 AND oi.order_id = $2 FOR UPDATE OF oi`,
      [itemId, orderId]
    );
    if (rows.length === 0) throw new HttpError(404, "Order item not found for this location");
    const item = rows[0];
    if (item.status === "CANCELLED") throw new HttpError(409, "Item is already voided");

    await client.query(
      `UPDATE order_items SET status = 'CANCELLED', voided_at = now(), voided_by_id = $1, void_reason = $2,
       updated_at = now() WHERE id = $3`,
      [req.user.sub, reason, itemId]
    );
    const restocked = item.status === "PENDING" && item.track_stock;
    if (restocked) {
      await addMovement(client, {
        locationId, menuItemId: item.menu_item_id, delta: item.quantity, reason: "VOID_RESTOCK",
        orderItemId: itemId, note: reason, userId: req.user.sub,
      });
    }

    const events = [
      await logEvent(client, {
        locationId, orderId, type: "ITEM_VOIDED", actorId: req.user.sub,
        message: `${order.table_label}: VOIDED ${item.quantity}x ${item.name} — ${reason}`,
        detail: {
          table: order.table_label, reason, restocked,
          amount: Number(item.quantity) * Number(item.unit_price), wasStatus: item.status,
        },
      }),
    ];

    const { rows: left } = await client.query(
      "SELECT 1 FROM order_items WHERE order_id = $1 AND status <> 'CANCELLED' LIMIT 1",
      [orderId]
    );
    const orderCancelled = left.length === 0;
    if (orderCancelled) {
      await client.query(
        `UPDATE orders SET status = 'CANCELLED', closed_at = now(), voided_at = now(), voided_by_id = $1,
         void_reason = $2 WHERE id = $3`,
        [req.user.sub, "All items voided", orderId]
      );
    }
    const fresh = await getOrder(client, locationId, orderId);
    return {
      item: fresh.items.find((i) => i.id === itemId),
      orderCancelled, events, stockIds: restocked ? [item.menu_item_id] : [],
      tableLabel: order.table_label,
    };
  });

  emitToLocation(locationId, "order-item:voided", {
    orderId, item: out.item, orderCancelled: out.orderCancelled, tableLabel: out.tableLabel,
  });
  emitActivity(locationId, out.events);
  await emitStock(locationId, out.stockIds);
  res.json({ item: out.item, orderCancelled: out.orderCancelled });
});

// POST /orders/:orderId/void — supervisor/admin voids a whole order: either
// an OPEN order (everything not yet voided is cancelled) or an already-PAID
// order (the payment is marked VOIDED and drops out of sales).
router.post("/:orderId/void", async (req, res) => {
  if (!ROLES.VOID.includes(req.user.role)) {
    return res.status(403).json({ error: `Only ${ROLES.VOID.join(" or ")} can void` });
  }
  const reason = cleanReason(req.body && req.body.reason);
  const { orderId } = req.params;
  const locationId = req.user.locationId;

  const out = await withTransaction(async (client) => {
    const order = await lockOrder(client, locationId, orderId);
    if (order.status === "CANCELLED") throw new HttpError(409, "Order is already voided");

    const stockIds = [];
    let wasPaid = false;
    let amount = 0;

    if (order.status === "CLOSED") {
      const { rows } = await client.query(
        `UPDATE payments SET status = 'VOIDED', voided_at = now(), voided_by_id = $1, void_reason = $2
         WHERE order_id = $3 AND status = 'PAID' RETURNING total`,
        [req.user.sub, reason, orderId]
      );
      if (rows.length === 0) throw new HttpError(409, "No active payment found for this order");
      wasPaid = true;
      amount = Number(rows[0].total);
    } else {
      const { rows: items } = await client.query(
        `SELECT oi.*, mi.track_stock FROM order_items oi JOIN menu_items mi ON mi.id = oi.menu_item_id
         WHERE oi.order_id = $1 AND oi.status <> 'CANCELLED' FOR UPDATE OF oi`,
        [orderId]
      );
      for (const it of items) {
        amount += Number(it.quantity) * Number(it.unit_price);
        if (it.status === "PENDING" && it.track_stock) {
          await addMovement(client, {
            locationId, menuItemId: it.menu_item_id, delta: it.quantity, reason: "VOID_RESTOCK",
            orderItemId: it.id, note: reason, userId: req.user.sub,
          });
          stockIds.push(it.menu_item_id);
        }
      }
      await client.query(
        `UPDATE order_items SET status = 'CANCELLED', voided_at = now(), voided_by_id = $1, void_reason = $2,
         updated_at = now() WHERE order_id = $3 AND status <> 'CANCELLED'`,
        [req.user.sub, reason, orderId]
      );
    }

    await client.query(
      `UPDATE orders SET status = 'CANCELLED', closed_at = COALESCE(closed_at, now()), voided_at = now(),
       voided_by_id = $1, void_reason = $2 WHERE id = $3`,
      [req.user.sub, reason, orderId]
    );
    const ev = await logEvent(client, {
      locationId, orderId, type: wasPaid ? "SALE_VOIDED" : "ORDER_VOIDED", actorId: req.user.sub,
      message: `${order.table_label}: ${wasPaid ? "paid sale" : "order"} VOIDED — ${reason}`,
      detail: { table: order.table_label, reason, wasPaid, amount },
    });
    return { wasPaid, stockIds, events: [ev], tableLabel: order.table_label };
  });

  emitToLocation(locationId, "order:voided", { orderId, wasPaid: out.wasPaid, tableLabel: out.tableLabel });
  emitToRoles(locationId, ROLES.OVERSEE, "payment:changed", { orderId });
  emitActivity(locationId, out.events);
  await emitStock(locationId, out.stockIds);
  res.json({ orderId, voided: true, wasPaid: out.wasPaid });
});

module.exports = router;
