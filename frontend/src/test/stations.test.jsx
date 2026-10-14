// Phase 1: Hot / Cold / Bar screens, kitchen mode, and one open bill per table.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, act, waitFor, fireEvent } from "@testing-library/react";
import { makeFakeSocket, renderAs, USERS, order } from "./utils.jsx";

const fake = makeFakeSocket();
vi.mock("../lib/socket", () => ({ getSocket: () => fake, closeSocket: () => {} }));
const SOUND_STATE = vi.hoisted(() => ({ enabled: true, unlocked: true }));
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
    getSettings: vi.fn(),
    getCategories: vi.fn().mockResolvedValue([]),
    getTables: vi.fn(),
    updateItemStatus: vi.fn(),
    createOrder: vi.fn(),
  },
}));

import { playSound } from "../lib/sound";
import { api } from "../lib/api";
import { resetSettings } from "../hooks/useSettings";
import KitchenDisplay from "../pages/KitchenDisplay.jsx";
import OrderEntry from "../pages/OrderEntry.jsx";

const line = (id, name, station, status = "PENDING") => ({
  id, quantity: 1, unitPrice: 10000, taxRate: 0.1, notes: null, status, station, menuItem: { id: `m-${id}`, name },
});
const mixed = () =>
  order({
    items: [line("h", "Sate Ayam", "KITCHEN"), line("c", "Es Campur", "COLD"), line("b", "Kopi Susu", "BAR")],
  });

function setMode(mode) {
  resetSettings();
  api.getSettings.mockResolvedValue({ kitchenMode: mode, locationName: "Test" });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getOpenOrders.mockResolvedValue([]);
  api.getTables.mockResolvedValue([]);
  setMode("ONE");
});

describe("kitchen screens", () => {
  it("one kitchen: hot and cold dishes on the kitchen screen, drinks only on the bar", async () => {
    api.getOpenOrders.mockResolvedValue([mixed()]);
    const k = renderAs(USERS.KITCHEN, <KitchenDisplay board="kitchen" />);
    await screen.findByText(/Sate Ayam/);
    expect(screen.getByText(/Es Campur/)).toBeInTheDocument();
    expect(screen.queryByText(/Kopi Susu/)).toBeNull();
    expect(screen.getAllByText("Hot & Cold Kitchen").length).toBeGreaterThan(0);
    k.unmount();

    renderAs(USERS.KITCHEN, <KitchenDisplay board="bar" />);
    await screen.findByText(/Kopi Susu/);
    expect(screen.queryByText(/Sate Ayam/)).toBeNull();
    expect(screen.queryByText(/Es Campur/)).toBeNull();
  });

  it("split kitchen: hot and cold are separate screens", async () => {
    setMode("SPLIT");
    api.getOpenOrders.mockResolvedValue([mixed()]);
    const k = renderAs(USERS.KITCHEN, <KitchenDisplay board="kitchen" />);
    await screen.findByText(/Sate Ayam/);
    await waitFor(() => expect(screen.queryByText(/Es Campur/)).toBeNull());
    expect(screen.getAllByText("Hot Kitchen").length).toBeGreaterThan(0);
    k.unmount();

    renderAs(USERS.KITCHEN, <KitchenDisplay board="cold" />);
    await screen.findByText(/Es Campur/);
    expect(screen.queryByText(/Sate Ayam/)).toBeNull();
  });

  it("in one-kitchen mode the cold screen points to the kitchen screen", async () => {
    renderAs(USERS.KITCHEN, <KitchenDisplay board="cold" />);
    expect(await screen.findByText(/This restaurant uses one kitchen/)).toBeInTheDocument();
  });

  it("switching the mode in Admin updates an open screen at once", async () => {
    api.getOpenOrders.mockResolvedValue([mixed()]);
    renderAs(USERS.KITCHEN, <KitchenDisplay board="kitchen" />);
    await screen.findByText(/Es Campur/);
    act(() => fake.fire("settings:updated", { kitchenMode: "SPLIT", locationName: "Test" }));
    await waitFor(() => expect(screen.queryByText(/Es Campur/)).toBeNull());
    expect(screen.getByText(/Sate Ayam/)).toBeInTheDocument();
  });

  it("a dish marked READY leaves the board; a ticket with nothing left disappears", async () => {
    const o = order({ items: [line("h1", "Sate Ayam", "KITCHEN", "READY"), line("h2", "Soto", "KITCHEN", "PREPARING")] });
    api.getOpenOrders.mockResolvedValue([o]);
    renderAs(USERS.KITCHEN, <KitchenDisplay board="kitchen" />);
    await screen.findByText(/Soto/);
    expect(screen.queryByText(/Sate Ayam/)).toBeNull();
    act(() => fake.fire("order-item:updated", { orderId: o.id, tableLabel: "Table 1", item: { ...o.items[1], status: "READY" } }));
    await waitFor(() => expect(screen.queryByText(/Soto/)).toBeNull());
    expect(screen.getByText(/Nothing to make right now/)).toBeInTheDocument();
  });

  it("each screen rings only for its own dishes", async () => {
    const k = renderAs(USERS.KITCHEN, <KitchenDisplay board="kitchen" />);
    await waitFor(() => expect(api.getOpenOrders).toHaveBeenCalled());
    act(() => fake.fire("order:created", order({ id: "o2", items: [line("b1", "Kopi Susu", "BAR")] })));
    expect(playSound).not.toHaveBeenCalled(); // drinks only: not the kitchen's job
    k.unmount();

    renderAs(USERS.KITCHEN, <KitchenDisplay board="bar" />);
    await waitFor(() => expect(api.getOpenOrders).toHaveBeenCalledTimes(2));
    act(() => fake.fire("order:created", order({ id: "o3", items: [line("b2", "Kopi Susu", "BAR")] })));
    expect(playSound).toHaveBeenCalledWith("newOrder");
    expect(await screen.findByText(/New order: Table 1 — 1x Kopi Susu/)).toBeInTheDocument();
  });

  it("a second round rings only for the newly added dishes of this station", async () => {
    const o = order({ items: [line("h1", "Sate Ayam", "KITCHEN")] });
    api.getOpenOrders.mockResolvedValue([o]);
    renderAs(USERS.KITCHEN, <KitchenDisplay board="kitchen" />);
    await screen.findByText(/Sate Ayam/);

    // a round with only a drink: the kitchen stays quiet
    const withDrink = { ...o, items: [...o.items, line("b1", "Kopi Susu", "BAR")] };
    act(() => fake.fire("order:items-added", { order: withDrink, addedItemIds: ["b1"] }));
    expect(playSound).not.toHaveBeenCalled();

    // a round with a hot dish: ring, and it appears on the same ticket
    const withSoto = { ...withDrink, items: [...withDrink.items, line("h2", "Soto", "KITCHEN")] };
    act(() => fake.fire("order:items-added", { order: withSoto, addedItemIds: ["h2"] }));
    expect(playSound).toHaveBeenCalledWith("newOrder");
    expect(await screen.findByText(/Added to Table 1: 1x Soto/)).toBeInTheDocument();
  });
});

describe("one open bill per table (order entry)", () => {
  it("a table with an open bill says so, and sending adds to it", async () => {
    api.getTables.mockResolvedValue([{ id: "t1", label: "Table 1" }, { id: "t2", label: "Table 2" }]);
    api.getCategories.mockResolvedValue([{ id: "c1", name: "Mains", menuItems: [{ id: "m1", name: "Nasi Goreng", price: 45000 }] }]);
    api.getOpenOrders.mockResolvedValue([order()]); // Table 1 (id t1) is open
    api.createOrder.mockResolvedValue({ ...order(), added: true });
    renderAs(USERS.FOH, <OrderEntry />);

    expect(await screen.findByRole("option", { name: "Table 1 (open bill)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Table 2" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add more" }));
    expect(screen.getByRole("combobox")).toHaveValue("t1");
    fireEvent.click(await screen.findByText("Nasi Goreng", { selector: ".name" }));
    expect(screen.getByText("Add to Table 1's open bill")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add to bill" }));
    await waitFor(() => expect(api.createOrder).toHaveBeenCalledWith("t1", [{ menuItemId: "m1", quantity: 1 }]));
    expect(await screen.findByText(/Added to Table 1's bill/)).toBeInTheDocument();
  });
});
