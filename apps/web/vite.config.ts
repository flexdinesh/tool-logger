import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: { "@": resolve(import.meta.dirname, "src/client") } },
  publicDir: false,
  plugins: [react(), tailwindcss()],
  build: { outDir: "../../packages/webui/dist", emptyOutDir: true, sourcemap: false },
  server: {
    host: "127.0.0.1", port: 5173, strictPort: true, preTransformRequests: false,
    allowedHosts: ["localhost", "127.0.0.1"],
    fs: { strict: true, allow: [resolve(import.meta.dirname, ".."), resolve(import.meta.dirname, "../../node_modules")] },
  },
});
