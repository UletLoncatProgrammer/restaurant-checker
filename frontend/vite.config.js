import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Bind to 0.0.0.0 (via --host) so tablets on the restaurant LAN can reach
// the dev server by the machine's local IP, not just localhost.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.js"],
  },
});
