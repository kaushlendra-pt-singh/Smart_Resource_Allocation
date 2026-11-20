import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Every backend is reached through this dev server, so the browser only ever talks to one origin.
// That keeps the httpOnly refresh-token cookie (sameSite=strict) working without any CORS setup.
// Ports can be changed with env vars, e.g. AUTH_URL=http://localhost:9000 npm run dev
const target = (envName, fallback) => process.env[envName] || fallback;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api/auth": target("AUTH_URL", "http://localhost:8000"),
      "/api/ngo": target("NGO_URL", "http://localhost:8001"),
      "/api/resources": target("RES_URL", "http://localhost:8002"),
      "/api/inventory": target("RES_URL", "http://localhost:8002"),
      "/allocation": target("ALLOC_URL", "http://localhost:8003"),
    },
  },
});
