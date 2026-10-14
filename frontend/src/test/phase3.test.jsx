// Phase 3 screens: menus and pages follow the role's permissions; the roles editor.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { renderAs } from "./utils.jsx";

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
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getCategories: vi.fn().mockResolvedValue([]),
    getTables: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({ kitchenMode: "ONE" }),
    getUsers: vi.fn().mockResolvedValue([]),
    getRoles: vi.fn(),
    getPermissions: vi.fn(),
    createRole: vi.fn().mockResolvedValue({}),
    updateRole: vi.fn().mockResolvedValue({}),
    deleteRole: vi.fn().mockResolvedValue({}),
    setRoleEnabled: vi.fn().mockResolvedValue({}),
  },
}));

import { api } from "../lib/api";
import App from "../App.jsx";

const PERMS = [
  { key: "ORDER", label: "Take orders and serve dishes (Order Entry)", grantable: true },
  { key: "PAY", label: "Take payment (POS)", grantable: true },
  { key: "BOARD_BAR", label: "Bar screen", grantable: true },
  { key: "STAFF", label: "Manage staff and roles (Admin only)", grantable: false },
];
const ROLES = [
  { key: "ADMIN", role: "ADMIN", label: "Admin", builtin: true, enabled: true, permissions: ["ORDER", "PAY", "STAFF"], activeStaff: 1 },
  { key: "FOH", role: "FOH", label: "Waiter (front of house)", builtin: true, enabled: true, permissions: ["ORDER", "PAY"], activeStaff: 2 },
  { key: "FOOD_RUNNER", role: "FOOD_RUNNER", label: "Food runner", builtin: false, enabled: true, permissions: ["ORDER"], activeStaff: 0 },
];
const ADMIN = { id: "u-a", name: "Boss", role: "ADMIN", locationId: "loc" };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.getRoles.mockResolvedValue(ROLES);
  api.getPermissions.mockResolvedValue(PERMS);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("screens follow the role's permissions", () => {
  it("a custom 'bar only' role sees only the Bar screen and lands on it", async () => {
    renderAs({ id: "u-b", name: "Joko", role: "BARISTA", roleLabel: "Barista", locationId: "loc", permissions: ["BOARD_BAR"] }, <App />, "/");
    expect(await screen.findByText("Joko (Barista)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Bar" })).toBeInTheDocument();
    for (const name of ["Order Entry", "POS", "Hot & Cold Kitchen", "Dashboard", "Admin"]) {
      expect(screen.queryByRole("link", { name })).toBeNull();
    }
  });

  it("a page the role may not use bounces back", async () => {
    renderAs({ id: "u-r", name: "Rina", role: "FOOD_RUNNER", locationId: "loc", permissions: ["ORDER"] }, <App />, "/dashboard");
    expect(await screen.findByText("Order Entry", { selector: "strong" })).toBeInTheDocument();
  });

  it("a role with no screens gets a clear message", async () => {
    renderAs({ id: "u-n", name: "Nobody", role: "EMPTY", locationId: "loc", permissions: [] }, <App />, "/");
    expect(await screen.findByText(/Your role does not include any screen/)).toBeInTheDocument();
  });
});

describe("roles editor", () => {
  it("creates a role with tick-boxes; STAFF can't be ticked", async () => {
    renderAs(ADMIN, <App />, "/admin");
    fireEvent.click(await screen.findByRole("button", { name: "Roles" }));
    fireEvent.click(await screen.findByRole("button", { name: "New role" }));
    expect(screen.queryByLabelText(/Manage staff and roles/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Role name"), { target: { value: "Cashier" } });
    fireEvent.click(screen.getByLabelText("Take payment (POS)"));
    fireEvent.click(screen.getByRole("button", { name: "Save role" }));
    await waitFor(() => expect(api.createRole).toHaveBeenCalledWith("Cashier", ["PAY"]));
    expect(await screen.findByText(/Role "Cashier" created/)).toBeInTheDocument();
  });

  it("edits a built-in role's tick-boxes and deletes an own role", async () => {
    renderAs(ADMIN, <App />, "/admin");
    fireEvent.click(await screen.findByRole("button", { name: "Roles" }));
    expect(await screen.findByText("Always kept")).toBeInTheDocument();
    const edits = await screen.findAllByRole("button", { name: "Edit" });
    fireEvent.click(edits[0]); // Waiter
    expect(screen.queryByLabelText("Role name")).toBeNull(); // built-in names stay
    fireEvent.click(screen.getByLabelText("Bar screen"));
    fireEvent.click(screen.getByRole("button", { name: "Save role" }));
    await waitFor(() => expect(api.updateRole).toHaveBeenCalledWith("FOH", { permissions: ["ORDER", "PAY", "BOARD_BAR"] }));

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteRole).toHaveBeenCalledWith("FOOD_RUNNER"));
  });

  it("the staff form offers the company's roles by name, including its own", async () => {
    renderAs(ADMIN, <App />, "/admin");
    const select = await screen.findByLabelText("Role for the new person");
    await waitFor(() => expect(screen.getAllByRole("option", { name: "Food runner" }).length).toBeGreaterThan(0));
    expect(select).toBeInTheDocument();
  });
});
