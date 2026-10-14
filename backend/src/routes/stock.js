const Router = require("../lib/asyncRouter");
const { query, withTransaction } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { HttpError } = require("../lib/http");
const { ROLES } = require("../lib/roles");
const { logEvent, emitActivity } = require("../lib/events");
const { onHandMap, addMovement, emitStock } = require("../lib/stock");

const router = Router();
router.use(requireAuth);
router.use(requireRole(...ROLES.OVERSEE));

// GET /stock — tracked menu items and current on-hand.
router.get("/", async (req, res) => {
  const { rows } = await query(
    "SELECT id, name FROM menu_items WHERE location_id = $1 AND track_stock = true AND active = true ORDER BY name",
    [req.user.locationId]
  );
  const map = await onHandMap({ query }, rows.map((r) => r.id));
  res.json(rows.map((r) => ({ menuItemId: r.id, name: r.name, onHand: map.get(r.id) })));
});

// POST /stock/movements — receive a delivery (+) or correct a count (±, note
// required). Sales and voids write their own movements automatically.
router.post("/movements", async (req, res) => {
  const { menuItemId, delta, reason, note } = req.body || {};
  if (!["RECEIVE", "ADJUST"].includes(reason)) return res.status(400).json({ error: "reason must be RECEIVE or ADJUST" });
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100000) {
    return res.status(400).json({ error: "delta must be a non-zero whole number" });
  }
  if (reason === "RECEIVE" && delta < 0) return res.status(400).json({ error: "RECEIVE must be positive; use ADJUST to correct downward" });
  const cleanNote = typeof note === "string" ? note.trim() : "";
  if (reason === "ADJUST" && cleanNote.length < 3) return res.status(400).json({ error: "ADJUST needs a note explaining why" });

  const locationId = req.user.locationId;
  const out = await withTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM menu_items WHERE id = $1 AND location_id = $2 AND track_stock = true FOR UPDATE",
      [menuItemId, locationId]
    );
    if (rows.length === 0) throw new HttpError(404, "Tracked menu item not found for this location");
    const current = (await onHandMap(client, [menuItemId])).get(menuItemId);
    if (current + delta < 0) throw new HttpError(409, `Would make stock negative (${current} on hand)`);
    await addMovement(client, { locationId, menuItemId, delta, reason, note: cleanNote || null, userId: req.user.sub });
    const ev = await logEvent(client, {
      locationId, type: reason === "RECEIVE" ? "STOCK_RECEIVED" : "STOCK_ADJUSTED", actorId: req.user.sub,
      message: `Stock ${reason === "RECEIVE" ? "received" : "adjusted"}: ${delta > 0 ? "+" : ""}${delta} ${rows[0].name}${cleanNote ? ` — ${cleanNote}` : ""}`,
      detail: { delta, reason },
    });
    return { onHand: current + delta, events: [ev] };
  });
  emitActivity(locationId, out.events);
  await emitStock(locationId, [menuItemId]);
  res.status(201).json({ menuItemId, onHand: out.onHand });
});

module.exports = router;
