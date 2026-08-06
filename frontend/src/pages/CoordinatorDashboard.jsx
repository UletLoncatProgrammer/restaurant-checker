import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../lib/api";
import { getSocket } from "../lib/socket";

// The role you described as "coordinator with full visibility": every open
// table's status on one board, plus a live per-menu-item outstanding count
// (ordered minus delivered) so they can see e.g. "8x Nasi Goreng still owed
// to the floor" without walking around asking.
export default function CoordinatorDashboard() {
  const { user, logout } = useAuth();
  const [orders, setOrders] = useState([]);
  const [summary, setSummary] = useState([]);

  function refreshSummary() {
    api.getOutstandingSummary().then(setSummary).catch(console.error);
  }

  useEffect(() => {
    api.getOpenOrders().then(setOrders).catch(console.error);
    refreshSummary();

    const socket = getSocket(user.locationId);

    function handleCreated(order) {
      setOrders((prev) => [...prev, order]);
      refreshSummary();
    }
    function handleItemUpdated({ orderId, item }) {
      setOrders((prev) =>
        prev.map((o) =>
          o.id === orderId ? { ...o, items: o.items.map((i) => (i.id === item.id ? item : i)) } : o
        )
      );
      refreshSummary();
    }
    function handleClosed({ orderId }) {
      setOrders((prev) => prev.filter((o) => o.id !== orderId));
      refreshSummary();
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

  async function closeOrder(orderId) {
    try {
      await api.closeOrder(orderId);
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <div>
      <div className="topbar">
        <div>Coordinator Dashboard — {user?.name}</div>
        <button onClick={logout}>Log out</button>
      </div>
      <div className="container dashboard-columns">
        <div className="panel">
          <h2>Open tables</h2>
          <table>
            <thead>
              <tr>
                <th>Table</th>
                <th>Items</th>
                <th>Status</th>
                <th>Opened</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => {
                const total = order.items.reduce((s, i) => s + i.quantity, 0);
                const delivered = order.items
                  .filter((i) => i.status === "DELIVERED")
                  .reduce((s, i) => s + i.quantity, 0);
                const allDelivered = delivered === total;
                return (
                  <tr key={order.id}>
                    <td>{order.table.label}</td>
                    <td>
                      {delivered}/{total} delivered
                    </td>
                    <td>
                      <span className={`status-pill ${allDelivered ? "status-DELIVERED" : "status-PREPARING"}`}>
                        {allDelivered ? "Complete" : "In progress"}
                      </span>
                    </td>
                    <td>{new Date(order.openedAt).toLocaleTimeString()}</td>
                    <td>
                      {allDelivered && <button onClick={() => closeOrder(order.id)}>Close table</button>}
                    </td>
                  </tr>
                );
              })}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={5}>No open tables.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <h2>Outstanding by item</h2>
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Ordered</th>
                <th>Delivered</th>
                <th>Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {summary
                .filter((row) => row.outstanding > 0)
                .sort((a, b) => b.outstanding - a.outstanding)
                .map((row) => (
                  <tr key={row.menuItemId}>
                    <td>{row.name}</td>
                    <td>{row.ordered}</td>
                    <td>{row.delivered}</td>
                    <td className="outstanding-count">{row.outstanding}</td>
                  </tr>
                ))}
              {summary.every((row) => row.outstanding === 0) && (
                <tr>
                  <td colSpan={4}>Nothing outstanding right now.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
