import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../lib/api";
import { getSocket } from "../lib/socket";
import { rp } from "../lib/money";
import { useLiveOrders } from "../hooks/useLiveOrders";
import { useAlerts } from "../hooks/useAlerts";
import Topbar from "../components/Topbar.jsx";
import AlertBanner from "../components/AlertBanner.jsx";
import ReasonDialog from "../components/ReasonDialog.jsx";
import LineExtras from "../components/LineExtras.jsx";
import { useSettings } from "../hooks/useSettings";
import { stationName } from "../lib/stations";
import { can } from "../lib/permissions";

// Each tab and the permission it needs.
const TABS = [["Live", "DASHBOARD"], ["Transactions", "DASHBOARD"], ["Kitchen history", "HISTORY"], ["Activity", "DASHBOARD"], ["Stock", "DASHBOARD"], ["Report", "EXPORT"]];

// One dashboard for the three oversight roles; what you can DO depends on role:
//   COORDINATOR  see everything, download the Excel report, receive stock
//   SUPERVISOR   see everything, VOID items / orders / paid sales
//   ADMIN        all of the above
// The server enforces every one of these; hiding a button is only convenience.
export default function CoordinatorDashboard() {
  const { user } = useAuth();
  const canVoid = can(user, "VOID");
  const visibleTabs = TABS.filter(([, perm]) => can(user, perm)).map(([t]) => t);
  const [tab, setTab] = useState(visibleTabs[0] || "Live");
  const [voidTarget, setVoidTarget] = useState(null); // { kind, orderId, itemId?, label }
  const { alerts, push, dismiss } = useAlerts();

  const { orders, reload } = useLiveOrders(user);
  const [summary, setSummary] = useState([]);
  const refreshSummary = useCallback(() => api.getOutstandingSummary().then(setSummary).catch(console.error), []);

  useEffect(() => {
    refreshSummary();
    const socket = getSocket();
    const events = ["order:created", "order-item:updated", "order-item:voided", "order:closed", "order:voided"];
    events.forEach((e) => socket.on(e, refreshSummary));
    return () => events.forEach((e) => socket.off(e, refreshSummary));
  }, [refreshSummary]);

  async function confirmVoid(reason) {
    const t = voidTarget;
    if (t.kind === "item") await api.voidItem(t.orderId, t.itemId, reason);
    else await api.voidOrder(t.orderId, reason);
    setVoidTarget(null);
    push(`Voided: ${t.label}`, "void");
    reload();
  }


  return (
    <div>
      <Topbar title="Dashboard" />
      <AlertBanner alerts={alerts} onDismiss={dismiss} />
      <div className="container">
        <div className="tabs" role="tablist">
          {visibleTabs.map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "primary" : ""} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>

        {tab === "Live" && (
          <div className="dashboard-columns">
            <div className="panel">
              <h2>Open tables</h2>
              {orders.length === 0 && <p>No open tables.</p>}
              {orders.map((order) => {
                const live = order.items.filter((i) => i.status !== "CANCELLED");
                const delivered = live.filter((i) => i.status === "DELIVERED").length;
                return (
                  <div key={order.id} className="order-block">
                    <div className="order-block-head">
                      <strong>{order.table.label}</strong>
                      <span>{delivered}/{live.length} served · opened {new Date(order.openedAt).toLocaleTimeString()}</span>
                      {canVoid && (
                        <button className="danger small" onClick={() => setVoidTarget({ kind: "order", orderId: order.id, label: `${order.table.label} (whole order)` })}>
                          Void order
                        </button>
                      )}
                    </div>
                    {order.items.map((item) => (
                      <div key={item.id} className={`cart-row ${item.status === "CANCELLED" ? "voided" : ""}`}>
                        <span>{item.quantity}x {item.menuItem.name}</span>
                        <span style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                          <span className={`status-pill status-${item.status}`}>{item.status}</span>
                          {canVoid && item.status !== "CANCELLED" && (
                            <button
                              className="danger small"
                              onClick={() => setVoidTarget({ kind: "item", orderId: order.id, itemId: item.id, label: `${order.table.label}: ${item.quantity}x ${item.menuItem.name}` })}
                            >
                              Void
                            </button>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
            <div className="panel">
              <h2>Outstanding by item</h2>
              <table>
                <thead>
                  <tr><th>Item</th><th>Ordered</th><th>Delivered</th><th>Outstanding</th></tr>
                </thead>
                <tbody>
                  {summary
                    .filter((row) => row.outstanding > 0)
                    .sort((a, b) => b.outstanding - a.outstanding)
                    .map((row) => (
                      <tr key={row.menuItemId}>
                        <td>{row.name}</td><td>{row.ordered}</td><td>{row.delivered}</td>
                        <td className="outstanding-count">{row.outstanding}</td>
                      </tr>
                    ))}
                  {summary.every((row) => row.outstanding === 0) && (
                    <tr><td colSpan={4}>Nothing outstanding right now.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "Transactions" && <Transactions user={user} canVoid={canVoid} onVoid={setVoidTarget} />}
        {tab === "Kitchen history" && <KitchenHistory />}
        {tab === "Activity" && <Activity />}
        {tab === "Stock" && <Stock />}
        {tab === "Report" && can(user, "EXPORT") && <Report />}
      </div>

      {voidTarget && (
        <ReasonDialog
          title={`Void ${voidTarget.kind === "sale" ? "paid sale" : voidTarget.kind}`}
          detail={`${voidTarget.label}. This is logged under your name.`}
          onConfirm={confirmVoid}
          onCancel={() => setVoidTarget(null)}
        />
      )}
    </div>
  );
}

function Transactions({ canVoid, onVoid }) {
  const [date, setDate] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api.getTransactions(date || undefined).then((d) => { setData(d); setError(""); }).catch((e) => setError(e.message));
  }, [date]);

  useEffect(() => {
    load();
    const socket = getSocket();
    socket.on("payment:changed", load);
    return () => socket.off("payment:changed", load);
  }, [load]);

  return (
    <div className="panel">
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Transactions</h2>
        <label>
          Date{" "}
          <input type="date" value={date || data?.date || ""} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      {error && <p className="error-text">{error}</p>}
      {data && (
        <>
          <div className="stat-row">
            <Stat label="Paid sales" value={data.totals.paidCount} />
            <Stat label="Food & drinks" value={rp(data.totals.subtotal)} />
            <Stat label="Member discounts" value={rp(data.totals.discount || 0)} />
            <Stat label="Service" value={rp(data.totals.service || 0)} />
            <Stat label="Tax" value={rp(data.totals.tax)} />
            <Stat label="Gross" value={rp(data.totals.total)} strong />
            <Stat label="Voided" value={`${data.totals.voidedCount} (${rp(data.totals.voidedTotal)})`} />
          </div>
          <table>
            <thead>
              <tr><th>#</th><th>Time</th><th>Table</th><th>Items</th><th>Method</th><th>Total</th><th>By</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {data.payments.map((p) => (
                <tr key={p.id} className={p.status === "VOIDED" ? "voided" : ""}>
                  <td>{p.receiptNo}</td>
                  <td>{new Date(p.paidAt).toLocaleTimeString()}</td>
                  <td>{p.tableLabel}</td>
                  <td>{p.items}{p.memberName ? <div className="stock-note">Member {p.memberName}: −{rp(p.discount)}</div> : null}</td>
                  <td>{p.method}</td>
                  <td>{rp(p.total)}</td>
                  <td>{p.cashier}</td>
                  <td>
                    <span className={`status-pill ${p.status === "PAID" ? "status-READY" : "status-CANCELLED"}`}>{p.status}</span>
                    {p.status === "VOIDED" && <div style={{ fontSize: "0.8rem" }}>{p.voidReason} — {p.voidedBy}</div>}
                  </td>
                  <td>
                    {canVoid && p.status === "PAID" && (
                      <button className="danger small" onClick={() => onVoid({ kind: "sale", orderId: p.orderId, label: `Receipt #${p.receiptNo} (${p.tableLabel}, ${rp(p.total)})` })}>
                        Void sale
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {data.payments.length === 0 && <tr><td colSpan={9}>No transactions on this day.</td></tr>}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// Every dish the kitchen and bar finished on a day: when it was ordered, how long it
// took, who made it and who served it. Dishes leave the kitchen screens once READY;
// this is where supervisors trace them afterwards.
function KitchenHistory() {
  const { kitchenMode } = useSettings();
  const [date, setDate] = useState("");
  const [station, setStation] = useState("ALL");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api.getHistory(date || undefined, station).then((d) => { setData(d); setError(""); }).catch((e) => setError(e.message));
  }, [date, station]);

  useEffect(() => {
    load();
    const socket = getSocket();
    socket.on("order-item:updated", load); // a dish marked ready / served appears straight away
    return () => socket.off("order-item:updated", load);
  }, [load]);

  const choices = [
    ["ALL", "All"],
    ["KITCHEN", kitchenMode === "SPLIT" ? "Hot kitchen" : "Kitchen"],
    ...(kitchenMode === "SPLIT" ? [["COLD", "Cold kitchen"]] : []),
    ["BAR", "Bar"],
  ];
  const time = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

  return (
    <div className="panel">
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Kitchen &amp; bar history</h2>
        <label>
          Date{" "}
          <input type="date" value={date || data?.date || ""} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <div className="tabs">
        {choices.map(([value, label]) => (
          <button key={value} className={`small ${station === value ? "primary" : ""}`} onClick={() => setStation(value)}>{label}</button>
        ))}
      </div>
      {error && <p className="error-text">{error}</p>}
      {data && (
        <>
          <div className="stat-row">
            <Stat label="Dishes finished" value={data.stats.lines} />
            <Stat label="Portions" value={data.stats.units} />
            <Stat label="Average time to make" value={data.stats.avgMinutes === null ? "—" : `${data.stats.avgMinutes} min`} />
            <Stat label="Waiting to be served" value={data.stats.waitingToServe} strong={data.stats.waitingToServe > 0} />
          </div>
          <table>
            <thead>
              <tr><th>Ready at</th><th>Table</th><th>Dish</th><th>Made in</th><th>Ordered</th><th>Took</th><th>Made by</th><th>Served</th></tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.id}>
                  <td>{time(l.readyAt)}</td>
                  <td>{l.table}{l.customerName ? ` · ${l.customerName}` : ""}</td>
                  <td>{l.quantity}x {l.item}<LineExtras item={l} /></td>
                  <td>{stationName(l.station)}</td>
                  <td>{time(l.orderedAt)}</td>
                  <td>{l.minutes} min</td>
                  <td>{l.readyBy || "—"}</td>
                  <td>{l.status === "DELIVERED" ? `${time(l.deliveredAt)} · ${l.deliveredBy || "—"}` : <strong style={{ color: "#b45309" }}>Waiting to be served</strong>}</td>
                </tr>
              ))}
              {data.lines.length === 0 && <tr><td colSpan={8}>Nothing was finished on this day.</td></tr>}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, strong }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={strong ? { fontWeight: 800 } : undefined}>{value}</div>
    </div>
  );
}

function Activity() {
  const [events, setEvents] = useState([]);
  useEffect(() => {
    api.getActivity().then(setEvents).catch(console.error);
    const socket = getSocket();
    const onNew = (e) => setEvents((prev) => (prev.some((x) => x.id === e.id) ? prev : [e, ...prev].slice(0, 200)));
    socket.on("activity:new", onNew);
    return () => socket.off("activity:new", onNew);
  }, []);
  return (
    <div className="panel">
      <h2>Activity (newest first)</h2>
      <table>
        <thead><tr><th>Time</th><th>Who</th><th>What</th></tr></thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id} className={/VOID/.test(e.type) ? "voided-event" : ""}>
              <td>{new Date(e.createdAt).toLocaleTimeString()}</td>
              <td>{e.actorName || "—"}</td>
              <td>{e.message}</td>
            </tr>
          ))}
          {events.length === 0 && <tr><td colSpan={3}>No activity yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Stock() {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({ menuItemId: "", delta: "", reason: "RECEIVE", note: "" });
  const [msg, setMsg] = useState("");

  const load = useCallback(() => api.getStock().then(setItems).catch((e) => setMsg(e.message)), []);
  useEffect(() => {
    load();
    const socket = getSocket();
    socket.on("stock:updated", load);
    return () => socket.off("stock:updated", load);
  }, [load]);

  async function submit(e) {
    e.preventDefault();
    setMsg("");
    try {
      const delta = Number(form.delta);
      await api.addStockMovement(form.menuItemId, form.reason === "RECEIVE" ? Math.abs(delta) : delta, form.reason, form.note);
      setForm({ ...form, delta: "", note: "" });
      setMsg("Saved.");
      load();
    } catch (err) {
      setMsg(err.message);
    }
  }

  return (
    <div className="dashboard-columns">
      <div className="panel">
        <h2>Tracked stock</h2>
        <table>
          <thead><tr><th>Item</th><th>On hand</th></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.menuItemId}><td>{i.name}</td><td className={i.onHand <= 5 ? "outstanding-count" : ""}>{i.onHand}</td></tr>
            ))}
            {items.length === 0 && <tr><td colSpan={2}>No dish is counted yet. Tick "Count stock" for a dish in Admin &gt; Menu, then add its first delivery here.</td></tr>}
          </tbody>
        </table>
      </div>
      <form className="panel" onSubmit={submit}>
        <h2>Receive / adjust</h2>
        <label>Item
          <select value={form.menuItemId} onChange={(e) => setForm({ ...form, menuItemId: e.target.value })} required style={{ width: "100%" }}>
            <option value="">Choose…</option>
            {items.map((i) => <option key={i.menuItemId} value={i.menuItemId}>{i.name}</option>)}
          </select>
        </label>
        <label>Type
          <select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} style={{ width: "100%" }}>
            <option value="RECEIVE">Receive delivery (+)</option>
            <option value="ADJUST">Adjust count (+/−, note required)</option>
          </select>
        </label>
        <label>Quantity
          <input type="number" required value={form.delta} onChange={(e) => setForm({ ...form, delta: e.target.value })} style={{ width: "100%" }} />
        </label>
        <label>Note
          <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} style={{ width: "100%" }} />
        </label>
        {msg && <p className={msg === "Saved." ? "" : "error-text"}>{msg}</p>}
        <button className="primary" type="submit" style={{ width: "100%" }}>Save</button>
      </form>
    </div>
  );
}

function Report() {
  const [period, setPeriod] = useState("day");
  const [date, setDate] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    setMsg("");
    try {
      const name = await api.downloadReport(period, date || undefined);
      setMsg(`Downloaded ${name}`);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ maxWidth: 520 }}>
      <h2>Excel report (sales + stock in one file)</h2>
      <p>
        Sheets: Summary, Sales by day, Sales by item, Transactions, Stock, Voids. Days run midnight to midnight in the
        restaurant&apos;s timezone; a week is Monday to Sunday.
      </p>
      <div className="method-row">
        <button className={period === "day" ? "primary" : ""} onClick={() => setPeriod("day")}>Daily</button>
        <button className={period === "week" ? "primary" : ""} onClick={() => setPeriod("week")}>Weekly</button>
      </div>
      <label style={{ display: "block", marginTop: "1rem" }}>
        {period === "day" ? "Day" : "Any date in the week"} (leave empty for today)
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ marginLeft: "0.5rem" }} />
      </label>
      <button className="primary" onClick={download} disabled={busy} style={{ marginTop: "1rem" }}>
        {busy ? "Preparing…" : "Download Excel"}
      </button>
      {msg && <p className={msg.startsWith("Downloaded") ? "" : "error-text"}>{msg}</p>}
    </div>
  );
}
