// Entry (§9.2 M1 subset): env → config → runtime adapter → serve.
import type { RuntimeAdapter } from "@agena/core";
import { FakeRuntimeAdapter } from "@agena/core/testing";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { startDaemon } from "./server.ts";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  // Dynamic import keeps the Pi SDK out of fake-runtime runs (tests/demo).
  const adapter: RuntimeAdapter =
    config.runtime === "fake"
      ? new FakeRuntimeAdapter()
      : new (await import("@agena/runtime-pi")).PiRuntimeAdapter();
  const daemon = await startDaemon(config, adapter);
  log("info", "daemon listening", {
    host: config.host,
    port: daemon.port,
    runtime: config.runtime,
    workspaceDir: config.workspaceDir,
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    // ponytail: §9.7 graceful drain is M2 — M1 closes and exits
    process.once(signal, () => {
      log("info", "shutting down", { signal });
      void daemon.close().then(() => process.exit(0));
    });
  }
}

main().catch((err: unknown) => {
  log("error", "daemon failed to start", { err: String(err) });
  process.exit(1);
});
