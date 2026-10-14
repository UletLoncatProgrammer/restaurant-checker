import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../lib/api";
import { playSound } from "../lib/sound";
import { useLiveOrders } from "../hooks/useLiveOrders";
import { useAlerts } from "../hooks/useAlerts";
import { useWakeLock } from "../hooks/useWakeLock";
import { useSettings } from "../hooks/useSettings";
import { boardStations, boardTitle, stationOf } from "../lib/stations";
import Topbar from "../components/Topbar.jsx";
import AlertBanner from "../components/AlertBanner.jsx";
import LineExtras from "../components/LineExtras.jsx";

const NEXT_STATUS = {
  PENDING: "PREPARING",
  PREPARING: "READY",
};
const TODO = ["PENDING", "PREPARING"];
const VOID_SHOWN_MS = 60000; // a voided dish stays visible (crossed out) for a minute so the cook notices

// One screen per station: board="kitchen" (hot, or hot + cold in one-kitchen mode),
// board="cold" (cold kitchen, only in split mode) or board="bar".
// A ticket shows only the dishes this station still has to make; once a dish is
// marked READY it leaves the board (the waiter is told it is ready).
// New dishes ring; a void rings differently so nobody makes a cancelled dish.
export default function KitchenDisplay({ board = "kitchen" }) {
  const { user } = useAuth();
  const { kitchenMode } = useSettings();
  const { alerts, push, dismiss } = useAlerts();
  useWakeLock();

  const stations = boardStations(board, kitchenMode);
  const mine = (item) => stations.includes(stationOf(item));
  const describe = (items) => items.map((i) => `${i.quantity}x ${i.menuItem.name}`).join(", ");
  const visibleOrderIds = useRef(new Set()); // tickets on screen right now (for whole-order voids)
  const [recentVoids, setRecentVoids] = useState(() => new Set()); // dish lines voided in the last minute
  function showVoid(itemId) {
    setRecentVoids((prev) => new Set(prev).add(itemId));
    setTimeout(() => setRecentVoids((prev) => { const n = new Set(prev); n.delete(itemId); return n; }), VOID_SHOWN_MS);
  }

  const { orders } = useLiveOrders(user, {
    onOrderCreated: (order) => {
      const forUs = order.items.filter(mine);
      if (forUs.length === 0) return; // e.g. only drinks: the bar's job, not ours
      playSound("newOrder");
      push(`New order: ${order.table.label} — ${describe(forUs)}`, "new");
    },
    onItemsAdded: ({ order, addedItemIds }) => {
      const forUs = order.items.filter((i) => addedItemIds.includes(i.id) && mine(i));
      if (forUs.length === 0) return;
      playSound("newOrder");
      push(`Added to ${order.table.label}: ${describe(forUs)}`, "new");
    },
    onItemVoided: ({ tableLabel, item }) => {
      if (!mine(item)) return;
      showVoid(item.id);
      playSound("void");
      push(`VOIDED — ${tableLabel}: ${item.quantity}x ${item.menuItem.name}. Stop making it.`, "void");
    },
    onOrderVoided: ({ orderId, tableLabel }) => {
      if (!visibleOrderIds.current.has(orderId)) return;
      playSound("void");
      push(`VOIDED — whole order for ${tableLabel}. Stop making it.`, "void");
    },
  });

  async function advance(orderId, item) {
    const next = NEXT_STATUS[item.status];
    if (!next) return;
    try {
      // The server pushes the change back over the socket to every screen
      // (including this one), so there is no local optimistic update to drift.
      await api.updateItemStatus(orderId, item.id, next);
    } catch (e) {
      push(e.message, "void");
    }
  }

  const title = boardTitle(board, kitchenMode);

  // In one-kitchen mode the cold dishes are on the Hot & Cold Kitchen screen.
  if (board === "cold" && kitchenMode !== "SPLIT") {
    return (
      <div>
        <Topbar title="Cold Kitchen" />
        <div className="container">
          <p>
            This restaurant uses one kitchen: cold dishes are shown on the <Link to="/kitchen">Hot &amp; Cold Kitchen</Link> screen.
            An admin can split them in Admin &gt; Kitchen.
          </p>
        </div>
      </div>
    );
  }

  // Tickets with something still to make here (or a dish voided in the last minute),
  // showing only this station's lines.
  const tickets = orders
    .map((order) => ({
      order,
      lines: order.items.filter((i) => mine(i) && (TODO.includes(i.status) || i.status === "CANCELLED")),
    }))
    .filter((t) => t.lines.some((i) => TODO.includes(i.status) || recentVoids.has(i.id)))
    .map((t) => ({ ...t, lines: t.lines.filter((i) => TODO.includes(i.status) || recentVoids.has(i.id)) }));
  visibleOrderIds.current = new Set(tickets.map((t) => t.order.id));

  return (
    <div>
      <Topbar title={title} />
      <AlertBanner alerts={alerts} onDismiss={dismiss} />
      <div className="container">
        <div className="kds-board">
          {tickets.map(({ order, lines }) => (
            <div key={order.id} className="ticket">
              <div className="ticket-header">
                <span>{order.table.label}{order.customer?.name ? ` · ${order.customer.name}` : ""}</span>
                <span>{new Date(order.openedAt).toLocaleTimeString()}</span>
              </div>
              {lines.map((item) => (
                <div key={item.id} className={`ticket-item ${item.status === "CANCELLED" ? "voided" : ""}`}>
                  <span>
                    {item.quantity}x {item.menuItem.name}
                    <LineExtras item={item} />
                    {item.status === "CANCELLED" && <em style={{ display: "block", fontSize: "0.8rem" }}>VOIDED — do not make</em>}
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
          ))}
          {tickets.length === 0 && <p>Nothing to make right now.</p>}
        </div>
      </div>
    </div>
  );
}
