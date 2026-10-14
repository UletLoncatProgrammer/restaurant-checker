// Who may do what. A role is just a name plus a list of these permissions.
// The five built-in roles are presets; a company can change their tick-boxes
// (except ADMIN, which always has everything) and create its own roles.
const { query } = require("../db");

const PERMISSIONS = {
  ORDER: "Take orders and serve dishes (Order Entry)",
  PAY: "Take payment (POS)",
  BOARD_KITCHEN: "Hot kitchen screen (in one-kitchen mode: hot and cold dishes)",
  BOARD_COLD: "Cold kitchen screen",
  BOARD_BAR: "Bar screen",
  DASHBOARD: "Dashboard: live tables, payments, activity and stock",
  HISTORY: "Kitchen and bar history",
  VOID: "Void dishes, orders and paid sales",
  EXPORT: "Download the Excel report",
  MENU: "Edit the menu, tables and kitchen setup",
  MEMBERS: "Manage the member list (member discounts)",
  STAFF: "Manage staff, roles and billing settings (Admin only)",
};
const ALL = Object.keys(PERMISSIONS);
// STAFF lets someone create accounts and roles - i.e. make themselves Admin -
// so only the built-in ADMIN role has it; it cannot be ticked for other roles.
const GRANTABLE = ALL.filter((p) => p !== "STAFF");

const BUILTIN = {
  ADMIN: { label: "Admin", permissions: ALL },
  COORDINATOR: { label: "Coordinator", permissions: ["ORDER", "PAY", "BOARD_KITCHEN", "BOARD_COLD", "BOARD_BAR", "DASHBOARD", "HISTORY", "EXPORT", "MENU", "MEMBERS"] },
  SUPERVISOR: { label: "Supervisor", permissions: ["ORDER", "PAY", "BOARD_KITCHEN", "BOARD_COLD", "BOARD_BAR", "DASHBOARD", "HISTORY", "VOID", "MEMBERS"] },
  FOH: { label: "Waiter (front of house)", permissions: ["ORDER", "PAY"] },
  KITCHEN: { label: "Kitchen / bar", permissions: ["BOARD_KITCHEN", "BOARD_COLD", "BOARD_BAR"] },
};
const BUILTIN_KEYS = Object.keys(BUILTIN);

// Roles of one company, cached for a few seconds (every request needs them).
const CACHE_MS = 3000;
const cache = new Map();
function invalidateRoles(locationId) {
  cache.delete(locationId);
}

// Map key -> { key, label, permissions, builtin, custom: bool (has a row) }
async function rolesOf(locationId) {
  const hit = cache.get(locationId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.roles;
  const roles = new Map();
  for (const key of BUILTIN_KEYS) roles.set(key, { key, label: BUILTIN[key].label, permissions: [...BUILTIN[key].permissions], builtin: true });
  const { rows } = await query("SELECT key, label, permissions, builtin FROM roles WHERE location_id = $1 ORDER BY created_at", [locationId]);
  for (const r of rows) {
    if (r.key === "ADMIN") continue; // ADMIN can never lose anything
    const base = roles.get(r.key);
    roles.set(r.key, {
      key: r.key,
      label: base ? base.label : r.label,
      permissions: r.permissions.filter((p) => GRANTABLE.includes(p)),
      builtin: !!base,
    });
  }
  cache.set(locationId, { roles, at: Date.now() });
  if (cache.size > 2000) cache.clear();
  return roles;
}

async function permissionsFor(locationId, roleKey) {
  const r = (await rolesOf(locationId)).get(roleKey);
  return r ? r.permissions : [];
}

const can = (user, perm) => !!(user && user.permissions && user.permissions.includes(perm));

// Express middleware: the user needs at least one of the listed permissions.
function requirePerm(...perms) {
  return (req, res, next) => {
    if (!perms.some((p) => can(req.user, p))) {
      return res.status(403).json({ error: `Not allowed: needs permission ${perms.join(" or ")}` });
    }
    next();
  };
}

// Kitchen-only screens never get the customer's phone number.
const seesPhone = (perms) => ["ORDER", "PAY", "DASHBOARD"].some((p) => perms.includes(p));

module.exports = { PERMISSIONS, ALL, GRANTABLE, BUILTIN, BUILTIN_KEYS, rolesOf, permissionsFor, invalidateRoles, can, requirePerm, seesPhone };
