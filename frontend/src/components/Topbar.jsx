import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { SoundToggle } from "./SoundControl.jsx";
import { useSettings } from "../hooks/useSettings";
import { boardTitle } from "../lib/stations";

const KITCHEN_ROLES = ["KITCHEN", "COORDINATOR", "SUPERVISOR", "ADMIN"];

// The menu depends on the kitchen mode: a separate Cold Kitchen screen exists only in split mode.
function links(kitchenMode) {
  return [
    { to: "/order-entry", label: "Order Entry", roles: ["FOH", "COORDINATOR", "SUPERVISOR", "ADMIN"] },
    { to: "/pos", label: "POS", roles: ["FOH", "COORDINATOR", "SUPERVISOR", "ADMIN"] },
    { to: "/kitchen", label: boardTitle("kitchen", kitchenMode), roles: KITCHEN_ROLES },
    ...(kitchenMode === "SPLIT" ? [{ to: "/kitchen/cold", label: "Cold Kitchen", roles: KITCHEN_ROLES }] : []),
    { to: "/bar", label: "Bar", roles: KITCHEN_ROLES },
    { to: "/dashboard", label: "Dashboard", roles: ["COORDINATOR", "SUPERVISOR", "ADMIN"] },
    { to: "/admin", label: "Admin", roles: ["COORDINATOR", "ADMIN"] },
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
          {user?.name} ({user?.role})
        </span>
        <nav className="topbar-nav">
          {links(kitchenMode).filter((l) => l.roles.includes(user?.role)).map((l) => (
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
