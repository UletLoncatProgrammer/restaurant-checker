const crypto = require("crypto");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { HttpError } = require("../lib/http");
const { emitToLocation } = require("../socket");

const router = require("../lib/asyncRouter")();
router.use(requireAuth);

const EDITORS = ["ADMIN", "COORDINATOR"];
function requireEditor(req) {
  if (!EDITORS.includes(req.user.role)) throw new HttpError(403, "Requires ADMIN or COORDINATOR");
}
function cleanLabel(raw) {
  const label = typeof raw === "string" ? raw.trim() : "";
  if (label.length < 1 || label.length > 30) throw new HttpError(400, "label must be 1 to 30 characters");
  return label;
}

// Restaurant-wide settings every screen needs (e.g. which kitchen screens exist).
router.get("/settings", async (req, res) => {
  const { rows } = await query("SELECT name, kitchen_mode FROM locations WHERE id = $1", [req.user.locationId]);
  res.json({ locationName: rows[0].name, kitchenMode: rows[0].kitchen_mode });
});

// ONE = hot and cold dishes on one kitchen screen; SPLIT = a Hot Kitchen and a Cold Kitchen screen.
router.patch("/settings", async (req, res) => {
  requireEditor(req);
  const mode = req.body && req.body.kitchenMode;
  if (mode !== "ONE" && mode !== "SPLIT") throw new HttpError(400, "kitchenMode must be ONE or SPLIT");
  const { rows } = await query(
    "UPDATE locations SET kitchen_mode = $2 WHERE id = $1 RETURNING name, kitchen_mode",
    [req.user.locationId, mode]
  );
  const settings = { locationName: rows[0].name, kitchenMode: rows[0].kitchen_mode };
  emitToLocation(req.user.locationId, "settings:updated", settings); // open screens switch at once
  res.json(settings);
});

router.get("/tables", async (req, res) => {
  const { rows } = await query(
    "SELECT * FROM restaurant_tables WHERE location_id = $1 AND active = true ORDER BY label ASC",
    [req.user.locationId]
  );
  res.json(rows);
});

router.post("/tables", async (req, res) => {
  requireEditor(req);
  const label = cleanLabel(req.body && req.body.label);
  try {
    const { rows } = await query(
      "INSERT INTO restaurant_tables (id, location_id, label) VALUES ($1, $2, $3) RETURNING *",
      [crypto.randomUUID(), req.user.locationId, label]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === "23505") throw new HttpError(409, "A table with that name already exists");
    throw e;
  }
});

// Rename, or take a table out of service (history keeps pointing at it).
router.patch("/tables/:id", async (req, res) => {
  requireEditor(req);
  const b = req.body || {};
  if (b.active !== undefined && typeof b.active !== "boolean") throw new HttpError(400, "active must be true or false");
  const label = b.label === undefined ? null : cleanLabel(b.label);
  if (b.active === false) {
    const { rows: open } = await query(
      "SELECT 1 FROM orders WHERE table_id = $1 AND location_id = $2 AND status = 'OPEN' LIMIT 1",
      [req.params.id, req.user.locationId]
    );
    if (open.length) throw new HttpError(409, "This table has an open order — finish or void it first");
  }
  try {
    const { rows } = await query(
      `UPDATE restaurant_tables SET label = COALESCE($3, label), active = COALESCE($4, active)
       WHERE id = $1 AND location_id = $2 RETURNING *`,
      [req.params.id, req.user.locationId, label, b.active === undefined ? null : b.active]
    );
    if (rows.length === 0) throw new HttpError(404, "Table not found for this location");
    res.json(rows[0]);
  } catch (e) {
    if (e.code === "23505") throw new HttpError(409, "A table with that name already exists");
    throw e;
  }
});

module.exports = router;
