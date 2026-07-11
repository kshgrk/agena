// Renderer build. Runs standalone (`pnpm dev` → browser, mock bridge auto-installs
// when window.agena is absent). When main/preload land, electron-vite consumes this
// config as its renderer section — keep it free of Electron imports.
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// @agena/client's local-config.ts imports node:fs/os/path at module scope;
// vite's browser externalization throws on named-import access, killing the
// renderer graph at boot. Alias the builtins to a throw-on-call shim (the
// renderer never calls local-config — that IO lives in the Electron main).
const nodeShim = fileURLToPath(
  new URL("./src/renderer/lib/node-builtins-shim.ts", import.meta.url),
);

export default defineConfig(({ command }) => ({
  root: "src/renderer",
  // packaged builds load from file:// inside the asar — assets must be relative
  base: command === "build" ? "./" : "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "node:fs": nodeShim,
      "node:os": nodeShim,
      "node:path": nodeShim,
    },
  },
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    target: "es2023",
  },
  // AGENA_DEV_PORT lets a second local instance run beside the main one.
  // Default differs from apps/desktop (5199) so both apps can run side by side.
  server: {
    port: Number(process.env.AGENA_DEV_PORT ?? 5210),
    strictPort: true,
  },
}));
