// Real-time layer. Each socket must present a valid JWT at connect time and is
// placed ONLY in its own location's rooms — the client cannot ask to join
// another branch (the v1 `join-location` event let anyone subscribe to any
// location by guessing an id; that is removed).
//
// Rooms:  location:<id>            every staff screen at the branch
//         location:<id>:<ROLE>     role-scoped, used for money/audit events
//                                  that kitchen/floor tablets should not see.
const { authenticateToken } = require("./middleware/auth");

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
    const { sub, locationId, role } = socket.data.user;
    socket.join(`location:${locationId}`);
    socket.join(`location:${locationId}:${role}`);
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

// Emit only to sockets whose role is in `roles` (e.g. payment totals go to
// coordinators/supervisors/admins, not to the kitchen display).
function emitToRoles(locationId, roles, event, payload) {
  if (!io) return;
  io.to(roles.map((r) => `location:${locationId}:${r}`)).emit(event, payload);
}

module.exports = { initSocket, disconnectUser, emitToLocation, emitToRoles };
