// Sets up a brand-new company on an EMPTY database: the organization, its first
// branch, tables, and the first ADMIN login. Run once per company stack by
// deploy/new-company.sh (or by hand). Refuses to run if a company already exists,
// so it can never mix two companies in one database.
//
// Usage: npm run provision -- --company "Acme Foods" --location "Main Branch" \
//          --admin-email owner@acme.com --admin-name "Budi" [--tables 20] [--timezone Asia/Jakarta]
require("dotenv").config();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { pool, withTransaction } = require("./db");
const { generateTempPassword } = require("./lib/password");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const company = arg("company");
  const location = arg("location", "Main Branch");
  const email = (arg("admin-email") || "").trim().toLowerCase();
  const adminName = arg("admin-name", "Owner");
  const tables = Number(arg("tables", "10"));
  const timezone = arg("timezone", "Asia/Jakarta");
  if (!company || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !(tables >= 0 && tables <= 200)) {
    console.error('Usage: npm run provision -- --company "<name>" --location "<branch>" --admin-email <email> [--admin-name <n>] [--tables 0-200] [--timezone <IANA>]');
    process.exit(1);
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    console.error(`Unknown timezone "${timezone}" (use an IANA name such as Asia/Jakarta)`);
    process.exit(1);
  }

  const temp = generateTempPassword();
  const hash = await bcrypt.hash(temp, Number(process.env.BCRYPT_COST) || 12);
  await withTransaction(async (client) => {
    const { rows } = await client.query("SELECT count(*)::int AS n FROM organizations");
    if (rows[0].n > 0) throw new Error("This database already has a company. One stack = one company; create a new stack instead.");
    const orgId = crypto.randomUUID();
    const locId = crypto.randomUUID();
    await client.query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [orgId, company]);
    await client.query("INSERT INTO locations (id, organization_id, name, timezone) VALUES ($1, $2, $3, $4)", [locId, orgId, location, timezone]);
    for (let i = 1; i <= tables; i++) {
      await client.query("INSERT INTO restaurant_tables (id, location_id, label) VALUES ($1, $2, $3)", [crypto.randomUUID(), locId, `Table ${i}`]);
    }
    await client.query(
      `INSERT INTO users (id, location_id, name, email, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5, 'ADMIN', true)`,
      [crypto.randomUUID(), locId, adminName, email, hash]
    );
  });
  console.log(`Created company "${company}" with branch "${location}", ${tables} tables.`);
  console.log(`ADMIN login: ${email}`);
  console.log(`TEMPORARY_PASSWORD=${temp}`);
  console.log("(shown once; the admin must choose their own password at first sign-in)");
}

main()
  .catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  })
  .finally(() => pool.end());
