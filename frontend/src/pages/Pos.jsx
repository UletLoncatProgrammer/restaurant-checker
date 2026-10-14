import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../lib/api";
import { rp } from "../lib/money";
import { useLiveOrders } from "../hooks/useLiveOrders";
import { can } from "../lib/permissions";
import Topbar from "../components/Topbar.jsx";

const METHODS = [
  ["CASH", "Cash"],
  ["CARD", "Card"],
  ["QRIS", "QRIS"],
  ["OTHER", "Other"],
];

// Subtotal, member discount, service charge, tax and total - the same on the bill and the receipt.
function Totals({ b, method }) {
  const row = (label, value, style) => (
    <tr style={style}><td>{label}</td><td style={{ textAlign: "right" }}>{value}</td></tr>
  );
  return (
    <>
      {row("Subtotal", rp(b.subtotal))}
      {b.discount > 0 && row(`Member discount${b.memberName || b.member ? ` — ${b.memberName || b.member.name}` : ""} (${b.discountPercent}%)`, `− ${rp(b.discount)}`)}
      {b.service > 0 && row(`Service charge (${b.servicePercent}%)`, rp(b.service))}
      {row(b.taxPercent !== null && b.taxPercent !== undefined ? `${b.taxLabel || "Tax"} (${b.taxPercent}%)` : b.taxLabel || "Tax", rp(b.tax))}
      {row(method ? `Total (${method})` : "Total", rp(b.total), { fontWeight: 700, fontSize: method ? undefined : "1.2rem" })}
    </>
  );
}

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
            <Totals b={receipt} method={receipt.method} />
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
  // member discount: the cashier types the member's phone and presses Find
  const [phone, setPhone] = useState("");
  const [member, setMember] = useState(null); // { id, name, discountPercent }
  const [memberMsg, setMemberMsg] = useState("");
  // phone not found: someone allowed to keep the member list can add the member right here
  const [notFound, setNotFound] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDisc, setNewDisc] = useState("10");

  const selected = orders.find((o) => o.id === selectedId) || null;
  // Reload the bill whenever the selected order's items change status.
  const signature = useMemo(() => (selected ? selected.items.map((i) => `${i.id}:${i.status}`).join("|") : ""), [selected]);

  useEffect(() => {
    setBill(null);
    setError("");
    if (!selectedId || !selected) return;
    let current = true; // ignore an older answer that arrives after a newer request
    api.getBill(selectedId, member?.id).then((b) => current && setBill(b)).catch((e) => current && setError(e.message));
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, signature, member?.id]);

  async function findMember(e) {
    e.preventDefault();
    setMemberMsg("");
    setNotFound(false);
    try {
      const m = await api.lookupMember(phone);
      setMember(m);
    } catch (err) {
      setMember(null);
      setMemberMsg(err.message);
      setNotFound(/No active member/.test(err.message));
    }
  }

  async function addMember() {
    setMemberMsg("");
    try {
      await api.createMember({ name: newName.trim(), phone, discountPercent: Number(newDisc), note: "" });
      const m = await api.lookupMember(phone); // the server's answer, so the bill uses exactly what was saved
      setMember(m);
      setNotFound(false);
      setNewName("");
    } catch (err) {
      setMemberMsg(err.message);
    }
  }

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
      const r = await api.pay(selectedId, method, method === "CASH" ? tenderedNumber : undefined, member?.id);
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
                setMember(null); // another table: forget the member found for the previous one
                setPhone("");
                setMemberMsg("");
                setNotFound(false);
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
                      <Totals b={bill} />
                    </tbody>
                  </table>
                  <form className="member-row" onSubmit={findMember}>
                    {member ? (
                      <>
                        <span>Member: <strong>{member.name}</strong> ({member.discountPercent}% off)</span>
                        <button type="button" className="small" onClick={() => { setMember(null); setPhone(""); setNotFound(false); }}>Remove</button>
                      </>
                    ) : (
                      <>
                        <input value={phone} onChange={(e) => { setPhone(e.target.value); setNotFound(false); }} inputMode="tel" placeholder="Member phone number" aria-label="Member phone number" />
                        <button type="submit" className="small" disabled={phone.trim().length < 6}>Find member</button>
                      </>
                    )}
                  </form>
                  {memberMsg && <p className="error-text">{memberMsg}</p>}
                  {!member && notFound && (can(user, "MEMBERS") ? (
                    <div className="member-row">
                      <span>Not a member yet. Add as new member:</span>
                      <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Member name" aria-label="New member name" maxLength={60} />
                      <input value={newDisc} onChange={(e) => setNewDisc(e.target.value)} inputMode="decimal" aria-label="New member discount percent" style={{ width: 80 }} />
                      <span>%</span>
                      <button type="button" className="small primary" onClick={addMember} disabled={newName.trim().length < 2}>Add member &amp; apply</button>
                    </div>
                  ) : (
                    <p className="hint">Not a member yet. Ask an Admin, Coordinator or Supervisor to add them (Admin → Members).</p>
                  ))}
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
