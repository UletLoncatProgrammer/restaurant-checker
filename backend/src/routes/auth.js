const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { query } = require("../db");
const { signToken } = require("../middleware/auth");

const router = express.Router();

// Roles a person can grant themselves via self-service signup. COORDINATOR
// and ADMIN are deliberately excluded — those see every table, every
// menu/table edit, and every location's data, so letting anyone self-signup
// into that role would be a real hole in a multi-tenant system. Those
// accounts get provisioned separately (seed script or a future admin panel).
const SELF_SIGNUP_ROLES = ["FOH", "KITCHEN"];

// Self-service account creation. Requires picking an existing location
// (see GET /public/locations) — this does not create organizations or
// locations, only a staff account within one that already exists.
router.post("/signup", async (req, res) => {
  const { name, email, password, locationId, role } = req.body || {};

  if (!name || !email || !password || !locationId || !role) {
    return res.status(400).json({ error: "name, email, password, locationId, and role are all required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  if (!SELF_SIGNUP_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of ${SELF_SIGNUP_ROLES.join(", ")}` });
  }

  const { rows: locRows } = await query("SELECT id FROM locations WHERE id = $1", [locationId]);
  if (locRows.length === 0) {
    return res.status(400).json({ error: "Unknown location" });
  }

  const { rows: existing } = await query("SELECT id FROM users WHERE email = $1", [email]);
  if (existing.length > 0) {
    return res.status(409).json({ error: "An account with this email already exists" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const id = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO users (id, location_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [id, locationId, name, email, passwordHash, role]
  );
  const user = rows[0];

  const token = signToken({ id: user.id, role: user.role, locationId: user.location_id });
  res.status(201).json({
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
