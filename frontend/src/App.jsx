import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext.jsx";
import Login from "./pages/Login.jsx";
import Signup from "./pages/Signup.jsx";
import OrderEntry from "./pages/OrderEntry.jsx";
import KitchenDisplay from "./pages/KitchenDisplay.jsx";
import CoordinatorDashboard from "./pages/CoordinatorDashboard.jsx";

// Every screen here is role-gated, not just hidden by navigation — a
// kitchen tablet loading the FOH screen by mistake should bounce, not
// silently show the wrong UI.
function RequireRole({ roles, children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (!roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

function Home() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role === "FOH") return <Navigate to="/order-entry" replace />;
  if (user.role === "KITCHEN") return <Navigate to="/kitchen" replace />;
  return <Navigate to="/dashboard" replace />;
}

// Restricts right-click and text selection app-wide, matching the pattern
// used on the main Clearion site. Cosmetic only — it deters casual
// right-click/copy, not a determined user with devtools. Don't rely on
// this for anything that actually needs to be secret (see the note in
// index.css for the same caveat on the CSS side).
function useRightClickRestriction() {
  useEffect(() => {
    const blockContextMenu = (e) => e.preventDefault();
    document.addEventListener("contextmenu", blockContextMenu);
    return () => document.removeEventListener("contextmenu", blockContextMenu);
  }, []);
}

export default function App() {
  useRightClickRestriction();
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/" element={<Home />} />
      <Route
        path="/order-entry"
        element={
          <RequireRole roles={["FOH", "COORDINATOR", "ADMIN"]}>
            <OrderEntry />
          </RequireRole>
        }
      />
      <Route
        path="/kitchen"
        element={
          <RequireRole roles={["KITCHEN", "COORDINATOR", "ADMIN"]}>
            <KitchenDisplay />
          </RequireRole>
        }
      />
      <Route
        path="/dashboard"
        element={
          <RequireRole roles={["COORDINATOR", "ADMIN"]}>
            <CoordinatorDashboard />
          </RequireRole>
        }
      />
    </Routes>
  );
}
