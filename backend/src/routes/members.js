// Member list: regulars who get a discount. The cashier finds a member by phone at
// payment time (needs PAY); keeping the list needs the MEMBERS permission.
const crypto = require("crypto");
const Router = require("../lib/asyncRouter");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { HttpError } = require("../lib/http");
const { can } = require("../lib/permissions");
const { phoneKey, percent } = require("../lib/billing");
const { logAuth } = require("../lib/audit");

const router = Router();
router.use(requireAuth);

function needs(user, perms) {
  if (!perms.some((p) => can(user, p))) throw new HttpError(403, `Not allowed (needs permission ${perms.join(" or ")})`);
}
const shape = (m) => ({
  id: m.id, name: m.name, phone: m.phone, discountPercent: percent(m.discount_rate),
  note: m.note || "", active: m.active, createdAt: m.created_at,
});
function cleanName(raw) {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length < 2 || name.length > 60) throw new HttpError(400, "Name must be 2 to 60 characters");
  return name;
}
function cleanPhone(raw) {
  const phone = typeof raw === "string" ? raw.trim() : "";
  const key = phoneKey(phone);
  if (phone.length > 30 || !/^[0-9]{6,15}$/.test(key)) throw new HttpError(400, "Phone number: 6 to 15 digits");
  return { phone, key };
}
// 10 = 10% off. Allowed: more than 0, at most 100, two decimals at most.
function cleanDiscount(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > 100) throw new HttpError(400, "Discount must be a percentage above 0 and at most 100");
  return Math.round(raw * 100) / 10000; // 10 -> 0.1
}
function cleanNote(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.trim().length > 200) throw new HttpError(400, "Note must be 200 characters or fewer");
  return raw.trim() || null;
}

// GET /members/lookup?phone=... — the cashier's search at payment time (active members only).
router.get("/lookup", async (req, res) => {
  needs(req.user, ["PAY", "MEMBERS"]);
  const key = phoneKey(req.query.phone);
  if (!/^[0-9]{6,15}$/.test(key)) throw new HttpError(400, "Type the member's phone number (6 to 15 digits)");
  const { rows } = await query(
    "SELECT * FROM members WHERE location_id = $1 AND phone_key = $2 AND active = true",
    [req.user.locationId, key]
  );
  if (rows.length === 0) throw new HttpError(404, "No active member with that phone number");
  res.json(shape(rows[0]));
});

// GET /members?q=... — the list, searchable by name or phone.
router.get("/", async (req, res) => {
  needs(req.user, ["MEMBERS"]);
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const key = phoneKey(q);
  const { rows } = await query(
    `SELECT * FROM members WHERE location_id = $1
       AND ($2 = '' OR lower(name) LIKE '%' || lower($2) || '%' OR ($3 <> '' AND phone_key LIKE '%' || $3 || '%'))
     ORDER BY active DESC, lower(name) LIMIT 500`,
    [req.user.locationId, q, key]
  );
  res.json(rows.map(shape));
});

router.post("/", async (req, res) => {
  needs(req.user, ["MEMBERS"]);
  const b = req.body || {};
  const name = cleanName(b.name);
  const { phone, key } = cleanPhone(b.phone);
  const rate = cleanDiscount(b.discountPercent);
  const note = cleanNote(b.note);
  try {
    const { rows } = await query(
      `INSERT INTO members (id, location_id, name, phone, phone_key, discount_rate, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [crypto.randomUUID(), req.user.locationId, name, phone, key, rate, note]
    );
    await logAuth({ locationId: req.user.locationId, userId: req.user.sub, type: "MEMBER_CREATED", ip: req.ip, detail: { memberId: rows[0].id, discount: rate } });
    res.status(201).json(shape(rows[0]));
  } catch (e) {
    if (e.code === "23505") throw new HttpError(409, "A member with that phone number already exists");
    throw e;
  }
});

// Change name, phone, discount, note, or switch a member off/on (members are never deleted:
// old receipts keep pointing at them).
router.patch("/:id", async (req, res) => {
  needs(req.user, ["MEMBERS"]);
  const b = req.body || {};
  const sets = [];
  const vals = [req.params.id, req.user.locationId];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.name !== undefined) add("name", cleanName(b.name));
  if (b.phone !== undefined) { const p = cleanPhone(b.phone); add("phone", p.phone); add("phone_key", p.key); }
  if (b.discountPercent !== undefined) add("discount_rate", cleanDiscount(b.discountPercent));
  if (b.note !== undefined) add("note", cleanNote(b.note));
  if (b.active !== undefined) { if (typeof b.active !== "boolean") throw new HttpError(400, "active must be true or false"); add("active", b.active); }
  if (sets.length === 0) throw new HttpError(400, "Nothing to change");
  try {
    const { rows } = await query(`UPDATE members SET ${sets.join(", ")} WHERE id = $1 AND location_id = $2 RETURNING *`, vals);
    if (rows.length === 0) throw new HttpError(404, "Member not found");
    await logAuth({ locationId: req.user.locationId, userId: req.user.sub, type: "MEMBER_UPDATED", ip: req.ip, detail: { memberId: rows[0].id, changes: Object.keys(b) } });
    res.json(shape(rows[0]));
  } catch (e) {
    if (e.code === "23505") throw new HttpError(409, "A member with that phone number already exists");
    throw e;
  }
});

module.exports = router;
