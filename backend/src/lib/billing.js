// The bill: food subtotal - member discount + service charge + restaurant tax.
// All money is handled in whole cents (integers) so there are no floating-point
// surprises, and each amount is rounded to whole currency units (rupiah).
const { HttpError } = require("./http");

const toCents = (v) => Math.round(Number(v) * 100);
const fromCents = (c) => c / 100;
const basisPoints = (rate) => Math.round(Number(rate || 0) * 10000); // 0.10 -> 1000
// amount x rate, rounded ONCE to whole rupiah (returned in cents). cents x basis points is an
// exact whole number for any real bill, so the only rounding is the final one, like the database's round().
const shareRupiah = (cents, bp) => Math.round((cents * bp) / 1000000) * 100;

// subtotal: food total (number). rates are fractions (0.10 = 10%).
function billTotals({ subtotal, discountRate = 0, serviceRate = 0, taxRate = 0, taxOnService = true }) {
  const sub = toCents(subtotal);
  const discount = shareRupiah(sub, basisPoints(discountRate));
  const afterDiscount = sub - discount;
  const service = shareRupiah(afterDiscount, basisPoints(serviceRate));
  const taxBase = afterDiscount + (taxOnService ? service : 0);
  const tax = shareRupiah(taxBase, basisPoints(taxRate));
  return {
    subtotal: fromCents(sub),
    discount: fromCents(discount),
    afterDiscount: fromCents(afterDiscount),
    service: fromCents(service),
    taxBase: fromCents(taxBase),
    tax: fromCents(tax),
    total: fromCents(afterDiscount + service + tax),
  };
}

// The restaurant's current billing settings.
async function billingSettings(db, locationId) {
  const { rows } = await db.query(
    "SELECT tax_label, tax_rate, service_rate, tax_on_service FROM locations WHERE id = $1",
    [locationId]
  );
  const r = rows[0];
  return { taxLabel: r.tax_label, taxRate: Number(r.tax_rate), serviceRate: Number(r.service_rate), taxOnService: r.tax_on_service };
}

// Phone numbers as typed ("+62 812-3456-7890", "0812 3456 7890") -> one key ("081234567890").
function phoneKey(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("62")) d = "0" + d.slice(2);
  else if (d.startsWith("8")) d = "0" + d;
  return d;
}

// An active member of THIS restaurant, or a 404.
async function findMember(db, locationId, memberId) {
  if (memberId === undefined || memberId === null || memberId === "") return null;
  if (typeof memberId !== "string") throw new HttpError(400, "memberId must be text");
  const { rows } = await db.query(
    "SELECT id, name, phone, discount_rate FROM members WHERE id = $1 AND location_id = $2 AND active = true",
    [memberId, locationId]
  );
  if (rows.length === 0) throw new HttpError(404, "Member not found (or switched off)");
  return { id: rows[0].id, name: rows[0].name, phone: rows[0].phone, discountRate: Number(rows[0].discount_rate) };
}

const percent = (rate) => Math.round(Number(rate) * 10000) / 100; // 0.05 -> 5

module.exports = { billTotals, billingSettings, phoneKey, findMember, percent };
