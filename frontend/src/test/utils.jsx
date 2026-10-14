import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext.jsx";

// Minimal stand-in for a socket.io client: on/off/emit plus a `fire` helper
// so tests can simulate the server pushing an event.
export function makeFakeSocket() {
  const handlers = new Map();
  return {
    on: (e, h) => handlers.set(e, [...(handlers.get(e) || []), h]),
    off: (e, h) => handlers.set(e, (handlers.get(e) || []).filter((x) => x !== h)),
    close: () => {},
    fire: (e, payload) => (handlers.get(e) || []).forEach((h) => h(payload)),
  };
}

export const USERS = {
  FOH: { id: "u-foh", name: "Wati", role: "FOH", locationId: "loc" },
  FOH2: { id: "u-foh2", name: "Budi", role: "FOH", locationId: "loc" },
  KITCHEN: { id: "u-k", name: "Cook", role: "KITCHEN", locationId: "loc" },
  COORDINATOR: { id: "u-c", name: "Coord", role: "COORDINATOR", locationId: "loc" },
  SUPERVISOR: { id: "u-s", name: "Sup", role: "SUPERVISOR", locationId: "loc" },
};

export function renderAs(user, ui, route = "/") {
  localStorage.setItem("user", JSON.stringify(user));
  localStorage.setItem("token", "t");
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthProvider>{ui}</AuthProvider>
    </MemoryRouter>
  );
}

export const order = (over = {}) => ({
  id: "o1",
  status: "OPEN",
  openedAt: "2026-10-08T05:00:00Z",
  openedById: "u-foh",
  table: { id: "t1", label: "Table 1" },
  items: [
    { id: "i1", quantity: 2, unitPrice: 45000, taxRate: 0.1, notes: null, status: "PENDING", menuItem: { id: "m1", name: "Nasi Goreng" } },
  ],
  ...over,
});
