import { useCallback, useRef, useState } from "react";

// On-screen alert banners: the visual twin of every sound, so an alert still
// registers if the tablet is muted, the volume is low, or the room is loud.
export function useAlerts(ttlMs = 10000) {
  const [alerts, setAlerts] = useState([]);
  const nextId = useRef(1);
  const push = useCallback(
    (message, tone = "info") => {
      const id = nextId.current++;
      setAlerts((prev) => [...prev.slice(-4), { id, message, tone }]);
      setTimeout(() => setAlerts((prev) => prev.filter((a) => a.id !== id)), ttlMs);
    },
    [ttlMs]
  );
  const dismiss = useCallback((id) => setAlerts((prev) => prev.filter((a) => a.id !== id)), []);
  return { alerts, push, dismiss };
}
