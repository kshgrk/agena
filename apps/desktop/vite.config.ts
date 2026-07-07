// Renderer build. Runs standalone (`pnpm dev` → browser, mock bridge auto-installs
// when window.agena is absent). When main/preload land, electron-vite consumes this
// config as its renderer section — keep it free of Electron imports.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    target: "es2023",
  },
  server: { port: 5199 },
});
