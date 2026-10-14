const { query } = require("../db");
const { config } = require("../config");

const router = require("../lib/asyncRouter")();

// Unauthenticated on purpose and deliberately tiny: lets an app confirm it reached
// the right company's server (and show its name) before the user types a password.
// It no longer lists branches or people - the old /public/locations endpoint
// exposed every location name to anyone and existed only for the removed signup form.
router.get("/info", async (req, res) => {
  let name = config.companyName;
  if (!name) {
    const { rows } = await query("SELECT name FROM organizations ORDER BY created_at LIMIT 1");
    name = rows[0] ? rows[0].name : "Restaurant Checker";
  }
  res.json({ name, app: "restaurant-checker", apiVersion: 3 });
});

module.exports = router;
