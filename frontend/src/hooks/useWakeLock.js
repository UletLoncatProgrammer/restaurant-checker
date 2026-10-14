import { useEffect } from "react";

// Best effort: ask the browser to keep the screen on while this page is open
// (Safari supports it from iOS 16.4). A sleeping tablet cannot play alerts.
// Silently does nothing where unsupported — the README tells staff to set
// Auto-Lock to Never as the reliable fix.
export function useWakeLock() {
  useEffect(() => {
    let lock = null;
    let cancelled = false;
    async function acquire() {
      try {
        if (!cancelled && "wakeLock" in navigator && document.visibilityState === "visible") {
          lock = await navigator.wakeLock.request("screen");
        }
      } catch {
        /* denied or unsupported */
      }
    }
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", acquire);
      lock?.release?.().catch?.(() => {});
    };
  }, []);
}
