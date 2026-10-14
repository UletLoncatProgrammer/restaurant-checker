import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { renderAs, USERS } from "./utils.jsx";

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
    login: vi.fn(),
    changePassword: vi.fn(),
    getUsers: vi.fn(),
    getRoles: vi.fn(),
    setRoleEnabled: vi.fn(),
    createUser: vi.fn(),
    updateUser: vi.fn(),
    resetPassword: vi.fn(),
    getTables: vi.fn().mockResolvedValue([]),
    getCategories: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
  },
}));

import { api } from "../lib/api";
import App from "../App.jsx";
import { AuthProvider } from "../context/AuthContext.jsx";
import { companyUrl } from "../lib/server";

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe("company code", () => {
  it("turns a code into the company address, and rejects junk", () => {
    vi.stubEnv("VITE_BASE_DOMAIN", "example.com");
    expect(companyUrl(" Pizza-Palace ")).toBe("https://pizza-palace.example.com");
    expect(companyUrl("a")).toBeNull();
    expect(companyUrl("x.evil.com/")).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("sign-in", () => {
  it("has no sign-up link", () => {
    localStorage.clear();
    render(<MemoryRouter initialEntries={["/login"]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
    expect(screen.queryByText(/create an account/i)).toBeNull();
    expect(screen.getByText(/ask your manager/i)).toBeInTheDocument();
  });

  it("a temporary password sends the person to choose their own", async () => {
    localStorage.clear();
    api.login.mockResolvedValue({ token: "t", user: USERS.FOH, mustChangePassword: true });
    api.changePassword.mockResolvedValue({ token: "t2", user: USERS.FOH });
    render(<MemoryRouter initialEntries={["/login"]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "w@x.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Temp12345678" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await screen.findByText(/choose your own password/i);

    fireEvent.change(screen.getByLabelText(/temporary password/i), { target: { value: "Temp12345678" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "Brand-new-pass1" } });
    fireEvent.change(screen.getByLabelText("New password again"), { target: { value: "different" } });
    fireEvent.click(screen.getByRole("button", { name: /save password/i }));
    await screen.findByText(/not the same/i);
    expect(api.changePassword).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("New password again"), { target: { value: "Brand-new-pass1" } });
    fireEvent.click(screen.getByRole("button", { name: /save password/i }));
    await waitFor(() => expect(api.changePassword).toHaveBeenCalledWith("Temp12345678", "Brand-new-pass1"));
    await waitFor(() => expect(localStorage.getItem("mustChange")).toBeNull());
  });

  it("while a temporary password is in use, work screens bounce to the password page", async () => {
    localStorage.setItem("mustChange", "1");
    renderAs(USERS.FOH, <App />, "/order-entry");
    await screen.findByText(/choose your own password/i);
  });
});

describe("admin page", () => {
  const roleRows = (off = []) => ["ADMIN", "COORDINATOR", "SUPERVISOR", "FOH", "KITCHEN"].map((role) => ({ role, enabled: !off.includes(role), activeStaff: role === "FOH" ? 1 : 0, removable: role !== "ADMIN" }));
  beforeEach(() => api.getRoles.mockResolvedValue(roleRows()));

  const ADMIN = { id: "u-a", name: "Boss", role: "ADMIN", locationId: "loc" };
  const staff = (o = {}) => ({ id: "u-1", name: "Wati", email: "w@x.com", role: "FOH", active: true, mustChangePassword: false, lastLoginAt: null, ...o });

  afterEach(() => localStorage.clear());

  it("lists staff and shows a new temporary password once", async () => {
    api.getUsers.mockResolvedValue([staff()]);
    api.createUser.mockResolvedValue({ user: staff({ id: "u-2", name: "Budi" }), temporaryPassword: "Abc123xyzQWE" });
    renderAs(ADMIN, <App />, "/admin");
    await screen.findByText("Wati");
    fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "Budi" } });
    fireEvent.change(screen.getByPlaceholderText("Email"), { target: { value: "b@x.com" } });
    fireEvent.click(screen.getByRole("button", { name: /add staff/i }));
    await screen.findByText(/Abc123xyzQWE/);
    expect(api.createUser).toHaveBeenCalledWith({ name: "Budi", email: "b@x.com", role: "FOH" });
  });

  it("an admin cannot change their own role or disable themself from the list", async () => {
    api.getUsers.mockResolvedValue([staff({ id: "u-a", name: "Boss", role: "ADMIN" })]);
    renderAs(ADMIN, <App />, "/admin");
    await screen.findByText("Boss");
    expect(screen.queryByRole("button", { name: /disable/i })).toBeNull();
  });

  it("front-of-house staff cannot open it", async () => {
    renderAs(USERS.FOH, <App />, "/admin");
    await waitFor(() => expect(screen.queryByText("Admin")).toBeNull());
  });

  it("removed roles disappear from the staff form, and can be removed/restored on the Roles tab", async () => {
    api.getUsers.mockResolvedValue([]);
    api.getRoles.mockResolvedValue(roleRows(["SUPERVISOR"]));
    api.setRoleEnabled.mockResolvedValue({});
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAs(ADMIN, <App />, "/admin");
    await waitFor(() => expect(screen.getAllByRole("option", { name: "FOH" }).length).toBeGreaterThan(0));
    expect(screen.queryByRole("option", { name: "SUPERVISOR" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Roles" }));
    await screen.findAllByText(/Always kept/);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(api.setRoleEnabled).toHaveBeenCalledWith("SUPERVISOR", true));

    api.getRoles.mockResolvedValue(roleRows());
    fireEvent.click((await screen.findAllByRole("button", { name: "Remove" }))[0]);
    await waitFor(() => expect(api.setRoleEnabled).toHaveBeenCalledWith("COORDINATOR", false));
  });
});
