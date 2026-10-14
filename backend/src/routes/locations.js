const crypto = require("crypto");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { HttpError } = require("../lib/http");
const { emitToLocation } = require("../socket");
const { percent } = require("../lib/billing");
const { logAuth } = require("../lib/audit");

const router = require("../lib/asyncRouter")();
router.use(requireAuth);

// Editing the menu, tables and kitchen setup needs the MENU permission.
const { can } = require("../lib/permissions");
function requireEditor(req) {
  if (!can(req.user, "MENU")) throw new HttpError(403, "Not allowed to edit the menu (needs permission MENU)");
}
function cleanLabel(raw) {
  const label = typeof raw === "string" ? raw.trim() : "";
  if (label.length < 1 || label.length > 30) throw new HttpError(400, "label must be 1 to 30 characters");
  return label;
}

// Restaurant-wide settings every screen needs: the kitchen mode and the billing rates.
const SETTINGS_SQL = "SELECT name, kitchen_mode, tax_label, tax_rate, service_rate, tax_on_service FROM locations WHERE id = $1";
function shapeSettings(r) {
  return {
    locationName: r.name,
    kitchenMode: r.kitchen_mode,
    billing: { taxLabel: r.tax_label, taxPercent: percent(r.tax_rate), servicePercent: percent(r.service_rate), taxOnService: r.tax_on_service },
  };
}
// 10 -> 0.10; 0 to 25, at most two decimals.
function cleanPercent(raw, what) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 25) throw new HttpError(400, `${what} must be a percentage from 0 to 25`);
  return Math.round(raw * 100) / 10000;
}

router.get("/settings", async (req, res) => {
  const { rows } = await query(SETTINGS_SQL, [req.user.locationId]);
  res.json(shapeSettings(rows[0]));
});

// { kitchenMode }                       ONE = hot and cold dishes on one screen; SPLIT = separate (needs MENU)
// { taxLabel, taxPercent, servicePercent, taxOnService }   billing (needs STAFF = Admin): money rules
router.patch("/settings", async (req, res) => {
  const b = req.body || {};
  const sets = [];
  const vals = [req.user.locationId];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.kitchenMode !== undefined) {
    requireEditor(req);
    if (b.kitchenMode !== "ONE" && b.kitchenMode !== "SPLIT") throw new HttpError(400, "kitchenMode must be ONE or SPLIT");
    add("kitchen_mode", b.kitchenMode);
  }
  const billing = ["taxLabel", "taxPercent", "servicePercent", "taxOnService"].filter((k) => b[k] !== undefined);
  if (billing.length) {
    if (!can(req.user, "STAFF")) throw new HttpError(403, "Only Admin can change tax and service charge");
    if (b.taxLabel !== undefined) {
      const label = typeof b.taxLabel === "string" ? b.taxLabel.trim() : "";
      if (label.length < 1 || label.length > 20) throw new HttpError(400, "Tax name must be 1 to 20 characters");
      add("tax_label", label);
    }
    if (b.taxPercent !== undefined) add("tax_rate", cleanPercent(b.taxPercent, "Tax"));
    if (b.servicePercent !== undefined) add("service_rate", cleanPercent(b.servicePercent, "Service charge"));
    if (b.taxOnService !== undefined) {
      if (typeof b.taxOnService !== "boolean") throw new HttpError(400, "taxOnService must be true or false");
      add("tax_on_service", b.taxOnService);
    }
  }
  if (sets.length === 0) throw new HttpError(400, "Nothing to change");
  await query(`UPDATE locations SET ${sets.join(", ")} WHERE id = $1`, vals);
  const { rows } = await query(SETTINGS_SQL, [req.user.locationId]);
  const settings = shapeSettings(rows[0]);
  if (billing.length) {
    await logAuth({ locationId: req.user.locationId, userId: req.user.sub, type: "BILLING_CHANGED", ip: req.ip, detail: settings.billing });
  }
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
