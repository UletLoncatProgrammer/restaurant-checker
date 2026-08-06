// Real-time layer. Rooms are per-location ("location:<id>") so a screen only
// receives events for its own restaurant branch, even though the server
// process can serve multiple locations.

let io = null;

function initSocket(server, corsOrigin) {
  const { Server } = require("socket.io");
  io = new Server(server, {
    cors: { origin: corsOrigin, methods: ["GET", "POST"] },
  });

  io.on("connection", (socket) => {
    socket.on("join-location", (locationId) => {
      if (typeof locationId === "string" && locationId.length > 0) {
        socket.join(`location:${locationId}`);
      }
    });
  });

  return io;
}

function emitToLocation(locationId, event, payload) {
  if (!io) return;
  io.to(`location:${locationId}`).emit(event, payload);
}

module.exports = { initSocket, emitToLocation };
