import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../lib/api";
import { getSocket } from "../lib/socket";

// Front-of-house screen, two jobs in one place:
// 1. Send a new order to the kitchen (top half).
// 2. See which already-sent items are READY and mark them DELIVERED once
//    carried to the table (bottom half) — this is the step that actually
//    closes the loop back to the kitchen and lets a table's order be closed.
export default function OrderEntry() {
  const { user, logout } = useAuth();
  const [categories, setCategories] = useState([]);
  const [tables, setTables] = useState([]);
  const [tableId, setTableId] = useState("");
  const [cart, setCart] = useState({}); // menuItemId -> { menuItem, quantity }
  const [status, setStatus] = useState("");
  const [openOrders, setOpenOrders] = useState([]);

  useEffect(() => {
    api.getCategories().then(setCategories).catch((e) => setStatus(e.message));
    api.getTables().then(setTables).catch((e) => setStatus(e.message));
    api.getOpenOrders().then(setOpenOrders).catch(console.error);

    const socket = getSocket(user.locationId);

    function handleCreated(order) {
      setOpenOrders((prev) => [...prev, order]);
    }
    function handleItemUpdated({ orderId, item }) {
      setOpenOrders((prev) =>
        prev.map((o) =>
          o.id === orderId ? { ...o, items: o.items.map((i) => (i.id === item.id ? item : i)) } : o
        )
      );
    }
    function handleClosed({ orderId }) {
      setOpenOrders((prev) => prev.filter((o) => o.id !== orderId));
    }

    socket.on("order:created", handleCreated);
    socket.on("order-item:updated", handleItemUpdated);
    socket.on("order:closed", handleClosed);

    return () => {
      socket.off("order:created", handleCreated);
      socket.off("order-item:updated", handleItemUpdated);
      socket.off("order:closed", handleClosed);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.locationId]);

  function addItem(menuItem) {
    setCart((prev) => {
      const existing = prev[menuItem.id];
      const quantity = (existing?.quantity || 0) + 1;
      return { ...prev, [menuItem.id]: { menuItem, quantity } };
    });
  }

  function changeQty(menuItemId, delta) {
    setCart((prev) => {
      const existing = prev[menuItemId];
      if (!existing) return prev;
      const quantity = existing.quantity + delta;
      if (quantity <= 0) {
        const { [menuItemId]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [menuItemId]: { ...existing, quantity } };
    });
  }

  async function sendOrder() {
    if (!tableId) {
      setStatus("Pick a table first.");
      return;
    }
    const items = Object.entries(cart).map(([menuItemId, { quantity }]) => ({ menuItemId, quantity }));
    if (items.length === 0) {
      setStatus("Add at least one item.");
      return;
    }
    try {
      await api.createOrder(tableId, items);
      setCart({});
      setTableId("");
      setStatus("Order sent to kitchen.");
    } catch (e) {
      setStatus(e.message);
    }
  }

  async function markDelivered(orderId, itemId) {
    try {
      await api.updateItemStatus(orderId, itemId, "DELIVERED");
      // Update locally too in case the socket event is delayed.
      setOpenOrders((prev) =>
        prev.map((o) =>
          o.id === orderId
            ? { ...o, items: o.items.map((i) => (i.id === itemId ? { ...i, status: "DELIVERED" } : i)) }
            : o
        )
      );
    } catch (e) {
      setStatus(e.message);
    }
  }

  async function closeTable(orderId) {
    try {
      await api.closeOrder(orderId);
      setOpenOrders((prev) => prev.filter((o) => o.id !== orderId));
    } catch (e) {
      setStatus(e.message);
    }
  }

  const cartItems = Object.values(cart);
  const total = cartItems.reduce((sum, { menuItem, quantity }) => sum + Number(menuItem.price) * quantity, 0);

  return (
    <div>
      <div className="topbar">
        <div>Order Entry — {user?.name}</div>
        <button onClick={logout}>Log out</button>
      </div>
      <div className="container">
        <label>
          Table
          <select value={tableId} onChange={(e) => setTableId(e.target.value)} style={{ marginLeft: "0.5rem" }}>
            <option value="">Select a table</option>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        {status && <p className="error-text">{status}</p>}

        {categories.map((cat) => (
          <div key={cat.id} style={{ marginTop: "1.5rem" }}>
            <h3>{cat.name}</h3>
            <div className="grid menu-grid">
              {cat.menuItems.map((item) => (
                <div key={item.id} className="menu-card" onClick={() => addItem(item)}>
                  <div className="name">{item.name}</div>
                  <div className="price">Rp {Number(item.price).toLocaleString("id-ID")}</div>
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="cart-panel">
          <h3>Order for this table</h3>
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
                <span>Total</span>
                <span>Rp {total.toLocaleString("id-ID")}</span>
              </div>
              <button onClick={sendOrder} style={{ background: "#16a34a", color: "white", width: "100%", marginTop: "1rem" }}>
                Send to kitchen
              </button>
            </>
          )}
        </div>

        <div className="cart-panel" style={{ marginTop: "1.5rem" }}>
          <h3>Your open tables — deliver &amp; close</h3>
          {openOrders.length === 0 && <p>No open tables right now.</p>}
          {openOrders.map((order) => {
            const allDelivered = order.items.every((i) => i.status === "DELIVERED");
            return (
              <div key={order.id} style={{ marginBottom: "1rem", paddingBottom: "1rem", borderBottom: "1px solid #eee" }}>
                <div style={{ fontWeight: 700, marginBottom: "0.5rem" }}>{order.table.label}</div>
                {order.items.map((item) => (
                  <div key={item.id} className="cart-row">
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
                  <button onClick={() => closeTable(order.id)} style={{ background: "#16a34a", color: "white", marginTop: "0.5rem" }}>
                    Close table
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
