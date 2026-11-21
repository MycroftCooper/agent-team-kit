import { fileURLToPath } from "node:url";
import { createServer } from "vite";

export async function startDevWeb({ backendUrl, port, waitForBackend }) {
  const server = await createServer({
    root: fileURLToPath(new URL(".", import.meta.url)),
    define: { "import.meta.env.VITE_ATK_AGENT_URL": JSON.stringify(backendUrl) },
    plugins: waitForBackend ? [{
      name: "atk-backend-reload",
      configureServer(server) { server.middlewares.use("/api/v1", waitForBackend); },
    }] : [],
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      cors: false,
      fs: { allow: [".", "../../packages/contracts", "../../node_modules"].map(
        (directory) => fileURLToPath(new URL(directory, import.meta.url)),
      ) },
      proxy: { "/api/v1/": { target: backendUrl, changeOrigin: false } },
    },
  });
  try {
    return await server.listen();
  } catch (error) {
    await server.close();
    throw error;
  }
}
