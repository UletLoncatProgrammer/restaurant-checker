import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

export default function ChangePassword() {
  const { user, mustChangePassword, changePassword, logout } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (next !== again) return setError("The two new passwords are not the same");
    setBusy(true);
    try {
      await changePassword(current, next);
      navigate("/");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <h1>{mustChangePassword ? "Choose your own password" : "Change password"}</h1>
        <p style={{ fontSize: "0.85rem", marginTop: 0 }}>
          {mustChangePassword ? `Hello ${user?.name}. You are using a temporary password. ` : ""}
          Use at least 8 characters. Other devices will be signed out.
        </p>
        {error && <div className="error-text" role="alert">{error}</div>}
        <label>
          {mustChangePassword ? "Temporary password" : "Current password"}
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoFocus />
        </label>
        <label>
          New password
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} />
        </label>
        <label>
          New password again
          <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} required />
        </label>
        <button type="submit" disabled={busy}>{busy ? "Saving..." : "Save password"}</button>
        <button type="button" onClick={logout} style={{ background: "#e5e7eb", color: "#111" }}>Log out</button>
      </form>
    </div>
  );
}
