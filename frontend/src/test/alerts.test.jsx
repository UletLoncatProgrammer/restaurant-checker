import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, act, waitFor } from "@testing-library/react";
import { makeFakeSocket, renderAs, USERS, order } from "./utils.jsx";

const fake = makeFakeSocket();
vi.mock("../lib/socket", () => ({ getSocket: () => fake, closeSocket: () => {} }));
const SOUND_STATE = vi.hoisted(() => ({ enabled: true, unlocked: true })); // stable object: useSyncExternalStore needs a cached snapshot
vi.mock("../lib/sound", () => ({
  playSound: vi.fn().mockResolvedValue(true),
  unlockAudio: vi.fn(),
  setSoundEnabled: vi.fn(),
  subscribe: () => () => {},
  getSoundState: () => SOUND_STATE,
}));
vi.mock("../lib/api", () => ({
  getToken: () => "t",
  api: {
    getOpenOrders: vi.fn(),
    getCategories: vi.fn().mockResolvedValue([]),
    getTables: vi.fn().mockResolvedValue([]),
    updateItemStatus: vi.fn(),
  },
}));

import { playSound } from "../lib/sound";
import { api } from "../lib/api";
import KitchenDisplay from "../pages/KitchenDisplay.jsx";
import OrderEntry from "../pages/OrderEntry.jsx";

beforeEach(() => {
  vi.clearAllMocks();
  api.getOpenOrders.mockResolvedValue([]);
});

const readyEvent = (openedBy) => ({
  orderId: "o1",
  orderOpenedById: openedBy,
  tableLabel: "Table 1",
  item: { id: "i1", quantity: 2, status: "READY", menuItem: { id: "m1", name: "Nasi Goreng" } },
});

describe("kitchen alerts", () => {
  it("rings and shows a banner when a new order arrives", async () => {
    renderAs(USERS.KITCHEN, <KitchenDisplay />);
    await waitFor(() => expect(api.getOpenOrders).toHaveBeenCalled());
    act(() => fake.fire("order:created", order()));
    expect(playSound).toHaveBeenCalledWith("newOrder");
    expect(await screen.findByText(/New order: Table 1 — 2x Nasi Goreng/)).toBeInTheDocument(); // banner names the dishes
    expect(screen.getAllByText(/2x Nasi Goreng/)).toHaveLength(2); // banner + the ticket line
  });

  it("rings the void sound and tells the cook to stop when an item is voided", async () => {
    api.getOpenOrders.mockResolvedValue([order()]);
    renderAs(USERS.KITCHEN, <KitchenDisplay />);
    await screen.findByText(/2x Nasi Goreng/);
    act(() =>
      fake.fire("order-item:voided", {
        orderId: "o1", tableLabel: "Table 1", orderCancelled: false,
        item: { ...order().items[0], status: "CANCELLED" },
      })
    );
    expect(playSound).toHaveBeenCalledWith("void");
    expect(await screen.findByText(/Stop making it/)).toBeInTheDocument();
    expect(screen.getByText(/VOIDED — do not make/)).toBeInTheDocument();
  });

  it("does not ring for ordinary status updates", async () => {
    renderAs(USERS.KITCHEN, <KitchenDisplay />);
    await waitFor(() => expect(api.getOpenOrders).toHaveBeenCalled());
    act(() => fake.fire("order-item:updated", readyEvent("u-foh")));
    expect(playSound).not.toHaveBeenCalled();
  });
});

describe("waiter alerts", () => {
  it("a waiter hears READY for their own table", async () => {
    renderAs(USERS.FOH, <OrderEntry />);
    await waitFor(() => expect(api.getOpenOrders).toHaveBeenCalled());
    act(() => fake.fire("order-item:updated", readyEvent("u-foh")));
    expect(playSound).toHaveBeenCalledWith("ready");
    expect(await screen.findByText(/Ready to serve — Table 1/)).toBeInTheDocument();
  });

  it("a waiter does NOT hear READY for a colleague's table", async () => {
    renderAs(USERS.FOH2, <OrderEntry />);
    await waitFor(() => expect(api.getOpenOrders).toHaveBeenCalled());
    act(() => fake.fire("order-item:updated", readyEvent("u-foh")));
    expect(playSound).not.toHaveBeenCalled();
  });

  it("a coordinator hears READY for every table", async () => {
    renderAs(USERS.COORDINATOR, <OrderEntry />);
    await waitFor(() => expect(api.getOpenOrders).toHaveBeenCalled());
    act(() => fake.fire("order-item:updated", readyEvent("u-foh")));
    expect(playSound).toHaveBeenCalledWith("ready");
  });

  it("does not ring for non-READY transitions", async () => {
    renderAs(USERS.FOH, <OrderEntry />);
    await waitFor(() => expect(api.getOpenOrders).toHaveBeenCalled());
    const e = readyEvent("u-foh");
    e.item.status = "PREPARING";
    act(() => fake.fire("order-item:updated", e));
    expect(playSound).not.toHaveBeenCalled();
  });
});
