// Real-time layer. Each socket must present a valid JWT at connect time and is
// placed ONLY in its own location's rooms — the client cannot ask to join
// another branch (the v1 `join-location` event let anyone subscribe to any
// location by guessing an id; that is removed).
//
// Rooms:  location:<id>                 every staff screen at the branch
//         location:<id>:perm:<PERM>     screens whose role has that permission, used for
//                                       money/audit events kitchen tablets should not see
//         location:<id>:phone|nophone   who may see customers' phone numbers
//         location:<id>:role:<KEY>      to sign out everyone of a role whose permissions changed
//         user:<id>                     one person's screens
const { authenticateToken } = require("./middleware/auth");
const { seesPhone } = require("./lib/permissions");

let io = null;

// corsOrigin: "*" (tests/dev) or an array / comma list of exact origins.
function initSocket(server, corsOrigin) {
  const { Server } = require("socket.io");
  io = new Server(server, {
    cors: { origin: corsOrigin, methods: ["GET", "POST"] },
    maxHttpBufferSize: 1e5,
  });

  // The handshake token is checked against the database (active account, current
  // password version), exactly like an HTTP request.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error("Missing token"));
      const user = await authenticateToken(token);
      if (!user) return next(new Error("Invalid or expired token"));
      socket.data.user = user;
      next();
    } catch {
      next(new Error("Invalid or expired token"));
    }
  });

  io.on("connection", (socket) => {
    const { sub, locationId, role, permissions } = socket.data.user;
    socket.join(`location:${locationId}`);
    socket.join(`location:${locationId}:role:${role}`);
    for (const p of permissions) socket.join(`location:${locationId}:perm:${p}`);
    socket.join(`location:${locationId}:${seesPhone(permissions) ? "phone" : "nophone"}`);
    socket.join(`user:${sub}`);
  });

  return io;
}

// Kicks every live screen of one person (account disabled, role changed, password reset).
function disconnectUser(userId) {
  if (!io) return;
  io.in(`user:${userId}`).disconnectSockets(true);
}

function emitToLocation(locationId, event, payload) {
  if (!io) return;
  io.to(`location:${locationId}`).emit(event, payload);
}

// Emit only to screens whose role has one of `perms` (e.g. payment totals go to
// the dashboard, not to the kitchen display). A screen in several rooms gets it once.
function emitToPerms(locationId, perms, event, payload) {
  if (!io) return;
  io.to(perms.map((p) => `location:${locationId}:perm:${p}`)).emit(event, payload);
}

// An order event: full to screens that may see phone numbers, without the phone to the rest.
function emitOrderEvent(locationId, event, full, stripped) {
  if (!io) return;
  io.to(`location:${locationId}:phone`).emit(event, full);
  io.to(`location:${locationId}:nophone`).emit(event, stripped);
}

// A role's permissions changed: its people reconnect and get the new rooms.
function disconnectRole(locationId, roleKey) {
  if (!io) return;
  io.in(`location:${locationId}:role:${roleKey}`).disconnectSockets(true);
}

module.exports = { initSocket, disconnectUser, disconnectRole, emitToLocation, emitToPerms, emitOrderEvent };
