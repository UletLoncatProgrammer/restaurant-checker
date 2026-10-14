// All environment-driven settings in one place, with fail-fast checks for the
// things that must never run with a default in production.
require("dotenv").config();

const PLACEHOLDER = /change-this|changeme|secret$|password/i;

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const cfg = {
    production,
    port: Number(env.PORT) || 4000,
    jwtSecret: env.JWT_SECRET,
    tokenTtl: env.TOKEN_TTL || "12h",
    bcryptCost: Number(env.BCRYPT_COST) || 12,
    // Comma separated list of allowed browser/app origins, or "*" for development only.
    corsOrigins: (env.CORS_ORIGIN || "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean),
    trustProxy: env.TRUST_PROXY === undefined ? production : env.TRUST_PROXY === "true",
    companyName: env.COMPANY_NAME || null,
    loginMaxFailures: Number(env.LOGIN_MAX_FAILURES) || 5,
    loginLockMinutes: Number(env.LOGIN_LOCK_MINUTES) || 5,
  };

  if (!cfg.jwtSecret) throw new Error("JWT_SECRET is not set. Copy .env.example to .env and set a real secret.");
  if (production) {
    if (cfg.jwtSecret.length < 32 || PLACEHOLDER.test(cfg.jwtSecret)) {
      throw new Error("JWT_SECRET must be a random string of at least 32 characters in production.");
    }
    if (cfg.corsOrigins.includes("*")) {
      throw new Error('CORS_ORIGIN="*" is not allowed in production. List the exact origins, e.g. https://acme.example.com,https://localhost,capacitor://localhost');
    }
    if (!env.DATABASE_URL || /restaurant:restaurant@/.test(env.DATABASE_URL)) {
      throw new Error("DATABASE_URL must not use the default restaurant/restaurant password in production.");
    }
  }
  return cfg;
}

module.exports = { loadConfig, config: loadConfig() };
