import { getServerUrl } from "./server";

const base = () => getServerUrl();

function getToken() {
  return localStorage.getItem("token");
}

function handleUnauthorized(path) {
  // An expired/invalid session (tokens last 12h): clear it and go to login
  // instead of leaving a half-working screen. Login itself returns 401 for a
  // wrong password — don't redirect on that.
  if (path.startsWith("/auth/login")) return;
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  if (typeof window !== "undefined" && !/(^|#)\/?login$/.test(window.location.hash || window.location.pathname)) window.location.assign(window.location.hash ? "#/login" : "/login");
}

async function request(path, { method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${base()}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (res.status === 401) handleUnauthorized(path);
  if (!res.ok) {
    if (res.status === 403 && data.code === "PASSWORD_CHANGE_REQUIRED") {
      localStorage.setItem("mustChange", "1");
      if (typeof window !== "undefined") window.location.assign(window.location.hash ? "#/change-password" : "/change-password");
    }
    const err = new Error(data.error || `Request failed: ${res.status}`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

// Downloads the Excel report. The token lives in localStorage (not a cookie),
// so a plain <a href> can't authenticate: fetch the file, then hand the blob
// to the browser as a download.
async function downloadReport(period, date) {
  const qs = new URLSearchParams({ period });
  if (date) qs.set("date", date);
  const res = await fetch(`${base()}/reports/export?${qs}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Download failed: ${res.status}`);
  }
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match ? match[1] : `report-${period}.xlsx`;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return filename;
}

export const api = {
  login: (email, password) => request("/auth/login", { method: "POST", body: { email, password } }),
  me: () => request("/auth/me"),
  changePassword: (currentPassword, newPassword) =>
    request("/auth/change-password", { method: "POST", body: { currentPassword, newPassword } }),
  // staff (ADMIN)
  getUsers: () => request("/users"),
  createUser: (data) => request("/users", { method: "POST", body: data }),
  updateUser: (id, data) => request(`/users/${id}`, { method: "PATCH", body: data }),
  getRoles: () => request("/users/roles"),
  setRoleEnabled: (role, enabled) => request(`/users/roles/${role}`, { method: "PATCH", body: { enabled } }),
  resetPassword: (id) => request(`/users/${id}/reset-password`, { method: "POST" }),
  // menu + tables (ADMIN / COORDINATOR)
  createCategory: (name) => request("/menu/categories", { method: "POST", body: { name } }),
  deleteCategory: (id) => request(`/menu/categories/${id}`, { method: "DELETE" }),
  createMenuItem: (data) => request("/menu/items", { method: "POST", body: data }),
  updateMenuItem: (id, data) => request(`/menu/items/${id}`, { method: "PATCH", body: data }),
  createTable: (label) => request("/locations/tables", { method: "POST", body: { label } }),
  updateTable: (id, data) => request(`/locations/tables/${id}`, { method: "PATCH", body: data }),
  getCategories: () => request("/menu/categories"),
  getTables: () => request("/locations/tables"),
  getSettings: () => request("/locations/settings"),
  updateSettings: (data) => request("/locations/settings", { method: "PATCH", body: data }),
  getOpenOrders: () => request("/orders/open"),
  getOutstandingSummary: () => request("/orders/outstanding-summary"),
  createOrder: (tableId, items) => request("/orders", { method: "POST", body: { tableId, items } }),
  updateItemStatus: (orderId, itemId, status) =>
    request(`/orders/${orderId}/items/${itemId}`, { method: "PATCH", body: { status } }),
  voidItem: (orderId, itemId, reason) =>
    request(`/orders/${orderId}/items/${itemId}/void`, { method: "POST", body: { reason } }),
  voidOrder: (orderId, reason) => request(`/orders/${orderId}/void`, { method: "POST", body: { reason } }),
  getBill: (orderId) => request(`/payments/bill/${orderId}`),
  pay: (orderId, method, amountTendered) =>
    request("/payments", { method: "POST", body: { orderId, method, amountTendered } }),
  getReceipt: (paymentId) => request(`/payments/${paymentId}/receipt`),
  getTransactions: (date) => request(`/transactions${date ? `?date=${date}` : ""}`),
  getActivity: () => request("/transactions/activity?limit=100"),
  getStock: () => request("/stock"),
  addStockMovement: (menuItemId, delta, reason, note) =>
    request("/stock/movements", { method: "POST", body: { menuItemId, delta, reason, note } }),
  downloadReport,
};

export { getToken };
