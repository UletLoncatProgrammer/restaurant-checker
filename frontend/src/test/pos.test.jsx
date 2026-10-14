import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { makeFakeSocket, renderAs, USERS, order } from "./utils.jsx";

const fake = makeFakeSocket();
vi.mock("../lib/socket", () => ({ getSocket: () => fake, closeSocket: () => {} }));
const SOUND_STATE = vi.hoisted(() => ({ enabled: true, unlocked: true })); // stable object: useSyncExternalStore needs a cached snapshot
vi.mock("../lib/sound", () => ({
  playSound: vi.fn(), unlockAudio: vi.fn(), setSoundEnabled: vi.fn(),
  subscribe: () => () => {}, getSoundState: () => SOUND_STATE,
}));
vi.mock("../lib/api", () => ({
  getToken: () => "t",
  api: { getOpenOrders: vi.fn(), getBill: vi.fn(), pay: vi.fn() },
}));

import { api } from "../lib/api";
import Pos from "../pages/Pos.jsx";

const served = order({ items: [{ ...order().items[0], status: "DELIVERED" }] });
const bill = {
  orderId: "o1", tableLabel: "Table 1", payable: true, undelivered: [],
  lines: [{ name: "Nasi Goreng", quantity: 2, unitPrice: 45000, lineSubtotal: 90000, lineTax: 9000, delivered: true }],
  subtotal: 90000, tax: 9000, total: 99000,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getOpenOrders.mockResolvedValue([served]);
  api.getBill.mockResolvedValue(bill);
});

describe("POS", () => {
  it("shows the server bill, blocks short cash, charges and shows the receipt", async () => {
    api.pay.mockResolvedValue({
      receiptNo: "12", locationName: "Resto", tableLabel: "Table 1", cashierName: "Wati", paidAt: "2026-10-08T05:00:00Z",
      method: "CASH", status: "PAID", subtotal: 90000, tax: 9000, total: 99000, amountTendered: 100000, changeGiven: 1000,
      lines: [{ name: "Nasi Goreng", quantity: 2, lineSubtotal: 90000 }],
    });
    renderAs(USERS.FOH, <Pos />);
    fireEvent.click(await screen.findByText("Ready to pay"));
    await screen.findByText("Rp 99.000", { selector: "td" });

    const charge = screen.getByRole("button", { name: /Charge/ });
    expect(charge).toBeDisabled(); // cash selected, nothing tendered
    const input = screen.getByLabelText(/Cash received/);
    fireEvent.change(input, { target: { value: "50000" } });
    expect(charge).toBeDisabled();
    expect(screen.getByText(/Short by Rp 49\.000/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "100000" } });
    expect(screen.getByText(/Change: Rp 1\.000/)).toBeInTheDocument();
    fireEvent.click(charge);

    await waitFor(() => expect(api.pay).toHaveBeenCalledWith("o1", "CASH", 100000));
    expect(await screen.findByText(/Receipt #12/)).toBeInTheDocument();
    expect(screen.getByText("Print receipt")).toBeInTheDocument();
  });

  it("does not offer payment for a table that is not fully served", async () => {
    api.getOpenOrders.mockResolvedValue([order()]); // PENDING
    api.getBill.mockResolvedValue({ ...bill, payable: false, undelivered: ["2x Nasi Goreng"], lines: [{ ...bill.lines[0], delivered: false }] });
    renderAs(USERS.FOH, <Pos />);
    fireEvent.click(await screen.findByText("0/1 served"));
    expect(await screen.findByText(/Not served yet: 2x Nasi Goreng/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Card"));
    expect(screen.getByRole("button", { name: /Charge/ })).toBeDisabled();
  });

  it("surfaces a server rejection (e.g. already paid) instead of a receipt", async () => {
    api.pay.mockRejectedValue(new Error("This order has already been paid"));
    renderAs(USERS.FOH, <Pos />);
    fireEvent.click(await screen.findByText("Ready to pay"));
    await screen.findByText("Rp 99.000", { selector: "td" });
    fireEvent.click(screen.getByText("Card"));
    fireEvent.click(screen.getByRole("button", { name: /Charge/ }));
    expect(await screen.findByText(/already been paid/)).toBeInTheDocument();
    expect(screen.queryByText(/Receipt #/)).toBeNull();
  });
});
