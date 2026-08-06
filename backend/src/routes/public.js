const express = require("express");
const { query } = require("../db");

const router = express.Router();

// Unauthenticated on purpose: a new user picking a branch on the signup
// form needs to see branch names before they have a token. Only exposes
// id + organization + branch name — no menu, pricing, tables, or staff
// data, so this is a small, deliberate exposure, not an oversight.
router.get("/locations", async (req, res) => {
  const { rows } = await query(
    `SELECT l.id, l.name, o.name AS organization_name
     FROM locations l JOIN organizations o ON o.id = l.organization_id
     ORDER BY o.name, l.name`
  );
  res.json(rows.map((r) => ({ id: r.id, name: r.name, organizationName: r.organization_name })));
});

module.exports = router;
