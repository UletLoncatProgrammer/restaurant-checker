import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { api } from "../lib/api";
import { closeSocket, getSocket } from "../lib/socket";
import { resetSettings } from "../hooks/useSettings";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const raw = localStorage.getItem("user");
    return raw ? JSON.parse(raw) : null;
  });
  // A person with a temporary password may do nothing but choose a new one.
  const [mustChangePassword, setMustChange] = useState(() => localStorage.getItem("mustChange") === "1");

  const store = (token, u, must) => {
    localStorage.setItem("token", token);
    localStorage.setItem("user", JSON.stringify(u));
    if (must) localStorage.setItem("mustChange", "1");
    else localStorage.removeItem("mustChange");
    setMustChange(!!must);
    setUser(u);
  };

  const login = useCallback(async (email, password) => {
    const { token, user, mustChangePassword } = await api.login(email, password);
    store(token, user, mustChangePassword);
    return user;
  }, []);

  const changePassword = useCallback(async (currentPassword, newPassword) => {
    const { token, user } = await api.changePassword(currentPassword, newPassword);
    store(token, user, false);
    return user;
  }, []);

  // Keep the role and its permissions current: on start-up, and whenever the server
  // signs this screen out of the live connection (e.g. an admin changed the role's
  // tick-boxes) - then reconnect with the new permissions.
  const userId = user && user.id;
  useEffect(() => {
    if (!userId || typeof api.me !== "function") return undefined;
    let stopped = false;
    const refresh = () =>
      api
        .me()
        .then(({ user: fresh, mustChangePassword: must }) => {
          if (stopped || !fresh) return;
          localStorage.setItem("user", JSON.stringify(fresh));
          if (must) localStorage.setItem("mustChange", "1");
          setUser(fresh);
          setMustChange(!!must);
        })
        .catch(() => {}); // 401 is handled by the api layer (back to sign-in)
    refresh();
    const socket = getSocket();
    const onDrop = (reason) => {
      if (reason !== "io server disconnect") return; // network blips reconnect by themselves
      refresh().then(() => !stopped && socket.connect && socket.connect());
    };
    socket.on("disconnect", onDrop);
    return () => {
      stopped = true;
      socket.off("disconnect", onDrop);
    };
  }, [userId]);

  const logout = useCallback(() => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    localStorage.removeItem("mustChange");
    closeSocket();
    resetSettings();
    setMustChange(false);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, mustChangePassword, login, changePassword, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
