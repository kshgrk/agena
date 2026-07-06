// §9.9 env config — M1 subset. ponytail: daemon.json overlay, Zod validation,
// workspaceId check, storage/pty/limits/shutdown blocks land with M2's state tree.

export interface DaemonConfig {
  host: string;
  port: number;
  token: string;
  runtime: "pi" | "fake";
  workspaceDir: string;
  stateDir: string;
  storage?: "memory" | "sqlite";
}

export function loadConfig(
  env: Record<string, string | undefined>,
): DaemonConfig {
  // AGENA_AUTH_TOKEN is the §3.2 canonical name; AGENA_TOKEN accepted as alias.
  const token = env.AGENA_AUTH_TOKEN ?? env.AGENA_TOKEN;
  if (!token) {
    throw new Error(
      "AGENA_AUTH_TOKEN is required — refusing to start without an auth token",
    );
  }
  const runtime = env.AGENA_RUNTIME ?? "pi";
  if (runtime !== "pi" && runtime !== "fake") {
    throw new Error(`AGENA_RUNTIME must be "pi" or "fake", got "${runtime}"`);
  }
  const port = env.AGENA_PORT === undefined ? 7777 : Number(env.AGENA_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `AGENA_PORT must be an integer port, got "${env.AGENA_PORT}"`,
    );
  }
  return {
    host: env.AGENA_HOST ?? "0.0.0.0",
    port,
    token,
    runtime,
    workspaceDir: env.AGENA_WORKSPACE_DIR ?? "/workspace",
    stateDir: env.AGENA_STATE_DIR ?? "/var/lib/agena",
    storage: (env.AGENA_STORAGE as "memory" | "sqlite" | undefined) ?? "sqlite",
  };
}
