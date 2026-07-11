// Entry point: give the renderer a window.agena when no preload provided one
// (i.e. plain-browser `pnpm dev`). No-op inside the real Electron shell.
import { createMockBridge } from "./bridge.ts";

export function installMockBridge(): void {
  if (window.agena) return;
  window.agena = createMockBridge();
  console.info("[mock] installed mock AgenaBridge on window.agena");
}
