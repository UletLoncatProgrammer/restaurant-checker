import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../lib/api";

// Self-service signup — deliberately limited to FOH and KITCHEN roles.
// Coordinator/Admin accounts (full visibility, menu editing) are not
// self-service; see the note in backend/src/routes/auth.js for why.
export default function Signup() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [locations, setLocations] = useState([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [locationId, setLocationId] = useState("");
  const [role, setRole] = useState("FOH");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.getPublicLocations().then(setLocations).catch((e) => setError(e.message));
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await signup({ name, email, password, locationId, role });
      navigate("/");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit} style={{ width: 340 }}>
        <h1>Create staff account</h1>
        {error && <div className="error-text">{error}</div>}
        <label>
          Full name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password (min 8 characters)
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
        </label>
        <label>
          Branch
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} required style={{ width: "100%", marginTop: "0.3rem" }}>
            <option value="">Select your branch</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.organizationName} — {l.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value)} style={{ width: "100%", marginTop: "0.3rem" }}>
            <option value="FOH">Front-of-house</option>
            <option value="KITCHEN">Kitchen</option>
          </select>
        </label>
        <p style={{ fontSize: "0.8rem", color: "#6b7280" }}>
          Coordinator/Admin accounts aren't self-service — ask whoever manages your branch to create one for you.
        </p>
        <button type="submit" disabled={loading}>
          {loading ? "Creating account..." : "Create account"}
        </button>
        <p style={{ textAlign: "center", marginTop: "1rem", fontSize: "0.9rem" }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
