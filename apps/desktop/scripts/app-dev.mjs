import { spawn } from "node:child_process";

const url = process.env.AGENA_RENDERER_URL ?? "http://localhost:5199";

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
