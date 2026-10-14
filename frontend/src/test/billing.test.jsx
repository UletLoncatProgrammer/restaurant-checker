// Billing screens: member discount at the POS, Admin > Billing and Admin > Members.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { renderAs, USERS, order } from "./utils.jsx";

vi.mock("../lib/socket", () => ({ getSocket: () => ({ on() {}, off() {} }), closeSocket() {} }));
const SOUND_STATE = vi.hoisted(() => ({ enabled: false, unlocked: true }));
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
    updateSettings: vi.fn(),
    getBill: vi.fn(),
    pay: vi.fn(),
    lookupMember: vi.fn(),
    getMembers: vi.fn(),
    createMember: vi.fn(),
    updateMember: vi.fn(),
    getUsers: vi.fn().mockResolvedValue([]),
    getRoles: vi.fn().mockResolvedValue([]),
    getPermissions: vi.fn().mockResolvedValue([]),
  },
}));

import { api } from "../lib/api";
import { resetSettings } from "../hooks/useSettings";
import Pos from "../pages/Pos.jsx";
import App from "../App.jsx";

const served = () => order({ items: [{ id: "i1", quantity: 2, unitPrice: 50000, status: "DELIVERED", station: "KITCHEN", menuItem: { id: "m1", name: "Nasi Goreng" } }] });
const bill = (over = {}) => ({
  orderId: "o1", payable: true, undelivered: [],
  lines: [{ name: "Nasi Goreng", quantity: 2, unitPrice: 50000, lineSubtotal: 100000, delivered: true }],
  subtotal: 100000, discount: 0, discountPercent: 0, member: null,
  service: 5000, servicePercent: 5, taxLabel: "PB1", taxPercent: 10, tax: 10500, total: 115500,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetSettings();
  api.getOpenOrders.mockResolvedValue([served()]);
  api.getSettings.mockResolvedValue({ kitchenMode: "ONE", billing: { taxLabel: "PB1", taxPercent: 10, servicePercent: 5, taxOnService: true } });
});

describe("POS: member discount, service charge and tax", () => {
  it("shows the breakdown, applies a member found by phone, and pays with the member", async () => {
    api.getBill.mockImplementation((id, memberId) =>
      Promise.resolve(memberId
        ? bill({ member: { id: "mem1", name: "Sari" }, discount: 10000, discountPercent: 10, service: 4500, tax: 9450, total: 103950 })
        : bill()));
    api.lookupMember.mockResolvedValue({ id: "mem1", name: "Sari", discountPercent: 10 });
    api.pay.mockResolvedValue({
      id: "p1", receiptNo: "7", locationName: "Test", tableLabel: "Table 1", cashierName: "Wati", paidAt: "2026-10-15T05:00:00Z",
      method: "CARD", status: "PAID", lines: bill().lines, subtotal: 100000, discount: 10000, memberName: "Sari", discountPercent: 10,
      service: 4500, servicePercent: 5, taxLabel: "PB1", taxPercent: 10, tax: 9450, total: 103950, amountTendered: null, changeGiven: null,
    });
    renderAs(USERS.FOH, <Pos />, "/pos?order=o1");

    expect(await screen.findByText("Service charge (5%)")).toBeInTheDocument();
    expect(screen.getByText("PB1 (10%)")).toBeInTheDocument();
    expect(screen.getByText("Rp 115.500")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Member phone number"), { target: { value: "0812 3456 789" } });
    fireEvent.click(screen.getByRole("button", { name: "Find member" }));
    await waitFor(() => expect(api.lookupMember).toHaveBeenCalledWith("0812 3456 789"));
    expect(await screen.findByText(/Member discount — Sari \(10%\)/)).toBeInTheDocument();
    expect(api.getBill).toHaveBeenLastCalledWith("o1", "mem1");

    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    fireEvent.click(screen.getByRole("button", { name: /Charge/ }));
    await waitFor(() => expect(api.pay).toHaveBeenCalledWith("o1", "CARD", undefined, "mem1"));
    expect(await screen.findByText(/Receipt #7/)).toBeInTheDocument();
    expect(screen.getByText(/Member discount — Sari/)).toBeInTheDocument();
  });

  it("an unknown phone shows the server's message and no discount", async () => {
    api.getBill.mockResolvedValue(bill());
    api.lookupMember.mockRejectedValue(new Error("No active member with that phone number"));
    renderAs(USERS.FOH, <Pos />, "/pos?order=o1");
    await screen.findByText("Service charge (5%)");
    fireEvent.change(screen.getByLabelText("Member phone number"), { target: { value: "0899999999" } });
    fireEvent.click(screen.getByRole("button", { name: "Find member" }));
    expect(await screen.findByText("No active member with that phone number")).toBeInTheDocument();
    expect(screen.queryByText(/Member discount/)).toBeNull();
  });
});

describe("POS: phone not found", () => {
  it("a supervisor can add the member right there and the discount is applied", async () => {
    api.getBill.mockImplementation((id, memberId) =>
      Promise.resolve(memberId ? bill({ member: { id: "m2", name: "Budi" }, discount: 15000, discountPercent: 15, total: 97750 }) : bill()));
    api.lookupMember
      .mockRejectedValueOnce(new Error("No active member with that phone number"))
      .mockResolvedValueOnce({ id: "m2", name: "Budi", discountPercent: 15 });
    api.createMember.mockResolvedValue({ id: "m2", name: "Budi" });
    renderAs(USERS.SUPERVISOR, <Pos />, "/pos?order=o1");
    await screen.findByText("Service charge (5%)");
    fireEvent.change(screen.getByLabelText("Member phone number"), { target: { value: "0877 1111 222" } });
    fireEvent.click(screen.getByRole("button", { name: "Find member" }));
    fireEvent.change(await screen.findByLabelText("New member name"), { target: { value: "Budi" } });
    fireEvent.change(screen.getByLabelText("New member discount percent"), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "Add member & apply" }));
    await waitFor(() =>
      expect(api.createMember).toHaveBeenCalledWith({ name: "Budi", phone: "0877 1111 222", discountPercent: 15, note: "" }));
    expect(await screen.findByText(/Member discount — Budi \(15%\)/)).toBeInTheDocument();
    expect(api.getBill).toHaveBeenLastCalledWith("o1", "m2");
  });

  it("a waiter is told who can add members and gets no add form", async () => {
    api.getBill.mockResolvedValue(bill());
    api.lookupMember.mockRejectedValue(new Error("No active member with that phone number"));
    renderAs(USERS.FOH, <Pos />, "/pos?order=o1");
    await screen.findByText("Service charge (5%)");
    fireEvent.change(screen.getByLabelText("Member phone number"), { target: { value: "0877 1111 222" } });
    fireEvent.click(screen.getByRole("button", { name: "Find member" }));
    expect(await screen.findByText(/Ask an Admin, Coordinator or Supervisor/)).toBeInTheDocument();
    expect(screen.queryByLabelText("New member name")).toBeNull();
  });
});

describe("Admin: billing and members", () => {
  const ADMIN = { id: "u-a", name: "Boss", role: "ADMIN", locationId: "loc" };

  it("Billing saves tax name, rates and the tax-on-service choice", async () => {
    api.updateSettings.mockResolvedValue({});
    renderAs(ADMIN, <App />, "/admin");
    fireEvent.click(await screen.findByRole("button", { name: "Billing" }));
    const svc = await screen.findByLabelText("Service charge percent");
    fireEvent.change(svc, { target: { value: "7.5" } });
    fireEvent.click(screen.getByLabelText(/Charge tax on the service charge too/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({ taxLabel: "PB1", taxPercent: 10, servicePercent: 7.5, taxOnService: false }));
  });

  it("a coordinator sees Members but not Billing; adding a member sends the details", async () => {
    api.getMembers.mockResolvedValue([]);
    api.createMember.mockResolvedValue({ id: "m9", name: "Sari" });
    renderAs(USERS.COORDINATOR, <App />, "/admin");
    expect(await screen.findByRole("button", { name: "Members" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Billing" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    fireEvent.change(await screen.findByLabelText("Member name"), { target: { value: "Sari" } });
    fireEvent.change(screen.getByLabelText("Member phone"), { target: { value: "0812345678" } });
    fireEvent.change(screen.getByLabelText("Discount percent"), { target: { value: "12.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    await waitFor(() =>
      expect(api.createMember).toHaveBeenCalledWith({ name: "Sari", phone: "0812345678", discountPercent: 12.5, note: "" }));
    expect(await screen.findByText("Member Sari added")).toBeInTheDocument();
  });
});
