import { io } from "socket.io-client";
import { API_URL } from "./api";

let socket = null;

// One shared socket per tab, joined to the current user's location room.
// Kitchen Display / Coordinator Dashboard / Order Entry all subscribe to
// the same room so any status change is reflected everywhere instantly.
export function getSocket(locationId) {
  if (!socket) {
    socket = io(API_URL, { transports: ["websocket"] });
  }
  if (locationId) {
    socket.emit("join-location", locationId);
  }
  return socket;
}
