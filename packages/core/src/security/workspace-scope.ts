import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Directory names that hold credentials or agent state rather than project
 * source. A project root is never one of these and never sits inside one, so a
 * paired device cannot point a provider at them even though it is otherwise
 * authorized to create projects.
 */
const FORBIDDEN_PATH_SEGMENTS = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".azure",
  ".gcloud",
  ".password-store",
  "Keychains"
]);

// EXARCH is also the product and source-repository name, so rejecting every
// path segment with that spelling blocks the app from working on itself. What
// is forbidden is the per-user application-state tree as a whole: no project
// source lives under Application Support or inside a sandbox container, and
// those directories hold the state of every other application on the machine,
// not only this one's.
const FORBIDDEN_PATH_SEQUENCES = [
  ["Library", "Application Support"],
  ["Library", "Containers"],
  ["Library", "Group Containers"],
  ["Library", "Cookies"],
  ["Library", "Mail"],
  ["Library", "Messages"]
];

export class WorkspaceScopeError extends Error {
  readonly code = "workspace_scope";
}

export interface WorkspaceIdentity {
  device: string;
  inode: string;
}

/**
 * Resolves a path for comparison. Symlinks are followed so that two names for
 * one directory cannot be used to slip past a containment check.
 *
 * A path that does not exist yet still has to resolve consistently with one
 * that does, or a containment check comparing the two would be meaningless: on
 * macOS both /tmp and /var/folders are themselves symlinks, so a lexical
 * fallback would compare /var/folders/x/project against its own realpath
 * /private/var/folders/x/project and conclude they are unrelated. Anchor on the
 * deepest ancestor that does exist and re-append the rest.
 */
export function resolveWorkspacePath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new WorkspaceScopeError("Workspace path must be a non-empty string");
  }
  if (path.includes("\0")) {
    throw new WorkspaceScopeError("Workspace path must not contain a null byte");
  }
  if (!isAbsolute(path)) {
    throw new WorkspaceScopeError("Workspace path must be absolute");
  }
  const lexical = resolve(path);
  const missing: string[] = [];
  let current = lexical;
  while (true) {
    try {
      const existing = realpathSync(current);
      return missing.length === 0 ? existing : join(existing, ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return lexical;
      missing.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

/**
 * True when `candidate` is `scope` itself or sits underneath it. Both sides are
 * resolved first, so `..` traversal and symlinked aliases are already gone by
 * the time the prefix comparison happens.
 */
export function isWithinPath(candidate: string, scope: string): boolean {
  const resolvedCandidate = resolveWorkspacePath(candidate);
  const resolvedScope = resolveWorkspacePath(scope);
  if (resolvedCandidate === resolvedScope) return true;
  const difference = relative(resolvedScope, resolvedCandidate);
  return (
    difference.length > 0 &&
    !difference.startsWith("..") &&
    !isAbsolute(difference)
  );
}

/**
 * Rejects roots that are too broad to be a project, or that sit in a directory
 * holding credentials. This bounds what a compromised or modified mobile client
 * can aim a provider process at (SECURITY.md threat 5.5), independently of what
 * the client's own interface allows.
 */
export function assertUsableRepositoryRoot(
  repoRoot: string,
  home: string = homedir()
): string {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    throw new WorkspaceScopeError("Workspace path must be a non-empty string");
  }
  if (repoRoot.includes("\0")) {
    throw new WorkspaceScopeError("Workspace path must not contain a null byte");
  }
  if (!isAbsolute(repoRoot)) {
    throw new WorkspaceScopeError("Workspace path must be absolute");
  }
  const lexical = resolve(repoRoot);
  let rootEntry;
  try {
    rootEntry = lstatSync(lexical);
  } catch {
    rootEntry = undefined;
  }
  if (rootEntry?.isSymbolicLink()) {
    throw new WorkspaceScopeError("A project root must not be a symbolic link");
  }
  const resolved = resolveWorkspacePath(lexical);
  if (resolved === sep) {
    throw new WorkspaceScopeError("A project root must not be the filesystem root");
  }
  const segments = resolved.split(sep).filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    throw new WorkspaceScopeError("A project root must not be a top-level directory");
  }
  // A home directory is two segments on macOS, so the top-level rule lets it
  // through — and it contains every credential directory the list below
  // forbids. Naming it as a root would put .ssh and .aws back inside the
  // provider's working tree by the side door.
  if (isHomeDirectory(resolved, home)) {
    throw new WorkspaceScopeError("A project root must not be a home directory");
  }
  for (const segment of segments) {
    if (FORBIDDEN_PATH_SEGMENTS.has(segment)) {
      throw new WorkspaceScopeError(
        `A project root must not sit inside ${segment}`
      );
    }
  }
  for (const sequence of FORBIDDEN_PATH_SEQUENCES) {
    if (containsSegmentSequence(segments, sequence)) {
      throw new WorkspaceScopeError(
        `A project root must not sit inside ${sequence.join("/")}`
      );
    }
  }
  if (rootEntry === undefined) {
    throw new WorkspaceScopeError("A project root must be an existing directory");
  }
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw new WorkspaceScopeError("A project root must be an existing directory");
  }
  if (!stats.isDirectory()) {
    throw new WorkspaceScopeError("A project root must be a directory");
  }
  return resolved;
}

/** Binds an enrollment to the directory object, not merely its pathname. */
export function captureWorkspaceIdentity(repoRoot: string): WorkspaceIdentity {
  const resolved = assertUsableRepositoryRoot(repoRoot);
  const stats = statSync(resolved, { bigint: true });
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

/**
 * Fails when an enrolled root was replaced, recreated, or changed into a
 * symlink. Re-enrollment is required to bind a new directory identity.
 */
export function assertWorkspaceIdentity(
  repoRoot: string,
  expected: WorkspaceIdentity
): string {
  const lexical = resolve(repoRoot);
  let entry;
  try {
    entry = lstatSync(lexical, { bigint: true });
  } catch {
    throw new WorkspaceScopeError("The enrolled project root no longer exists");
  }
  if (entry.isSymbolicLink()) {
    throw new WorkspaceScopeError("The enrolled project root was replaced by a symbolic link");
  }
  if (!entry.isDirectory()) {
    throw new WorkspaceScopeError("The enrolled project root is no longer a directory");
  }
  if (entry.dev.toString() !== expected.device || entry.ino.toString() !== expected.inode) {
    throw new WorkspaceScopeError("The enrolled project root identity changed; re-enrollment is required");
  }
  const resolved = assertUsableRepositoryRoot(lexical);
  if (resolved !== lexical) {
    throw new WorkspaceScopeError("The enrolled project root no longer resolves to its stored path");
  }
  return resolved;
}

/**
 * True when the resolved path is the running user's home directory, or the
 * directory that holds home directories. Both sides are resolved because a
 * home directory reached through a symlink is still a home directory.
 */
function isHomeDirectory(resolved: string, home: string): boolean {
  if (home.length === 0 || !isAbsolute(home)) return false;
  const resolvedHome = resolveWorkspacePath(home);
  if (resolved === resolvedHome) return true;
  const parent = dirname(resolvedHome);
  return parent !== resolvedHome && resolved === parent;
}

function containsSegmentSequence(segments: string[], sequence: string[]): boolean {
  return segments.some((_, index) =>
    sequence.every((segment, offset) => segments[index + offset] === segment)
  );
}

/**
 * Normalizes the scope stored on a project. Every allowed path is resolved and
 * absolute, duplicates collapse, and the repository root must fall inside at
 * least one of them, so the stored scope can never be narrower than the root it
 * accompanies.
 */
export function normalizeWorkspaceScope(input: {
  repoRoot: string;
  allowedPaths?: string[];
}): { repoRoot: string; allowedPaths: string[] } {
  const repoRoot = assertUsableRepositoryRoot(input.repoRoot);
  if (input.allowedPaths === undefined) {
    return { repoRoot, allowedPaths: [repoRoot] };
  }
  if (input.allowedPaths.length === 0) {
    throw new WorkspaceScopeError("A project scope must list at least one allowed path");
  }
  const allowedPaths = [...new Set(input.allowedPaths.map(resolveWorkspacePath))];
  if (!allowedPaths.some((allowed) => isWithinPath(repoRoot, allowed))) {
    throw new WorkspaceScopeError("A project root must sit inside its own allowed paths");
  }
  return { repoRoot, allowedPaths };
}

/**
 * The enforcement point. Called before a provider process is given a working
 * directory and before Git inspects one.
 */
export function assertWithinWorkspaceScope(candidate: string, allowedPaths: string[]): string {
  const resolved = resolveWorkspacePath(candidate);
  if (allowedPaths.length === 0) {
    throw new WorkspaceScopeError("Project scope is empty; refusing to use any path");
  }
  // allowedPaths are canonicalized when enrolled. Do not resolve them again:
  // if an attacker replaces a stored path with a symlink, following both the
  // candidate and its authorization boundary would retarget the boundary too.
  if (!allowedPaths.some((allowed) => isWithinCanonicalPath(resolved, allowed))) {
    throw new WorkspaceScopeError("Path is outside the project's allowed paths");
  }
  return resolved;
}

/** True when two already-canonical workspace keys overlap. */
export function workspacePathsOverlap(left: string, right: string): boolean {
  return isWithinCanonicalPath(left, right) || isWithinCanonicalPath(right, left);
}

function isWithinCanonicalPath(candidate: string, scope: string): boolean {
  if (!isAbsolute(candidate) || !isAbsolute(scope)) return false;
  if (candidate === scope) return true;
  const difference = relative(scope, candidate);
  return difference.length > 0 && !difference.startsWith("..") && !isAbsolute(difference);
}
