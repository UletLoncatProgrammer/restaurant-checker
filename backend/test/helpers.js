// Shared test setup. Needs a reachable Postgres: set TEST_DATABASE_URL (or
// DATABASE_URL) to a database where it is OK to create throwaway orgs. Tests
// create their own isolated organization/location with random ids and never
// delete or modify other data.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
if (!process.env.DATABASE_URL) throw new Error("Set TEST_DATABASE_URL (or DATABASE_URL) to run backend tests");

const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { pool } = require("../src/db");
const { createApp } = require("../src/app");
const { initSocket } = require("../src/socket");
const { signToken } = require("../src/middleware/auth");

const uid = () => crypto.randomUUID();

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, "..", "sql", "schema.sql"), "utf8");
  await pool.query(sql);
}

async function startServer() {
  const server = http.createServer(createApp());
  initSocket(server, "*");
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

// Creates an isolated tenant: org, location, tables, menu, one user per role.
async function createTenant({ timezone = "Asia/Jakarta", name = "Test" } = {}) {
  const orgId = uid();
  const locationId = uid();
  await pool.query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [orgId, `${name} Org ${orgId.slice(0, 6)}`]);
  await pool.query("INSERT INTO locations (id, organization_id, name, timezone) VALUES ($1, $2, $3, $4)", [
    locationId, orgId, `${name} Loc ${locationId.slice(0, 6)}`, timezone,
  ]);
  const tables = {};
  for (const label of ["T1", "T2", "T3"]) {
    tables[label] = uid();
    await pool.query("INSERT INTO restaurant_tables (id, location_id, label) VALUES ($1, $2, $3)", [tables[label], locationId, label]);
  }
  const catId = uid();
  await pool.query("INSERT INTO menu_categories (id, location_id, name) VALUES ($1, $2, 'All')", [catId, locationId]);
  const menu = {};
  const defs = [
    ["nasi", "Nasi Goreng", 45000, 0.1, false],
    ["tea", "Es Teh", 10000, 0.1, true],
    ["odd", "Odd Price", 33333, 0.1, false], // tax 3333.3 -> rounds to 3333
  ];
  for (const [key, nm, price, tax, track] of defs) {
    menu[key] = uid();
    await pool.query(
      `INSERT INTO menu_items (id, location_id, category_id, name, price, tax_rate, track_stock)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [menu[key], locationId, catId, nm, price, tax, track]
    );
  }
  await pool.query(
    "INSERT INTO stock_movements (id, location_id, menu_item_id, delta, reason) VALUES ($1, $2, $3, 5, 'OPENING')",
    [uid(), locationId, menu.tea]
  );
  const users = {};
  const tokens = {};
  for (const role of ["ADMIN", "COORDINATOR", "SUPERVISOR", "FOH", "KITCHEN"]) {
    const id = uid();
    users[role] = id;
    await pool.query(
      "INSERT INTO users (id, location_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, 'x', $5)",
      [id, locationId, `${role} user`, `${role.toLowerCase()}-${id}@t.example`, role]
    );
    tokens[role] = signToken({ id, role, locationId });
  }
  return { orgId, locationId, tables, menu, users, tokens };
}

function client(base, token) {
  return async function call(method, url, body, { raw = false } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (raw) return res;
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
}

module.exports = { pool, uid, migrate, startServer, createTenant, client };
