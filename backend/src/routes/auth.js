const express = require("express");
const bcrypt = require("bcryptjs");
const { query } = require("../db");
const { signToken } = require("../middleware/auth");

const router = express.Router();

// Deliberately simple email+password login for v1. No password reset flow,
// no SSO — add those before handing real staff credentials at scale.
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  const { rows } = await query("SELECT * FROM users WHERE email = $1", [email]);
  const user = rows[0];
  if (!user || !user.active) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = signToken({ id: user.id, role: user.role, locationId: user.location_id });
  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      locationId: user.location_id,
    },
  });
});

module.exports = router;
