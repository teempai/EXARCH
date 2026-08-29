import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WorkspaceScopeError,
  assertUsableRepositoryRoot,
  assertWorkspaceIdentity,
  assertWithinWorkspaceScope,
  captureWorkspaceIdentity,
  isWithinPath,
  normalizeWorkspaceScope
} from "./workspace-scope.js";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "exarch-scope-"));
}

describe("workspace scope", () => {
  it("rejects roots that are too broad or hold credentials", () => {
    expect(() => assertUsableRepositoryRoot("/")).toThrow(WorkspaceScopeError);
    expect(() => assertUsableRepositoryRoot("/Users")).toThrow(/top-level/);
    expect(() => assertUsableRepositoryRoot("relative/path")).toThrow(/absolute/);
    expect(() => assertUsableRepositoryRoot("/Users/someone/.ssh")).toThrow(/\.ssh/);
    expect(() => assertUsableRepositoryRoot("/Users/someone/.ssh/keys")).toThrow(/\.ssh/);
    expect(() => assertUsableRepositoryRoot("/Users/someone/project\0")).toThrow(/null byte/);
  });

  /**
   * A home directory is two segments on macOS, so the top-level rule admitted
   * it — and it contains every credential directory the forbidden list exists
   * to keep out of a provider's working tree.
   */
  it("rejects a home directory and the directory holding home directories", () => {
    const home = realpathSync(homedir());
    expect(() => assertUsableRepositoryRoot(home)).toThrow(/home directory/);
    expect(() => assertUsableRepositoryRoot(homedir())).toThrow(/home directory/);
    // The parent, whatever it is called on this platform.
    expect(() => assertUsableRepositoryRoot(join(home, ".."))).toThrow(WorkspaceScopeError);
    // A project inside the home directory is still fine; only the root itself
    // and its parent are refused.
    const inside = mkdtempSync(join(home, ".exarch-scope-test-"));
    expect(assertUsableRepositoryRoot(inside)).toBe(realpathSync(inside));
    rmSync(inside, { recursive: true, force: true });
  });

  it("rejects the per-user application-state tree, not only this application's corner of it", () => {
    const home = realpathSync(homedir());
    expect(() =>
      assertUsableRepositoryRoot(join(home, "Library", "Application Support", "SomeOtherApp"))
    ).toThrow(/Application Support/);
    expect(() =>
      assertUsableRepositoryRoot(join(home, "Library", "Containers", "com.example.app"))
    ).toThrow(/Containers/);
  });

  it("protects EXARCH application data without rejecting an EXARCH source repository", () => {
    const root = workspace();
    const sourceRepository = join(root, "EXARCH");
    const applicationData = join(root, "Library", "Application Support", "EXARCH", "data");
    mkdirSync(sourceRepository);
    mkdirSync(applicationData, { recursive: true });

    expect(assertUsableRepositoryRoot(sourceRepository)).toBe(realpathSync(sourceRepository));
    // The refusal now covers Application Support as a whole rather than this
    // application's own directory inside it, so the message names the tree.
    expect(() => assertUsableRepositoryRoot(applicationData)).toThrow(
      /Library\/Application Support/
    );
  });

  it("rejects a root that does not exist or is not a directory", () => {
    const root = workspace();
    const file = join(root, "not-a-directory");
    writeFileSync(file, "x");
    expect(() => assertUsableRepositoryRoot(file)).toThrow(/must be a directory/);
    expect(() => assertUsableRepositoryRoot(join(root, "missing"))).toThrow(/existing directory/);
  });

  it("defaults the scope to the root and keeps it absolute and resolved", () => {
    const root = workspace();
    const project = join(root, "project");
    mkdirSync(project);
    const scope = normalizeWorkspaceScope({ repoRoot: join(project, "..", "project") });
    expect(scope.allowedPaths).toEqual([scope.repoRoot]);
    expect(scope.repoRoot.endsWith("project")).toBe(true);
  });

  it("requires the root to sit inside its own allowed paths", () => {
    const root = workspace();
    const project = join(root, "project");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(project);
    mkdirSync(elsewhere);
    expect(() => normalizeWorkspaceScope({ repoRoot: project, allowedPaths: [elsewhere] })).toThrow(
      /inside its own allowed paths/
    );
    expect(() => normalizeWorkspaceScope({ repoRoot: project, allowedPaths: [] })).toThrow(
      /at least one allowed path/
    );
    expect(normalizeWorkspaceScope({ repoRoot: project, allowedPaths: [root] }).allowedPaths).toHaveLength(1);
  });

  it("refuses traversal and symlinked aliases that leave the scope", () => {
    const root = workspace();
    const project = join(root, "project");
    const secrets = join(root, "secrets");
    mkdirSync(project);
    mkdirSync(secrets);
    const escape = join(project, "escape");
    symlinkSync(secrets, escape);

    const canonicalProject = realpathSync(project);
    expect(assertWithinWorkspaceScope(join(project, "nested"), [canonicalProject])).toContain("project");
    expect(() => assertWithinWorkspaceScope(join(project, "..", "secrets"), [canonicalProject])).toThrow(
      /outside the project/
    );
    // The symlink resolves out of the scope, so the prefix comparison must not
    // be fooled by its name sitting under the project directory.
    expect(() => assertWithinWorkspaceScope(escape, [canonicalProject])).toThrow(/outside the project/);
    expect(() => assertWithinWorkspaceScope(project, [])).toThrow(/scope is empty/);
  });

  it("treats a sibling with a shared prefix as outside the scope", () => {
    const root = workspace();
    const project = join(root, "app");
    const sibling = join(root, "app-secrets");
    mkdirSync(project);
    mkdirSync(sibling);
    expect(isWithinPath(sibling, project)).toBe(false);
    expect(isWithinPath(project, project)).toBe(true);
  });

  it("does not retarget a canonical scope when its stored path becomes a symlink", () => {
    const root = workspace();
    const project = join(root, "project");
    const moved = join(root, "project-moved");
    const outside = join(root, "outside");
    mkdirSync(project);
    mkdirSync(outside);
    const canonicalProject = realpathSync(project);
    const identity = captureWorkspaceIdentity(canonicalProject);

    renameSync(project, moved);
    symlinkSync(outside, project);

    expect(() => assertWithinWorkspaceScope(project, [canonicalProject])).toThrow(/outside/);
    expect(() => assertWorkspaceIdentity(canonicalProject, identity)).toThrow(/symbolic link/);
  });

  it("requires re-enrollment when a directory is recreated at the same path", () => {
    const root = workspace();
    const project = join(root, "project");
    const moved = join(root, "project-moved");
    mkdirSync(project);
    const identity = captureWorkspaceIdentity(project);

    renameSync(project, moved);
    mkdirSync(project);

    expect(() => assertWorkspaceIdentity(project, identity)).toThrow(/identity changed/);
  });
});
