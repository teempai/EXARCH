import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CanonicalStore } from "../../../packages/core/src/index.js";
import { GitWorkspaceManager } from "./git-workspace-manager.js";

describe("GitWorkspaceManager", () => {
  it("captures dirty metadata and holds one mutating lease until the after checkpoint", async () => {
    const repo = repository();
    const store = new CanonicalStore(":memory:");
    const seeded = seed(store, repo);
    const manager = new GitWorkspaceManager(store, 60_000);
    writeFileSync(join(repo, "tracked.txt"), "changed\n");
    writeFileSync(join(repo, "untracked.txt"), "untracked\n");

    const active = await manager.acquire({
      ...seeded,
      worktreePath: repo,
      turnId: "turn_1",
      provider: "codex"
    });
    expect(active.checkpoint).toMatchObject({
      phase: "before",
      isRepository: true,
      branch: "main",
      dirty: true,
      untracked: [{ path: "untracked.txt", sizeBytes: 10 }]
    });
    expect(active.checkpoint.head).toMatch(/^[a-f0-9]{40}$/);
    expect(active.checkpoint.diffBytes).toBeGreaterThan(0);
    await expect(
      manager.acquire({
        ...seeded,
        worktreePath: repo,
        turnId: "turn_2",
        provider: "claude"
      })
    ).rejects.toThrow(/conflicting lease/);
    expect(manager.heartbeat(active.lease.id, "turn_1").stale).toBe(false);
    const after = await manager.finalize(active.lease.id, "turn_1");
    expect(after.phase).toBe("after");
    expect(store.listWorkspaceLeases()).toEqual([]);
    store.close();
  });

  it("requires explicit Git inspection before a stale lease is released", async () => {
    const repo = repository();
    let now = new Date("2026-08-23T12:00:00Z");
    const store = new CanonicalStore(":memory:", { now: () => now });
    const seeded = seed(store, repo);
    const manager = new GitWorkspaceManager(store, 1_000);
    const active = await manager.acquire({
      ...seeded,
      worktreePath: repo,
      turnId: "turn_stale",
      provider: "hermes"
    });
    now = new Date("2026-08-23T12:00:02Z");
    await expect(manager.finalize(active.lease.id, "turn_stale")).rejects.toThrow(/reconciliation/);
    const reconciled = await manager.reconcileStale(active.lease.id);
    expect(reconciled).toMatchObject({ phase: "reconciliation", isRepository: true });
    expect(store.listWorkspaceLeases()).toEqual([]);
    store.close();
  });

  it("records a bounded non-repository checkpoint and rejects relative paths", async () => {
    const directory = mkdtempSync(join(tmpdir(), "exarch-non-repo-"));
    const store = new CanonicalStore(":memory:");
    const manager = new GitWorkspaceManager(store);
    await expect(manager.checkpoint(directory, "before")).resolves.toMatchObject({
      isRepository: false,
      repositoryRoot: realpathSync(directory)
    });
    await expect(manager.checkpoint("relative", "before")).rejects.toThrow(/absolute/);
    store.close();
  });

  it("returns a bounded redacted patch without reading untracked file contents", async () => {
    const repo = repository();
    const store = new CanonicalStore(":memory:");
    const manager = new GitWorkspaceManager(store);
    const secret = "sk-ABCDEFGHIJKLMNOP";
    writeFileSync(join(repo, "tracked.txt"), `changed ${secret}\n`);
    writeFileSync(join(repo, "untracked-secret.txt"), "must remain unread\n");

    const changes = await manager.readChanges(repo);
    expect(changes).toMatchObject({
      isRepository: true,
      branch: "main",
      truncated: false,
      redacted: true
    });
    expect(changes.patch).toContain("[REDACTED:OPENAI_STYLE_KEY]");
    expect(changes.patch).not.toContain(secret);
    expect(changes.patch).not.toContain("must remain unread");
    expect(changes.untracked).toEqual([{ path: "untracked-secret.txt", sizeBytes: 19 }]);

    await expect(manager.readChanges(repo, 10)).resolves.toMatchObject({ truncated: true });
    await expect(manager.readChanges(repo, 0)).rejects.toThrow(/limit/);
    store.close();
  });

  it("returns an empty patch for a clean repository", async () => {
    const repo = repository();
    const store = new CanonicalStore(":memory:");
    const changes = await new GitWorkspaceManager(store).readChanges(repo);
    expect(changes).toMatchObject({ patch: "", patchBytes: 0, truncated: false, redacted: false });
    store.close();
  });

  it("does not execute commands a repository defines through its own Git configuration", async () => {
    const repo = repository();
    const store = new CanonicalStore(":memory:");
    const seeded = seed(store, repo);
    const manager = new GitWorkspaceManager(store, 60_000);

    // `core.fsmonitor` is executed by `git status`, and a `textconv` filter is
    // executed by `git diff` even under `--no-ext-diff`. Both are reachable from
    // a repository-local `.git/config` that the daemon never authored.
    const statusMarker = join(repo, "fsmonitor-ran");
    const diffMarker = join(repo, "textconv-ran");
    writeFileSync(join(repo, ".gitattributes"), "*.bin diff=trap\n");
    writeFileSync(join(repo, "payload.bin"), "one\n");
    git(repo, "add", ".gitattributes", "payload.bin");
    git(repo, "commit", "-m", "Hostile fixture");
    // Arm the traps only after the fixture is committed, so the markers can
    // come from the manager under test and from nothing else.
    git(repo, "config", "core.fsmonitor", `touch ${statusMarker}; false`);
    git(repo, "config", "diff.trap.textconv", `touch ${diffMarker}; cat`);
    writeFileSync(join(repo, "payload.bin"), "two\n");
    expect(existsSync(statusMarker)).toBe(false);
    expect(existsSync(diffMarker)).toBe(false);

    const active = await manager.acquire({
      ...seeded,
      worktreePath: repo,
      turnId: "turn_hostile",
      provider: "codex"
    });
    expect(active.checkpoint.isRepository).toBe(true);
    await manager.readChanges(repo);
    await manager.finalize(active.lease.id, "turn_hostile");

    expect(existsSync(statusMarker)).toBe(false);
    expect(existsSync(diffMarker)).toBe(false);
    store.close();
  });

  it("rejects Git topology that expands an enrolled subdirectory to sibling content", async () => {
    const repo = repository();
    const child = join(repo, "child");
    const sibling = join(repo, "sibling");
    mkdirSync(child);
    mkdirSync(sibling);
    writeFileSync(join(child, "visible.txt"), "visible\n");
    writeFileSync(join(sibling, "secret.txt"), "secret\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "Nested fixture");
    writeFileSync(join(sibling, "secret.txt"), "changed secret\n");
    const store = new CanonicalStore(":memory:");
    const project = store.createProject({ name: "Child only", repoRoot: child });

    await expect(
      new GitWorkspaceManager(store).readChanges(child, undefined, project.allowedPaths)
    ).rejects.toThrow(/outside the project/);
    store.close();
  });

  it("neutralizes repository-local core.worktree before topology discovery", async () => {
    const repo = repository();
    git(repo, "config", "core.worktree", "..");
    const store = new CanonicalStore(":memory:");
    const project = store.createProject({ name: "Pinned worktree", repoRoot: repo });

    await expect(
      new GitWorkspaceManager(store).checkpoint(repo, "before", project.allowedPaths)
    ).resolves.toMatchObject({
      isRepository: true,
      repositoryRoot: realpathSync(repo)
    });
    store.close();
  });

  it("keys nested paths in one Git repository to the same writer lease", async () => {
    const repo = repository();
    const child = join(repo, "child");
    mkdirSync(child);
    const store = new CanonicalStore(":memory:");
    const rootProject = store.createProject({ name: "Root", repoRoot: repo });
    const childProject = store.createProject({
      name: "Child",
      repoRoot: child,
      allowedPaths: [repo]
    });
    const rootConversation = store.createConversation({
      projectId: rootProject.id,
      title: "Root",
      activeProvider: "codex"
    });
    const childConversation = store.createConversation({
      projectId: childProject.id,
      title: "Child",
      activeProvider: "claude"
    });
    const manager = new GitWorkspaceManager(store);
    const active = await manager.acquire({
      projectId: rootProject.id,
      worktreePath: repo,
      conversationId: rootConversation.id,
      turnId: "turn_root",
      provider: "codex"
    });

    expect(active.lease).toMatchObject({
      worktreePath: realpathSync(repo),
      scopeKind: "git"
    });
    await expect(
      manager.acquire({
        projectId: childProject.id,
        worktreePath: child,
        conversationId: childConversation.id,
        turnId: "turn_child",
        provider: "claude",
        allowedPaths: childProject.allowedPaths
      })
    ).rejects.toThrow(/conflicting lease/);
    store.close();
  });
});

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), "exarch-git-workspace-"));
  git(directory, "init", "-b", "main");
  git(directory, "config", "user.email", "exarch@example.invalid");
  git(directory, "config", "user.name", "Exarch Test");
  writeFileSync(join(directory, "tracked.txt"), "initial\n");
  git(directory, "add", "tracked.txt");
  git(directory, "commit", "-m", "Initial fixture");
  return directory;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

function seed(store: CanonicalStore, repoRoot: string) {
  const project = store.createProject({ name: "Workspace", repoRoot });
  const conversation = store.createConversation({
    projectId: project.id,
    title: "Workspace",
    activeProvider: "codex"
  });
  return { projectId: project.id, conversationId: conversation.id };
}
