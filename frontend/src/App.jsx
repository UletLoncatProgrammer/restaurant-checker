import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext.jsx";
import Login from "./pages/Login.jsx";
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

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
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
