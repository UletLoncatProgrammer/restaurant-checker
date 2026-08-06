const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

function getToken() {
  return localStorage.getItem("token");
}

async function request(path, { method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data;
}

export const api = {
  login: (email, password) => request("/auth/login", { method: "POST", body: { email, password } }),
  signup: (data) => request("/auth/signup", { method: "POST", body: data }),
  getPublicLocations: () => request("/public/locations"),
  getCategories: () => request("/menu/categories"),
  getTables: () => request("/locations/tables"),
  getOpenOrders: () => request("/orders/open"),
  getOutstandingSummary: () => request("/orders/outstanding-summary"),
  createOrder: (tableId, items) => request("/orders", { method: "POST", body: { tableId, items } }),
  updateItemStatus: (orderId, itemId, status) =>
    request(`/orders/${orderId}/items/${itemId}`, { method: "PATCH", body: { status } }),
  closeOrder: (orderId) => request(`/orders/${orderId}/close`, { method: "POST" }),
};

export { API_URL, getToken };
