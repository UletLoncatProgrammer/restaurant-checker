const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Router = require("../lib/asyncRouter");
const { query, withTransaction } = require("../db");
const { config } = require("../config");
const { requireAuth, requirePerm, invalidateUser } = require("../middleware/auth");
const { PERMISSIONS, GRANTABLE, BUILTIN, rolesOf, invalidateRoles } = require("../lib/permissions");
const { HttpError } = require("../lib/http");
const { passwordProblem, generateTempPassword } = require("../lib/password");
const { logAuth } = require("../lib/audit");
const { disconnectUser, disconnectRole } = require("../socket");

const router = Router();
router.use(requireAuth);
router.use(requirePerm("STAFF")); // staff and roles: Admin only
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

// Can a staff member be given this role (now)? It must exist and not be switched off.
async function assertUsableRole(client, locationId, key) {
  if (typeof key !== "string" || !(await rolesOf(locationId)).has(key)) throw new HttpError(400, `Unknown role "${key}"`);
  if ((await disabledRoles(client, locationId)).includes(key)) {
    throw new HttpError(409, `The ${key} role is not used by this company. Restore it in Admin > Roles first.`);
  }
}

function cleanPermissions(raw) {
  if (!Array.isArray(raw) || raw.some((p) => typeof p !== "string")) throw new HttpError(400, "permissions must be a list");
  const bad = raw.filter((p) => !GRANTABLE.includes(p));
  if (bad.length) throw new HttpError(400, `Unknown or not allowed permission: ${bad.join(", ")}`);
  return [...new Set(raw)];
}
function cleanLabel(raw) {
  const label = typeof raw === "string" ? raw.trim() : "";
  if (label.length < 2 || label.length > 40) throw new HttpError(400, "Role name must be 2 to 40 characters");
  return label;
}

// The tick-boxes a role can have, with plain-language descriptions.
router.get("/permissions", async (req, res) => {
  res.json(Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label, grantable: GRANTABLE.includes(key) })));
});

// Every role of this company (built-in and own), what it may do, and how many people hold it.
router.get("/roles", async (req, res) => {
  const locationId = req.user.locationId;
  const [roles, off] = [await rolesOf(locationId), await disabledRoles({ query }, locationId)];
  const { rows } = await query(
    "SELECT role, count(*) FILTER (WHERE active)::int AS active, count(*)::int AS total FROM users WHERE location_id = $1 GROUP BY role",
    [locationId]
  );
  const counts = Object.fromEntries(rows.map((r) => [r.role, r]));
  res.json(
    [...roles.values()].map((r) => ({
      role: r.key,
      key: r.key,
      label: r.label,
      builtin: r.builtin,
      permissions: r.permissions,
      enabled: !off.includes(r.key),
      activeStaff: counts[r.key] ? counts[r.key].active : 0,
      staff: counts[r.key] ? counts[r.key].total : 0,
      removable: r.builtin && r.key !== "ADMIN",
      editable: r.key !== "ADMIN",
      deletable: !r.builtin,
    }))
  );
});

// Create the company's own role, e.g. { label: "Food runner", permissions: ["ORDER"] }.
router.post("/roles", async (req, res) => {
  const locationId = req.user.locationId;
  const label = cleanLabel(req.body && req.body.label);
  const permissions = cleanPermissions(req.body && req.body.permissions);
  const roles = await rolesOf(locationId);
  if ([...roles.values()].some((r) => r.label.toLowerCase() === label.toLowerCase())) throw new HttpError(409, "A role with that name already exists");
  const base = label.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^([^A-Z])/, "R_$1").slice(0, 26) || "ROLE";
  let key = base;
  for (let n = 2; roles.has(key) || BUILTIN[key]; n++) key = `${base}_${n}`;
  await query("INSERT INTO roles (location_id, key, label, permissions, builtin) VALUES ($1, $2, $3, $4, false)", [locationId, key, label, permissions]);
  invalidateRoles(locationId);
  await logAuth({ locationId, userId: req.user.sub, type: "ROLE_CREATED", ip: req.ip, detail: { role: key, permissions } });
  res.status(201).json({ key, label, permissions, builtin: false });
});

// Change a role:
//   { enabled: false | true }        switch a built-in role off for this company / back on
//   { label?, permissions? }         rename (own roles) / change what it may do (any role but ADMIN)
// Switching off is refused while active staff hold the role; ADMIN can never change.
router.patch("/roles/:role", async (req, res) => {
  const key = String(req.params.role || "").toUpperCase();
  const locationId = req.user.locationId;
  const b = req.body || {};
  const roles = await rolesOf(locationId);
  const role = roles.get(key);
  if (!role) return res.status(404).json({ error: "Unknown role" });

  if (b.enabled !== undefined) {
    const enabled = b.enabled;
    if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false" });
    if (key === "ADMIN" && !enabled) return res.status(400).json({ error: "The ADMIN role cannot be removed" });
    if (!role.builtin) return res.status(400).json({ error: "Your own roles are deleted, not switched off" });
    await withTransaction(async (client) => {
      await client.query("SELECT id FROM locations WHERE id = $1 FOR UPDATE", [locationId]);
      if (!enabled) {
        const { rows } = await client.query(
          "SELECT count(*)::int AS n FROM users WHERE location_id = $1 AND role = $2 AND active = true",
          [locationId, key]
        );
        if (rows[0].n > 0) {
          throw new HttpError(409, `${rows[0].n} active staff member${rows[0].n === 1 ? " has" : "s have"} the ${key} role. Change their role or disable them first.`);
        }
      }
      await client.query(
        enabled
          ? "UPDATE locations SET disabled_roles = array_remove(disabled_roles, $2) WHERE id = $1"
          : "UPDATE locations SET disabled_roles = (SELECT array(SELECT DISTINCT x FROM unnest(disabled_roles || $2::text) x)) WHERE id = $1",
        [locationId, key]
      );
    });
    await logAuth({ locationId, userId: req.user.sub, type: enabled ? "ROLE_RESTORED" : "ROLE_REMOVED", ip: req.ip, detail: { role: key } });
  }

  if (b.label !== undefined || b.permissions !== undefined) {
    if (key === "ADMIN") return res.status(400).json({ error: "Admin always has every permission" });
    const label = b.label === undefined || role.builtin ? role.label : cleanLabel(b.label);
    const permissions = b.permissions === undefined ? role.permissions : cleanPermissions(b.permissions);
    await query(
      `INSERT INTO roles (location_id, key, label, permissions, builtin) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (location_id, key) DO UPDATE SET label = EXCLUDED.label, permissions = EXCLUDED.permissions`,
      [locationId, key, label, permissions, role.builtin]
    );
    invalidateRoles(locationId);
    disconnectRole(locationId, key); // their screens reconnect with the new permissions
    await logAuth({ locationId, userId: req.user.sub, type: "ROLE_UPDATED", ip: req.ip, detail: { role: key, permissions } });
  }
  const now = (await rolesOf(locationId)).get(key);
  const off = await disabledRoles({ query }, locationId);
  res.json({ role: key, key, label: now.label, permissions: now.permissions, builtin: now.builtin, enabled: !off.includes(key) });
});

// Delete one of the company's own roles (only when nobody has it any more).
router.delete("/roles/:role", async (req, res) => {
  const key = String(req.params.role || "").toUpperCase();
  const locationId = req.user.locationId;
  const role = (await rolesOf(locationId)).get(key);
  if (!role) return res.status(404).json({ error: "Unknown role" });
  if (role.builtin) return res.status(400).json({ error: "Built-in roles are switched off, not deleted" });
  const { rows } = await query("SELECT count(*)::int AS n FROM users WHERE location_id = $1 AND role = $2", [locationId, key]);
  if (rows[0].n > 0) throw new HttpError(409, `${rows[0].n} staff member${rows[0].n === 1 ? " still has" : "s still have"} this role. Give them another role first.`);
  await query("DELETE FROM roles WHERE location_id = $1 AND key = $2", [locationId, key]);
  invalidateRoles(locationId);
  await logAuth({ locationId, userId: req.user.sub, type: "ROLE_DELETED", ip: req.ip, detail: { role: key } });
  res.json({ deleted: true });
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
  await assertUsableRole({ query }, req.user.locationId, role);
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
  if (role !== undefined && (typeof role !== "string" || !(await rolesOf(locationId)).has(role))) return res.status(400).json({ error: `Unknown role "${role}"` });
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
    if (newActive && (newRole !== user.role || !user.active)) await assertUsableRole(client, locationId, newRole);
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
