const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Thin query helper. Every call site uses parameterized queries ($1, $2...)
// — never string-concatenate user input into SQL.
function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query };
