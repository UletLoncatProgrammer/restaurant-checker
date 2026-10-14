const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Router = require("../lib/asyncRouter");
const { query, withTransaction } = require("../db");
const { config } = require("../config");
const { requireAuth, requireRole, invalidateUser } = require("../middleware/auth");
const { HttpError } = require("../lib/http");
const { passwordProblem, generateTempPassword } = require("../lib/password");
const { logAuth } = require("../lib/audit");
const { disconnectUser } = require("../socket");

const router = Router();
router.use(requireAuth);
router.use(requireRole("ADMIN"));

const ROLE_LIST = ["ADMIN", "COORDINATOR", "SUPERVISOR", "FOH", "KITCHEN"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function shape(u) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, active: u.active,
    mustChangePassword: u.must_change_password, lastLoginAt: u.last_login_at, createdAt: u.created_at,
  };
}

function cleanName(raw) {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length < 2 || name.length > 60) throw new HttpError(400, "Name must be 2 to 60 characters");
  return name;
}

// Another ADMIN must remain: a company can never lock itself out.
async function assertAnotherActiveAdmin(client, locationId, exceptUserId) {
  const { rows } = await client.query(
    "SELECT id FROM users WHERE location_id = $1 AND role = 'ADMIN' AND active = true AND id <> $2 FOR UPDATE",
    [locationId, exceptUserId]
  );
  if (rows.length === 0) throw new HttpError(409, "There must always be at least one active ADMIN");
}

async function disabledRoles(client, locationId) {
  const { rows } = await client.query("SELECT disabled_roles FROM locations WHERE id = $1", [locationId]);
  return rows[0] ? rows[0].disabled_roles : [];
}

// Which of the built-in roles this company uses, and how many active people hold each.
router.get("/roles", async (req, res) => {
  const off = await disabledRoles({ query }, req.user.locationId);
  const { rows } = await query(
    "SELECT role, count(*)::int AS n FROM users WHERE location_id = $1 AND active = true GROUP BY role",
    [req.user.locationId]
  );
  const counts = Object.fromEntries(rows.map((r) => [r.role, r.n]));
  res.json(ROLE_LIST.map((role) => ({ role, enabled: !off.includes(role), activeStaff: counts[role] || 0, removable: role !== "ADMIN" })));
});

// Remove (enabled:false) or bring back (enabled:true) a built-in role for THIS company.
// Removing is refused while active staff still hold the role: move or disable them first,
// so nobody is left with a login whose role no longer exists. ADMIN can never be removed.
router.patch("/roles/:role", async (req, res) => {
  const role = String(req.params.role || "").toUpperCase();
  const enabled = req.body && req.body.enabled;
  if (!ROLE_LIST.includes(role)) return res.status(404).json({ error: "Unknown role" });
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false" });
  if (role === "ADMIN" && !enabled) return res.status(400).json({ error: "The ADMIN role cannot be removed" });
  const locationId = req.user.locationId;
  await withTransaction(async (client) => {
    await client.query("SELECT id FROM locations WHERE id = $1 FOR UPDATE", [locationId]);
    if (!enabled) {
      const { rows } = await client.query(
        "SELECT count(*)::int AS n FROM users WHERE location_id = $1 AND role = $2 AND active = true",
        [locationId, role]
      );
      if (rows[0].n > 0) {
        throw new HttpError(409, `${rows[0].n} active staff member${rows[0].n === 1 ? " has" : "s have"} the ${role} role. Change their role or disable them first.`);
      }
    }
    await client.query(
      enabled
        ? "UPDATE locations SET disabled_roles = array_remove(disabled_roles, $2) WHERE id = $1"
        : "UPDATE locations SET disabled_roles = (SELECT array(SELECT DISTINCT x FROM unnest(disabled_roles || $2::text) x)) WHERE id = $1",
      [locationId, role]
    );
  });
  await logAuth({ locationId, userId: req.user.sub, type: enabled ? "ROLE_RESTORED" : "ROLE_REMOVED", ip: req.ip, detail: { role } });
  res.json({ role, enabled });
});

router.get("/", async (req, res) => {
  const { rows } = await query(
    "SELECT * FROM users WHERE location_id = $1 ORDER BY active DESC, lower(name)",
    [req.user.locationId]
  );
  res.json(rows.map(shape));
});

// Creates a staff login. If no password is given, a temporary one is generated and
// returned ONCE; either way the person must choose their own at first sign-in.
router.post("/", async (req, res) => {
  const { email: rawEmail, role, password } = req.body || {};
  const name = cleanName(req.body && req.body.name);
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 120) return res.status(400).json({ error: "A valid e-mail address is required" });
  if (!ROLE_LIST.includes(role)) return res.status(400).json({ error: `role must be one of ${ROLE_LIST.join(", ")}` });
  if ((await disabledRoles({ query }, req.user.locationId)).includes(role)) {
    return res.status(409).json({ error: `The ${role} role is not used by this company. Restore it in Admin > Roles first.` });
  }
  const temp = password === undefined || password === null || password === "";
  const pw = temp ? generateTempPassword() : password;
  const problem = passwordProblem(pw, { email });
  if (problem) return res.status(400).json({ error: problem });

  const hash = await bcrypt.hash(pw, config.bcryptCost);
  let row;
  try {
    const { rows } = await query(
      `INSERT INTO users (id, location_id, name, email, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING *`,
      [crypto.randomUUID(), req.user.locationId, name, email, hash, role]
    );
    row = rows[0];
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "An account with this e-mail already exists" });
    throw e;
  }
  await logAuth({ locationId: req.user.locationId, userId: req.user.sub, type: "USER_CREATED", email, ip: req.ip, detail: { newUserId: row.id, role } });
  res.status(201).json({ user: shape(row), temporaryPassword: temp ? pw : undefined });
});

router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { role, active } = req.body || {};
  const locationId = req.user.locationId;
  if (role !== undefined && !ROLE_LIST.includes(role)) return res.status(400).json({ error: `role must be one of ${ROLE_LIST.join(", ")}` });
  if (active !== undefined && typeof active !== "boolean") return res.status(400).json({ error: "active must be true or false" });
  const name = req.body && req.body.name !== undefined ? cleanName(req.body.name) : undefined;

  const out = await withTransaction(async (client) => {
    const { rows } = await client.query("SELECT * FROM users WHERE id = $1 AND location_id = $2 FOR UPDATE", [id, locationId]);
    if (rows.length === 0) throw new HttpError(404, "Staff member not found");
    const user = rows[0];
    const newRole = role === undefined ? user.role : role;
    const newActive = active === undefined ? user.active : active;
    const losesAdmin = user.role === "ADMIN" && user.active && (newRole !== "ADMIN" || !newActive);
    if (losesAdmin) await assertAnotherActiveAdmin(client, locationId, user.id);
    if (newActive && (newRole !== user.role || !user.active) && (await disabledRoles(client, locationId)).includes(newRole)) {
      throw new HttpError(409, `The ${newRole} role is not used by this company. Restore it in Admin > Roles first.`);
    }
    const sessionChanges = newRole !== user.role || newActive !== user.active;
    const { rows: upd } = await client.query(
      `UPDATE users SET name = COALESCE($2, name), role = $3, active = $4,
              token_version = token_version + $5 WHERE id = $1 RETURNING *`,
      [id, name || null, newRole, newActive, sessionChanges ? 1 : 0]
    );
    return { user: upd[0], sessionChanges };
  });
  invalidateUser(id);
  if (out.sessionChanges) disconnectUser(id);
  await logAuth({ locationId, userId: req.user.sub, type: "USER_UPDATED", email: out.user.email, ip: req.ip, detail: { targetUserId: id, role, active } });
  res.json(shape(out.user));
});

// Forgotten password: the ADMIN issues a new temporary one (shown once). The
// person's old logins on every device stop working immediately.
router.post("/:id/reset-password", async (req, res) => {
  const { id } = req.params;
  const { rows } = await query("SELECT * FROM users WHERE id = $1 AND location_id = $2", [id, req.user.locationId]);
  if (rows.length === 0) return res.status(404).json({ error: "Staff member not found" });
  const user = rows[0];
  const temp = generateTempPassword();
  const hash = await bcrypt.hash(temp, config.bcryptCost);
  await query(
    `UPDATE users SET password_hash = $2, must_change_password = true, token_version = token_version + 1,
            failed_logins = 0, locked_until = NULL WHERE id = $1`,
    [id, hash]
  );
  invalidateUser(id);
  disconnectUser(id);
  await logAuth({ locationId: req.user.locationId, userId: req.user.sub, type: "PASSWORD_RESET", email: user.email, ip: req.ip, detail: { targetUserId: id } });
  res.json({ temporaryPassword: temp });
});

module.exports = router;
