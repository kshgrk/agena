import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AGENA_URL,
  loadOrCreateClientId,
  readAgenaLocalConfig,
  readAgenaLocalCredentials,
  resolveLocalClientConfig,
  writeAgenaLocalConfig,
  writeAgenaLocalCredentials,
} from "../src/local-config.ts";

const tempDirs: string[] = [];

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agena-local-config-"));
  tempDirs.push(dir);
  return dir;
}

describe("local config", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists a stable client id with private permissions", () => {
    const configDir = tempConfigDir();
    const first = loadOrCreateClientId({ configDir });
    const second = loadOrCreateClientId({ configDir });

    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(statSync(join(configDir, "client-id")).mode & 0o777).toBe(0o600);
  });

  it("reads and writes profiles and credentials", () => {
    const configDir = tempConfigDir();
    writeAgenaLocalConfig(
      {
        v: 1,
        defaultProfile: "work",
        profiles: {
          work: {
            workspaceId: "workspace-1",
            url: "http://127.0.0.1:7701",
            composeProject: "agena-work",
            createdAt: "2026-07-07T00:00:00.000Z",
          },
        },
      },
      { configDir },
    );
    writeAgenaLocalCredentials(
      { v: 1, profiles: { work: { token: "config-token" } } },
      { configDir },
    );

    expect(readAgenaLocalConfig({ configDir }).profiles.work?.url).toBe(
      "http://127.0.0.1:7701",
    );
    expect(readAgenaLocalCredentials({ configDir }).profiles.work?.token).toBe(
      "config-token",
    );
    expect(statSync(join(configDir, "credentials.json")).mode & 0o777).toBe(
      0o600,
    );
  });

  it("resolves flags, env, profile files, then localhost defaults", () => {
    const configDir = tempConfigDir();
    writeAgenaLocalConfig(
      {
        v: 1,
        defaultProfile: "work",
        profiles: { work: { url: "http://profile" } },
      },
      { configDir },
    );
    writeAgenaLocalCredentials(
      { v: 1, profiles: { work: { token: "profile-token" } } },
      { configDir },
    );

    expect(resolveLocalClientConfig({ configDir, env: {} })).toMatchObject({
      url: "http://profile",
      token: "profile-token",
      profile: "work",
    });
    expect(
      resolveLocalClientConfig({
        configDir,
        env: { AGENA_URL: "http://env", AGENA_TOKEN: "env-token" },
      }),
    ).toMatchObject({ url: "http://env", token: "env-token" });
    expect(
      resolveLocalClientConfig({
        configDir,
        url: "http://flag",
        token: "flag-token",
        env: { AGENA_URL: "http://env", AGENA_TOKEN: "env-token" },
      }),
    ).toMatchObject({ url: "http://flag", token: "flag-token" });
    expect(
      resolveLocalClientConfig({ configDir: tempConfigDir(), env: {} }),
    ).toMatchObject({
      url: DEFAULT_AGENA_URL,
    });
  });
});
