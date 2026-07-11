// Electron main: opens the renderer and hosts the REAL AgenaBridge
// (bridge.mjs — @agena/client against the daemon; D-INV-2: the token lives
// here, never in the renderer). Set AGENA_MOCK=1 to skip the real bridge and
// fall back to the renderer's mock (window.agenaShell still gives Finder).
// Daemon endpoint: AGENA_URL / AGENA_TOKEN env, defaulting to the local
// docker workspace (127.0.0.1:7700, dev token).
import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  Notification,
  shell,
} from "electron";
import { createBridgeHost } from "./bridge.mjs";
import { notificationForEvent } from "./native-notification.mjs";

const DEV_PORT = process.env.AGENA_DEV_PORT ?? "5210";
const RENDERER_URL =
  process.env.AGENA_RENDERER_URL ?? `http://localhost:${DEV_PORT}`;

// Packaged builds carry dist-config.json (written by scripts/bundle-main.mjs
// from .env at package time — never committed): the release connects to the
// Modal daemon out of the box. Env vars still override for dev/testing.
function loadDistConfig() {
  try {
    return JSON.parse(
      readFileSync(
        fileURLToPath(new URL("./dist-config.json", import.meta.url)),
        "utf8",
      ),
    );
  } catch {
    return null;
  }
}
const distConfig = loadDistConfig();
const AGENA_URL =
  process.env.AGENA_URL ?? distConfig?.url ?? "http://127.0.0.1:7700";
const AGENA_TOKEN = process.env.AGENA_TOKEN ?? distConfig?.token ?? "dev";
const USE_MOCK = process.env.AGENA_MOCK === "1";
const preload = fileURLToPath(new URL("./preload.cjs", import.meta.url));

// Folder-capture caps for the mock-ingestion path (agena-shell:read-folder).
// The real bridge copies via tar instead; these bound only the mock's memory.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  ".venv",
  "__pycache__",
  ".DS_Store",
]);
const MAX_FILES = 400;
const MAX_TEXT_BYTES = 128 * 1024;

async function captureFolder(root) {
  const files = [];
  const queue = [root];
  while (queue.length > 0 && files.length < MAX_FILES) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile()) {
        try {
          const info = await stat(full);
          let text = null;
          if (info.size <= MAX_TEXT_BYTES) {
            const buf = await readFile(full);
            if (!buf.subarray(0, 1024).includes(0)) text = buf.toString("utf8");
          }
          files.push({ path: relative(root, full), size: info.size, text });
        } catch {
          // unreadable file — skip
        }
      }
    }
  }
  return { name: basename(root), files };
}

// A non-default dev port marks a parallel test instance: give it its own
// userData so persisted state and the Chromium profile lock never collide
// with the main instance.
if (process.env.AGENA_DEV_PORT && process.env.AGENA_DEV_PORT !== "5210") {
  app.setPath(
    "userData",
    `${app.getPath("userData")}-dev${process.env.AGENA_DEV_PORT}`,
  );
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0c0e13",
    title: "Agena",
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: USE_MOCK ? ["--agena-mock"] : [],
    },
  });

  // SECURITY: transcript markdown renders model-authored links, so window.open
  // / target=_blank (incl. middle-click) reach here with untrusted URLs. A
  // child window would inherit this window's preload — handing remote content
  // the full agenaPreload bridge (openPty = command execution). Never create
  // children: http(s)/mailto go to the OS browser, everything else is dropped.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // The renderer is a single-page app: block navigation away from its origin
  // (same-origin stays allowed so dev-server reloads keep working).
  win.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin === new URL(win.webContents.getURL()).origin) {
        return;
      }
    } catch {
      // unparseable target → block
    }
    event.preventDefault();
  });

  const pickFolder = async () => {
    const result = await dialog.showOpenDialog(win, {
      title: "Open project folder",
      buttonLabel: "Open project",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  };

  // native picker + capture for the mock/browser path (window.agenaShell)
  ipcMain.handle("agena-shell:pick-folder", () => pickFolder());
  ipcMain.handle("agena-shell:read-folder", (_event, path) => {
    if (typeof path !== "string" || !path.startsWith("/")) return null;
    return captureFolder(path);
  });

  // the real bridge (window.agenaPreload → agena:invoke)
  const host = createBridgeHost({
    url: AGENA_URL,
    token: AGENA_TOKEN,
    userData: app.getPath("userData"),
    getWindow: () => win,
    broadcast: (channel, payload) => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send(channel, payload);
      }
    },
    notify: (event, replayed) => {
      if (win.isFocused() || !Notification.isSupported()) return;
      const content = notificationForEvent(event, replayed);
      if (!content) return;
      const notification = new Notification(content);
      notification.on("click", () => {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      });
      notification.show();
    },
  });
  ipcMain.handle("agena:invoke", async (event, req) => {
    const method = req?.method;
    const args = Array.isArray(req?.args) ? req.args : [];
    try {
      const value = await host.call(method, args, {
        pickFolder,
        makePorts: () => new MessageChannelMain(),
        sendPort: (ptyId, port) =>
          event.sender.postMessage("agena:pty-port", { ptyId }, [port]),
      });
      return { ok: true, value };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: typeof err?.code === "string" ? err.code : "INTERNAL",
          message: err?.message ?? String(err),
          retryable: err?.retryable === true,
        },
      };
    }
  });

  app.on("before-quit", () => void host.dispose());
  if (app.isPackaged) {
    void win.loadFile("dist/renderer/index.html");
  } else {
    void win.loadURL(RENDERER_URL);
  }
});

app.on("window-all-closed", () => app.quit());
