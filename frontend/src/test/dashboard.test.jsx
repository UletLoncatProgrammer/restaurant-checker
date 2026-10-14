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
  api: {
    getOpenOrders: vi.fn(),
    getOutstandingSummary: vi.fn().mockResolvedValue([]),
    voidOrder: vi.fn().mockResolvedValue({}),
    voidItem: vi.fn().mockResolvedValue({}),
    getTransactions: vi.fn(),
    downloadReport: vi.fn().mockResolvedValue("report-x-week-2026-10-05.xlsx"),
  },
}));

import { api } from "../lib/api";
import CoordinatorDashboard from "../pages/CoordinatorDashboard.jsx";

beforeEach(() => {
  vi.clearAllMocks();
  api.getOpenOrders.mockResolvedValue([order()]);
  api.getOutstandingSummary.mockResolvedValue([]);
  api.getTransactions.mockResolvedValue({
    date: "2026-10-08",
    totals: { paidCount: 1, subtotal: 90000, tax: 9000, total: 99000, voidedCount: 0, voidedTotal: 0 },
    payments: [{ id: "p1", receiptNo: "7", orderId: "o9", tableLabel: "Table 9", paidAt: "2026-10-08T05:00:00Z", cashier: "Wati", method: "CASH", subtotal: 90000, tax: 9000, total: 99000, status: "PAID", items: "2x Nasi Goreng" }],
  });
});

describe("dashboard permissions in the UI", () => {
  it("coordinator sees orders but has no void buttons, and can export", async () => {
    renderAs(USERS.COORDINATOR, <CoordinatorDashboard />);
    await screen.findByText(/2x Nasi Goreng/);
    expect(screen.queryByText("Void order")).toBeNull();
    expect(screen.queryByText("Void")).toBeNull();
    expect(screen.getByRole("tab", { name: "Report" })).toBeInTheDocument();
  });

  it("supervisor sees void buttons but not the Excel report tab", async () => {
    renderAs(USERS.SUPERVISOR, <CoordinatorDashboard />);
    await screen.findByText(/2x Nasi Goreng/);
    expect(screen.getByText("Void order")).toBeInTheDocument();
    expect(screen.getByText("Void")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Report" })).toBeNull();
  });

  it("voiding requires a reason of 3+ characters, then calls the API", async () => {
    renderAs(USERS.SUPERVISOR, <CoordinatorDashboard />);
    fireEvent.click(await screen.findByText("Void order"));
    const dialog = screen.getByRole("dialog");
    const submit = dialog.querySelector("button[type=submit]");
    expect(submit).toBeDisabled();
    fireEvent.change(dialog.querySelector("input"), { target: { value: "ab" } });
    expect(submit).toBeDisabled();
    fireEvent.change(dialog.querySelector("input"), { target: { value: "wrong table" } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => expect(api.voidOrder).toHaveBeenCalledWith("o1", "wrong table"));
  });

  it("transactions tab lists payments and supervisors can void a sale", async () => {
    renderAs(USERS.SUPERVISOR, <CoordinatorDashboard />);
    fireEvent.click(await screen.findByRole("tab", { name: "Transactions" }));
    await screen.findByText("Table 9");
    expect(screen.getByText(/Rp 99\.000/, { selector: "td" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Void sale"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("coordinator downloads the weekly report", async () => {
    renderAs(USERS.COORDINATOR, <CoordinatorDashboard />);
    fireEvent.click(await screen.findByRole("tab", { name: "Report" }));
    fireEvent.click(screen.getByText("Weekly"));
    fireEvent.click(screen.getByText("Download Excel"));
    await waitFor(() => expect(api.downloadReport).toHaveBeenCalledWith("week", undefined));
    expect(await screen.findByText(/Downloaded report-x-week/)).toBeInTheDocument();
  });
});
