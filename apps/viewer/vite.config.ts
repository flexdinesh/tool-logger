import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: { "@": resolve(import.meta.dirname, "src/client") } },
  publicDir: false,
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: {
    // Vite 8 can leave speculative imports pending during shutdown. Transform on demand.
    preTransformRequests: false,
    // Node also allowlists frontend request paths before Vite runs.
    fs: {
      strict: true,
      allow: [
        resolve(import.meta.dirname, "src/client"),
        resolve(import.meta.dirname, "src/shared"),
        resolve(import.meta.dirname, "node_modules"),
        resolve(import.meta.dirname, "../../node_modules"),
      ],
    },
    allowedHosts: ["localhost", "127.0.0.1"],
  },
});
