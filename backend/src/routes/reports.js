const Router = require("../lib/asyncRouter");
const { requireAuth, requireRole } = require("../middleware/auth");
const { ROLES } = require("../lib/roles");
const { resolvePeriod } = require("../lib/period");
const { getReportData } = require("../lib/reportData");
const { buildWorkbook } = require("../lib/reportWorkbook");

const router = Router();
router.use(requireAuth);
router.use(requireRole(...ROLES.EXPORT));

// GET /reports/export?period=day|week&date=YYYY-MM-DD
// One .xlsx with sales + stock (+ transactions and voids). `date` defaults to
// today in the location's timezone; for period=week it picks the ISO week
// (Mon–Sun) containing that date.
router.get("/export", async (req, res) => {
  const win = await resolvePeriod(req.user.locationId, req.query.period || "day", req.query.date);
  if (win.error) return res.status(400).json({ error: win.error });

  const data = await getReportData(req.user.locationId, win);
  const wb = await buildWorkbook(data);

  const slug = data.locationName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "location";
  const filename = `report-${slug}-${data.period}-${data.startDate}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  await wb.xlsx.write(res);
  res.end();
});

module.exports = router;
