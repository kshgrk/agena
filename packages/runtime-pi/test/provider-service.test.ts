import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { PiProviderService } from "../src/provider-service.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function piDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agena-provider-"));
  dirs.push(dir);
  return dir;
}

test("persists API-key credentials and provider-scoped environment", async () => {
  const dir = piDir();
  const changed = vi.fn();
  const service = new PiProviderService({
    piDir: dir,
    onCredentialsChanged: changed,
  });
  const summary = await service.saveApiKey("example", "secret-value", {
    EXAMPLE_REGION: "test",
  });

  expect(summary).toMatchObject({
    id: "example",
    methods: ["api_key"],
    configured: true,
    credentialKind: "api_key",
  });
  expect(JSON.stringify(summary)).not.toContain("secret-value");
  expect(changed).toHaveBeenCalledTimes(1);
  expect(statSync(join(dir, "auth.json")).mode & 0o777).toBe(0o600);

  const restarted = new PiProviderService({ piDir: dir });
  expect(restarted.authStorage.getProviderEnv("example")).toEqual({
    EXAMPLE_REGION: "test",
  });
  expect(await restarted.authStorage.getApiKey("example")).toBe("secret-value");
  expect((await restarted.remove("example")).configured).toBe(false);
});

test("reload observes credentials written by another runtime", async () => {
  const dir = piDir();
  const service = new PiProviderService({ piDir: dir });
  const other = new PiProviderService({ piDir: dir });
  await other.saveApiKey("external", "new-value");
  expect(service.authStorage.has("external")).toBe(false);
  await service.reload();
  expect(service.status("external")).toMatchObject({
    configured: true,
    credentialKind: "api_key",
  });
});

test("delegates OAuth interaction to Pi callbacks and persists its result", async () => {
  const dir = piDir();
  const service = new PiProviderService({ piDir: dir });
  service.modelRegistry.registerProvider("test-oauth", {
    oauth: {
      name: "Test OAuth",
      async login(callbacks) {
        callbacks.onAuth({ url: "https://example.test/authorize" });
        const code = await callbacks.onPrompt({ message: "Code" });
        return {
          access: `access-${code}`,
          refresh: "refresh",
          expires: Date.now() + 60_000,
        };
      },
      async refreshToken(credentials) {
        return credentials;
      },
      getApiKey(credentials) {
        return credentials.access;
      },
    },
  });
  const onAuth = vi.fn();
  const result = await service.loginOAuth("test-oauth", {
    onAuth,
    onDeviceCode: vi.fn(),
    onPrompt: async () => "ok",
    onSelect: async () => undefined,
  });

  expect(onAuth).toHaveBeenCalledWith({
    url: "https://example.test/authorize",
  });
  expect(result).toMatchObject({
    id: "test-oauth",
    methods: ["oauth"],
    configured: true,
    credentialKind: "oauth",
  });
  expect(readFileSync(join(dir, "auth.json"), "utf8")).toContain('"refresh"');
});

test("advertises Pi's pinned OAuth-only provider capabilities", () => {
  const service = new PiProviderService({ piDir: piDir() });
  expect(service.status("github-copilot").methods).toEqual(["oauth"]);
  expect(service.status("openai-codex").methods).toEqual(["oauth"]);
  expect(service.status("anthropic").methods).toEqual(["api_key", "oauth"]);
});

test("rejects API-key saves for Pi OAuth-only providers", async () => {
  const service = new PiProviderService({ piDir: piDir() });
  await expect(
    service.saveApiKey("github-copilot", "not-supported"),
  ).rejects.toThrow("does not support API-key login");
  await expect(
    service.saveApiKey("openai-codex", "not-supported"),
  ).rejects.toThrow("does not support API-key login");
});

test("rejects false success when the durable credential mutation does not stick", async () => {
  const service = new PiProviderService({ piDir: piDir() });
  vi.spyOn(service.authStorage, "set").mockImplementation(() => {});
  await expect(service.saveApiKey("example", "secret")).rejects.toThrow(
    "failed to persist API key",
  );
  vi.restoreAllMocks();

  await service.saveApiKey("example", "secret");
  vi.spyOn(service.authStorage, "remove").mockImplementation(() => {});
  await expect(service.remove("example")).rejects.toThrow(
    "failed to remove credential",
  );
});

test("rejects false OAuth success when login returns without durable credentials", async () => {
  const service = new PiProviderService({ piDir: piDir() });
  service.modelRegistry.registerProvider("test-oauth", {
    oauth: {
      name: "Test OAuth",
      async login() {
        return {
          access: "unused",
          refresh: "unused",
          expires: Date.now() + 60_000,
        };
      },
      async refreshToken(credentials) {
        return credentials;
      },
      getApiKey(credentials) {
        return credentials.access;
      },
    },
  });
  vi.spyOn(service.authStorage, "login").mockResolvedValue(undefined);
  await expect(
    service.loginOAuth("test-oauth", {
      onAuth: vi.fn(),
      onDeviceCode: vi.fn(),
      onPrompt: async () => "",
      onSelect: async () => undefined,
    }),
  ).rejects.toThrow("failed to persist OAuth credential");
});
