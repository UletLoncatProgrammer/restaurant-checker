// Creates (or fails clearly on a duplicate) a staff account of ANY role,
// including SUPERVISOR / COORDINATOR / ADMIN, which self-signup cannot grant.
// Works on an existing database — use this instead of re-running the seed.
//
// Usage:
//   npm run create-user -- --email sup@downtown.example --name "Dewi" \
//        --role SUPERVISOR --location "Downtown Branch" [--password ...]
// If --password is omitted a random one is generated and printed once
// (avoids putting a real password in shell history).
require("dotenv").config();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { pool } = require("./db");
const { passwordProblem } = require("./lib/password");

// Built-in roles only; the company's own roles are given in Admin > Staff.
const ROLES = ["ADMIN", "COORDINATOR", "SUPERVISOR", "FOH", "KITCHEN"];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = (arg("email") || "").trim().toLowerCase();
  const name = arg("name");
  const role = (arg("role") || "").toUpperCase();
  const locationName = arg("location");
  if (!email || !name || !ROLES.includes(role) || !locationName) {
    console.error(`Usage: npm run create-user -- --email <e> --name <n> --role <${ROLES.join("|")}> --location "<location name>" [--password <p>]`);
    process.exit(1);
  }
  const { rows: locs } = await pool.query("SELECT id, name FROM locations WHERE name = $1", [locationName]);
  if (locs.length !== 1) {
    const { rows: all } = await pool.query("SELECT name FROM locations ORDER BY name");
    console.error(`${locs.length === 0 ? "No" : "More than one"} location named "${locationName}". Available: ${all.map((l) => l.name).join(", ")}`);
    process.exit(1);
  }
  const generated = !arg("password");
  const password = arg("password") || crypto.randomBytes(9).toString("base64url");
  const problem = passwordProblem(password, { email });
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, Number(process.env.BCRYPT_COST) || 12);
  try {
    await pool.query(
      "INSERT INTO users (id, location_id, name, email, password_hash, role, must_change_password) VALUES ($1, $2, $3, $4, $5, $6, true)",
      [crypto.randomUUID(), locs[0].id, name, email, hash, role]
    );
  } catch (e) {
    if (e.code === "23505") {
      console.error(`A user with email ${email} already exists.`);
      process.exit(1);
    }
    throw e;
  }
  console.log(`Created ${role} "${name}" <${email}> at ${locs[0].name}.`);
  if (generated) console.log(`Generated password (shown once): ${password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
