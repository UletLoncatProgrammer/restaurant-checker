const express = require("express");
const crypto = require("crypto");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

router.get("/tables", async (req, res) => {
  const { rows } = await query(
    "SELECT * FROM restaurant_tables WHERE location_id = $1 ORDER BY label ASC",
    [req.user.locationId]
  );
  res.json(rows);
});

router.post("/tables", async (req, res) => {
  if (!["ADMIN", "COORDINATOR"].includes(req.user.role)) {
    return res.status(403).json({ error: "Requires ADMIN or COORDINATOR" });
  }
  const { label } = req.body || {};
  if (!label) return res.status(400).json({ error: "label is required" });
  const id = crypto.randomUUID();
  const { rows } = await query(
    "INSERT INTO restaurant_tables (id, location_id, label) VALUES ($1, $2, $3) RETURNING *",
    [id, req.user.locationId, label]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
