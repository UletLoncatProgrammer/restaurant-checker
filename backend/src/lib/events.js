const crypto = require("crypto");
const { emitToRoles } = require("../socket");
const { ROLES } = require("./roles");

// Appends to the activity log inside the caller's transaction and returns the
// event shape the dashboard displays. Call emitActivity() AFTER commit.
async function logEvent(client, { locationId, orderId = null, type, actorId, message, detail = {} }) {
  const id = crypto.randomUUID();
  const { rows } = await client.query(
    `INSERT INTO order_events (id, location_id, order_id, type, actor_id, message, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING created_at, (SELECT name FROM users WHERE id = $5) AS actor_name`,
    [id, locationId, orderId, type, actorId, message, JSON.stringify(detail)]
  );
  return {
    id,
    type,
    orderId,
    message,
    detail,
    actorName: rows[0].actor_name,
    createdAt: rows[0].created_at,
  };
}

function emitActivity(locationId, events) {
  for (const e of events) emitToRoles(locationId, ROLES.OVERSEE, "activity:new", e);
}

module.exports = { logEvent, emitActivity };
