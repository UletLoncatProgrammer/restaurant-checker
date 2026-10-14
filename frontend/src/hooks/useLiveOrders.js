import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { getSocket } from "../lib/socket";

// Keeps a list of open orders in sync with the server over the socket, and
// reports interesting events to the page (for sounds/banners) via `handlers`:
//   onOrderCreated(order)
//   onItemsAdded({ order, addedItemIds, addedById })   (a new round on a table's open bill)
//   onItemUpdated({ orderId, orderOpenedById, tableLabel, item })
//   onItemVoided({ orderId, tableLabel, item, orderCancelled })
//   onOrderVoided({ orderId, tableLabel, wasPaid })
// Handlers are read through a ref so changing them never re-subscribes.
export function useLiveOrders(user, handlers = {}) {
  const [orders, setOrders] = useState([]);
  const ref = useRef(handlers);
  ref.current = handlers;

  const load = useCallback(() => {
    api.getOpenOrders().then(setOrders).catch(console.error);
  }, []);

  useEffect(() => {
    const socket = getSocket();
    const replaceItem = (orderId, item) => (prev) =>
      prev.map((o) => (o.id === orderId ? { ...o, items: o.items.map((i) => (i.id === item.id ? item : i)) } : o));
    const drop = (orderId) => (prev) => prev.filter((o) => o.id !== orderId);

    const onCreated = (order) => {
      setOrders((prev) => (prev.some((o) => o.id === order.id) ? prev : [...prev, order]));
      ref.current.onOrderCreated?.(order);
    };
    const onItemsAdded = (e) => {
      // replace our copy of the order with the server's (it now has the new lines)
      setOrders((prev) => (prev.some((o) => o.id === e.order.id) ? prev.map((o) => (o.id === e.order.id ? e.order : o)) : [...prev, e.order]));
      ref.current.onItemsAdded?.(e);
    };
    const onItem = (e) => {
      setOrders(replaceItem(e.orderId, e.item));
      ref.current.onItemUpdated?.(e);
    };
    const onItemVoided = (e) => {
      setOrders(e.orderCancelled ? drop(e.orderId) : replaceItem(e.orderId, e.item));
      ref.current.onItemVoided?.(e);
    };
    const onClosed = ({ orderId }) => setOrders(drop(orderId));
    const onVoided = (e) => {
      setOrders(drop(e.orderId));
      ref.current.onOrderVoided?.(e);
    };

    socket.on("order:created", onCreated);
    socket.on("order:items-added", onItemsAdded);
    socket.on("order-item:updated", onItem);
    socket.on("order-item:voided", onItemVoided);
    socket.on("order:closed", onClosed);
    socket.on("order:voided", onVoided);
    // (Re)connect: refetch, so anything missed while the tablet was asleep or
    // offline shows up. Also covers the very first connect.
    socket.on("connect", load);
    load();

    return () => {
      socket.off("order:created", onCreated);
      socket.off("order:items-added", onItemsAdded);
      socket.off("order-item:updated", onItem);
      socket.off("order-item:voided", onItemVoided);
      socket.off("order:closed", onClosed);
      socket.off("order:voided", onVoided);
      socket.off("connect", load);
    };
  }, [user.id, load]);

  return { orders, reload: load };
}
