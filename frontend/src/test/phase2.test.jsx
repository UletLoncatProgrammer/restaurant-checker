// Phase 2 screens: notes / spice / customer on orders, kitchen history, menu editor.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
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
    getSettings: vi.fn().mockResolvedValue({ kitchenMode: "ONE" }),
    getCategories: vi.fn(),
    getTables: vi.fn(),
    createOrder: vi.fn(),
    getHistory: vi.fn(),
    getOutstandingSummary: vi.fn().mockResolvedValue([]),
    updateMenuItem: vi.fn().mockResolvedValue({}),
    updateCategory: vi.fn().mockResolvedValue({}),
  },
}));

import { api } from "../lib/api";
import OrderEntry from "../pages/OrderEntry.jsx";
import KitchenDisplay from "../pages/KitchenDisplay.jsx";
import CoordinatorDashboard from "../pages/CoordinatorDashboard.jsx";
import App from "../App.jsx";

const MENU = [
  { id: "c1", name: "Mains", noteHint: "e.g. no onion", menuItems: [{ id: "m1", name: "Nasi Goreng", price: 45000, spiceOption: true, station: "KITCHEN" }] },
  { id: "c2", name: "Drinks", noteHint: "", menuItems: [{ id: "m2", name: "Es Teh", price: 10000, spiceOption: false, station: "BAR" }] },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.getOpenOrders.mockResolvedValue([]);
  api.getTables.mockResolvedValue([{ id: "t1", label: "Table 1" }]);
  api.getCategories.mockResolvedValue(MENU);
  api.createOrder.mockResolvedValue({ ...order(), added: false });
});

describe("order entry: notes, spice and customer", () => {
  it("sends separate lines for different notes/spice, plus the customer", async () => {
    renderAs(USERS.FOH, <OrderEntry />);
    await screen.findByText("Nasi Goreng", { selector: ".name" });
    fireEvent.change(screen.getByRole("combobox", { name: /Table/ }), { target: { value: "t1" } });

    const dish = screen.getByText("Nasi Goreng", { selector: ".name" });
    fireEvent.click(dish);
    // the category's hint shows as the note placeholder; spice choice only for this dish
    const note = screen.getByLabelText("Note for Nasi Goreng");
    expect(note).toHaveAttribute("placeholder", "e.g. no onion");
    fireEvent.change(screen.getByLabelText("Spice for Nasi Goreng"), { target: { value: "SPICY" } });
    fireEvent.change(note, { target: { value: "extra egg" } });
    // tapping again starts a new plain line (the first one has a note now)
    fireEvent.click(dish);
    fireEvent.click(screen.getByText("Es Teh", { selector: ".name" }));
    expect(screen.queryByLabelText("Spice for Es Teh")).toBeNull();

    fireEvent.change(screen.getByLabelText("Customer name"), { target: { value: "Budi" } });
    fireEvent.change(screen.getByLabelText("Customer phone"), { target: { value: "0812 3456" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to kitchen" }));

    await waitFor(() => expect(api.createOrder).toHaveBeenCalled());
    const [tableId, items, customer] = api.createOrder.mock.calls[0];
    expect(tableId).toBe("t1");
    expect(items).toEqual([
      { menuItemId: "m1", quantity: 1, notes: "extra egg", spice: "SPICY" },
      { menuItemId: "m1", quantity: 1 },
      { menuItemId: "m2", quantity: 1 },
    ]);
    expect(customer).toEqual({ name: "Budi", phone: "0812 3456" });
  });

  it("the kitchen ticket shows spice, note and customer name", async () => {
    api.getOpenOrders.mockResolvedValue([
      order({
        customer: { name: "Budi", phone: null },
        items: [{ id: "i1", quantity: 1, status: "PENDING", station: "KITCHEN", spice: "SPICY", notes: "extra egg", menuItem: { id: "m1", name: "Nasi Goreng" } }],
      }),
    ]);
    renderAs(USERS.KITCHEN, <KitchenDisplay board="kitchen" />);
    expect(await screen.findByText(/Table 1 · Budi/)).toBeInTheDocument();
    expect(screen.getByText("Spicy")).toBeInTheDocument();
    expect(screen.getByText(/extra egg/)).toBeInTheDocument();
  });
});

describe("kitchen history tab", () => {
  it("lists finished dishes with who made and served them, and filters by station", async () => {
    api.getHistory.mockResolvedValue({
      date: "2026-10-14",
      station: "ALL",
      stats: { lines: 2, units: 3, avgMinutes: 7, waitingToServe: 1 },
      lines: [
        { id: "a", table: "T1", customerName: "Budi", item: "Nasi Goreng", quantity: 2, notes: null, spice: "SPICY", station: "KITCHEN", status: "DELIVERED", orderedAt: "2026-10-14T05:00:00Z", readyAt: "2026-10-14T05:07:00Z", minutes: 7, readyBy: "Cook Ani", deliveredAt: "2026-10-14T05:09:00Z", deliveredBy: "Wati" },
        { id: "b", table: "T2", customerName: null, item: "Es Teh", quantity: 1, notes: null, spice: null, station: "BAR", status: "READY", orderedAt: "2026-10-14T05:00:00Z", readyAt: "2026-10-14T05:07:00Z", minutes: 7, readyBy: "Bar Joko", deliveredAt: null, deliveredBy: null },
      ],
    });
    renderAs(USERS.SUPERVISOR, <CoordinatorDashboard />);
    fireEvent.click(await screen.findByRole("tab", { name: "Kitchen history" }));
    expect(await screen.findByText("Cook Ani")).toBeInTheDocument();
    expect(screen.getByText(/· Wati/)).toBeInTheDocument();
    expect(screen.getByText("Waiting to be served", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("7 min", { selector: ".stat-value" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Bar" }));
    await waitFor(() => expect(api.getHistory).toHaveBeenLastCalledWith(undefined, "BAR"));
  });
});

describe("menu editor", () => {
  const ADMIN = { id: "u-a", name: "Boss", role: "ADMIN", locationId: "loc" };
  it("edits price, spice choice, note hint, moves a category, and switches a dish back on", async () => {
    api.getCategories.mockResolvedValue([
      { ...MENU[0], menuItems: [...MENU[0].menuItems, { id: "m3", name: "Old Dish", price: 1000, station: "KITCHEN", active: false }] },
    ]);
    renderAs(ADMIN, <App />, "/admin");
    fireEvent.click(await screen.findByRole("button", { name: "Menu" }));
    await waitFor(() => expect(api.getCategories).toHaveBeenCalledWith(true));

    const price = await screen.findByLabelText("Price of Nasi Goreng");
    fireEvent.change(price, { target: { value: "47000" } });
    fireEvent.blur(price);
    await waitFor(() => expect(api.updateMenuItem).toHaveBeenCalledWith("m1", { price: 47000 }));

    fireEvent.click(screen.getByLabelText("Spicy choice for Nasi Goreng"));
    await waitFor(() => expect(api.updateMenuItem).toHaveBeenCalledWith("m1", { spiceOption: false }));

    const hint = screen.getByLabelText("Note hint for Mains");
    fireEvent.change(hint, { target: { value: "less salt" } });
    fireEvent.blur(hint);
    await waitFor(() => expect(api.updateCategory).toHaveBeenCalledWith("c1", { noteHint: "less salt" }));

    fireEvent.change(screen.getByLabelText("Where all dishes of Mains are made"), { target: { value: "COLD" } });
    await waitFor(() => expect(api.updateCategory).toHaveBeenCalledWith("c1", { station: "COLD" }));

    fireEvent.click(screen.getByRole("button", { name: "Switch on" }));
    await waitFor(() => expect(api.updateMenuItem).toHaveBeenCalledWith("m3", { active: true }));
  });
});
