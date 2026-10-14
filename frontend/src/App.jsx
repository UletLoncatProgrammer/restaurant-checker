import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext.jsx";
import { unlockAudio } from "./lib/sound";
import { SoundLockedBar } from "./components/SoundControl.jsx";
import Login from "./pages/Login.jsx";
import Connect from "./pages/Connect.jsx";
import ChangePassword from "./pages/ChangePassword.jsx";
import Admin from "./pages/Admin.jsx";
import { needsServer } from "./lib/server";
import OrderEntry from "./pages/OrderEntry.jsx";
import KitchenDisplay from "./pages/KitchenDisplay.jsx";
import CoordinatorDashboard from "./pages/CoordinatorDashboard.jsx";
import Pos from "./pages/Pos.jsx";

// Every screen here is role-gated, not just hidden by navigation — a
// kitchen tablet loading the FOH screen by mistake should bounce, not
// silently show the wrong UI. (The API enforces the same rules server-side.)
function RequireRole({ roles, children }) {
  const { user, mustChangePassword } = useAuth();
  if (needsServer()) return <Navigate to="/connect" replace />;
  if (!user) return <Navigate to="/login" replace />;
  if (mustChangePassword) return <Navigate to="/change-password" replace />;
  if (!roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

function RequireUser({ children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function Home() {
  const { user, mustChangePassword } = useAuth();
  if (needsServer()) return <Navigate to="/connect" replace />;
  if (!user) return <Navigate to="/login" replace />;
  if (mustChangePassword) return <Navigate to="/change-password" replace />;
  if (user.role === "FOH") return <Navigate to="/order-entry" replace />;
  if (user.role === "KITCHEN") return <Navigate to="/kitchen" replace />;
  return <Navigate to="/dashboard" replace />;
}

// Disables the right-click / long-press context menu and image/text dragging
// app-wide. Cosmetic only: it deters casual copy/inspect on a shared tablet,
// it does NOT stop someone with devtools or "view source". Never treat it as
// security — the API checks every request on its own.
export function useRightClickRestriction() {
  useEffect(() => {
    const block = (e) => e.preventDefault();
    document.addEventListener("contextmenu", block, true);
    document.addEventListener("dragstart", block, true);
    return () => {
      document.removeEventListener("contextmenu", block, true);
      document.removeEventListener("dragstart", block, true);
    };
  }, []);
}

// Browsers only allow audio after a user gesture. Unlock on the first tap or
// key press anywhere, so sound alerts work as soon as someone touches the page.
function useAudioUnlock() {
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);
}

export default function App() {
  const { user } = useAuth();
  useRightClickRestriction();
  useAudioUnlock();
  return (
    <>
      {user && <SoundLockedBar />}
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/connect" element={<Connect />} />
        <Route path="/change-password" element={<RequireUser><ChangePassword /></RequireUser>} />
        <Route
          path="/admin"
          element={
            <RequireRole roles={["COORDINATOR", "ADMIN"]}>
              <Admin />
            </RequireRole>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
        <Route path="/" element={<Home />} />
        <Route
          path="/order-entry"
          element={
            <RequireRole roles={["FOH", "COORDINATOR", "SUPERVISOR", "ADMIN"]}>
              <OrderEntry />
            </RequireRole>
          }
        />
        <Route
          path="/pos"
          element={
            <RequireRole roles={["FOH", "COORDINATOR", "SUPERVISOR", "ADMIN"]}>
              <Pos />
            </RequireRole>
          }
        />
        <Route
          path="/kitchen"
          element={
            <RequireRole roles={["KITCHEN", "COORDINATOR", "SUPERVISOR", "ADMIN"]}>
              <KitchenDisplay board="kitchen" key="kitchen" />
            </RequireRole>
          }
        />
        <Route
          path="/kitchen/cold"
          element={
            <RequireRole roles={["KITCHEN", "COORDINATOR", "SUPERVISOR", "ADMIN"]}>
              <KitchenDisplay board="cold" key="cold" />
            </RequireRole>
          }
        />
        <Route
          path="/bar"
          element={
            <RequireRole roles={["KITCHEN", "COORDINATOR", "SUPERVISOR", "ADMIN"]}>
              <KitchenDisplay board="bar" key="bar" />
            </RequireRole>
          }
        />
        <Route
          path="/dashboard"
          element={
            <RequireRole roles={["COORDINATOR", "SUPERVISOR", "ADMIN"]}>
              <CoordinatorDashboard />
            </RequireRole>
          }
        />
      </Routes>
    </>
  );
}
