import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { IS_WRAPPER, clearServerUrl } from "../lib/server";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const company = localStorage.getItem("companyName");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err) {
      setError(err instanceof TypeError ? "Cannot reach the server. Check your internet connection." : err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>{company || "Restaurant Checker"}</h1>
        {error && <div className="error-text" role="alert">{error}</div>}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button type="submit" disabled={loading}>
          {loading ? "Signing in..." : "Sign in"}
        </button>
        <p style={{ textAlign: "center", marginTop: "1rem", fontSize: "0.85rem", color: "#6b7280" }}>
          No account? Ask your manager to create one for you.
        </p>
        {IS_WRAPPER && (
          <p style={{ textAlign: "center", fontSize: "0.85rem" }}>
            <Link to="/connect" onClick={() => { clearServerUrl(); localStorage.removeItem("companyName"); }}>
              Change company
            </Link>
          </p>
        )}
      </form>
    </div>
  );
}
