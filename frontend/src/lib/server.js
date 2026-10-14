// Where is this company's server? Resolved at run time, in this order:
//   1. a saved choice (the Android/Windows app asks for a company code once),
//   2. VITE_API_URL given at build time,
//   3. development: the local backend; otherwise the page's own address
//      (the browser version is served by the company's own server).
export const IS_WRAPPER = import.meta.env.VITE_APP_TARGET === "wrapper";
const KEY = "serverUrl";

export function getServerUrl() {
  const saved = localStorage.getItem(KEY);
  if (saved) return saved;
  const built = import.meta.env.VITE_API_URL;
  if (built) return built.replace(/\/+$/, "");
  if (IS_WRAPPER) return "";
  if (import.meta.env.DEV) return "http://localhost:4000";
  return typeof window !== "undefined" ? window.location.origin : "";
}

export const needsServer = () => IS_WRAPPER && !localStorage.getItem(KEY) && !import.meta.env.VITE_API_URL;
export const setServerUrl = (url) => localStorage.setItem(KEY, url.replace(/\/+$/, ""));
export const clearServerUrl = () => localStorage.removeItem(KEY);

// "Pizza-Palace" -> https://pizza-palace.<base domain>; same rules as the provisioning script.
export function companyUrl(code) {
  const slug = String(code || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(slug)) return null;
  const base = import.meta.env.VITE_BASE_DOMAIN;
  if (!base) return null;
  return `https://${slug}.${base}`;
}

// Asks the server who it is, so a wrong code fails before anyone types a password.
export async function checkServer(url) {
  const res = await fetch(`${url}/public/info`, { headers: { Accept: "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.app !== "restaurant-checker") throw new Error("That is not a Restaurant Checker server");
  return data;
}
