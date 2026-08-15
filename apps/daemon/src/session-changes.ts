import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { EventStore, SessionRecord } from "@agena/core";
import { resolveWorkspacePath } from "@agena/core";
import type {
  AgenaEvent,
  GitBaselineRecorded,
  GitChangedFile,
  GitCommitChange,
  GitCurrentChanges,
  GitHeadObserved,
  GitWorktreeChanges,
  SessionChangeDiffQuery,
  SessionChangeDiffResponse,
  SessionChangesResponse,
} from "@agena/protocol";

type GitResult = { code: number; stdout: Buffer; stderr: Buffer };
type WorktreeState = {
  id: string;
  root: string;
  absoluteRoot: string;
  cwd: string;
  branch?: string;
  head?: string;
  detached: boolean;
  unborn: boolean;
};
type CommitDetails = Omit<
  GitCommitChange,
  "observedAt" | "observationSeq" | "state"
>;

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_TEXT_FILE = 2 * 1024 * 1024;

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) child.kill();
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }),
    );
  });
}

async function gitText(
  cwd: string,
  args: string[],
  allowFailure = false,
): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0 && !allowFailure) {
    throw new Error(
      result.stderr.toString("utf8").trim() || `git ${args[0]} failed`,
    );
  }
  return result.code === 0 ? result.stdout.toString("utf8") : "";
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function worktreeId(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

function emptyCurrent(): GitCurrentChanges {
  return { staged: [], unstaged: [], untracked: [], conflicts: [] };
}

function statusKind(code: string): GitChangedFile["status"] {
  if (code.includes("U") || ["AA", "DD"].includes(code)) return "conflict";
  if (code === "??") return "untracked";
  if (code.includes("R")) return "renamed";
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  return "modified";
}

function parseNumstat(
  text: string,
): Map<string, Pick<GitChangedFile, "additions" | "deletions" | "binary">> {
  const out = new Map<
    string,
    Pick<GitChangedFile, "additions" | "deletions" | "binary">
  >();
  for (const row of text.split("\0")) {
    if (!row) continue;
    const [adds = "0", dels = "0", path = ""] = row.split("\t");
    if (!path) continue;
    const binary = adds === "-" || dels === "-";
    out.set(path, {
      additions: binary ? 0 : Number.parseInt(adds, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(dels, 10) || 0,
      binary,
    });
  }
  return out;
}

function file(
  path: string,
  status: GitChangedFile["status"],
  stats?: Pick<GitChangedFile, "additions" | "deletions" | "binary">,
  previousPath?: string,
): GitChangedFile {
  return {
    path,
    status,
    additions: stats?.additions ?? 0,
    deletions: stats?.deletions ?? 0,
    binary: stats?.binary ?? false,
    ...(previousPath ? { previousPath } : {}),
  };
}

async function currentChanges(state: WorktreeState) {
  const [statusText, stagedText, unstagedText] = await Promise.all([
    gitText(state.absoluteRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]),
    gitText(state.absoluteRoot, [
      "diff",
      "--cached",
      "--numstat",
      "-z",
      "--no-renames",
    ]),
    gitText(state.absoluteRoot, ["diff", "--numstat", "-z", "--no-renames"]),
  ]);
  const stagedStats = parseNumstat(stagedText);
  const unstagedStats = parseNumstat(unstagedText);
  const current = emptyCurrent();
  const rows = statusText.split("\0");
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row || row.length < 4) continue;
    const code = row.slice(0, 2);
    const path = row.slice(3);
    const renamed = code.includes("R");
    const previousPath = renamed ? rows[++index] : undefined;
    const kind = statusKind(code);
    if (kind === "conflict") {
      current.conflicts.push(file(path, kind, undefined, previousPath));
      continue;
    }
    if (kind === "untracked") {
      let stats: Pick<GitChangedFile, "additions" | "deletions" | "binary"> = {
        additions: 0,
        deletions: 0,
        binary: false,
      };
      try {
        const bytes = await readFile(join(state.absoluteRoot, path));
        const binary = bytes.subarray(0, 1024).includes(0);
        const text = binary ? "" : bytes.toString("utf8");
        stats = {
          additions:
            text === ""
              ? 0
              : text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
          deletions: 0,
          binary,
        };
      } catch {
        // The file may disappear between status and read; the next refresh heals it.
      }
      current.untracked.push(file(path, kind, stats));
      continue;
    }
    const [x, y] = code;
    if (x && x !== " ") {
      current.staged.push(
        file(path, kind, stagedStats.get(path), previousPath),
      );
    }
    if (y && y !== " ") {
      current.unstaged.push(
        file(path, kind, unstagedStats.get(path), previousPath),
      );
    }
  }
  return current;
}

async function commitFiles(
  root: string,
  oid: string,
): Promise<{ files: GitChangedFile[]; additions: number; deletions: number }> {
  const parents = (
    await gitText(root, ["rev-list", "--parents", "-n", "1", oid])
  )
    .trim()
    .split(/\s+/);
  const parent = parents[1] ?? EMPTY_TREE;
  const [names, nums] = await Promise.all([
    gitText(root, ["diff", "--name-status", "-z", "--no-renames", parent, oid]),
    gitText(root, ["diff", "--numstat", "-z", "--no-renames", parent, oid]),
  ]);
  const stats = parseNumstat(nums);
  const fields = names.split("\0");
  const files: GitChangedFile[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const code = fields[index];
    const path = fields[index + 1];
    if (!code || !path) continue;
    files.push(file(path, statusKind(code), stats.get(path)));
  }
  return {
    files,
    additions: files.reduce((sum, item) => sum + item.additions, 0),
    deletions: files.reduce((sum, item) => sum + item.deletions, 0),
  };
}

async function commit(
  state: WorktreeState,
  oid: string,
  observedAt: string,
  observationSeq: number,
  cache: Map<string, Promise<CommitDetails | null>>,
): Promise<GitCommitChange | null> {
  const key = `${state.absoluteRoot}\0${oid}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      const metadata = await gitText(
        state.absoluteRoot,
        ["show", "-s", "--format=%H%x00%h%x00%s%x00%an%x00%cI", oid],
        true,
      );
      if (!metadata) return null;
      const [
        fullOid = oid,
        shortOid = oid.slice(0, 7),
        title = "",
        author = "",
        committedAt = observedAt,
      ] = metadata.replace(/\n$/, "").split("\0");
      return {
        oid: fullOid,
        shortOid,
        title,
        author,
        committedAt,
        ...(await commitFiles(state.absoluteRoot, fullOid)),
      };
    })().catch((error) => {
      cache.delete(key);
      throw error;
    });
    if (cache.size >= 500) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(key, pending);
  }
  const details = await pending;
  if (!details) return null;
  const reachable = state.head
    ? (
        await runGit(state.absoluteRoot, [
          "merge-base",
          "--is-ancestor",
          details.oid,
          state.head,
        ])
      ).code === 0
    : false;
  return {
    ...details,
    observedAt,
    observationSeq,
    state: reachable ? "current" : "abandoned",
  };
}

async function readAllEvents(
  store: EventStore,
  sessionId: string,
): Promise<AgenaEvent[]> {
  const events: AgenaEvent[] = [];
  let fromSeq = 0;
  for (;;) {
    const page = await store.readEvents(sessionId, fromSeq, 2_500);
    events.push(...page.events);
    if (page.nextFromSeq === null) return events;
    fromSeq = page.nextFromSeq;
  }
}

function baseline(events: readonly AgenaEvent[], id: string) {
  return events.find(
    (event) =>
      event.type === "git.baseline.recorded" &&
      (event.payload as GitBaselineRecorded).worktreeId === id,
  );
}

function observations(events: readonly AgenaEvent[], id: string) {
  return events.filter(
    (event) =>
      event.type === "git.head.observed" &&
      (event.payload as GitHeadObserved).worktreeId === id,
  );
}

export class SessionChangesService {
  readonly #pending = new Map<string, Promise<void>>();
  readonly #summaries = new Map<string, SessionChangesResponse>();
  readonly #summaryPending = new Map<string, Promise<SessionChangesResponse>>();
  readonly #commitDetails = new Map<string, Promise<CommitDetails | null>>();
  readonly workspaceDir: string;
  readonly store: EventStore;

  constructor(workspaceDir: string, store: EventStore) {
    this.workspaceDir = workspaceDir;
    this.store = store;
  }

  watch(): () => void {
    return this.store.onCommitted((batch) => {
      const types = new Set(batch.events.map((event) => event.type));
      const reason = types.has("session.created")
        ? "session_resume"
        : [...types].some((type) =>
              [
                "tool.call.completed",
                "tool.call.failed",
                "tool.call.aborted",
                "tool.call.denied",
              ].includes(type),
            )
          ? "tool_completed"
          : [...types].some((type) =>
                ["run.completed", "run.failed", "run.aborted"].includes(type),
              )
            ? "turn_completed"
            : null;
      if (!reason) return;
      queueMicrotask(
        () => void this.observe(batch.sessionId, reason).catch(() => {}),
      );
    });
  }

  async #state(session: SessionRecord): Promise<WorktreeState> {
    const absoluteCwd = await resolveWorkspacePath(
      this.workspaceDir,
      session.cwd,
    );
    const workspaceRoot = await realpath(this.workspaceDir);
    const top = await realpath(
      (await gitText(absoluteCwd, ["rev-parse", "--show-toplevel"])).trim(),
    );
    if (!inside(workspaceRoot, top))
      throw new Error("Git worktree is outside the Agena workspace");
    const root = relative(workspaceRoot, top).replaceAll("\\", "/") || ".";
    const branch =
      (
        await gitText(top, ["symbolic-ref", "--quiet", "--short", "HEAD"], true)
      ).trim() || undefined;
    const head =
      (await gitText(top, ["rev-parse", "--verify", "HEAD"], true)).trim() ||
      undefined;
    return {
      id: worktreeId(root),
      root,
      absoluteRoot: top,
      cwd: session.cwd,
      ...(branch ? { branch } : {}),
      ...(head ? { head } : {}),
      detached: Boolean(head && !branch),
      unborn: !head,
    };
  }

  observe(sessionId: string, reason: GitHeadObserved["reason"]): Promise<void> {
    const existing = this.#pending.get(sessionId);
    if (existing) return existing;
    const promise = this.#observe(sessionId, reason).finally(() =>
      this.#pending.delete(sessionId),
    );
    this.#pending.set(sessionId, promise);
    return promise;
  }

  async #observe(
    sessionId: string,
    reason: GitHeadObserved["reason"],
  ): Promise<void> {
    const session = await this.store.getSession(sessionId);
    if (!session || session.scope === "control") return;
    const state = await this.#state(session);
    const events = await readAllEvents(this.store, sessionId);
    const first = baseline(events, state.id);
    if (!first) {
      await this.store.appendEvents({
        sessionId,
        branchId: session.rootBranchId,
        events: [
          {
            type: "git.baseline.recorded",
            v: 1,
            source: { kind: "filesystem" },
            payload: {
              worktreeId: state.id,
              worktreeRoot: state.root,
              cwd: state.cwd,
              ...(state.head ? { head: state.head } : {}),
              ...(state.branch ? { headRef: state.branch } : {}),
              detached: state.detached,
              unborn: state.unborn,
            } satisfies GitBaselineRecorded,
          },
        ],
      });
      return;
    }
    const prior = observations(events, state.id).at(-1);
    const priorPayload = (prior?.payload ?? first.payload) as
      | GitHeadObserved
      | GitBaselineRecorded;
    if (
      priorPayload.head === state.head &&
      priorPayload.headRef === state.branch
    )
      return;
    await this.store.appendEvents({
      sessionId,
      branchId: session.rootBranchId,
      events: [
        {
          type: "git.head.observed",
          v: 1,
          source: { kind: "filesystem" },
          payload: {
            worktreeId: state.id,
            worktreeRoot: state.root,
            ...(priorPayload.head ? { previousHead: priorPayload.head } : {}),
            ...(state.head ? { head: state.head } : {}),
            ...(priorPayload.headRef
              ? { previousRef: priorPayload.headRef }
              : {}),
            ...(state.branch ? { headRef: state.branch } : {}),
            reason,
          } satisfies GitHeadObserved,
        },
      ],
    });
  }

  async #sessions(rootSessionId: string): Promise<SessionRecord[]> {
    const all = await this.store.listSessions({
      allProjects: true,
      includeArchived: true,
    });
    const included = new Set([rootSessionId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const session of all) {
        if (
          session.parentSessionId &&
          included.has(session.parentSessionId) &&
          !included.has(session.sessionId)
        ) {
          included.add(session.sessionId);
          changed = true;
        }
      }
    }
    return all.filter((session) => included.has(session.sessionId));
  }

  async get(sessionId: string): Promise<SessionChangesResponse> {
    const existing = this.#summaryPending.get(sessionId);
    if (existing) return existing;
    const pending = this.#get(sessionId).finally(() =>
      this.#summaryPending.delete(sessionId),
    );
    this.#summaryPending.set(sessionId, pending);
    return pending;
  }

  async #get(sessionId: string): Promise<SessionChangesResponse> {
    const sessions = await this.#sessions(sessionId);
    if (!sessions.some((session) => session.sessionId === sessionId))
      throw new Error("SESSION_NOT_FOUND");
    await Promise.all(
      sessions.map((session) =>
        this.observe(session.sessionId, "manual_refresh").catch(() => {}),
      ),
    );
    const groups = new Map<
      string,
      { state: WorktreeState; sessions: SessionRecord[] }
    >();
    const unavailable: GitWorktreeChanges[] = [];
    for (const session of sessions) {
      try {
        const state = await this.#state(session);
        const group = groups.get(state.id) ?? { state, sessions: [] };
        group.sessions.push(session);
        groups.set(state.id, group);
      } catch (error) {
        unavailable.push({
          worktreeId: `unavailable:${session.sessionId}`,
          sessionId: session.sessionId,
          label: session.title || "Session workspace",
          root: session.cwd,
          cwd: session.cwd,
          available: false,
          error:
            error instanceof Error ? error.message : "Git worktree unavailable",
          commits: [],
          current: emptyCurrent(),
        });
      }
    }
    const worktrees: GitWorktreeChanges[] = [];
    for (const { state, sessions: members } of groups.values()) {
      const eventSets = await Promise.all(
        members.map((session) => readAllEvents(this.store, session.sessionId)),
      );
      const allEvents = eventSets
        .flat()
        .sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq,
        );
      const base = allEvents.find(
        (event) =>
          event.type === "git.baseline.recorded" &&
          (event.payload as GitBaselineRecorded).worktreeId === state.id,
      );
      const seen = new Set<string>();
      const commits: GitCommitChange[] = [];
      for (const event of observations(allEvents, state.id)) {
        const payload = event.payload as GitHeadObserved;
        if (!payload.head) continue;
        let oids = [payload.head];
        if (payload.previousHead) {
          const forward =
            (
              await runGit(state.absoluteRoot, [
                "merge-base",
                "--is-ancestor",
                payload.previousHead,
                payload.head,
              ])
            ).code === 0;
          if (forward) {
            const listed = await gitText(
              state.absoluteRoot,
              [
                "rev-list",
                "--reverse",
                `${payload.previousHead}..${payload.head}`,
              ],
              true,
            );
            oids = listed.trim().split("\n").filter(Boolean);
          }
        }
        for (const oid of oids) {
          if (seen.has(oid)) continue;
          seen.add(oid);
          const item = await commit(
            state,
            oid,
            event.createdAt,
            event.seq,
            this.#commitDetails,
          );
          if (item) commits.push(item);
        }
      }
      const representative = members[0];
      if (!representative) continue;
      worktrees.push({
        worktreeId: state.id,
        sessionId: representative.sessionId,
        label:
          representative.title || state.root.split("/").pop() || "Worktree",
        root: state.root,
        cwd: state.cwd,
        ...(state.branch ? { branch: state.branch } : {}),
        ...(state.head ? { head: state.head } : {}),
        available: true,
        ...(base ? { trackingStartedAt: base.createdAt } : {}),
        commits,
        current: await currentChanges(state),
      });
    }
    worktrees.push(...unavailable);
    const uniqueFiles = new Set<string>();
    let additions = 0;
    let deletions = 0;
    let conflicts = 0;
    for (const worktree of worktrees) {
      for (const item of worktree.commits.flatMap((entry) => entry.files)) {
        uniqueFiles.add(`${worktree.worktreeId}:${item.path}`);
        additions += item.additions;
        deletions += item.deletions;
      }
      for (const item of Object.values(worktree.current).flat()) {
        uniqueFiles.add(`${worktree.worktreeId}:${item.path}`);
        additions += item.additions;
        deletions += item.deletions;
      }
      conflicts += worktree.current.conflicts.length;
    }
    const summary = {
      sessionId,
      observedAt: new Date().toISOString(),
      worktrees,
      totals: { files: uniqueFiles.size, additions, deletions, conflicts },
    };
    this.#summaries.delete(sessionId);
    this.#summaries.set(sessionId, summary);
    if (this.#summaries.size > 100) {
      const oldest = this.#summaries.keys().next().value;
      if (oldest) this.#summaries.delete(oldest);
    }
    return summary;
  }

  async diff(
    sessionId: string,
    query: SessionChangeDiffQuery,
  ): Promise<SessionChangeDiffResponse> {
    // The client can only select entries from a summary it already received.
    // Reuse that validated snapshot instead of rebuilding every commit per click.
    const summary =
      this.#summaries.get(sessionId) ?? (await this.get(sessionId));
    const worktree = summary.worktrees.find(
      (item) => item.worktreeId === query.worktreeId && item.available,
    );
    if (!worktree)
      return {
        kind: "unavailable",
        path: query.path,
        message: "Worktree unavailable",
      };
    const session = await this.store.getSession(worktree.sessionId);
    if (!session)
      return {
        kind: "unavailable",
        path: query.path,
        message: "Session unavailable",
      };
    const state = await this.#state(session);
    const selectedCommit =
      query.source === "commit"
        ? worktree.commits.find((item) => item.oid === query.commit)
        : undefined;
    if (query.source === "commit" && !selectedCommit) {
      return {
        kind: "unavailable",
        path: query.path,
        message: "Commit was not observed in this session",
      };
    }
    const selectedFile =
      selectedCommit?.files.find((item) => item.path === query.path) ??
      (query.source === "commit"
        ? undefined
        : worktree.current[
            query.source === "conflict" ? "conflicts" : query.source
          ].find((item) => item.path === query.path));
    if (!selectedFile) {
      return {
        kind: "unavailable",
        path: query.path,
        message: "File was not observed in this change group",
      };
    }
    const readGit = async (spec: string): Promise<Buffer> => {
      const result = await runGit(state.absoluteRoot, ["show", spec]);
      return result.code === 0 ? result.stdout : Buffer.alloc(0);
    };
    let oldBytes: Buffer = Buffer.alloc(0);
    let newBytes: Buffer = Buffer.alloc(0);
    if (query.source === "commit" && query.commit) {
      const parent = (
        await gitText(state.absoluteRoot, [
          "rev-list",
          "--parents",
          "-n",
          "1",
          query.commit,
        ])
      )
        .trim()
        .split(/\s+/)[1];
      oldBytes = await readGit(`${parent ?? EMPTY_TREE}:${query.path}`);
      newBytes = await readGit(`${query.commit}:${query.path}`);
    } else if (query.source === "staged") {
      oldBytes = state.head
        ? await readGit(`HEAD:${query.path}`)
        : Buffer.alloc(0);
      newBytes = await readGit(`:${query.path}`);
    } else {
      oldBytes =
        query.source === "untracked"
          ? Buffer.alloc(0)
          : await readGit(`:${query.path}`);
      try {
        const absolute = await resolveWorkspacePath(
          this.workspaceDir,
          join(state.root, query.path),
        );
        if ((await stat(absolute)).size > MAX_TEXT_FILE)
          return {
            kind: "binary",
            path: query.path,
            message: "File is too large to preview",
          };
        newBytes = await readFile(absolute);
      } catch {
        newBytes = Buffer.alloc(0);
      }
    }
    if (
      oldBytes.subarray(0, 1024).includes(0) ||
      newBytes.subarray(0, 1024).includes(0)
    ) {
      return {
        kind: "binary",
        path: query.path,
        message: "Binary files cannot be rendered as text",
      };
    }
    const oldText = oldBytes.toString("utf8");
    const newText = newBytes.toString("utf8");
    return {
      kind: "text",
      path: query.path,
      oldText,
      newText,
      additions: selectedFile.additions,
      deletions: selectedFile.deletions,
    };
  }
}
