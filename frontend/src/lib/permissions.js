// What the signed-in person may do. The server sends the list with the user
// (user.permissions) and checks it again on every request; the screens use it
// only to show what can be used. Older saved sessions have no list yet: the
// built-in role presets below fill in until the next refresh.
const BUILTIN = {
  ADMIN: ["ORDER", "PAY", "BOARD_KITCHEN", "BOARD_COLD", "BOARD_BAR", "DASHBOARD", "HISTORY", "VOID", "EXPORT", "MENU", "MEMBERS", "STAFF"],
  COORDINATOR: ["ORDER", "PAY", "BOARD_KITCHEN", "BOARD_COLD", "BOARD_BAR", "DASHBOARD", "HISTORY", "EXPORT", "MENU", "MEMBERS"],
  SUPERVISOR: ["ORDER", "PAY", "BOARD_KITCHEN", "BOARD_COLD", "BOARD_BAR", "DASHBOARD", "HISTORY", "VOID", "MEMBERS"],
  FOH: ["ORDER", "PAY"],
  KITCHEN: ["BOARD_KITCHEN", "BOARD_COLD", "BOARD_BAR"],
};

export function permsOf(user) {
  if (!user) return [];
  return Array.isArray(user.permissions) ? user.permissions : BUILTIN[user.role] || [];
}
export const can = (user, perm) => permsOf(user).includes(perm);
export const canAny = (user, perms) => perms.some((p) => can(user, p));

// The first screen a person should land on.
export function homePath(user) {
  if (can(user, "ORDER")) return "/order-entry";
  if (can(user, "BOARD_KITCHEN") || can(user, "BOARD_COLD")) return "/kitchen";
  if (can(user, "BOARD_BAR")) return "/bar";
  if (canAny(user, ["DASHBOARD", "HISTORY", "EXPORT"])) return "/dashboard";
  if (can(user, "PAY")) return "/pos";
  if (canAny(user, ["MENU", "STAFF", "MEMBERS"])) return "/admin";
  return "/no-access";
}

// Short names for tables (the full descriptions come from the server).
export const SHORT = {
  ORDER: "Orders", PAY: "Payment", BOARD_KITCHEN: "Hot kitchen", BOARD_COLD: "Cold kitchen", BOARD_BAR: "Bar",
  DASHBOARD: "Dashboard", HISTORY: "History", VOID: "Void", EXPORT: "Excel", MENU: "Menu", MEMBERS: "Members", STAFF: "Staff, roles & billing",
};
