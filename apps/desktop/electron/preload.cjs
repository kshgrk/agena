// Preload: exposes the REAL bridge transport (window.agenaPreload — a thin
// invoke/stream surface the renderer's lib/bridge.ts adapts into AgenaBridge)
// plus window.agenaShell (native picker/capture for the mock/browser path).
// Never defines window.agena: errors must cross as data ({ok,error}) because
// contextBridge strips custom props from thrown Errors, and the renderer
// needs error.code (SESSION_BUSY → steer conversion etc).
const { contextBridge, ipcRenderer } = require("electron");

const useMock = process.argv.includes("--agena-mock");

if (!useMock) {
  contextBridge.exposeInMainWorld("agenaPreload", {
    invoke: (method, args) =>
      ipcRenderer.invoke("agena:invoke", { method, args }),
    onBatch: (cb) => {
      const handler = (_event, batch) => cb(batch);
      ipcRenderer.on("agena:batch", handler);
      return () => ipcRenderer.removeListener("agena:batch", handler);
    },
    onStatus: (cb) => {
      const handler = (_event, s) => cb(s.state, s.detail);
      ipcRenderer.on("agena:status", handler);
      return () => ipcRenderer.removeListener("agena:status", handler);
    },
  });

  // PTY MessagePorts can't cross contextBridge return values; they hop via
  // window.postMessage transfer into the main world (lib/bridge.ts catches
  // them keyed by ptyId).
  ipcRenderer.on("agena:pty-port", (event, msg) => {
    window.postMessage(
      { type: "agena:pty-port", ptyId: msg.ptyId },
      "*",
      event.ports,
    );
  });
}

contextBridge.exposeInMainWorld("agenaShell", {
  pickFolder: () => ipcRenderer.invoke("agena-shell:pick-folder"),
  readFolder: (path) => ipcRenderer.invoke("agena-shell:read-folder", path),
});
