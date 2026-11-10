import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA is served by the backend on 127.0.0.1:1421 in production. During
// development Vite runs on 5173 and proxies /api to the backend, so the browser
// still only ever talks to one origin at a time.
const backendUrl = "http://127.0.0.1:1421";
export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: command === "serve" ? { "import.meta.env.VITE_ATK_AGENT_URL": JSON.stringify(backendUrl) } : {},
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api/v1/": {
        target: backendUrl,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
}));
