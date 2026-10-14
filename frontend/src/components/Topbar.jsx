import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { SoundToggle } from "./SoundControl.jsx";
import { useSettings } from "../hooks/useSettings";
import { boardTitle } from "../lib/stations";
import { canAny } from "../lib/permissions";

// Each link shows only to people whose role has one of its permissions.
// A separate Cold Kitchen screen exists only in split-kitchen mode.
function links(kitchenMode) {
  return [
    { to: "/order-entry", label: "Order Entry", perms: ["ORDER"] },
    { to: "/pos", label: "POS", perms: ["PAY"] },
    { to: "/kitchen", label: boardTitle("kitchen", kitchenMode), perms: ["BOARD_KITCHEN", ...(kitchenMode === "SPLIT" ? [] : ["BOARD_COLD"])] },
    ...(kitchenMode === "SPLIT" ? [{ to: "/kitchen/cold", label: "Cold Kitchen", perms: ["BOARD_COLD"] }] : []),
    { to: "/bar", label: "Bar", perms: ["BOARD_BAR"] },
    { to: "/dashboard", label: "Dashboard", perms: ["DASHBOARD", "HISTORY", "EXPORT"] },
    { to: "/admin", label: "Admin", perms: ["MENU", "STAFF", "MEMBERS"] },
  ];
}

export default function Topbar({ title }) {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const { kitchenMode } = useSettings();
  return (
    <div className="topbar">
      <div className="topbar-left">
        <strong>{title}</strong>
        <span className="topbar-user">
          {user?.name} ({user?.roleLabel || user?.role})
        </span>
        <nav className="topbar-nav">
          {links(kitchenMode).filter((l) => canAny(user, l.perms)).map((l) => (
            <Link key={l.to} to={l.to} className={pathname === l.to ? "active" : ""}>
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="topbar-right">
        <SoundToggle />
        <Link to="/change-password" className="topbar-nav-link">Password</Link>
        <button onClick={logout}>Log out</button>
      </div>
    </div>
  );
}
