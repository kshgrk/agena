import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const desktopRenderer = new URL(
  "../desktopChamber/src/renderer/",
  import.meta.url,
);
const nodeShim = fileURLToPath(
  new URL("lib/node-builtins-shim.ts", desktopRenderer),
);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  resolve: {
    alias: {
      "node:fs": nodeShim,
      "node:os": nodeShim,
      "node:path": nodeShim,
    },
  },
  build: { outDir: "dist", emptyOutDir: true, target: "es2023" },
  server: { port: 5220, strictPort: true },
});
