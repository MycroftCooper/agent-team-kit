import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA is served by the backend on 127.0.0.1:1421 in production. During
// development Vite runs on 5173 and proxies /api to the backend, so the browser
// still only ever talks to one origin at a time.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:1421",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
