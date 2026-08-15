import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface PiPackageRecord {
  source: string;
  enabled: boolean;
  installed: boolean;
}

interface PackageState {
  packages: Array<Omit<PiPackageRecord, "installed">>;
}

export interface PiPackageServiceOptions {
  piDir: string;
}

/**
 * Installs exact-pinned Pi packages under PI_DIR and exposes only explicitly
 * enabled sources to newly created Agena sessions.
 */
export class PiPackageService {
  readonly extensionSources: string[] = [];
  readonly #statePath: string;
  readonly #manager: DefaultPackageManager;
  #records: PackageState["packages"];

  constructor(options: PiPackageServiceOptions) {
    this.#statePath = join(options.piDir, "agena-packages.json");
    this.#manager = new DefaultPackageManager({
      cwd: options.piDir,
      agentDir: options.piDir,
      settingsManager: SettingsManager.create(options.piDir, options.piDir),
    });
    this.#records = readState(this.#statePath);
    this.#syncSources();
  }

  list(): PiPackageRecord[] {
    return this.#records.map((record) => ({
      ...record,
      installed: this.#installed(record.source),
    }));
  }

  async install(source: string): Promise<void> {
    assertExactPackageSource(source);
    const existing = this.#records.find((record) => record.source === source);
    if (existing && this.#installed(source)) return;
    await this.#manager.install(source);
    if (existing) {
      this.#syncSources();
      return;
    }
    this.#records.push({ source, enabled: true });
    try {
      writeState(this.#statePath, this.#records);
    } catch (error) {
      this.#records.pop();
      await this.#manager.remove(source).catch(() => {});
      throw error;
    }
    this.#syncSources();
  }

  async remove(source: string): Promise<void> {
    const index = this.#records.findIndex((record) => record.source === source);
    if (index === -1) return;
    const [record] = this.#records.splice(index, 1);
    try {
      writeState(this.#statePath, this.#records);
    } catch (error) {
      if (record) this.#records.splice(index, 0, record);
      throw error;
    }
    try {
      await this.#manager.remove(source);
    } catch (error) {
      if (record) this.#records.splice(index, 0, record);
      writeState(this.#statePath, this.#records);
      throw error;
    }
    this.#syncSources();
  }

  async setEnabled(source: string, enabled: boolean): Promise<void> {
    const record = this.#records.find(
      (candidate) => candidate.source === source,
    );
    if (!record) throw new Error(`Pi package is not installed: ${source}`);
    if (record.enabled === enabled) return;
    const previous = record.enabled;
    record.enabled = enabled;
    try {
      this.#changed();
    } catch (error) {
      record.enabled = previous;
      writeState(this.#statePath, this.#records);
      throw error;
    }
  }

  async update(source: string, replacement: string): Promise<void> {
    assertExactPackageSource(replacement);
    const record = this.#records.find(
      (candidate) => candidate.source === source,
    );
    if (!record) throw new Error(`Pi package is not installed: ${source}`);
    if (source === replacement) return;
    await this.#manager.install(replacement);
    record.source = replacement;
    try {
      writeState(this.#statePath, this.#records);
    } catch (error) {
      record.source = source;
      await this.#manager.remove(replacement).catch(() => {});
      throw error;
    }
    await this.#manager.remove(source).catch(() => {});
    this.#syncSources();
  }

  #changed(): void {
    writeState(this.#statePath, this.#records);
    this.#syncSources();
  }

  #syncSources(): void {
    this.extensionSources.splice(
      0,
      this.extensionSources.length,
      ...this.#records.flatMap((record) => {
        if (!record.enabled) return [];
        const path = this.#manager.getInstalledPath(record.source, "user");
        return path ? [path] : [];
      }),
    );
  }

  #installed(source: string): boolean {
    const path = this.#manager.getInstalledPath(source, "user");
    return path !== undefined && existsSync(path);
  }
}

export function assertExactPackageSource(source: string): void {
  const npm =
    /^npm:(?:@[^/@]+\/[^/@]+|[^/@]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
  const git = /^(?:git\+https:\/\/|https:\/\/|git@)[^#]+#[0-9a-f]{40}$/i;
  if (!npm.test(source) && !git.test(source)) {
    throw new Error(
      `Pi packages must use an exact npm version or Git commit: ${source}`,
    );
  }
}

function readState(path: string): PackageState["packages"] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as PackageState;
  if (!Array.isArray(parsed.packages))
    throw new Error("invalid Pi package state");
  return parsed.packages.map((record) => {
    assertExactPackageSource(record.source);
    if (typeof record.enabled !== "boolean") {
      throw new Error("invalid Pi package enabled state");
    }
    return { source: record.source, enabled: record.enabled };
  });
}

function writeState(path: string, packages: PackageState["packages"]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ packages }, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
}
