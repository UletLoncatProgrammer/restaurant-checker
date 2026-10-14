import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { getSocket } from "../lib/socket";

// Restaurant-wide settings (for now: the kitchen mode), shared by every screen
// in this browser tab. Loaded once, then kept up to date by the server's
// "settings:updated" message, so changing the mode in Admin updates open
// kitchen screens immediately.
let cache = null;
const listeners = new Set();
function publish(settings) {
  cache = settings;
  listeners.forEach((l) => l(settings));
}

export function resetSettings() {
  cache = null; // on logout: the next person may belong to another restaurant
}

export function useSettings() {
  const [settings, setSettings] = useState(cache);
  useEffect(() => {
    listeners.add(setSettings);
    if (!cache && typeof api.getSettings === "function") {
      api.getSettings().then(publish).catch(() => {});
    }
    const socket = getSocket();
    socket.on("settings:updated", publish);
    return () => {
      listeners.delete(setSettings);
      socket.off("settings:updated", publish);
    };
  }, []);
  return settings || { kitchenMode: "ONE", billing: null };
}

export { publish as setSettingsForTests };
