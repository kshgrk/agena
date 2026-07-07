import { execFile as execFileCb } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EventStore, SessionRecord, SnapshotStore } from "@agena/core";
import type { SnapshotSummary } from "@agena/protocol";

const execFile = promisify(execFileCb);

type SnapshotInput = {
  name?: string;
  sessionId?: string;
  kind?: SnapshotSummary["kind"];
};

type RestoreJournal = {
  snapshotId: string;
  safetySnapshotId: string;
  safetyPath: string;
  sessionId?: string;
};

export class SnapshotManager {
  readonly #store: EventStore;
  readonly #snapshots: SnapshotStore | null;
  readonly #workspaceDir: string;
  readonly #snapshotDir: string;
  readonly #journalPath: string;
  readonly #controlSession: SessionRecord;

  constructor(
    store: EventStore,
    workspaceDir: string,
    stateDir: string,
    controlSession: SessionRecord,
  ) {
    this.#store = store;
    this.#snapshots = snapshotStore(store);
    this.#workspaceDir = workspaceDir;
    this.#snapshotDir = join(stateDir, "snapshots");
    this.#journalPath = join(this.#snapshotDir, "restore-journal.json");
    this.#controlSession = controlSession;
    mkdirSync(this.#snapshotDir, { recursive: true });
  }

  async list(): Promise<SnapshotSummary[]> {
    return (await this.#snapshots?.listSnapshots()) ?? [];
  }

  async create(input: SnapshotInput = {}): Promise<SnapshotSummary> {
    const snapshot = await this.#createRecord(input);
    await this.#appendControl("snapshot.created", {
      snapshotId: snapshot.snapshotId,
      workspaceId: snapshot.workspaceId,
      ...(snapshot.name ? { name: snapshot.name } : {}),
      kind: snapshot.kind,
      storage: {
        backend: "tar",
        path: snapshot.storagePath,
        sha256: snapshot.sha256,
        sizeBytes: snapshot.sizeBytes,
      },
      ...(snapshot.sessionId
        ? { triggeredBySessionId: snapshot.sessionId }
        : {}),
    });
    return snapshot;
  }

  async restore(
    snapshotId: string,
    input: { sessionId?: string } = {},
  ): Promise<{ snapshotId: string; safetySnapshotId: string }> {
    const target = (await this.list()).find(
      (s) => s.snapshotId === snapshotId && s.status === "available",
    );
    if (!target) throw new Error("SNAPSHOT_NOT_FOUND");
    const safety = await this.create({
      name: `pre-restore ${snapshotId}`,
      kind: "pre_restore",
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
    writeFileSync(
      this.#journalPath,
      JSON.stringify(
        {
          snapshotId,
          safetySnapshotId: safety.snapshotId,
          safetyPath: safety.storagePath,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        } satisfies RestoreJournal,
        null,
        2,
      ),
    );
    try {
      await replaceWorkspace(this.#workspaceDir, target.storagePath);
      rmSync(this.#journalPath, { force: true });
      await this.#appendControl("snapshot.restored", {
        snapshotId,
        safetySnapshotId: safety.snapshotId,
        ...(input.sessionId ? { triggeredBySessionId: input.sessionId } : {}),
      });
      return { snapshotId, safetySnapshotId: safety.snapshotId };
    } catch (err) {
      await this.#appendControl("snapshot.restore_failed", {
        snapshotId,
        safetySnapshotId: safety.snapshotId,
        error: { code: "restore_failed", message: message(err) },
      });
      throw err;
    }
  }

  async delete(snapshotId: string): Promise<void> {
    await this.#snapshots?.markSnapshotDeleted(snapshotId);
    await this.#appendControl("snapshot.deleted", { snapshotId });
  }

  async recoverJournal(): Promise<void> {
    let journal: RestoreJournal;
    try {
      journal = JSON.parse(readFileSync(this.#journalPath, "utf8"));
    } catch {
      return;
    }
    try {
      await replaceWorkspace(this.#workspaceDir, journal.safetyPath);
      await this.#appendControl("snapshot.restore_failed", {
        snapshotId: journal.snapshotId,
        safetySnapshotId: journal.safetySnapshotId,
        error: {
          code: "restore_incomplete",
          message: "restored safety snapshot after interrupted restore",
        },
      });
    } finally {
      rmSync(this.#journalPath, { force: true });
    }
  }

  async #createRecord(input: SnapshotInput): Promise<SnapshotSummary> {
    if (!this.#snapshots) {
      throw new Error("SNAPSHOTS_UNSUPPORTED");
    }
    const snapshotId = randomUUID();
    const storagePath = join(this.#snapshotDir, `${snapshotId}.tar.gz`);
    await execFile("tar", ["-czf", storagePath, "-C", this.#workspaceDir, "."]);
    return this.#snapshots.createSnapshotRecord({
      snapshotId,
      workspaceId: "default",
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.name ? { name: input.name } : {}),
      kind: input.kind ?? "manual",
      storagePath,
      sha256: await sha256File(storagePath),
      sizeBytes: statSync(storagePath).size,
    });
  }

  async #appendControl(type: string, payload: unknown): Promise<void> {
    await this.#store.appendEvents({
      sessionId: this.#controlSession.sessionId,
      branchId: this.#controlSession.rootBranchId,
      events: [{ type, v: 1, source: { kind: "daemon" }, payload }],
    });
  }
}

async function replaceWorkspace(workspaceDir: string, archivePath: string) {
  for (const entry of readdirSync(workspaceDir)) {
    rmSync(join(workspaceDir, entry), { recursive: true, force: true });
  }
  await execFile("tar", ["-xzf", archivePath, "-C", workspaceDir]);
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(`sha256:${hash.digest("hex")}`));
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function snapshotStore(store: EventStore): SnapshotStore | null {
  return "createSnapshotRecord" in store &&
    "listSnapshots" in store &&
    "markSnapshotDeleted" in store
    ? (store as EventStore & SnapshotStore)
    : null;
}
