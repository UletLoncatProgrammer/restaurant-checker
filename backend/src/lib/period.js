const { query } = require("../db");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Resolves a report window in the LOCATION's local calendar (its timezone
// column) — not the server's or the tablet's clock. `period` is "day" or
// "week"; a week is ISO: Monday 00:00 to next Monday 00:00 local time.
// Returns { error } for bad input, otherwise
// { period, timezone, startDate, endDate (exclusive), start, end } where
// start/end are timestamptz instants usable directly in SQL comparisons.
async function resolvePeriod(locationId, period, dateParam) {
  if (!["day", "week"].includes(period)) return { error: "period must be day or week" };
  if (dateParam !== undefined && dateParam !== null && !DATE_RE.test(dateParam)) {
    return { error: "date must be YYYY-MM-DD" };
  }
  try {
    const { rows } = await query(
      `SELECT l.timezone,
              to_char(w.start_date, 'YYYY-MM-DD') AS start_date,
              to_char(w.end_date, 'YYYY-MM-DD') AS end_date,
              (w.start_date::timestamp AT TIME ZONE l.timezone) AS start_ts,
              (w.end_date::timestamp AT TIME ZONE l.timezone) AS end_ts
       FROM locations l,
       LATERAL (SELECT COALESCE($3::date, (now() AT TIME ZONE l.timezone)::date) AS anchor) a,
       LATERAL (SELECT CASE WHEN $2 = 'week' THEN date_trunc('week', a.anchor)::date ELSE a.anchor END AS start_date,
                       CASE WHEN $2 = 'week' THEN date_trunc('week', a.anchor)::date + 7 ELSE a.anchor + 1 END AS end_date) w
       WHERE l.id = $1`,
      [locationId, period, dateParam || null]
    );
    if (rows.length === 0) return { error: "Unknown location" };
    const r = rows[0];
    return {
      period,
      timezone: r.timezone,
      startDate: r.start_date,
      endDate: r.end_date,
      start: r.start_ts,
      end: r.end_ts,
    };
  } catch (e) {
    // e.g. 2026-02-31 passes the regex but is not a real date
    if (e.code && e.code.startsWith("22")) return { error: "Invalid date" };
    throw e;
  }
}

module.exports = { resolvePeriod };
