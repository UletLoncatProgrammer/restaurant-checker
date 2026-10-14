const bcrypt = require("bcryptjs");
const { query } = require("../db");
const { config } = require("../config");
const { signToken, requireAuth, invalidateUser } = require("../middleware/auth");
const { passwordProblem } = require("../lib/password");
const { logAuth } = require("../lib/audit");
const { createLimiter } = require("../lib/rateLimit");
const { disconnectUser } = require("../socket");

const router = require("../lib/asyncRouter")();

// There is deliberately NO self-service signup: staff accounts are created by the
// company's ADMIN (POST /users). An open signup would let anyone who finds the
// server create a login that can read that company's orders and menu.

const loginLimiter = createLimiter({ windowMs: 10 * 60 * 1000, max: 40, message: "Too many sign-in attempts from this device. Try again in a few minutes." });
router.loginLimiter = loginLimiter;

// Compared against when the e-mail is unknown, so "no such user" and "wrong
// password" take the same time.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

const normalizeEmail = (e) => (typeof e === "string" ? e.trim().toLowerCase() : "");

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, locationId: u.location_id };
}

router.post("/login", loginLimiter, async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  const password = req.body && req.body.password;
  if (!email || typeof password !== "string" || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  if (password.length > 200 || email.length > 200) return res.status(400).json({ error: "Invalid credentials" });

  const { rows } = await query("SELECT * FROM users WHERE lower(email) = $1", [email]);
  const user = rows[0];

  if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.max(1, Math.ceil((new Date(user.locked_until) - Date.now()) / 60000));
    await logAuth({ locationId: user.location_id, userId: user.id, type: "LOGIN_BLOCKED", email, ip: req.ip });
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.` });
  }

  const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !user.active || !valid) {
    if (user) {
      const fails = user.failed_logins + 1;
      const lock = fails >= config.loginMaxFailures;
      await query(
        `UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END WHERE id = $1`,
        [user.id, lock ? 0 : fails, lock, String(config.loginLockMinutes)]
      );
      await logAuth({ locationId: user.location_id, userId: user.id, type: lock ? "LOCKED" : "LOGIN_FAIL", email, ip: req.ip });
    } else {
      await logAuth({ type: "LOGIN_FAIL", email, ip: req.ip, detail: { unknownEmail: true } });
    }
    return res.status(401).json({ error: "Invalid credentials" });
  }

  await query("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1", [user.id]);
  await logAuth({ locationId: user.location_id, userId: user.id, type: "LOGIN_OK", email, ip: req.ip });
  const token = signToken({ id: user.id, role: user.role, locationId: user.location_id, tokenVersion: user.token_version });
  res.json({ token, user: publicUser(user), mustChangePassword: user.must_change_password });
});

// Who am I? Lets an app confirm a saved token is still valid (account active,
// password not reset) when it starts up.
router.get("/me", requireAuth, async (req, res) => {
  const { rows } = await query("SELECT * FROM users WHERE id = $1", [req.user.sub]);
  res.json({ user: publicUser(rows[0]), mustChangePassword: rows[0].must_change_password });
});

// Choose a new password (also the only thing a person with a temporary password
// may do). Signs out every other device by bumping the token version.
router.post("/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    return res.status(400).json({ error: "currentPassword and newPassword are required" });
  }
  const { rows } = await query("SELECT * FROM users WHERE id = $1", [req.user.sub]);
  const user = rows[0];
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
    await logAuth({ locationId: user.location_id, userId: user.id, type: "LOGIN_FAIL", email: user.email, ip: req.ip, detail: { on: "change-password" } });
    return res.status(401).json({ error: "Current password is wrong" });
  }
  const problem = passwordProblem(newPassword, { email: user.email });
  if (problem) return res.status(400).json({ error: problem });
  if (newPassword === currentPassword) return res.status(400).json({ error: "Choose a password different from the current one" });

  const hash = await bcrypt.hash(newPassword, config.bcryptCost);
  const upd = await query(
    `UPDATE users SET password_hash = $2, must_change_password = false, token_version = token_version + 1,
            failed_logins = 0, locked_until = NULL WHERE id = $1 RETURNING token_version`,
    [user.id, hash]
  );
  invalidateUser(user.id);
  disconnectUser(user.id);
  await logAuth({ locationId: user.location_id, userId: user.id, type: "PASSWORD_CHANGED", email: user.email, ip: req.ip });
  const token = signToken({ id: user.id, role: user.role, locationId: user.location_id, tokenVersion: upd.rows[0].token_version });
  res.json({ token, user: publicUser(user), mustChangePassword: false });
});

module.exports = router;
