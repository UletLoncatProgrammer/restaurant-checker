const ExcelJS = require("exceljs");

const MONEY = "#,##0";
const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };

function addTable(ws, columns, rows, { totals } = {}) {
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 16, style: c.money ? { numFmt: MONEY } : {} }));
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = HEADER_FILL;
  ws.views = [{ state: "frozen", ySplit: 1 }];
  for (const r of rows) ws.addRow(r);
  if (totals) {
    const row = ws.addRow(totals);
    row.font = { bold: true };
    row.border = { top: { style: "thin" } };
  }
}

const sum = (rows, key) => rows.reduce((s, r) => s + r[key], 0);

// Builds the one-file report: Summary, Sales by day, Sales by item,
// Transactions, Stock, Voids. All numbers come from getReportData().
async function buildWorkbook(data, generatedAt = new Date()) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Restaurant Checker";
  wb.created = generatedAt;

  const lastDay = (() => {
    const d = new Date(`${data.endDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const label = data.period === "day" ? data.startDate : `${data.startDate} to ${lastDay}`;

  // ---- Summary
  const ws = wb.addWorksheet("Summary");
  ws.columns = [{ width: 34 }, { width: 22 }, { width: 14 }];
  const put = (a, b, c, opts = {}) => {
    const row = ws.addRow([a, b, c]);
    if (opts.bold) row.font = { bold: true };
    if (typeof b === "number") row.getCell(2).numFmt = MONEY;
    if (typeof c === "number") row.getCell(3).numFmt = MONEY;
    return row;
  };
  put(`${data.locationName} — ${data.period === "day" ? "Daily" : "Weekly"} report`, "", "", { bold: true }).font = { bold: true, size: 14 };
  put("Period (location local time)", label, "");
  put("Timezone", data.timezone, "");
  put("Generated at", generatedAt.toISOString(), "");
  put("", "", "");
  put("SALES", "", "", { bold: true });
  put("Paid sales (count)", data.summary.salesCount, "");
  put("Food & drinks (before discount)", data.summary.net, "");
  put("Member discounts", -data.summary.discount, "");
  put("Service charge", data.summary.service, "");
  put("Tax (PBJT)", data.summary.tax, "");
  put("Gross sales (what customers paid)", data.summary.gross, "", { bold: true });
  put("", "", "");
  put("By payment method", "Count", "Gross", { bold: true });
  for (const m of data.byMethod) put(m.method, m.count, m.gross);
  put("", "", "");
  put("VOIDS", "", "", { bold: true });
  put("Paid sales voided (count)", data.summary.voidedSalesCount, "");
  put("Paid sales voided (value)", data.summary.voidedSalesTotal, "");
  put("Void events logged (see Voids sheet)", data.voids.length, "");
  put("", "", "");
  put("NOTES", "", "", { bold: true });
  for (const note of [
    "Sales = payments marked PAID with paid_at in the period; sales voided later are excluded here and shown on Transactions/Voids.",
    "This report reflects the data at the time it was generated; re-running an old period after a later void will show different numbers.",
    "Bill = food & drinks - member discount + service charge + tax; each rounded to whole currency units. Rates are those in force when each bill was paid.",
    "Sales by item are before member discount, service charge and tax.",
    "Stock covers only menu items with stock tracking on. 'Sold' = units deducted when the order was sent.",
  ]) put(note, "", "");

  // ---- Sales by day
  addTable(
    wb.addWorksheet("Sales by day"),
    [
      { header: "Date", key: "day", width: 14 },
      { header: "Sales (count)", key: "salesCount", width: 14 },
      { header: "Net", key: "net", money: true },
      { header: "Discount", key: "discount", money: true },
      { header: "Service", key: "service", money: true },
      { header: "Tax", key: "tax", money: true },
      { header: "Gross", key: "gross", money: true },
    ],
    data.byDay,
    {
      totals: {
        day: "TOTAL", salesCount: sum(data.byDay, "salesCount"), net: sum(data.byDay, "net"), discount: sum(data.byDay, "discount"),
        service: sum(data.byDay, "service"), tax: sum(data.byDay, "tax"), gross: sum(data.byDay, "gross"),
      },
    }
  );

  // ---- Sales by item
  addTable(
    wb.addWorksheet("Sales by item"),
    [
      { header: "Item", key: "name", width: 32 },
      { header: "Category", key: "category", width: 18 },
      { header: "Qty sold", key: "qty", width: 12 },
      { header: "Net (before discount)", key: "net", money: true, width: 20 },
    ],
    data.byItem,
    { totals: { name: "TOTAL", qty: sum(data.byItem, "qty"), net: sum(data.byItem, "net") } }
  );

  // ---- Transactions
  addTable(
    wb.addWorksheet("Transactions"),
    [
      { header: "Receipt #", key: "receiptNo", width: 11 },
      { header: "Paid at", key: "paidLocal", width: 20 },
      { header: "Table", key: "table", width: 12 },
      { header: "Cashier", key: "cashier", width: 20 },
      { header: "Method", key: "method", width: 10 },
      { header: "Subtotal", key: "subtotal", money: true },
      { header: "Member", key: "member", width: 18 },
      { header: "Discount", key: "discount", money: true },
      { header: "Service", key: "service", money: true },
      { header: "Tax", key: "tax", money: true },
      { header: "Total", key: "total", money: true },
      { header: "Status", key: "status", width: 10 },
      { header: "Items", key: "items", width: 50 },
      { header: "Void reason", key: "voidReason", width: 30 },
      { header: "Voided by", key: "voidedBy", width: 18 },
    ],
    data.transactions
  );

  // ---- Stock
  addTable(
    wb.addWorksheet("Stock"),
    [
      { header: "Item", key: "name", width: 32 },
      { header: "Opening", key: "opening", width: 11 },
      { header: "Received", key: "received", width: 11 },
      { header: "Sold", key: "sold", width: 9 },
      { header: "Void restock", key: "voidRestock", width: 13 },
      { header: "Adjustments", key: "adjust", width: 13 },
      { header: "Closing", key: "closing", width: 11 },
    ],
    data.stock
  );

  // ---- Voids
  addTable(
    wb.addWorksheet("Voids"),
    [
      { header: "When", key: "at", width: 20 },
      { header: "Type", key: "type", width: 14 },
      { header: "Table", key: "table", width: 12 },
      { header: "Voided by", key: "actor", width: 20 },
      { header: "Value (ex-tax for items, gross for paid sales)", key: "amount", money: true, width: 24 },
      { header: "Reason", key: "reason", width: 34 },
    ],
    data.voids
  );

  return wb;
}

module.exports = { buildWorkbook };
