import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../lib/api";

// Front-of-house order entry: pick a table, tap menu items, send to kitchen.
// This is the screen that replaces "walk to the kitchen and shout the order."
export default function OrderEntry() {
  const { user, logout } = useAuth();
  const [categories, setCategories] = useState([]);
  const [tables, setTables] = useState([]);
  const [tableId, setTableId] = useState("");
  const [cart, setCart] = useState({}); // menuItemId -> { menuItem, quantity }
  const [status, setStatus] = useState("");

  useEffect(() => {
    api.getCategories().then(setCategories).catch((e) => setStatus(e.message));
    api.getTables().then(setTables).catch((e) => setStatus(e.message));
  }, []);

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
      </div>
    </div>
  );
}
