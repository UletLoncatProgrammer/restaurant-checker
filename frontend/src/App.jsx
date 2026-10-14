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
import { canAny, homePath } from "./lib/permissions";
import OrderEntry from "./pages/OrderEntry.jsx";
import KitchenDisplay from "./pages/KitchenDisplay.jsx";
import CoordinatorDashboard from "./pages/CoordinatorDashboard.jsx";
import Pos from "./pages/Pos.jsx";

// Every screen here is permission-gated, not just hidden by navigation — a
// kitchen tablet loading the order screen by mistake should bounce, not
// silently show the wrong UI. (The API enforces the same rules server-side.)
// `perms`: the person needs at least one of these permissions.
function RequirePerm({ perms, children }) {
  const { user, mustChangePassword } = useAuth();
  if (needsServer()) return <Navigate to="/connect" replace />;
  if (!user) return <Navigate to="/login" replace />;
  if (mustChangePassword) return <Navigate to="/change-password" replace />;
  if (!canAny(user, perms)) return <Navigate to="/" replace />;
  return children;
}

function NoAccess() {
  const { logout } = useAuth();
  return (
    <div className="login-screen">
      <div className="login-card">
        <h1>No screens yet</h1>
        <p>Your role does not include any screen. Ask your manager to tick what you need in Admin &gt; Roles.</p>
        <button onClick={logout}>Log out</button>
      </div>
    </div>
  );
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
  return <Navigate to={homePath(user)} replace />;
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
            <RequirePerm perms={["MENU", "STAFF", "MEMBERS"]}>
              <Admin />
            </RequirePerm>
          }
        />
        <Route path="/no-access" element={<RequireUser><NoAccess /></RequireUser>} />
        <Route path="*" element={<Navigate to="/" replace />} />
        <Route path="/" element={<Home />} />
        <Route
          path="/order-entry"
          element={
            <RequirePerm perms={["ORDER"]}>
              <OrderEntry />
            </RequirePerm>
          }
        />
        <Route
          path="/pos"
          element={
            <RequirePerm perms={["PAY"]}>
              <Pos />
            </RequirePerm>
          }
        />
        <Route
          path="/kitchen"
          element={
            <RequirePerm perms={["BOARD_KITCHEN", "BOARD_COLD"]}>
              <KitchenDisplay board="kitchen" key="kitchen" />
            </RequirePerm>
          }
        />
        <Route
          path="/kitchen/cold"
          element={
            <RequirePerm perms={["BOARD_COLD"]}>
              <KitchenDisplay board="cold" key="cold" />
            </RequirePerm>
          }
        />
        <Route
          path="/bar"
          element={
            <RequirePerm perms={["BOARD_BAR"]}>
              <KitchenDisplay board="bar" key="bar" />
            </RequirePerm>
          }
        />
        <Route
          path="/dashboard"
          element={
            <RequirePerm perms={["DASHBOARD", "HISTORY", "EXPORT"]}>
              <CoordinatorDashboard />
            </RequirePerm>
          }
        />
      </Routes>
    </>
  );
}
