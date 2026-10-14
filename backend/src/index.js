const http = require("http");
const { config } = require("./config");
const { createApp, corsOrigin } = require("./app");
const { initSocket } = require("./socket");
const { pool } = require("./db");

const server = http.createServer(createApp());
server.keepAliveTimeout = 65000; // longer than typical proxy idle timeouts
server.requestTimeout = 30000;
initSocket(server, corsOrigin);

server.listen(config.port, () => {
  console.log(`Restaurant Checker backend listening on port ${config.port}${config.production ? " (production)" : ""}`);
});

// Docker/systemd send SIGTERM on stop/update: finish in-flight requests, then close.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
