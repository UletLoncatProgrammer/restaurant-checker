import { createContext, useContext, useState, useCallback } from "react";
import { api } from "../lib/api";
import { closeSocket } from "../lib/socket";
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
