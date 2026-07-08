// Renderer build. Runs standalone (`pnpm dev` → browser, mock bridge auto-installs
// when window.agena is absent). When main/preload land, electron-vite consumes this
// config as its renderer section — keep it free of Electron imports.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  root: "src/renderer",
  // packaged builds load from file:// inside the asar — assets must be relative
  base: command === "build" ? "./" : "/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    target: "es2023",
  },
  // AGENA_DEV_PORT lets a second local instance run beside the main one
  server: { port: Number(process.env.AGENA_DEV_PORT ?? 5199), strictPort: true },
}));
