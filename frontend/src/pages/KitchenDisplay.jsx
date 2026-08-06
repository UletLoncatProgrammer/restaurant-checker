import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../lib/api";
import { getSocket } from "../lib/socket";

const NEXT_STATUS = {
  PENDING: "PREPARING",
  PREPARING: "READY",
};

// This screen is the direct replacement for the paper ticket on the magnet
// board. It must reflect new orders and status changes in real time without
// anyone refreshing — that's the whole point of the rebuild.
export default function KitchenDisplay() {
  const { user, logout } = useAuth();
  const [orders, setOrders] = useState([]);

  useEffect(() => {
    api.getOpenOrders().then(setOrders).catch(console.error);

    const socket = getSocket(user.locationId);

    function handleCreated(order) {
      setOrders((prev) => [...prev, order]);
    }
    function handleItemUpdated({ orderId, item }) {
      setOrders((prev) =>
        prev.map((o) =>
          o.id === orderId ? { ...o, items: o.items.map((i) => (i.id === item.id ? item : i)) } : o
        )
      );
    }
    function handleClosed({ orderId }) {
      setOrders((prev) => prev.filter((o) => o.id !== orderId));
    }

    socket.on("order:created", handleCreated);
    socket.on("order-item:updated", handleItemUpdated);
    socket.on("order:closed", handleClosed);

    return () => {
      socket.off("order:created", handleCreated);
      socket.off("order-item:updated", handleItemUpdated);
      socket.off("order:closed", handleClosed);
    };
  }, [user.locationId]);

  async function advance(orderId, item) {
    const next = NEXT_STATUS[item.status];
    if (!next) return;
    try {
      await api.updateItemStatus(orderId, item.id, next);
      // Also update locally in case the socket event is delayed — the
      // person tapping the button should see it change immediately.
      setOrders((prev) =>
        prev.map((o) =>
          o.id === orderId ? { ...o, items: o.items.map((i) => (i.id === item.id ? { ...i, status: next } : i)) } : o
        )
      );
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <div>
      <div className="topbar">
        <div>Kitchen Display — {user?.name}</div>
        <button onClick={logout}>Log out</button>
      </div>
      <div className="container">
        <div className="kds-board">
          {orders.map((order) => {
            const allReady = order.items.every((i) => i.status === "READY" || i.status === "DELIVERED");
            return (
              <div key={order.id} className={`ticket ${allReady ? "all-ready" : ""}`}>
                <div className="ticket-header">
                  <span>{order.table.label}</span>
                  <span>{new Date(order.openedAt).toLocaleTimeString()}</span>
                </div>
                {order.items.map((item) => (
                  <div key={item.id} className="ticket-item">
                    <span>
                      {item.quantity}x {item.menuItem.name}
                      {item.notes && <em style={{ display: "block", fontSize: "0.8rem" }}>{item.notes}</em>}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <span className={`status-pill status-${item.status}`}>{item.status}</span>
                      {NEXT_STATUS[item.status] && (
                        <button onClick={() => advance(order.id, item)}>Mark {NEXT_STATUS[item.status]}</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
          {orders.length === 0 && <p>No open orders right now.</p>}
        </div>
      </div>
    </div>
  );
}
