import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { companyUrl, checkServer, setServerUrl, clearServerUrl, getServerUrl } from "../lib/server";

// First screen of the Android / Windows app: which company are you working for?
// The code is the short name the owner received when the company was set up.
export default function Connect() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    const url = companyUrl(code);
    if (!url) {
      setError("Enter the company code you were given (letters, numbers and dashes).");
      return;
    }
    setBusy(true);
    try {
      const info = await checkServer(url);
      setServerUrl(url);
      localStorage.setItem("companyName", info.name || code);
      navigate("/login");
    } catch (err) {
      clearServerUrl();
      setError(err instanceof TypeError ? "Cannot reach that company. Check the code and your internet." : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <h1>Restaurant Checker</h1>
        <p style={{ fontSize: "0.9rem", marginTop: 0 }}>Enter your company code to connect.</p>
        {error && <div className="error-text">{error}</div>}
        <label>
          Company code
          <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoCapitalize="none" autoCorrect="off" required />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Connecting..." : "Connect"}
        </button>
        {getServerUrl() && <p style={{ fontSize: "0.8rem", color: "#6b7280" }}>Current: {getServerUrl()}</p>}
      </form>
    </div>
  );
}
