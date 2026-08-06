const express = require("express");
const crypto = require("crypto");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// All queries below use req.user.locationId, never a client-supplied
// locationId — that's the multi-tenant isolation boundary.

router.get("/categories", async (req, res) => {
  const { rows: categories } = await query(
    "SELECT * FROM menu_categories WHERE location_id = $1 ORDER BY sort_order ASC",
    [req.user.locationId]
  );
  const { rows: items } = await query(
    "SELECT * FROM menu_items WHERE location_id = $1 AND active = true ORDER BY name ASC",
    [req.user.locationId]
  );

  const result = categories.map((cat) => ({
    id: cat.id,
    name: cat.name,
    sortOrder: cat.sort_order,
    menuItems: items
      .filter((i) => i.category_id === cat.id)
      .map((i) => ({ id: i.id, name: i.name, price: i.price, taxRate: i.tax_rate, station: i.station })),
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
  if (!["ADMIN", "COORDINATOR"].includes(req.user.role)) {
    return res.status(403).json({ error: "Requires ADMIN or COORDINATOR" });
  }
  const { name, price, taxRate, categoryId, station } = req.body || {};
  if (!name || price === undefined) {
    return res.status(400).json({ error: "name and price are required" });
  }
  const id = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO menu_items (id, location_id, name, price, tax_rate, category_id, station)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [id, req.user.locationId, name, price, taxRate ?? 0, categoryId || null, station || "main"]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
