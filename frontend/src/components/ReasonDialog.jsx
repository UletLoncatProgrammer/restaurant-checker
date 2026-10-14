import { useState } from "react";

// Modal that forces a written reason before a void goes through. (The server
// enforces the reason too; this just makes it hard to tap past by accident.)
export default function ReasonDialog({ title, detail, confirmLabel = "Void", onConfirm, onCancel }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valid = reason.trim().length >= 3;

  async function submit(e) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm(reason.trim());
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit} role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {detail && <p>{detail}</p>}
        <label>
          Reason (required)
          <input
            autoFocus
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. wrong dish entered"
            style={{ width: "100%", marginTop: "0.3rem" }}
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" disabled={!valid || busy} className="danger">
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
