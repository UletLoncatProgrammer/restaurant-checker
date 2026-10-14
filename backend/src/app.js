const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { config } = require("./config");
const { query } = require("./db");
const { createLimiter } = require("./lib/rateLimit");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const menuRoutes = require("./routes/menu");
const orderRoutes = require("./routes/orders");
const locationRoutes = require("./routes/locations");
const publicRoutes = require("./routes/public");
const paymentRoutes = require("./routes/payments");
const transactionRoutes = require("./routes/transactions");
const stockRoutes = require("./routes/stock");
const reportRoutes = require("./routes/reports");

// "*" only ever reaches here outside production (config.js refuses it there).
const corsOrigin = config.corsOrigins.includes("*") ? "*" : config.corsOrigins;

// Built separately from index.js so tests can mount it on an ephemeral port.
function createApp() {
  const app = express();
  // Behind the reverse proxy the real client address is in X-Forwarded-For; without
  // this every device would share one rate-limit bucket (the proxy's address).
  if (config.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          // alert sounds are generated in the browser and played from blob: URLs
          "media-src": ["'self'", "blob:", "data:"],
          "img-src": ["'self'", "data:"],
        },
      },
    })
  );
  app.use(cors({ origin: corsOrigin, maxAge: 600 }));
  app.use(express.json({ limit: "100kb" }));
  app.use(createLimiter({ windowMs: 60 * 1000, max: 600 })); // generous: a busy restaurant, not a script

  app.get("/health", (req, res) => res.json({ ok: true }));
  // Readiness: also proves the database answers (used by the container healthcheck).
  app.get("/health/ready", async (req, res) => {
    try {
      await query("SELECT 1");
      res.json({ ok: true, db: true });
    } catch {
      res.status(503).json({ ok: false, db: false });
    }
  });

  app.use("/auth", authRoutes);
  app.use("/users", userRoutes);
  app.use("/menu", menuRoutes);
  app.use("/orders", orderRoutes);
  app.use("/payments", paymentRoutes);
  app.use("/transactions", transactionRoutes);
  app.use("/stock", stockRoutes);
  app.use("/reports", reportRoutes);
  app.use("/locations", locationRoutes);
  app.use("/public", publicRoutes);

  // The web app itself (built frontend) when this image ships with it: lets the same
  // address serve the browser version for PCs, while the Android/Windows apps bundle
  // their own copy and talk to the API at this address.
  const publicDir = process.env.STATIC_DIR || path.join(__dirname, "..", "public");
  if (fs.existsSync(path.join(publicDir, "index.html"))) {
    app.use(
      express.static(publicDir, {
        index: false,
        maxAge: "1h",
        setHeaders: (res, file) => {
          if (file.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache");
        },
      })
    );
    // Single-page-app fallback for browser navigations only; API paths still get a JSON 404.
    app.get(/^\/(?!auth\/|users|menu\/|orders|payments|transactions|stock|reports|locations|public\/|health|socket\.io).*/, (req, res) =>
      res.sendFile(path.join(publicDir, "index.html"))
    );
  }

  app.use((req, res) => res.status(404).json({ error: "Not found" }));

  // Central error handler: HttpError -> its status; anything else -> 500
  // without leaking internals to a tablet.
  app.use((err, req, res, next) => {
    if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON body" });
    if (err && err.type === "entity.too.large") return res.status(413).json({ error: "Request too large" });
    if (err && err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

module.exports = { createApp, corsOrigin };
