const { query } = require("../db");

// Never lets an audit-log failure break a login or an admin action.
async function logAuth({ locationId = null, userId = null, type, email = null, ip = null, detail = {} }) {
  try {
    await query(
      "INSERT INTO auth_events (location_id, user_id, type, email, ip, detail) VALUES ($1, $2, $3, $4, $5, $6)",
      [locationId, userId, type, email, ip, JSON.stringify(detail)]
    );
  } catch (err) {
    console.error("auth audit log failed:", err.message);
  }
}

module.exports = { logAuth };
