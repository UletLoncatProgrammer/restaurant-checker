// Upgrade path: a database created from the v1 schema must upgrade in place
// with the current schema.sql, keep its data, and be safe to migrate twice.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const base = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test("v1 database upgrades in place; migration is idempotent", async (t) => {
  if (!base) return t.skip("no database configured");
  const admin = new Client({ connectionString: base });
  await admin.connect();
  const dbName = `rc_migrate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  const c = new Client({ connectionString: url.toString() });
  await c.connect();
  try {
    const v1 = fs.readFileSync(path.join(__dirname, "fixtures", "schema.v1.sql"), "utf8");
    const v2 = fs.readFileSync(path.join(__dirname, "..", "sql", "schema.sql"), "utf8");
    await c.query(v1);
    await c.query("INSERT INTO organizations (id,name) VALUES ('o','O')");
    await c.query("INSERT INTO locations (id,organization_id,name) VALUES ('l','o','L')");
    await c.query("INSERT INTO restaurant_tables (id,location_id,label) VALUES ('t','l','T1')");
    await c.query("INSERT INTO users (id,location_id,name,email,password_hash,role) VALUES ('u','l','U','u@x','h','FOH')");
    await c.query("INSERT INTO menu_items (id,location_id,name,price,tax_rate) VALUES ('m','l','M',1000,0.1)");
    await c.query("INSERT INTO orders (id,location_id,table_id,opened_by_id) VALUES ('ord','l','t','u')");
    await c.query("INSERT INTO order_items (id,order_id,menu_item_id,quantity,unit_price,tax_rate) VALUES ('oi','ord','m',2,1000,0.1)");

    await c.query(v2);
    await c.query(v2); // second run must not fail

    const items = await c.query("SELECT quantity, status, void_reason FROM order_items WHERE id='oi'");
    assert.equal(items.rows[0].quantity, 2);
    assert.equal(items.rows[0].status, "PENDING");
    assert.equal(items.rows[0].void_reason, null);
    const m = await c.query("SELECT track_stock FROM menu_items WHERE id='m'");
    assert.equal(m.rows[0].track_stock, false);
    await c.query("INSERT INTO users (id,location_id,name,email,password_hash,role) VALUES ('s','l','S','s@x','h','SUPERVISOR')");
    const tables = await c.query("SELECT to_regclass('payments') p, to_regclass('order_events') e, to_regclass('stock_movements') s");
    assert.ok(tables.rows[0].p && tables.rows[0].e && tables.rows[0].s);
    // zero-quantity rows are now rejected
    await assert.rejects(c.query("INSERT INTO order_items (id,order_id,menu_item_id,quantity,unit_price) VALUES ('z','ord','m',0,1)"), /order_items_quantity_positive/);
  } finally {
    await c.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  }
});
