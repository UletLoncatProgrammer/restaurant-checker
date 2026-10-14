const jwt = require("jsonwebtoken");
const { query } = require("../db");
const { config } = require("../config");
const { permissionsFor, requirePerm } = require("../lib/permissions");

const JWT_SECRET = config.jwtSecret;

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      locationId: user.locationId,
      tv: user.tokenVersion || 0,
    },
    JWT_SECRET,
    { expiresIn: config.tokenTtl }
  );
}

// A token proves who someone WAS when it was issued. Every request re-checks the
// database, so disabling an account, changing its role or resetting its password
// takes effect immediately instead of when the 12 h token runs out. A 3 s cache
// keeps this to roughly one cheap query per user per few seconds under load.
const CACHE_MS = 3000;
const cache = new Map();
function invalidateUser(id) {
  cache.delete(id);
}

async function loadUser(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.row;
  const { rows } = await query(
    "SELECT id, name, role, location_id, active, must_change_password, token_version FROM users WHERE id = $1",
    [id]
  );
  const row = rows[0] || null;
  cache.set(id, { row, at: Date.now() });
  if (cache.size > 5000) cache.clear();
  return row;
}

// Routes that a person who must pick a new password may still call.
const ALLOWED_WHILE_MUST_CHANGE = new Set(["/auth/change-password", "/auth/me"]);

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing bearer token" });
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    const user = await loadUser(payload.sub);
    if (!user || !user.active || (payload.tv || 0) !== user.token_version) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    // Role, its permissions and the location come from the database, never from the token.
    const permissions = await permissionsFor(user.location_id, user.role);
    req.user = { sub: user.id, role: user.role, locationId: user.location_id, name: user.name, permissions };
    if (user.must_change_password && !ALLOWED_WHILE_MUST_CHANGE.has(req.baseUrl + req.path)) {
      return res.status(403).json({ error: "You must choose a new password first", code: "PASSWORD_CHANGE_REQUIRED" });
    }
    next();
  } catch (err) {
    next(err);
  }
}


// Verifies a raw token the same way (used by the socket handshake).
async function authenticateToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
  const user = await loadUser(payload.sub);
  if (!user || !user.active || (payload.tv || 0) !== user.token_version || user.must_change_password) return null;
  return { sub: user.id, role: user.role, locationId: user.location_id, permissions: await permissionsFor(user.location_id, user.role) };
}

// Every operational query in this app is location-scoped (req.user.locationId);
// what a person may do is checked with requirePerm("PAY") etc. (lib/permissions.js).
module.exports = { signToken, requireAuth, requirePerm, invalidateUser, authenticateToken };
