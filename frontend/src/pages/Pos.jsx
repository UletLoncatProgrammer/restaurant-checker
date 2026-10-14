import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../lib/api";
import { rp } from "../lib/money";
import { useLiveOrders } from "../hooks/useLiveOrders";
import Topbar from "../components/Topbar.jsx";

const METHODS = [
  ["CASH", "Cash"],
  ["CARD", "Card"],
  ["QRIS", "QRIS"],
  ["OTHER", "Other"],
];

function Receipt({ receipt, onDone }) {
  return (
    <div className="panel">
      <div className="receipt" id="receipt">
        <h2 style={{ textAlign: "center", margin: 0 }}>{receipt.locationName}</h2>
        <p style={{ textAlign: "center", margin: "0.25rem 0" }}>
          Receipt #{receipt.receiptNo} — {receipt.tableLabel}
        </p>
        <p style={{ textAlign: "center", margin: "0 0 0.75rem", fontSize: "0.85rem" }}>
          {new Date(receipt.paidAt).toLocaleString()} · Cashier: {receipt.cashierName}
        </p>
        {receipt.status === "VOIDED" && <p className="error-text">VOIDED: {receipt.voidReason}</p>}
        <table>
          <tbody>
            {receipt.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.quantity}x {l.name}</td>
                <td style={{ textAlign: "right" }}>{rp(l.lineSubtotal)}</td>
              </tr>
            ))}
            <tr><td>Subtotal</td><td style={{ textAlign: "right" }}>{rp(receipt.subtotal)}</td></tr>
            <tr><td>Tax</td><td style={{ textAlign: "right" }}>{rp(receipt.tax)}</td></tr>
            <tr style={{ fontWeight: 700 }}><td>Total ({receipt.method})</td><td style={{ textAlign: "right" }}>{rp(receipt.total)}</td></tr>
            {receipt.amountTendered !== null && (
              <>
                <tr><td>Cash received</td><td style={{ textAlign: "right" }}>{rp(receipt.amountTendered)}</td></tr>
                <tr><td>Change</td><td style={{ textAlign: "right" }}>{rp(receipt.changeGiven)}</td></tr>
              </>
            )}
          </tbody>
        </table>
        <p style={{ textAlign: "center", marginTop: "1rem" }}>Thank you!</p>
      </div>
      <div className="modal-actions no-print">
        <button onClick={() => window.print()}>Print receipt</button>
        <button onClick={onDone} className="primary">Done</button>
      </div>
    </div>
  );
}

// Waiter POS: pick a table that has been fully served, see the server-computed
// bill, take payment, show/print the receipt. The client never sends an amount
// to charge (only the cash handed over) — the server recomputes the bill.
export default function Pos() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const { orders } = useLiveOrders(user);
  const selectedId = params.get("order") || "";
  const [bill, setBill] = useState(null);
  const [method, setMethod] = useState("CASH");
  const [tendered, setTendered] = useState("");
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const selected = orders.find((o) => o.id === selectedId) || null;
  // Reload the bill whenever the selected order's items change status.
  const signature = useMemo(() => (selected ? selected.items.map((i) => `${i.id}:${i.status}`).join("|") : ""), [selected]);

  useEffect(() => {
    setBill(null);
    setError("");
    if (!selectedId || !selected) return;
    api.getBill(selectedId).then(setBill).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, signature]);

  const rows = orders.map((o) => {
    const live = o.items.filter((i) => i.status !== "CANCELLED");
    const delivered = live.filter((i) => i.status === "DELIVERED").length;
    return { order: o, live: live.length, delivered, ready: live.length > 0 && delivered === live.length };
  });
  rows.sort((a, b) => Number(b.ready) - Number(a.ready));

  const tenderedNumber = Number(tendered);
  const change = bill && method === "CASH" && tendered !== "" ? tenderedNumber - bill.total : null;
  const canPay = bill?.payable && !busy && (method !== "CASH" || (tendered !== "" && tenderedNumber >= bill.total));

  async function pay() {
    setBusy(true);
    setError("");
    try {
      const r = await api.pay(selectedId, method, method === "CASH" ? tenderedNumber : undefined);
      setReceipt(r);
      setParams({});
      setTendered("");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Topbar title="POS" />
      <div className="container dashboard-columns">
        <div className="panel no-print">
          <h2>Open tables</h2>
          {rows.length === 0 && <p>No open tables.</p>}
          {rows.map(({ order, live, delivered, ready }) => (
            <button
              key={order.id}
              className={`pos-table ${order.id === selectedId ? "selected" : ""}`}
              onClick={() => {
                setReceipt(null);
                setParams({ order: order.id });
              }}
            >
              <strong>{order.table.label}</strong>
              <span className={`status-pill ${ready ? "status-READY" : "status-PREPARING"}`}>
                {ready ? "Ready to pay" : `${delivered}/${live} served`}
              </span>
            </button>
          ))}
        </div>

        <div>
          {receipt && <Receipt receipt={receipt} onDone={() => setReceipt(null)} />}
          {!receipt && !selected && <div className="panel"><p>Pick a table to see its bill.</p></div>}
          {!receipt && selected && (
            <div className="panel">
              <h2>{selected.table.label} — bill</h2>
              {error && <p className="error-text">{error}</p>}
              {bill && (
                <>
                  <table>
                    <tbody>
                      {bill.lines.map((l, i) => (
                        <tr key={i}>
                          <td>{l.quantity}x {l.name}</td>
                          <td style={{ textAlign: "right" }}>{rp(l.lineSubtotal)}</td>
                        </tr>
                      ))}
                      <tr><td>Subtotal</td><td style={{ textAlign: "right" }}>{rp(bill.subtotal)}</td></tr>
                      <tr><td>Tax</td><td style={{ textAlign: "right" }}>{rp(bill.tax)}</td></tr>
                      <tr style={{ fontWeight: 700, fontSize: "1.2rem" }}><td>Total</td><td style={{ textAlign: "right" }}>{rp(bill.total)}</td></tr>
                    </tbody>
                  </table>
                  {!bill.payable && (
                    <p className="error-text">
                      {bill.lines.length === 0 ? "Nothing to charge." : `Not served yet: ${bill.undelivered.join(", ")}`}
                    </p>
                  )}
                  <div className="method-row">
                    {METHODS.map(([value, label]) => (
                      <button key={value} className={method === value ? "primary" : ""} onClick={() => setMethod(value)}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {method === "CASH" && (
                    <div style={{ marginTop: "1rem" }}>
                      <label>
                        Cash received
                        <input
                          inputMode="numeric"
                          type="number"
                          min="0"
                          value={tendered}
                          onChange={(e) => setTendered(e.target.value)}
                          style={{ marginLeft: "0.5rem" }}
                        />
                      </label>
                      <div className="method-row">
                        <button onClick={() => setTendered(String(bill.total))}>Exact</button>
                        {[50000, 100000, 200000].map((v) => (
                          <button key={v} onClick={() => setTendered(String(v))}>{rp(v)}</button>
                        ))}
                      </div>
                      {change !== null && (
                        <p style={{ fontWeight: 700 }}>
                          {change >= 0 ? `Change: ${rp(change)}` : `Short by ${rp(-change)}`}
                        </p>
                      )}
                    </div>
                  )}
                  <button className="primary" disabled={!canPay} onClick={pay} style={{ width: "100%", marginTop: "1rem" }}>
                    {busy ? "Processing…" : `Charge ${rp(bill.total)}`}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
