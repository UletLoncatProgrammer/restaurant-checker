const crypto = require("crypto");
const { query } = require("../db");
const { emitToLocation } = require("../socket");

// On-hand = SUM of the signed ledger. Returns Map(menuItemId -> integer).
async function onHandMap(db, menuItemIds) {
  if (menuItemIds.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT menu_item_id, COALESCE(SUM(delta), 0)::int AS on_hand
     FROM stock_movements WHERE menu_item_id = ANY($1::text[]) GROUP BY menu_item_id`,
    [menuItemIds]
  );
  const map = new Map(menuItemIds.map((id) => [id, 0]));
  for (const r of rows) map.set(r.menu_item_id, r.on_hand);
  return map;
}

async function addMovement(client, { locationId, menuItemId, delta, reason, orderItemId = null, note = null, userId = null }) {
  await client.query(
    `INSERT INTO stock_movements (id, location_id, menu_item_id, delta, reason, order_item_id, note, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [crypto.randomUUID(), locationId, menuItemId, delta, reason, orderItemId, note, userId]
  );
}

// Tells every screen at the branch the new on-hand for tracked items (so a
// "3 left" badge on the order screen updates live). Call after commit.
async function emitStock(locationId, menuItemIds) {
  if (menuItemIds.length === 0) return;
  const { rows } = await query(
    "SELECT id FROM menu_items WHERE id = ANY($1::text[]) AND track_stock = true",
    [menuItemIds]
  );
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return;
  const map = await onHandMap({ query }, ids);
  emitToLocation(
    locationId,
    "stock:updated",
    ids.map((id) => ({ menuItemId: id, onHand: map.get(id) }))
  );
}

module.exports = { onHandMap, addMovement, emitStock };
