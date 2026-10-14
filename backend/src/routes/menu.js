const crypto = require("crypto");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { onHandMap } = require("../lib/stock");
const { HttpError } = require("../lib/http");

const router = require("../lib/asyncRouter")();
router.use(requireAuth);

// All queries below use req.user.locationId, never a client-supplied
// locationId — that's the multi-tenant isolation boundary.

// Editing the menu, tables and kitchen setup needs the MENU permission.
const { can } = require("../lib/permissions");
function requireEditor(req) {
  if (!can(req.user, "MENU")) throw new HttpError(403, "Not allowed to edit the menu (needs permission MENU)");
}

function cleanName(raw, what, max = 80) {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length < 1 || name.length > max) throw new HttpError(400, `${what} must be 1 to ${max} characters`);
  return name;
}
function cleanPrice(raw) {
  // whole rupiah in practice, but NUMERIC(10,2) so decimals work for other currencies
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 99999999) {
    throw new HttpError(400, "price must be a number from 0 to 99,999,999");
  }
  return Math.round(raw * 100) / 100;
}
function cleanTaxRate(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw new HttpError(400, "taxRate must be a number from 0 to 1 (0.10 = 10%)");
  }
  return raw;
}
// Where a dish is made. Accepts the codes and a few friendly names.
const STATION_ALIASES = { KITCHEN: "KITCHEN", HOT: "KITCHEN", MAIN: "KITCHEN", COLD: "COLD", BAR: "BAR", DRINKS: "BAR" };
function cleanStation(raw) {
  const s = typeof raw === "string" ? STATION_ALIASES[raw.trim().toUpperCase()] : undefined;
  if (!s) throw new HttpError(400, "station must be KITCHEN, COLD or BAR");
  return s;
}
async function assertCategory(locationId, categoryId) {
  if (categoryId === null || categoryId === undefined || categoryId === "") return null;
  if (typeof categoryId !== "string") throw new HttpError(400, "categoryId must be text");
  const { rows } = await query("SELECT id FROM menu_categories WHERE id = $1 AND location_id = $2", [categoryId, locationId]);
  if (rows.length === 0) throw new HttpError(400, "Unknown category for this location");
  return categoryId;
}

// ?all=1 (menu editors only) also returns switched-off dishes, marked active:false,
// so they can be switched back on.
router.get("/categories", async (req, res) => {
  const all = req.query.all === "1" && can(req.user, "MENU");
  const { rows: categories } = await query(
    "SELECT * FROM menu_categories WHERE location_id = $1 ORDER BY sort_order ASC, name ASC",
    [req.user.locationId]
  );
  const { rows: items } = await query(
    `SELECT * FROM menu_items WHERE location_id = $1 AND (active = true OR $2) ORDER BY name ASC`,
    [req.user.locationId, all]
  );

  const trackedIds = items.filter((i) => i.track_stock).map((i) => i.id);
  const onHand = await onHandMap({ query }, trackedIds);

  const result = categories.map((cat) => ({
    id: cat.id,
    name: cat.name,
    sortOrder: cat.sort_order,
    noteHint: cat.note_hint || "",
    menuItems: items
      .filter((i) => i.category_id === cat.id)
      .map((i) => ({
        id: i.id,
        name: i.name,
        price: i.price,
        taxRate: i.tax_rate,
        station: i.station,
        trackStock: i.track_stock,
        spiceOption: i.spice_option,
        active: i.active,
        onHand: i.track_stock ? onHand.get(i.id) : null,
      })),
  }));
  res.json(result);
});

router.get("/items", async (req, res) => {
  const { rows } = await query(
    "SELECT * FROM menu_items WHERE location_id = $1 AND active = true ORDER BY name ASC",
    [req.user.locationId]
  );
  res.json(rows);
});

router.post("/items", async (req, res) => {
  requireEditor(req);
  const b = req.body || {};
  const name = cleanName(b.name, "name");
  const price = cleanPrice(b.price);
  const taxRate = b.taxRate === undefined ? 0 : cleanTaxRate(b.taxRate);
  const station = b.station === undefined ? "KITCHEN" : cleanStation(b.station);
  const categoryId = await assertCategory(req.user.locationId, b.categoryId);
  if (b.trackStock !== undefined && typeof b.trackStock !== "boolean") throw new HttpError(400, "trackStock must be true or false");
  if (b.spiceOption !== undefined && typeof b.spiceOption !== "boolean") throw new HttpError(400, "spiceOption must be true or false");
  const { rows } = await query(
    `INSERT INTO menu_items (id, location_id, name, price, tax_rate, category_id, station, track_stock, spice_option)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [crypto.randomUUID(), req.user.locationId, name, price, taxRate, categoryId, station, b.trackStock === true, b.spiceOption === true]
  );
  res.status(201).json(rows[0]);
});

// Edit or switch off a dish. Past orders keep the price/tax they were sold at (frozen
// on the order line), so editing a price never rewrites history. "Delete" = active:false.
router.patch("/items/:id", async (req, res) => {
  requireEditor(req);
  const b = req.body || {};
  const sets = [];
  const vals = [req.params.id, req.user.locationId];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.name !== undefined) add("name", cleanName(b.name, "name"));
  if (b.price !== undefined) add("price", cleanPrice(b.price));
  if (b.taxRate !== undefined) add("tax_rate", cleanTaxRate(b.taxRate));
  if (b.station !== undefined) add("station", cleanStation(b.station));
  if (b.categoryId !== undefined) add("category_id", await assertCategory(req.user.locationId, b.categoryId));
  if (b.active !== undefined) { if (typeof b.active !== "boolean") throw new HttpError(400, "active must be true or false"); add("active", b.active); }
  if (b.trackStock !== undefined) { if (typeof b.trackStock !== "boolean") throw new HttpError(400, "trackStock must be true or false"); add("track_stock", b.trackStock); }
  if (b.spiceOption !== undefined) { if (typeof b.spiceOption !== "boolean") throw new HttpError(400, "spiceOption must be true or false"); add("spice_option", b.spiceOption); }
  if (sets.length === 0) throw new HttpError(400, "Nothing to change");
  const { rows } = await query(`UPDATE menu_items SET ${sets.join(", ")} WHERE id = $1 AND location_id = $2 RETURNING *`, vals);
  if (rows.length === 0) throw new HttpError(404, "Menu item not found for this location");
  res.json(rows[0]);
});

router.post("/categories", async (req, res) => {
  requireEditor(req);
  const name = cleanName(req.body && req.body.name, "name", 60);
  const sort = Number.isInteger(req.body && req.body.sortOrder) ? req.body.sortOrder : 0;
  const { rows } = await query(
    "INSERT INTO menu_categories (id, location_id, name, sort_order) VALUES ($1, $2, $3, $4) RETURNING *",
    [crypto.randomUUID(), req.user.locationId, name, sort]
  );
  res.status(201).json(rows[0]);
});

// Rename, reorder, set the waiters' note hint, and/or move every dish of the
// category to one station ({ station: "BAR" }).
router.patch("/categories/:id", async (req, res) => {
  requireEditor(req);
  const b = req.body || {};
  const name = b.name === undefined ? null : cleanName(b.name, "name", 60);
  const sort = b.sortOrder === undefined ? null : b.sortOrder;
  if (sort !== null && !Number.isInteger(sort)) throw new HttpError(400, "sortOrder must be a whole number");
  let hint = null;
  if (b.noteHint !== undefined) {
    if (typeof b.noteHint !== "string" || b.noteHint.trim().length > 80) throw new HttpError(400, "noteHint must be text of 80 characters or fewer");
    hint = b.noteHint.trim();
  }
  const station = b.station === undefined ? null : cleanStation(b.station);
  const { rows } = await query(
    `UPDATE menu_categories SET name = COALESCE($3, name), sort_order = COALESCE($4, sort_order),
            note_hint = CASE WHEN $5::text IS NULL THEN note_hint ELSE NULLIF($5, '') END
     WHERE id = $1 AND location_id = $2 RETURNING *`,
    [req.params.id, req.user.locationId, name, sort, hint]
  );
  if (rows.length === 0) throw new HttpError(404, "Category not found for this location");
  if (station) {
    await query("UPDATE menu_items SET station = $3 WHERE category_id = $1 AND location_id = $2", [req.params.id, req.user.locationId, station]);
  }
  res.json(rows[0]);
});

router.delete("/categories/:id", async (req, res) => {
  requireEditor(req);
  const { rows: active } = await query(
    "SELECT 1 FROM menu_items WHERE category_id = $1 AND location_id = $2 AND active = true LIMIT 1",
    [req.params.id, req.user.locationId]
  );
  if (active.length) throw new HttpError(409, "Move or remove the dishes in this category first");
  await query("UPDATE menu_items SET category_id = NULL WHERE category_id = $1 AND location_id = $2", [req.params.id, req.user.locationId]);
  const { rowCount } = await query("DELETE FROM menu_categories WHERE id = $1 AND location_id = $2", [req.params.id, req.user.locationId]);
  if (rowCount === 0) throw new HttpError(404, "Category not found for this location");
  res.json({ deleted: true });
});

module.exports = router;
