// Display helper only. All money math happens on the server (SQL numeric);
// the client never computes what to charge. Currency is assumed IDR.
export function rp(value) {
  return "Rp " + Number(value || 0).toLocaleString("id-ID", { maximumFractionDigits: 0 });
}
