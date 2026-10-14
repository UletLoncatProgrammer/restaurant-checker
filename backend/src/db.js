const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 20000, // a stuck query must not freeze the kitchen screen
});

// An idle client erroring (database restarted) must not crash the process.
pool.on("error", (err) => console.error("Postgres pool error:", err.message));

// Thin query helper. Every call site uses parameterized queries ($1, $2...)
// — never string-concatenate user input into SQL.
function query(text, params) {
  return pool.query(text, params);
}

// Runs fn(client) inside BEGIN/COMMIT, rolling back on any throw.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
