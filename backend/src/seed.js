// Seeds one organization with two locations, sample staff logins, a menu,
// and tables — enough to click through the app end to end. Not real data;
// replace before going live.
require("dotenv").config();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { pool } = require("./db");

async function main() {
  const orgId = crypto.randomUUID();
  await pool.query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [orgId, "Sample Restaurant Group"]);

  const locationsData = [{ name: "Downtown Branch" }, { name: "Uptown Branch" }];
  const passwordHash = await bcrypt.hash("password123", 10);

  for (const loc of locationsData) {
    const locationId = crypto.randomUUID();
    await pool.query("INSERT INTO locations (id, organization_id, name) VALUES ($1, $2, $3)", [
      locationId,
      orgId,
      loc.name,
    ]);

    const categoryId = crypto.randomUUID();
    await pool.query("INSERT INTO menu_categories (id, location_id, name, sort_order) VALUES ($1, $2, $3, $4)", [
      categoryId,
      locationId,
      "Mains",
      1,
    ]);

    const menuItems = [
      { name: "Nasi Goreng", price: 45000, taxRate: 0.1 },
      { name: "Mie Ayam", price: 35000, taxRate: 0.1 },
      { name: "Sate Ayam", price: 40000, taxRate: 0.1 },
      { name: "Es Teh Manis", price: 10000, taxRate: 0.1 },
    ];
    for (const m of menuItems) {
      await pool.query(
        `INSERT INTO menu_items (id, location_id, category_id, name, price, tax_rate)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [crypto.randomUUID(), locationId, categoryId, m.name, m.price, m.taxRate]
      );
    }

    for (const label of ["Table 1", "Table 2", "Table 3", "Table 4"]) {
      await pool.query("INSERT INTO restaurant_tables (id, location_id, label) VALUES ($1, $2, $3)", [
        crypto.randomUUID(),
        locationId,
        label,
      ]);
    }

    const namePrefix = loc.name.split(" ")[0].toLowerCase();
    const staff = [
      { role: "FOH", label: "FOH Staff" },
      { role: "KITCHEN", label: "Kitchen Staff" },
      { role: "COORDINATOR", label: "Coordinator" },
    ];
    for (const s of staff) {
      await pool.query(
        `INSERT INTO users (id, location_id, name, email, password_hash, role)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          crypto.randomUUID(),
          locationId,
          `${loc.name} ${s.label}`,
          `${s.role.toLowerCase()}@${namePrefix}.example`,
          passwordHash,
          s.role,
        ]
      );
    }

    console.log(`Seeded ${loc.name} with ${menuItems.length} menu items.`);
  }

  console.log("\nSample logins (password: password123):");
  console.log("  foh@downtown.example / kitchen@downtown.example / coordinator@downtown.example");
  console.log("  foh@uptown.example / kitchen@uptown.example / coordinator@uptown.example");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
