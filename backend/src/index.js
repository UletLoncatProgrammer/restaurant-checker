require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");

const { initSocket } = require("./socket");
const authRoutes = require("./routes/auth");
const menuRoutes = require("./routes/menu");
const orderRoutes = require("./routes/orders");
const locationRoutes = require("./routes/locations");

const app = express();
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5173";

app.use(cors({ origin: corsOrigin }));
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/auth", authRoutes);
app.use("/menu", menuRoutes);
app.use("/orders", orderRoutes);
app.use("/locations", locationRoutes);

// Centralized error handler so an unhandled exception in a route returns
// JSON instead of crashing the process or leaking a stack trace to a tablet.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const server = http.createServer(app);
initSocket(server, corsOrigin);

const port = process.env.PORT || 4000;
server.listen(port, () => {
  console.log(`Restaurant Checker backend listening on port ${port}`);
});
