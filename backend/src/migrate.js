// Applies sql/schema.sql to DATABASE_URL. Safe to re-run — every statement
// is IF NOT EXISTS / guarded against "already exists" errors.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { pool } = require("./db");

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, "..", "sql", "schema.sql"), "utf8");
  await pool.query(sql);
  console.log("Migration applied successfully.");
}

main()
  .catch((e) => {
    console.error("Migration failed:", e);
    process.exit(1);
  })
  .finally(() => pool.end());
