import { createJiti } from "jiti";

export interface PiMcpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  auth?: "oauth" | "bearer" | false;
  oauth?: { redirectUri?: string } | false;
  lifecycle?: "keep-alive" | "lazy" | "eager";
}

type AuthFlow = {
  startAuth(
    name: string,
    url: string,
    definition?: PiMcpServerEntry,
  ): Promise<{ authorizationUrl: string }>;
  completeAuthFromInput(name: string, input: string): Promise<string>;
};

type AuthStore = {
  removeAuthEntry(serverName: string): void;
};

let authFlow: Promise<AuthFlow> | undefined;
function loadAuthFlow(): Promise<AuthFlow> {
  authFlow ??= createJiti(import.meta.url).import(
    "pi-mcp-adapter/mcp-auth-flow.ts",
  ) as Promise<AuthFlow>;
  return authFlow;
}

let authStore: Promise<AuthStore> | undefined;
function loadAuthStore(): Promise<AuthStore> {
  authStore ??= createJiti(import.meta.url).import(
    "pi-mcp-adapter/mcp-auth.ts",
  ) as Promise<AuthStore>;
  return authStore;
}

export async function startAuth(
  name: string,
  url: string,
  definition?: PiMcpServerEntry,
): Promise<{ authorizationUrl: string }> {
  return (await loadAuthFlow()).startAuth(name, url, definition);
}

export async function completeAuthFromInput(
  name: string,
  input: string,
): Promise<string> {
  return (await loadAuthFlow()).completeAuthFromInput(name, input);
}

export async function removeMcpAuth(name: string): Promise<void> {
  (await loadAuthStore()).removeAuthEntry(name);
}
