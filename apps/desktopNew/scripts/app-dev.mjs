import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

// `AGENA_TOKEN="$AGENA_MODAL_TOKEN"` expands to an empty override when the
// shell has not exported .env. Load the repository env before spawning Vite
// and Electron so the documented command works from a fresh terminal.
const explicitToken = Boolean(process.env.AGENA_TOKEN);
if (process.env.AGENA_TOKEN === "") delete process.env.AGENA_TOKEN;
if (process.env.AGENA_MODAL_TOKEN === "") delete process.env.AGENA_MODAL_TOKEN;
try {
  loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // Optional: explicit shell variables still work without a repository .env.
}
process.env.AGENA_URL ??= process.env.AGENA_RELEASE_URL;
if (
  !explicitToken &&
  process.env.AGENA_URL?.includes(".modal.run") &&
  process.env.AGENA_MODAL_TOKEN
) {
  process.env.AGENA_TOKEN = process.env.AGENA_MODAL_TOKEN;
} else {
  process.env.AGENA_TOKEN ??= process.env.AGENA_MODAL_TOKEN;
}

const port = process.env.AGENA_DEV_PORT ?? "5210";
const url = process.env.AGENA_RENDERER_URL ?? `http://localhost:${port}`;

const vite = spawn("vite", ["--host", "127.0.0.1", "--strictPort"], {
  stdio: "inherit",
  env: process.env,
});

const stop = () => {
  if (!vite.killed) vite.kill();
};

process.on("exit", stop);
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(143);
});

await waitFor(url);

const electron = spawn("electron", ["."], {
  stdio: "inherit",
  env: process.env,
});

electron.on("exit", (code, signal) => {
  stop();
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

async function waitFor(target) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) break;
    try {
      const res = await fetch(target);
      if (res.ok) return;
    } catch {
      // server still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  stop();
  throw new Error(`renderer did not start at ${target}`);
}
