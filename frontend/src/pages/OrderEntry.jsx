import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../lib/api";
import { getSocket } from "../lib/socket";
import { playSound } from "../lib/sound";
import { rp } from "../lib/money";
import { useLiveOrders } from "../hooks/useLiveOrders";
import { useAlerts } from "../hooks/useAlerts";
import { useWakeLock } from "../hooks/useWakeLock";
import Topbar from "../components/Topbar.jsx";
import AlertBanner from "../components/AlertBanner.jsx";

// Front-of-house screen:
// 1. Send dishes to the kitchen/bar. A table has ONE running bill: sending again
//    for a table that is still open adds the dishes to that same bill.
// 2. Hear/see when food is READY, carry it, tap "Mark delivered".
// 3. Hand off to the POS ("Pay") once everything is delivered.
export default function OrderEntry() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { alerts, push, dismiss } = useAlerts();
  useWakeLock();

  const [categories, setCategories] = useState([]);
  const [tables, setTables] = useState([]);
  const [tableId, setTableId] = useState("");
  const [cart, setCart] = useState({}); // menuItemId -> { menuItem, quantity }
  const [status, setStatus] = useState("");

  const { orders } = useLiveOrders(user, {
    onItemUpdated: ({ orderOpenedById, tableLabel, item }) => {
      if (item.status !== "READY") return;
      // A waiter hears their OWN tables only; coordinators/supervisors/admins
      // hear everything (they cover the floor). Everyone still sees the order
      // status change on screen.
      const mine = orderOpenedById === user.id;
      if (user.role !== "FOH" || mine) {
        playSound("ready");
        push(`Ready to serve — ${tableLabel}: ${item.quantity}x ${item.menuItem.name}`, "ready");
      }
    },
    onItemVoided: ({ tableLabel, item }) => push(`Voided — ${tableLabel}: ${item.quantity}x ${item.menuItem.name}`, "void"),
    onOrderVoided: ({ tableLabel }) => push(`Order voided — ${tableLabel}`, "void"),
  });

  useEffect(() => {
    api.getCategories().then(setCategories).catch((e) => setStatus(e.message));
    api.getTables().then(setTables).catch((e) => setStatus(e.message));
    // Live stock counts ("3 left" / "Sold out") for tracked items.
    const socket = getSocket();
    const onStock = (list) =>
      setCategories((prev) =>
        prev.map((c) => ({
          ...c,
          menuItems: c.menuItems.map((m) => {
            const u = list.find((x) => x.menuItemId === m.id);
            return u ? { ...m, onHand: u.onHand } : m;
          }),
        }))
      );
    socket.on("stock:updated", onStock);
    return () => socket.off("stock:updated", onStock);
  }, []);

  function addItem(menuItem) {
    setCart((prev) => {
      const quantity = (prev[menuItem.id]?.quantity || 0) + 1;
      return { ...prev, [menuItem.id]: { menuItem, quantity } };
    });
  }

  function changeQty(menuItemId, delta) {
    setCart((prev) => {
      const existing = prev[menuItemId];
      if (!existing) return prev;
      const quantity = existing.quantity + delta;
      if (quantity <= 0) {
        const { [menuItemId]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [menuItemId]: { ...existing, quantity } };
    });
  }

  async function sendOrder() {
    if (!tableId) return setStatus("Pick a table first.");
    const items = Object.entries(cart).map(([menuItemId, { quantity }]) => ({ menuItemId, quantity }));
    if (items.length === 0) return setStatus("Add at least one item.");
    try {
      const order = await api.createOrder(tableId, items);
      setCart({});
      setTableId("");
      setStatus(order.added ? `Added to ${order.table.label}'s bill and sent to the kitchen.` : "Order sent to kitchen.");
    } catch (e) {
      setStatus(e.message);
    }
  }

  async function markDelivered(orderId, itemId) {
    try {
      await api.updateItemStatus(orderId, itemId, "DELIVERED");
    } catch (e) {
      setStatus(e.message);
    }
  }

  // the open bill of each table (one per table), to say "add to bill" instead of "new order"
  const openByTable = new Map(orders.map((o) => [o.table.id, o]));
  const openForSelected = tableId ? openByTable.get(tableId) : null;

  function addMoreTo(order) {
    setTableId(order.table.id);
    setStatus(`Adding to ${order.table.label}'s bill: tap dishes above, then press "Add to bill".`);
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { /* not available (tests) */ }
  }

  const cartItems = Object.values(cart);
  const total = cartItems.reduce((sum, { menuItem, quantity }) => sum + Number(menuItem.price) * quantity, 0);

  return (
    <div>
      <Topbar title="Order Entry" />
      <AlertBanner alerts={alerts} onDismiss={dismiss} />
      <div className="container">
        <label>
          Table
          <select value={tableId} onChange={(e) => setTableId(e.target.value)} style={{ marginLeft: "0.5rem" }}>
            <option value="">Select a table</option>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
                {openByTable.has(t.id) ? " (open bill)" : ""}
              </option>
            ))}
          </select>
        </label>

        {status && <p className="error-text">{status}</p>}

        {categories.map((cat) => (
          <div key={cat.id} style={{ marginTop: "1.5rem" }}>
            <h3>{cat.name}</h3>
            <div className="grid menu-grid">
              {cat.menuItems.map((item) => {
                const soldOut = item.trackStock && item.onHand <= 0;
                return (
                  <div
                    key={item.id}
                    className={`menu-card ${soldOut ? "sold-out" : ""}`}
                    onClick={() => !soldOut && addItem(item)}
                  >
                    <div className="name">{item.name}</div>
                    <div className="price">{rp(item.price)}</div>
                    {item.trackStock && (
                      <div className={`stock-note ${item.onHand <= 5 ? "low" : ""}`}>
                        {soldOut ? "Sold out" : `${item.onHand} left`}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <div className="cart-panel">
          <h3>{openForSelected ? `Add to ${openForSelected.table.label}'s open bill` : "Order for this table"}</h3>
          {cartItems.length === 0 && <p>No items yet — tap a menu item above.</p>}
          {cartItems.map(({ menuItem, quantity }) => (
            <div key={menuItem.id} className="cart-row">
              <span>{menuItem.name}</span>
              <div className="qty-controls">
                <button onClick={() => changeQty(menuItem.id, -1)}>-</button>
                <span>{quantity}</span>
                <button onClick={() => changeQty(menuItem.id, 1)}>+</button>
              </div>
            </div>
          ))}
          {cartItems.length > 0 && (
            <>
              <div className="cart-row" style={{ fontWeight: 700 }}>
                <span>Total (before tax)</span>
                <span>{rp(total)}</span>
              </div>
              <button onClick={sendOrder} style={{ background: "#16a34a", color: "white", width: "100%", marginTop: "1rem" }}>
                {openForSelected ? "Add to bill" : "Send to kitchen"}
              </button>
            </>
          )}
        </div>

        <div className="cart-panel" style={{ marginTop: "1.5rem" }}>
          <h3>Open tables — deliver &amp; pay</h3>
          {orders.length === 0 && <p>No open tables right now.</p>}
          {orders.map((order) => {
            const live = order.items.filter((i) => i.status !== "CANCELLED");
            const allDelivered = live.length > 0 && live.every((i) => i.status === "DELIVERED");
            return (
              <div key={order.id} style={{ marginBottom: "1rem", paddingBottom: "1rem", borderBottom: "1px solid #eee" }}>
                <div style={{ fontWeight: 700, marginBottom: "0.5rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>{order.table.label}</span>
                  <button className="small" onClick={() => addMoreTo(order)}>Add more</button>
                </div>
                {order.items.map((item) => (
                  <div key={item.id} className={`cart-row ${item.status === "CANCELLED" ? "voided" : ""}`}>
                    <span>
                      {item.quantity}x {item.menuItem.name}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <span className={`status-pill status-${item.status}`}>{item.status}</span>
                      {item.status === "READY" && (
                        <button onClick={() => markDelivered(order.id, item.id)} style={{ background: "#2563eb", color: "white" }}>
                          Mark delivered
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {allDelivered && (
                  <button onClick={() => navigate(`/pos?order=${order.id}`)} style={{ background: "#16a34a", color: "white", marginTop: "0.5rem" }}>
                    Pay this table
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
