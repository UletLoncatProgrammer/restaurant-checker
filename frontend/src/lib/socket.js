import { io } from "socket.io-client";
import { getToken } from "./api";
import { getServerUrl } from "./server";

let socket = null;

// One shared socket per tab. The server reads the JWT from the handshake and
// puts the socket in its own location's rooms — the client no longer asks to
// join a location. `auth` is a function so a reconnect sends the current token.
export function getSocket() {
  if (!socket) {
    socket = io(getServerUrl(), { transports: ["websocket"], auth: (cb) => cb({ token: getToken() }) });
  }
  return socket;
}

// Must run on logout: otherwise the next person to log in on this tablet would
// keep the previous user's role/location rooms until a page refresh.
export function closeSocket() {
  if (socket) {
    socket.close();
    socket = null;
  }
}
