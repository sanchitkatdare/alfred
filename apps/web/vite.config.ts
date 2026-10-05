import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // API calls go to `pnpm dev:api` (Wrangler Pages dev with Functions) on port 8788.
    proxy: { "/api": "http://127.0.0.1:8788" },
  },
});
