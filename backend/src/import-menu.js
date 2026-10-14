// Loads a restaurant's menu from a JSON file (see menus/application-example.json
// for the format) into the database. This is deliberately separate from
// seed.js and from staff accounts/login — a new restaurant onboarding
// should be able to define their menu and see it working before anyone
// thinks about user accounts.
//
// Safe to re-run after editing the JSON file: matches on name (organization
// name, location name within that org, category name within that location,
// item name within that category) and updates price/tax/table list in
// place rather than creating duplicates.
//
// Usage: node src/import-menu.js menus/application-example.json
require("dotenv").config();
const fs = require("fs");
const crypto = require("crypto");
const { pool } = require("./db");

async function findOrCreateOrganization(name) {
  const { rows } = await pool.query("SELECT * FROM organizations WHERE name = $1", [name]);
  if (rows[0]) return rows[0];
  const id = crypto.randomUUID();
  const { rows: created } = await pool.query(
    "INSERT INTO organizations (id, name) VALUES ($1, $2) RETURNING *",
    [id, name]
  );
  return created[0];
}

async function findOrCreateLocation(organizationId, loc) {
  const { rows } = await pool.query(
    "SELECT * FROM locations WHERE organization_id = $1 AND name = $2",
    [organizationId, loc.name]
  );
  if (rows[0]) return rows[0];
  const id = crypto.randomUUID();
  const { rows: created } = await pool.query(
    "INSERT INTO locations (id, organization_id, name, timezone) VALUES ($1, $2, $3, $4) RETURNING *",
    [id, organizationId, loc.name, loc.timezone || "Asia/Jakarta"]
  );
  return created[0];
}

async function findOrCreateCategory(locationId, name, sortOrder) {
  const { rows } = await pool.query(
    "SELECT * FROM menu_categories WHERE location_id = $1 AND name = $2",
    [locationId, name]
  );
  if (rows[0]) {
    await pool.query("UPDATE menu_categories SET sort_order = $1 WHERE id = $2", [sortOrder, rows[0].id]);
    return rows[0];
  }
  const id = crypto.randomUUID();
  const { rows: created } = await pool.query(
    "INSERT INTO menu_categories (id, location_id, name, sort_order) VALUES ($1, $2, $3, $4) RETURNING *",
    [id, locationId, name, sortOrder]
  );
  return created[0];
}

// Where a dish is made: "station" on the item, else on its category, else the hot kitchen.
const STATIONS = { KITCHEN: "KITCHEN", HOT: "KITCHEN", COLD: "COLD", BAR: "BAR" };
function stationOf(item, category) {
  const raw = String(item.station || (category && category.station) || "KITCHEN").toUpperCase();
  if (!STATIONS[raw]) throw new Error(`Unknown station "${raw}" for ${item.name} (use KITCHEN, COLD or BAR)`);
  return STATIONS[raw];
}

async function upsertMenuItem(locationId, categoryId, item, category) {
  const track = item.trackStock === true;
  const station = stationOf(item, category);
  const { rows } = await pool.query(
    "SELECT * FROM menu_items WHERE location_id = $1 AND category_id = $2 AND name = $3",
    [locationId, categoryId, item.name]
  );
  let id;
  if (rows[0]) {
    id = rows[0].id;
    await pool.query(
      "UPDATE menu_items SET price = $1, tax_rate = $2, active = true, track_stock = $3, station = $5 WHERE id = $4",
      [item.price, item.taxRate ?? 0, track, id, station]
    );
  } else {
    id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO menu_items (id, location_id, category_id, name, price, tax_rate, track_stock, station)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, locationId, categoryId, item.name, item.price, item.taxRate ?? 0, track, station]
    );
  }
  // Opening stock is written ONCE (only if this item has no movements yet), so
  // re-running the import after sales never resets real stock counts.
  if (track && Number.isInteger(item.openingStock) && item.openingStock > 0) {
    const { rows: existing } = await pool.query("SELECT 1 FROM stock_movements WHERE menu_item_id = $1 LIMIT 1", [id]);
    if (existing.length === 0) {
      await pool.query(
        `INSERT INTO stock_movements (id, location_id, menu_item_id, delta, reason, note)
         VALUES ($1, $2, $3, $4, 'OPENING', 'Opening stock from menu import')`,
        [crypto.randomUUID(), locationId, id, item.openingStock]
      );
    }
  }
}

async function ensureTable(locationId, label) {
  const { rows } = await pool.query(
    "SELECT * FROM restaurant_tables WHERE location_id = $1 AND label = $2",
    [locationId, label]
  );
  if (rows[0]) return;
  await pool.query("INSERT INTO restaurant_tables (id, location_id, label) VALUES ($1, $2, $3)", [
    crypto.randomUUID(),
    locationId,
    label,
  ]);
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node src/import-menu.js <path-to-menu.json>");
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));

  const org = await findOrCreateOrganization(data.organization);
  const location = await findOrCreateLocation(org.id, data.location);

  for (const label of data.tables || []) {
    await ensureTable(location.id, label);
  }

  let itemCount = 0;
  for (const cat of data.categories || []) {
    const category = await findOrCreateCategory(location.id, cat.name, cat.sortOrder ?? 0);
    for (const item of cat.items || []) {
      await upsertMenuItem(location.id, category.id, item, cat); // cat.station = default station for its dishes
      itemCount++;
    }
  }

  console.log(`Imported menu for "${data.location.name}" (org "${data.organization}"): ${itemCount} items, ${(data.tables || []).length} tables.`);
  console.log(`Location ID: ${location.id}`);
  console.log(`\nNote: no staff accounts were created by this script — that's handled separately.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
