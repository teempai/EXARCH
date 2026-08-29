import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  assertWithinWorkspaceScope,
  redactPayload,
  type CanonicalStore,
  type WorkspaceLeaseRecord
} from "../../../packages/core/src/index.js";
import type { Provider } from "../../../packages/protocol/src/index.js";

const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_UNTRACKED_ENTRIES = 500;
// The macOS product is laptop-only and `/usr/bin/git` is the system-provided
// entry point. Never resolve this security-sensitive checkpoint executable
// through a user-controlled PATH.
const GIT_EXECUTABLE = "/usr/bin/git";

/**
 * Git executes several configuration values as commands, and it reads them from
 * the repository-local `.git/config` of whatever worktree it runs in. A checkout
 * the user did not author is therefore able to run code the moment the daemon
 * takes a checkpoint, before any provider starts and before any approval exists.
 * Every invocation pins these keys to an empty value so a repository-local
 * definition cannot take effect.
 */
const NEUTRALIZED_CONFIG = [
  "core.fsmonitor=",
  "core.hooksPath=/dev/null",
  "core.worktree=",
  "core.sshCommand=",
  "core.pager=cat",
  "core.editor=false",
  "diff.external=",
  "uploadpack.packObjectsHook=",
  "protocol.ext.allow=never"
].flatMap((setting) => ["-c", setting]);

/**
 * System and global configuration cannot define these keys out from under the
 * pinned values above, and no protocol beyond the two the checkpoints need is
 * reachable.
 */
const HARDENED_GIT_ENVIRONMENT = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ALLOW_PROTOCOL: "file:https",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0"
} as const;

export interface RepositoryCheckpoint {
  phase: "before" | "after" | "reconciliation";
  worktreePath: string;
  repositoryRoot: string;
  isRepository: boolean;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  statusEntries: Array<{ status: string; path: string }>;
  statusSha256: string;
  diffSha256: string;
  diffBytes: number;
  untracked: Array<{ path: string; sizeBytes: number | null }>;
  untrackedTruncated: boolean;
}

export interface WorkspaceTurnLease {
  lease: WorkspaceLeaseRecord;
  checkpoint: RepositoryCheckpoint;
}

export interface RepositoryChanges {
  repositoryRoot: string;
  isRepository: boolean;
  branch: string | null;
  head: string | null;
  statusEntries: Array<{ status: string; path: string }>;
  untracked: Array<{ path: string; sizeBytes: number | null }>;
  patch: string;
  patchBytes: number;
  truncated: boolean;
  redacted: boolean;
  redactionMarkers: string[];
}

export class GitWorkspaceManager {
  constructor(
    private readonly store: CanonicalStore,
    private readonly leaseLifetimeMs = 60_000
  ) {}

  async acquire(input: {
    projectId: string;
    worktreePath: string;
    conversationId: string;
    turnId: string;
    provider: Provider;
    mode?: "read-only" | "mutating";
    allowedPaths?: string[];
  }): Promise<WorkspaceTurnLease> {
    this.store.assertProjectExecutionScope(input.projectId);
    const checkpoint = await this.checkpoint(
      input.worktreePath,
      "before",
      input.allowedPaths ?? this.projectScope(input.projectId)
    );
    const lease = this.store.acquireWorkspaceLease({
      ...input,
      // All paths inside one Git worktree share one mutation key. Non-Git
      // directories retain their canonical filesystem path and use overlap
      // detection in the store.
      worktreePath: checkpoint.repositoryRoot,
      mode: input.mode ?? "mutating",
      scopeKind: checkpoint.isRepository ? "git" : "path",
      lifetimeMs: this.leaseLifetimeMs
    });
    return { lease, checkpoint };
  }

  heartbeat(leaseId: string, turnId: string): WorkspaceLeaseRecord {
    return this.store.heartbeatWorkspaceLease(leaseId, turnId, this.leaseLifetimeMs);
  }

  async finalize(leaseId: string, turnId: string): Promise<RepositoryCheckpoint> {
    const lease = this.store.getWorkspaceLease(leaseId);
    if (lease.turnId !== turnId) throw new Error("Workspace lease owner mismatch");
    if (lease.stale) throw new Error("Stale workspace lease requires reconciliation");
    this.store.assertProjectExecutionScope(lease.projectId);
    const checkpoint = await this.checkpoint(
      lease.worktreePath,
      "after",
      this.projectScope(lease.projectId)
    );
    this.store.releaseWorkspaceLease(leaseId, turnId);
    return checkpoint;
  }

  async reconcileStale(leaseId: string): Promise<RepositoryCheckpoint> {
    const lease = this.store.getWorkspaceLease(leaseId);
    if (!lease.stale) throw new Error("Active workspace lease cannot be reconciled");
    this.store.assertProjectExecutionScope(lease.projectId);
    const checkpoint = await this.checkpoint(
      lease.worktreePath,
      "reconciliation",
      this.projectScope(lease.projectId)
    );
    this.store.releaseStaleWorkspaceLeaseAfterReconciliation(leaseId);
    return checkpoint;
  }

  private projectScope(projectId: string): string[] {
    return this.store.getProject(projectId).allowedPaths;
  }

  async checkpoint(
    inputPath: string,
    phase: RepositoryCheckpoint["phase"],
    allowedPaths?: string[]
  ): Promise<RepositoryCheckpoint> {
    if (!isAbsolute(inputPath)) throw new Error("Workspace path must be absolute");
    const worktreePath = await realpath(inputPath);
    // Enforced here as well as at the coordinator, because every Git invocation
    // below runs with the daemon's privileges in whatever directory it is given.
    if (allowedPaths !== undefined) assertWithinWorkspaceScope(worktreePath, allowedPaths);
    const inside = await git(worktreePath, ["rev-parse", "--is-inside-work-tree"], true);
    if (inside.exitCode !== 0 || inside.stdout.toString("utf8").trim() !== "true") {
      return emptyCheckpoint(worktreePath, phase);
    }
    const topologyResult = await git(worktreePath, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir"
    ]);
    const topology = topologyResult.stdout.toString("utf8").trim().split("\n");
    if (topology.length !== 3 || topology.some((path) => path.length === 0)) {
      throw new Error("Git returned an invalid repository topology");
    }
    const [reportedRoot, reportedGitDirectory, reportedCommonDirectory] = topology as [string, string, string];
    const [repositoryRoot, gitDirectory, commonDirectory] = await Promise.all([
      realpath(reportedRoot),
      realpath(reportedGitDirectory),
      realpath(reportedCommonDirectory)
    ]);
    if (allowedPaths !== undefined) {
      assertWithinWorkspaceScope(repositoryRoot, allowedPaths);
      assertWithinWorkspaceScope(gitDirectory, allowedPaths);
      assertWithinWorkspaceScope(commonDirectory, allowedPaths);
    }
    const relativePath = relative(repositoryRoot, worktreePath);
    if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
      throw new Error("Git worktree resolved outside its repository root");
    }
    const [branchResult, headResult, statusResult, unstaged, staged] = await Promise.all([
      git(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"], true),
      git(worktreePath, ["rev-parse", "--verify", "HEAD"], true),
      git(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      git(worktreePath, ["diff", "--binary", "--no-ext-diff", "--no-textconv"]),
      git(worktreePath, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"])
    ]);
    const statusEntries = parseStatus(statusResult.stdout);
    const untrackedPaths = statusEntries
      .filter((entry) => entry.status === "??")
      .map((entry) => entry.path);
    const untracked = await Promise.all(
      untrackedPaths.slice(0, MAX_UNTRACKED_ENTRIES).map(async (path) => ({
        path,
        sizeBytes: await safeUntrackedSize(repositoryRoot, path)
      }))
    );
    const diff = Buffer.concat([unstaged.stdout, Buffer.from("\n--STAGED--\n"), staged.stdout]);
    return {
      phase,
      worktreePath,
      repositoryRoot,
      isRepository: true,
      branch: branchResult.exitCode === 0 ? nonEmpty(branchResult.stdout) : null,
      head: headResult.exitCode === 0 ? nonEmpty(headResult.stdout) : null,
      dirty: statusEntries.length > 0,
      statusEntries,
      statusSha256: sha256(statusResult.stdout),
      diffSha256: sha256(diff),
      diffBytes: diff.byteLength,
      untracked,
      untrackedTruncated: untrackedPaths.length > MAX_UNTRACKED_ENTRIES
    };
  }

  async readChanges(
    inputPath: string,
    maxPatchBytes = 512 * 1024,
    allowedPaths?: string[]
  ): Promise<RepositoryChanges> {
    if (!Number.isSafeInteger(maxPatchBytes) || maxPatchBytes < 1 || maxPatchBytes > 1024 * 1024) {
      throw new Error("Change patch limit is outside the allowed range");
    }
    const checkpoint = await this.checkpoint(inputPath, "reconciliation", allowedPaths);
    if (!checkpoint.isRepository) {
      return {
        repositoryRoot: checkpoint.repositoryRoot,
        isRepository: false,
        branch: null,
        head: null,
        statusEntries: [],
        untracked: [],
        patch: "",
        patchBytes: 0,
        truncated: false,
        redacted: false,
        redactionMarkers: []
      };
    }
    const [unstaged, staged] = await Promise.all([
      git(checkpoint.worktreePath, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--"]),
      git(checkpoint.worktreePath, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--"])
    ]);
    const patchParts: Buffer[] = [];
    if (unstaged.stdout.byteLength > 0) patchParts.push(unstaged.stdout);
    if (staged.stdout.byteLength > 0) {
      if (patchParts.length > 0) patchParts.push(Buffer.from("\n-- STAGED CHANGES --\n", "utf8"));
      patchParts.push(staged.stdout);
    }
    const combined = Buffer.concat(patchParts);
    // Redact before bounding the response so truncation cannot split a secret
    // token and leave a recognizable prefix in the mobile-visible patch.
    const redaction = redactPayload({ patch: combined.toString("utf8") });
    const redactedPatch = Buffer.from(String(redaction.value.patch ?? ""), "utf8");
    const truncated = redactedPatch.byteLength > maxPatchBytes;
    const visible = redactedPatch
      .subarray(0, Math.min(redactedPatch.byteLength, maxPatchBytes))
      .toString("utf8");
    return {
      repositoryRoot: checkpoint.repositoryRoot,
      isRepository: true,
      branch: checkpoint.branch,
      head: checkpoint.head,
      statusEntries: checkpoint.statusEntries,
      untracked: checkpoint.untracked,
      patch: visible,
      patchBytes: combined.byteLength,
      truncated,
      redacted: redaction.redacted,
      redactionMarkers: redaction.markers
    };
  }
}

interface GitResult {
  stdout: Buffer;
  exitCode: number;
}

function git(cwd: string, args: string[], allowFailure = false): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      GIT_EXECUTABLE,
      [...NEUTRALIZED_CONFIG, "--no-optional-locks", "-C", cwd, ...args],
      {
        encoding: "buffer",
        timeout: 10_000,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        env: { ...process.env, ...HARDENED_GIT_ENVIRONMENT }
      },
      (error, stdout, stderr) => {
        const exitCode = typeof (error as NodeJS.ErrnoException & { code?: unknown } | null)?.code === "number"
          ? ((error as unknown as { code: number }).code)
          : error === null
            ? 0
            : 1;
        if (error !== null && !allowFailure) {
          reject(
            new Error(
              `Git command failed: ${Buffer.from(stderr).toString("utf8").trim() || error.message}`
            )
          );
          return;
        }
        resolvePromise({ stdout: Buffer.from(stdout), exitCode });
      }
    );
  });
}

function parseStatus(raw: Buffer): Array<{ status: string; path: string }> {
  const fields = raw.toString("utf8").split("\0");
  const entries: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined || field.length < 4) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    entries.push({ status, path });
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return entries;
}

async function safeUntrackedSize(repositoryRoot: string, path: string): Promise<number | null> {
  const absolute = resolve(repositoryRoot, path);
  const relativePath = relative(repositoryRoot, absolute);
  if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
    return null;
  }
  try {
    const value = await lstat(absolute);
    return value.isFile() ? value.size : null;
  } catch {
    return null;
  }
}

function emptyCheckpoint(
  worktreePath: string,
  phase: RepositoryCheckpoint["phase"]
): RepositoryCheckpoint {
  const empty = Buffer.alloc(0);
  return {
    phase,
    worktreePath,
    repositoryRoot: worktreePath,
    isRepository: false,
    branch: null,
    head: null,
    dirty: false,
    statusEntries: [],
    statusSha256: sha256(empty),
    diffSha256: sha256(Buffer.from("\n--STAGED--\n")),
    diffBytes: 12,
    untracked: [],
    untrackedTruncated: false
  };
}

function sha256(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function nonEmpty(value: Buffer): string | null {
  const text = value.toString("utf8").trim();
  return text.length === 0 ? null : text;
}
