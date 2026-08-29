import Database from "better-sqlite3";
import {
  EventEnvelopeSchema,
  GENESIS_HASH,
  createId,
  hashEvent,
  type EventEnvelope,
  type EventType,
  type Provider
} from "../../../protocol/src/index.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import {
  WorkspaceScopeError,
  assertWorkspaceIdentity,
  assertWithinWorkspaceScope,
  captureWorkspaceIdentity,
  normalizeWorkspaceScope,
  resolveWorkspacePath,
  workspacePathsOverlap
} from "../security/workspace-scope.js";
import { redactPayload, redactText } from "../security/redaction.js";

export interface CanonicalStoreOptions {
  requireEncrypted?: boolean;
  encryptionKey?: Uint8Array;
  now?: () => Date;
}

export interface ProjectRecord {
  id: string;
  name: string;
  repoRoot: string;
  allowedPaths: string[];
  createdAt: string;
}

export interface ConversationRecord {
  id: string;
  projectId: string;
  title: string;
  status: "active" | "archived" | "deleting" | "restoring";
  activeProvider: Provider | null;
  fallbackRoute: Provider[];
  pinned: boolean;
  nextSequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderBindingRecord {
  conversationId: string;
  provider: Provider;
  nativeSessionId: string | null;
  synchronizedThroughSequence: number;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface HistorySourceRecord {
  id: string;
  provider: Provider;
  nativeSessionId: string;
  conversationId: string;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  sourceDigest: string;
  importStatus: "importing" | "complete" | "partial" | "failed";
  importedItemCount: number;
  lastError: string | null;
  lastSyncedAt: string;
  metadata: Record<string, unknown>;
}

export interface HistoryImportItem {
  nativeItemId: string;
  type: EventType;
  payload: Record<string, unknown>;
  occurredAt: string;
  contentDigest: string;
}

export interface HistoryImportResult {
  source: HistorySourceRecord;
  conversation: ConversationRecord;
  inserted: number;
  corrected: number;
  unchanged: number;
}

export interface ConversationSyncCursor {
  sequence: number;
}

export interface ConversationSyncPage {
  conversations: ConversationRecord[];
  nextCursor: ConversationSyncCursor | null;
  hasMore: boolean;
}

export interface ConversationListCursor {
  pinned: boolean;
  updatedAt: string;
  id: string;
}

export interface ConversationListPage {
  conversations: ConversationRecord[];
  nextCursor: ConversationListCursor | null;
  hasMore: boolean;
}

export interface AppendEventInput {
  conversationId: string;
  turnId?: string | null;
  type: EventType;
  provider?: Provider | null;
  payload: Record<string, unknown>;
  occurredAt?: string;
  id?: string;
}

export interface EventQuery {
  after?: number;
  before?: number;
  limit?: number;
  type?: EventType;
  provider?: Provider;
  displayOnly?: boolean;
}

export interface SearchResult {
  event: EventEnvelope;
  snippet: string;
  rank: number;
}

export interface DecisionRecord {
  id: string;
  conversationId: string;
  text: string;
  status: "active" | "superseded";
  sourceEventIds: string[];
  supersededById: string | null;
  createdAt: string;
}

export interface TaskRecord {
  id: string;
  conversationId: string;
  text: string;
  status: "open" | "completed";
  sourceEventIds: string[];
  createdAt: string;
  completedAt: string | null;
}

export interface DeviceRecord {
  id: string;
  displayName: string;
  signingPublicKey: string;
  approvalPublicKey: string;
  status: "active" | "suspended" | "revoked";
  lastCounter: number;
  capabilities: string[];
  attestation: Record<string, unknown> | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface ApprovalRecord {
  id: string;
  conversationId: string;
  turnId: string;
  provider: Provider;
  status: "pending" | "decided" | "expired" | "delivery_failed";
  request: Record<string, unknown>;
  decision: Record<string, unknown> | null;
  expiresAt: string;
  createdAt: string;
  decidedAt: string | null;
}

export interface WorkspaceLeaseRecord {
  id: string;
  projectId: string;
  worktreePath: string;
  conversationId: string;
  turnId: string;
  provider: Provider;
  mode: "read-only" | "mutating";
  scopeKind: "git" | "path";
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  stale: boolean;
}

interface WorkspaceLeaseRow {
  id: string;
  project_id: string;
  worktree_path: string;
  conversation_id: string;
  turn_id: string;
  provider: Provider;
  mode: "read-only" | "mutating";
  scope_kind: "git" | "path";
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

interface EventRow {
  id: string;
  conversation_id: string;
  turn_id: string | null;
  sequence: number;
  type: string;
  provider: string | null;
  payload_json: string;
  previous_hash: string;
  event_hash: string;
  occurred_at: string;
}

interface HistorySourceRow {
  id: string;
  provider: Provider;
  native_session_id: string;
  conversation_id: string;
  source_created_at: string | null;
  source_updated_at: string | null;
  source_digest: string;
  import_status: HistorySourceRecord["importStatus"];
  imported_item_count: number;
  last_error: string | null;
  last_synced_at: string;
  metadata_json: string;
}

const MAX_EVENT_QUERY_LIMIT = 500;
const MAX_SEARCH_LIMIT = 100;

export class CanonicalStore {
  readonly database: Database.Database;
  private readonly now: () => Date;

  constructor(path: string, options: CanonicalStoreOptions = {}) {
    if (options.requireEncrypted === true && options.encryptionKey === undefined) {
      throw new Error("Encrypted storage is required, but no database encryption key was supplied");
    }
    this.database = new Database(path);
    this.now = options.now ?? (() => new Date());
    if (options.encryptionKey !== undefined) {
      if (options.encryptionKey.byteLength !== 32) {
        this.database.close();
        throw new Error("Database encryption key must contain exactly 32 bytes");
      }
      const encryptedDatabase = this.database as Database.Database & {
        key?: (key: Buffer) => number;
      };
      if (typeof encryptedDatabase.key !== "function") {
        this.database.close();
        throw new Error("Encrypted storage is required, but this runtime has no database key API");
      }
      this.database.pragma("cipher = 'sqlcipher'");
      this.database.pragma("legacy = 4");
      encryptedDatabase.key(Buffer.from(options.encryptionKey));
    }
    this.database.pragma("busy_timeout = 5000");
    this.migrate();
    if (options.requireEncrypted === true) {
      this.assertEncrypted();
    }
  }

  close(): void {
    this.database.close();
  }

  assertEncrypted(): void {
    let cipher: unknown;
    try {
      cipher = this.database.pragma("cipher", { simple: true });
    } catch {
      cipher = undefined;
    }
    if (cipher !== "sqlcipher") {
      throw new Error(
        "Encrypted storage is required, but this database is not using SQLCipher"
      );
    }
  }

  createProject(input: {
    name: string;
    repoRoot: string;
    allowedPaths?: string[];
    id?: string;
  }): ProjectRecord {
    const id = input.id ?? createId("project");
    const createdAt = this.now().toISOString();
    // Resolve and bound the scope before it is persisted, so every later reader
    // sees an absolute, symlink-resolved root that is inside its own scope.
    const { repoRoot, allowedPaths } = normalizeWorkspaceScope({
      repoRoot: input.repoRoot,
      ...(input.allowedPaths === undefined ? {} : { allowedPaths: input.allowedPaths })
    });
    const identity = captureWorkspaceIdentity(repoRoot);
    this.database
      .prepare(
        `INSERT INTO projects(
           id, name, repo_root, allowed_paths_json, root_device, root_inode, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        repoRoot,
        JSON.stringify(allowedPaths),
        identity.device,
        identity.inode,
        createdAt
      );
    return { id, name: input.name, repoRoot, allowedPaths, createdAt };
  }

  /**
   * Records a project discovered by a laptop-local provider history reader and
   * keeps it browse-only. A history transcript is descriptive data, not a
   * laptop-local authorization act, so only enrollProject may grant execution
   * scope. Remote clients cannot call either path or supply a root.
   */
  createImportedProject(input: {
    name: string;
    repoRoot: string;
    id?: string;
  }): ProjectRecord {
    const repoRoot = resolveWorkspacePath(input.repoRoot);
    const existing = this.getProjectByRepoRoot(repoRoot);
    if (existing !== null) {
      return existing;
    }
    const id = input.id ?? createId("project");
    const createdAt = this.now().toISOString();
    this.database
      .prepare(
        `INSERT INTO projects(id, name, repo_root, allowed_paths_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, input.name, repoRoot, "[]", createdAt);
    this.writeAudit("project.history_discovered", id, "success", {
      repoRoot,
      executionScope: "browse_only"
    });
    return { id, name: input.name, repoRoot, allowedPaths: [], createdAt };
  }

  /**
   * Re-checks every stored project against the current rules and withdraws
   * execution scope from any that no longer pass.
   *
   * The bounds are enforced when a project is created or imported, so a row
   * written under looser rules keeps whatever it was granted then. That
   * matters because history import creates projects from a `cwd` string it
   * reads out of a harness transcript, without anyone at the laptop acting:
   * a directory that should never have been usable can already be sitting in
   * the table. Tightening `assertUsableRepositoryRoot` does nothing for those
   * rows on its own.
   *
   * Scope is withdrawn rather than the row deleted. The conversations, their
   * events, and the hash chain over them all survive; what goes is the
   * ability to start a turn there, which is what needed a decision in the
   * first place. Running this at every start also catches a root that became
   * unusable after the fact — moved, deleted, or replaced by a symlink into
   * somewhere it should not reach.
   */
  revalidateProjectScopes(): { checked: number; withdrawn: string[] } {
    const withdrawn: string[] = [];
    const rows = this.database
      .prepare(
        `SELECT id, repo_root, root_device, root_inode
           FROM projects WHERE allowed_paths_json != '[]'`
      )
      .all() as Array<{
        id: string;
        repo_root: string;
        root_device: string | null;
        root_inode: string | null;
      }>;
    for (const row of rows) {
      let reason: string | null = null;
      try {
        if (row.root_device === null || row.root_inode === null) {
          throw new Error("Project root has no enrolled filesystem identity");
        }
        assertWorkspaceIdentity(row.repo_root, {
          device: row.root_device,
          inode: row.root_inode
        });
      } catch (error) {
        reason = error instanceof Error ? error.message : "Project root is no longer usable";
      }
      if (reason === null) continue;
      this.database
        .prepare("UPDATE projects SET allowed_paths_json = '[]' WHERE id = ?")
        .run(row.id);
      this.writeAudit("project.scope_withdrawn", row.id, "success", {
        repoRoot: row.repo_root,
        reason
      });
      withdrawn.push(row.id);
    }
    return { checked: rows.length, withdrawn };
  }

  /** Grants execution scope only after a laptop-local administrator acts. */
  enrollProject(input: { name: string; repoRoot: string }): ProjectRecord {
    const { repoRoot, allowedPaths } = normalizeWorkspaceScope({ repoRoot: input.repoRoot });
    const identity = captureWorkspaceIdentity(repoRoot);
    const existing = this.getProjectByRepoRoot(repoRoot);
    if (existing === null) {
      const project = this.createProject({ name: input.name, repoRoot, allowedPaths });
      this.writeAudit("project.enrolled", project.id, "success", { repoRoot, source: "local" });
      return project;
    }
    this.database
      .prepare(
        `UPDATE projects
            SET name = ?, allowed_paths_json = ?, root_device = ?, root_inode = ?
          WHERE id = ?`
      )
      .run(
        input.name,
        JSON.stringify(allowedPaths),
        identity.device,
        identity.inode,
        existing.id
      );
    this.writeAudit("project.enrolled", existing.id, "success", {
      repoRoot,
      source: existing.allowedPaths.length === 0 ? "history" : "local"
    });
    return this.getProject(existing.id);
  }

  /** Revalidates both the authorization scope and the enrolled directory identity. */
  assertProjectExecutionScope(projectId: string): string {
    const project = this.getProject(projectId);
    // Preserve the standard empty-scope error for browse-only history records.
    if (project.allowedPaths.length === 0) {
      return assertWithinWorkspaceScope(project.repoRoot, project.allowedPaths);
    }
    const row = this.database
      .prepare("SELECT root_device, root_inode FROM projects WHERE id = ?")
      .get(projectId) as { root_device: string | null; root_inode: string | null } | undefined;
    if (row === undefined || row.root_device === null || row.root_inode === null) {
      throw new WorkspaceScopeError("Project root has no enrolled filesystem identity");
    }
    const resolved = assertWorkspaceIdentity(project.repoRoot, {
      device: row.root_device,
      inode: row.root_inode
    });
    return assertWithinWorkspaceScope(resolved, project.allowedPaths);
  }

  listProjects(): ProjectRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM projects ORDER BY created_at, id")
      .all() as Array<{
      id: string;
      name: string;
      repo_root: string;
      allowed_paths_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      repoRoot: row.repo_root,
      allowedPaths: JSON.parse(row.allowed_paths_json) as string[],
      createdAt: row.created_at
    }));
  }

  getProjectByRepoRoot(repoRoot: string): ProjectRecord | null {
    // createProject stores the resolved root, so the lookup has to resolve too
    // or two names for one directory would mint two projects.
    let normalized: string;
    try {
      normalized = resolveWorkspacePath(repoRoot);
    } catch {
      return null;
    }
    const row = this.database.prepare("SELECT id FROM projects WHERE repo_root = ?").get(normalized) as
      | { id: string }
      | undefined;
    return row === undefined ? null : this.getProject(row.id);
  }

  createConversation(input: {
    projectId: string;
    title: string;
    activeProvider?: Provider | null;
    id?: string;
  }): ConversationRecord {
    const id = input.id ?? createId("conv");
    const now = this.now().toISOString();
    const activeProvider = input.activeProvider ?? null;
    const titleRedaction = redactText(input.title);
    const title = titleRedaction.value.slice(0, 500) || "Untitled conversation";
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO conversations(
             id, project_id, title, status, active_provider, fallback_route_json, next_sequence,
             created_at, updated_at
           ) VALUES (?, ?, ?, 'active', ?, ?, 1, ?, ?)`
        )
        .run(
          id,
          input.projectId,
          title,
          activeProvider,
          JSON.stringify(activeProvider === null ? [] : [activeProvider]),
          now,
          now
        );
      this.appendEventInternal({
        conversationId: id,
        type: "conversation.created",
        provider: activeProvider,
        payload: { projectId: input.projectId, title },
        occurredAt: now
      });
      if (titleRedaction.redacted) {
        this.appendEventInternal({
          conversationId: id,
          type: "security.redaction.applied",
          provider: activeProvider,
          payload: { target: "conversation.title", markers: titleRedaction.markers },
          occurredAt: now
        });
      }
    });
    transaction();
    return this.getConversation(id);
  }

  registerDevice(input: {
    id: string;
    displayName: string;
    signingPublicKey: string;
    approvalPublicKey: string;
    capabilities?: string[];
    attestation?: Record<string, unknown> | null;
  }): DeviceRecord {
    const createdAt = this.now().toISOString();
    this.database
      .prepare(
        `INSERT INTO devices(
           id, display_name, signing_public_key, approval_public_key, status,
           last_counter, capabilities_json, attestation_json, created_at, revoked_at
         ) VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           signing_public_key = excluded.signing_public_key,
           approval_public_key = excluded.approval_public_key,
           status = 'active',
           last_counter = 0,
           capabilities_json = excluded.capabilities_json,
           attestation_json = excluded.attestation_json,
           created_at = excluded.created_at,
           revoked_at = NULL
         WHERE devices.status = 'revoked'`
      )
      .run(
        input.id,
        input.displayName,
        input.signingPublicKey,
        input.approvalPublicKey,
        JSON.stringify(input.capabilities ?? []),
        input.attestation === undefined || input.attestation === null
          ? null
          : JSON.stringify(input.attestation),
        createdAt
      );
    const changes = this.database.prepare("SELECT changes() AS count").get() as { count: number };
    if (changes.count !== 1) {
      throw new Error(`Device is already active: ${input.id}`);
    }
    this.writeAudit("device.registered", input.id, "success", {
      displayName: input.displayName
    });
    return this.getDevice(input.id);
  }

  listDevices(): DeviceRecord[] {
    const rows = this.database
      .prepare("SELECT id FROM devices ORDER BY created_at, id")
      .all() as Array<{ id: string }>;
    return rows.map((row) => this.getDevice(row.id));
  }

  getDevice(id: string): DeviceRecord {
    const row = this.database.prepare("SELECT * FROM devices WHERE id = ?").get(id) as
      | {
          id: string;
          display_name: string;
          signing_public_key: string;
          approval_public_key: string;
          status: DeviceRecord["status"];
          last_counter: number;
          capabilities_json: string;
          attestation_json: string | null;
          created_at: string;
          revoked_at: string | null;
        }
      | undefined;
    if (row === undefined) throw new Error(`Unknown device: ${id}`);
    return {
      id: row.id,
      displayName: row.display_name,
      signingPublicKey: row.signing_public_key,
      approvalPublicKey: row.approval_public_key,
      status: row.status,
      lastCounter: row.last_counter,
      capabilities: JSON.parse(row.capabilities_json) as string[],
      attestation:
        row.attestation_json === null
          ? null
          : (JSON.parse(row.attestation_json) as Record<string, unknown>),
      createdAt: row.created_at,
      revokedAt: row.revoked_at
    };
  }

  advanceDeviceCounter(deviceId: string, counter: number): void {
    if (!Number.isSafeInteger(counter) || counter < 1) {
      throw new Error("Device counter must be a positive safe integer");
    }
    const result = this.database
      .prepare(
        `UPDATE devices SET last_counter = ?
          WHERE id = ? AND status = 'active' AND last_counter < ?`
      )
      .run(counter, deviceId, counter);
    if (result.changes !== 1) {
      throw new Error("Device is revoked or request counter was replayed");
    }
  }

  revokeDevice(deviceId: string): DeviceRecord {
    const revokedAt = this.now().toISOString();
    const result = this.database
      .prepare(
        `UPDATE devices SET status = 'revoked', revoked_at = ?
          WHERE id = ? AND status != 'revoked'`
      )
      .run(revokedAt, deviceId);
    if (result.changes !== 1) throw new Error("Device is missing or already revoked");
    this.writeAudit("device.revoked", deviceId, "success", {});
    return this.getDevice(deviceId);
  }

  createApproval(input: {
    id?: string;
    conversationId: string;
    turnId: string;
    provider: Provider;
    request: Record<string, unknown>;
    expiresAt: string;
  }): ApprovalRecord {
    const id = input.id ?? createId("approval");
    const createdAt = this.now().toISOString();
    if (Date.parse(input.expiresAt) <= this.now().getTime()) {
      throw new Error("Approval expiry must be in the future");
    }
    this.database
      .prepare(
        `INSERT INTO approvals(
           id, conversation_id, turn_id, provider, status, request_json,
           decision_json, expires_at, created_at, decided_at
         ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, ?, ?, NULL)`
      )
      .run(
        id,
        input.conversationId,
        input.turnId,
        input.provider,
        JSON.stringify(input.request),
        input.expiresAt,
        createdAt
      );
    return this.getApproval(id);
  }

  getApproval(id: string): ApprovalRecord {
    const row = this.database.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | {
          id: string;
          conversation_id: string;
          turn_id: string;
          provider: Provider;
          status: ApprovalRecord["status"];
          request_json: string;
          decision_json: string | null;
          expires_at: string;
          created_at: string;
          decided_at: string | null;
        }
      | undefined;
    if (row === undefined) throw new Error(`Unknown approval: ${id}`);
    return {
      id: row.id,
      conversationId: row.conversation_id,
      turnId: row.turn_id,
      provider: row.provider,
      status: row.status,
      request: JSON.parse(row.request_json) as Record<string, unknown>,
      decision: row.decision_json === null ? null : (JSON.parse(row.decision_json) as Record<string, unknown>),
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      decidedAt: row.decided_at
    };
  }

  listApprovals(conversationId: string, status?: ApprovalRecord["status"]): ApprovalRecord[] {
    const rows = (status === undefined
      ? this.database
          .prepare("SELECT id FROM approvals WHERE conversation_id = ? ORDER BY created_at, id")
          .all(conversationId)
      : this.database
          .prepare(
            "SELECT id FROM approvals WHERE conversation_id = ? AND status = ? ORDER BY created_at, id"
          )
          .all(conversationId, status)) as Array<{ id: string }>;
    return rows.map((row) => this.getApproval(row.id));
  }

  recordApprovalDecision(input: {
    approvalId: string;
    choice: string;
    deviceId: string;
    decidedAt: string;
    signature: string;
  }): ApprovalRecord {
    const approval = this.getApproval(input.approvalId);
    if (approval.status !== "pending") throw new Error("Approval is not pending");
    if (Date.parse(approval.expiresAt) <= this.now().getTime()) {
      this.database.prepare("UPDATE approvals SET status = 'expired' WHERE id = ?").run(input.approvalId);
      throw new Error("Approval expired");
    }
    const choices = Array.isArray(approval.request.choices)
      ? approval.request.choices.filter((choice): choice is string => typeof choice === "string")
      : [];
    if (!choices.includes(input.choice)) throw new Error("Approval choice is not offered");
    const result = this.database
      .prepare(
        `UPDATE approvals
            SET status = 'decided', decision_json = ?, decided_at = ?
          WHERE id = ? AND status = 'pending'`
      )
      .run(
        JSON.stringify({
          choice: input.choice,
          deviceId: input.deviceId,
          signature: input.signature
        }),
        input.decidedAt,
        input.approvalId
      );
    if (result.changes !== 1) throw new Error("Approval decision raced");
    return this.getApproval(input.approvalId);
  }

  markApprovalDeliveryFailed(approvalId: string): ApprovalRecord {
    const result = this.database
      .prepare("UPDATE approvals SET status = 'delivery_failed' WHERE id = ? AND status = 'decided'")
      .run(approvalId);
    if (result.changes !== 1) throw new Error("Approval decision is not deliverable");
    return this.getApproval(approvalId);
  }

  expireApproval(approvalId: string): ApprovalRecord {
    this.database
      .prepare("UPDATE approvals SET status = 'expired' WHERE id = ? AND status = 'pending'")
      .run(approvalId);
    return this.getApproval(approvalId);
  }

  acquireWorkspaceLease(input: {
    projectId: string;
    worktreePath: string;
    conversationId: string;
    turnId: string;
    provider: Provider;
    mode: "read-only" | "mutating";
    scopeKind?: "git" | "path";
    lifetimeMs?: number;
    id?: string;
  }): WorkspaceLeaseRecord {
    const lifetimeMs = input.lifetimeMs ?? 60_000;
    const scopeKind = input.scopeKind ?? "path";
    assertLeaseLifetime(lifetimeMs);
    return this.database.transaction(() => {
      const conflict = this.listWorkspaceLeases().find((lease) => {
        const sameScope = scopeKind === "git" && lease.scopeKind === "git"
          ? lease.worktreePath === input.worktreePath
          : workspacePathsOverlap(lease.worktreePath, input.worktreePath);
        return sameScope && (input.mode === "mutating" || lease.mode === "mutating");
      });
      if (conflict !== undefined) {
        throw new Error(
          conflict.stale
            ? "Workspace has a stale lease that requires reconciliation"
            : "Workspace already has an active conflicting lease"
        );
      }
      const id = input.id ?? createId("lease");
      const now = this.now();
      const acquiredAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + lifetimeMs).toISOString();
      this.database
        .prepare(
          `INSERT INTO workspace_leases(
             id, project_id, worktree_path, conversation_id, turn_id, provider,
             mode, scope_kind, acquired_at, heartbeat_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.projectId,
          input.worktreePath,
          input.conversationId,
          input.turnId,
          input.provider,
          input.mode,
          scopeKind,
          acquiredAt,
          acquiredAt,
          expiresAt
        );
      return this.getWorkspaceLease(id);
    })();
  }

  getWorkspaceLease(id: string): WorkspaceLeaseRecord {
    const row = this.database.prepare("SELECT * FROM workspace_leases WHERE id = ?").get(id) as
      | WorkspaceLeaseRow
      | undefined;
    if (row === undefined) throw new Error(`Unknown workspace lease: ${id}`);
    return workspaceLeaseFromRow(row, this.now());
  }

  listWorkspaceLeases(worktreePath?: string): WorkspaceLeaseRecord[] {
    const rows = (worktreePath === undefined
      ? this.database.prepare("SELECT * FROM workspace_leases ORDER BY acquired_at, id").all()
      : this.database
          .prepare(
            "SELECT * FROM workspace_leases WHERE worktree_path = ? ORDER BY acquired_at, id"
          )
          .all(worktreePath)) as WorkspaceLeaseRow[];
    const now = this.now();
    return rows.map((row) => workspaceLeaseFromRow(row, now));
  }

  heartbeatWorkspaceLease(id: string, turnId: string, lifetimeMs = 60_000): WorkspaceLeaseRecord {
    assertLeaseLifetime(lifetimeMs);
    const lease = this.getWorkspaceLease(id);
    if (lease.turnId !== turnId) throw new Error("Workspace lease owner mismatch");
    if (lease.stale) throw new Error("Stale workspace lease requires reconciliation");
    const now = this.now();
    const result = this.database
      .prepare("UPDATE workspace_leases SET heartbeat_at = ?, expires_at = ? WHERE id = ?")
      .run(now.toISOString(), new Date(now.getTime() + lifetimeMs).toISOString(), id);
    if (result.changes !== 1) throw new Error("Workspace lease disappeared");
    return this.getWorkspaceLease(id);
  }

  releaseWorkspaceLease(id: string, turnId: string): void {
    const result = this.database
      .prepare("DELETE FROM workspace_leases WHERE id = ? AND turn_id = ?")
      .run(id, turnId);
    if (result.changes !== 1) throw new Error("Workspace lease is missing or owned by another turn");
  }

  releaseStaleWorkspaceLeaseAfterReconciliation(id: string): void {
    const lease = this.getWorkspaceLease(id);
    if (!lease.stale) throw new Error("Active workspace lease cannot be reconciled away");
    const result = this.database.prepare("DELETE FROM workspace_leases WHERE id = ?").run(id);
    if (result.changes !== 1) throw new Error("Workspace lease disappeared during reconciliation");
  }

  writeAudit(
    action: string,
    subjectId: string | null,
    result: string,
    metadata: Record<string, unknown>
  ): void {
    this.database
      .prepare(
        `INSERT INTO audit_log(id, action, subject_id, result, metadata_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        createId("audit"),
        action,
        subjectId,
        result,
        JSON.stringify(metadata),
        this.now().toISOString()
      );
  }

  /**
   * Drops audit rows older than the retention window, keeping a floor of the
   * most recent entries whatever their age.
   *
   * Every authenticated request writes a row, and so does every failed one —
   * including failures rejected before any signature is checked, which a
   * caller that can reach the loopback port can produce as fast as it can
   * send headers. Nothing pruned the table, so it grew for as long as the
   * daemon ran, inside the encrypted store, with no ceiling.
   *
   * The floor matters more than the window: an incident worth investigating
   * is usually recent and dense, and a burst of failures should not push the
   * evidence of what caused them out of the table.
   */
  pruneAuditLog(options: { retainDays?: number; retainRows?: number } = {}): number {
    const retainDays = options.retainDays ?? 90;
    const retainRows = options.retainRows ?? 50_000;
    if (!Number.isSafeInteger(retainDays) || retainDays < 1) {
      throw new Error("Audit retention window must be a positive number of days");
    }
    if (!Number.isSafeInteger(retainRows) || retainRows < 1) {
      throw new Error("Audit retention floor must be a positive row count");
    }
    const cutoff = new Date(this.now().getTime() - retainDays * 24 * 60 * 60_000).toISOString();
    const result = this.database
      .prepare(
        `DELETE FROM audit_log
          WHERE occurred_at < ?
            AND id NOT IN (
              SELECT id FROM audit_log ORDER BY occurred_at DESC, id DESC LIMIT ?
            )`
      )
      .run(cutoff, retainRows);
    return result.changes;
  }

  getProject(id: string): ProjectRecord {
    const row = this.database
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(id) as
      | {
          id: string;
          name: string;
          repo_root: string;
          allowed_paths_json: string;
          created_at: string;
        }
      | undefined;
    if (row === undefined) {
      throw new Error(`Unknown project: ${id}`);
    }
    return {
      id: row.id,
      name: row.name,
      repoRoot: row.repo_root,
      allowedPaths: JSON.parse(row.allowed_paths_json) as string[],
      createdAt: row.created_at
    };
  }

  getConversation(id: string): ConversationRecord {
    const row = this.database
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(id) as
      | {
          id: string;
          project_id: string;
          title: string;
          status: ConversationRecord["status"];
          active_provider: Provider | null;
          fallback_route_json: string;
          pinned: number;
          next_sequence: number;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (row === undefined) {
      throw new Error(`Unknown conversation: ${id}`);
    }
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      status: row.status,
      activeProvider: row.active_provider,
      fallbackRoute: parseFallbackRoute(row.fallback_route_json),
      pinned: row.pinned === 1,
      nextSequence: row.next_sequence,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listConversations(projectId?: string): ConversationRecord[] {
    const rows = (projectId === undefined
      ? this.database.prepare("SELECT id FROM conversations ORDER BY updated_at DESC").all()
      : this.database
          .prepare("SELECT id FROM conversations WHERE project_id = ? ORDER BY updated_at DESC")
          .all(projectId)) as Array<{ id: string }>;
    return rows.map((row) => this.getConversation(row.id));
  }

  listConversationPage(
    after: ConversationListCursor | null,
    limit = 30
  ): ConversationListPage {
    const bounded = boundedLimit(limit, 100);
    const rows = (after === null
      ? this.database
          .prepare(
            `SELECT id, pinned, updated_at
               FROM conversations
              ORDER BY pinned DESC, updated_at DESC, id DESC
              LIMIT ?`
          )
          .all(bounded + 1)
      : this.database
          .prepare(
            `SELECT id, pinned, updated_at
               FROM conversations
              WHERE pinned < ?
                 OR (pinned = ? AND updated_at < ?)
                 OR (pinned = ? AND updated_at = ? AND id < ?)
              ORDER BY pinned DESC, updated_at DESC, id DESC
              LIMIT ?`
          )
          .all(
            after.pinned ? 1 : 0,
            after.pinned ? 1 : 0,
            after.updatedAt,
            after.pinned ? 1 : 0,
            after.updatedAt,
            after.id,
            bounded + 1
          )) as Array<{ id: string; pinned: number; updated_at: string }>;
    const hasMore = rows.length > bounded;
    const pageRows = rows.slice(0, bounded);
    const last = pageRows.at(-1);
    return {
      conversations: pageRows.map((row) => this.getConversation(row.id)),
      nextCursor: last === undefined
        ? after
        : { pinned: last.pinned === 1, updatedAt: last.updated_at, id: last.id },
      hasMore
    };
  }

  listConversationChanges(
    after: ConversationSyncCursor | null,
    limit = 200
  ): ConversationSyncPage {
    const bounded = boundedLimit(limit, 500);
    const rows = (after === null
      ? this.database
          .prepare(
            `SELECT conversations.id, conversation_changes.sequence
               FROM conversation_changes
               JOIN conversations ON conversations.id = conversation_changes.conversation_id
              ORDER BY conversation_changes.sequence LIMIT ?`
          )
          .all(bounded + 1)
      : this.database
          .prepare(
            `SELECT conversations.id, conversation_changes.sequence
               FROM conversation_changes
               JOIN conversations ON conversations.id = conversation_changes.conversation_id
              WHERE conversation_changes.sequence > ?
              ORDER BY conversation_changes.sequence LIMIT ?`
          )
          .all(after.sequence, bounded + 1)) as Array<{
      id: string;
      sequence: number;
    }>;
    const hasMore = rows.length > bounded;
    const pageRows = rows.slice(0, bounded);
    const last = pageRows.at(-1);
    return {
      conversations: pageRows.map((row) => this.getConversation(row.id)),
      nextCursor: last === undefined ? after : { sequence: last.sequence },
      hasMore
    };
  }

  setConversationPinned(id: string, pinned: boolean): ConversationRecord {
    const result = this.database
      .prepare("UPDATE conversations SET pinned = ? WHERE id = ?")
      .run(pinned ? 1 : 0, id);
    if (result.changes !== 1) throw new Error(`Unknown conversation: ${id}`);
    return this.getConversation(id);
  }

  setConversationFallbackRoute(id: string, route: Provider[]): ConversationRecord {
    const conversation = this.getConversation(id);
    const normalized = normalizeFallbackRoute(route);
    if (conversation.activeProvider !== null && !normalized.includes(conversation.activeProvider)) {
      throw new Error("Fallback route must include the active harness");
    }
    const result = this.database
      .prepare("UPDATE conversations SET fallback_route_json = ? WHERE id = ?")
      .run(JSON.stringify(normalized), id);
    if (result.changes !== 1) throw new Error(`Unknown conversation: ${id}`);
    return this.getConversation(id);
  }

  getProviderBinding(conversationId: string, provider: Provider): ProviderBindingRecord | null {
    const row = this.database
      .prepare("SELECT * FROM provider_bindings WHERE conversation_id = ? AND provider = ?")
      .get(conversationId, provider) as
      | {
          conversation_id: string;
          provider: Provider;
          native_session_id: string | null;
          synchronized_through_sequence: number;
          status: string;
          metadata_json: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    return row === undefined ? null : providerBindingFromRow(row);
  }

  upsertProviderBinding(input: {
    conversationId: string;
    provider: Provider;
    nativeSessionId: string | null;
    synchronizedThroughSequence?: number;
    status?: string;
    metadata?: Record<string, unknown>;
  }): ProviderBindingRecord {
    const now = this.now().toISOString();
    const metadata = redactPayload(input.metadata ?? {}).value;
    this.database
      .prepare(
        `INSERT INTO provider_bindings(
           conversation_id, provider, native_session_id, synchronized_through_sequence,
           status, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, provider) DO UPDATE SET
           native_session_id = excluded.native_session_id,
           synchronized_through_sequence = excluded.synchronized_through_sequence,
           status = excluded.status,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`
      )
      .run(
        input.conversationId,
        input.provider,
        input.nativeSessionId,
        input.synchronizedThroughSequence ?? 0,
        input.status ?? "bound",
        JSON.stringify(metadata),
        now,
        now
      );
    return this.getProviderBinding(input.conversationId, input.provider) as ProviderBindingRecord;
  }

  listHistorySources(provider?: Provider): HistorySourceRecord[] {
    const rows = (provider === undefined
      ? this.database.prepare("SELECT * FROM history_sources ORDER BY source_updated_at DESC, id").all()
      : this.database
          .prepare("SELECT * FROM history_sources WHERE provider = ? ORDER BY source_updated_at DESC, id")
          .all(provider)) as HistorySourceRow[];
    return rows.map(historySourceFromRow);
  }

  recordHistoryImportFailure(input: {
    provider: Provider;
    nativeSessionId: string;
    error: string;
  }): void {
    const now = this.now().toISOString();
    const error = redactText(input.error).value.slice(0, 2_000);
    this.database
      .prepare(
        `UPDATE history_sources
            SET import_status = 'failed', last_error = ?, last_synced_at = ?
          WHERE provider = ? AND native_session_id = ?`
      )
      .run(error, now, input.provider, input.nativeSessionId);
  }

  importHistoryThread(input: {
    provider: Provider;
    nativeSessionId: string;
    projectId: string;
    title: string;
    archived?: boolean;
    sourceCreatedAt?: string | null;
    sourceUpdatedAt?: string | null;
    sourceDigest: string;
    metadata?: Record<string, unknown>;
    items: HistoryImportItem[];
  }): HistoryImportResult {
    return this.database.transaction(() => {
      const now = this.now().toISOString();
      const title = redactText(input.title).value.slice(0, 500) || `${input.provider} thread`;
      const metadata = redactPayload(input.metadata ?? {}).value;
      let sourceRow = this.database
        .prepare("SELECT * FROM history_sources WHERE provider = ? AND native_session_id = ?")
        .get(input.provider, input.nativeSessionId) as HistorySourceRow | undefined;
      let conversation: ConversationRecord;
      if (sourceRow === undefined) {
        const conversationId = createId("conv");
        const createdAt = input.sourceCreatedAt ?? now;
        const updatedAt = input.sourceUpdatedAt ?? createdAt;
        this.database
          .prepare(
            `INSERT INTO conversations(
               id, project_id, title, status, active_provider, fallback_route_json,
               next_sequence, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
          )
          .run(
            conversationId,
            input.projectId,
            title,
            input.archived === true ? "archived" : "active",
            input.provider,
            JSON.stringify([input.provider]),
            createdAt,
            createdAt
          );
        this.appendEventInternal({
          conversationId,
          type: "conversation.created",
          provider: input.provider,
          payload: {
            projectId: input.projectId,
            title,
            imported: true,
            nativeSessionId: input.nativeSessionId
          },
          occurredAt: createdAt
        });
        const sourceId = createId("history");
        this.database
          .prepare(
            `INSERT INTO history_sources(
               id, provider, native_session_id, conversation_id, source_created_at,
               source_updated_at, source_digest, import_status, imported_item_count,
               last_error, last_synced_at, metadata_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'importing', 0, NULL, ?, ?)`
          )
          .run(
            sourceId,
            input.provider,
            input.nativeSessionId,
            conversationId,
            input.sourceCreatedAt ?? null,
            input.sourceUpdatedAt ?? null,
            input.sourceDigest,
            now,
            JSON.stringify(metadata)
          );
        this.upsertProviderBinding({
          conversationId,
          provider: input.provider,
          nativeSessionId: input.nativeSessionId,
          metadata: { imported: true }
        });
        sourceRow = this.database.prepare("SELECT * FROM history_sources WHERE id = ?").get(sourceId) as HistorySourceRow;
        conversation = this.getConversation(conversationId);
        if (updatedAt !== createdAt) {
          this.database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(updatedAt, conversationId);
        }
      } else {
        conversation = this.getConversation(sourceRow.conversation_id);
        const status = input.archived === true ? "archived" : "active";
        const updatedAt = input.sourceUpdatedAt ?? conversation.updatedAt;
        if (
          conversation.projectId !== input.projectId ||
          conversation.title !== title ||
          conversation.status !== status ||
          conversation.updatedAt !== updatedAt
        ) {
          this.database
            .prepare(
              `UPDATE conversations
                  SET project_id = ?, title = ?, status = ?, updated_at = ?
                WHERE id = ?`
            )
            .run(input.projectId, title, status, updatedAt, conversation.id);
        }
        this.database
          .prepare("UPDATE history_sources SET import_status = 'importing', last_error = NULL WHERE id = ?")
          .run(sourceRow.id);
      }

      let inserted = 0;
      let corrected = 0;
      let unchanged = 0;
      for (const item of [...input.items].sort(compareHistoryItems)) {
        const itemPayload = redactPayload(item.payload).value;
        const existing = this.database
          .prepare(
            "SELECT canonical_event_id, content_digest FROM imported_items WHERE history_source_id = ? AND native_item_id = ?"
          )
          .get(sourceRow.id, item.nativeItemId) as
          | { canonical_event_id: string; content_digest: string }
          | undefined;
        if (existing?.content_digest === item.contentDigest) {
          unchanged += 1;
          continue;
        }
        const event = this.appendEventInternal({
          conversationId: conversation.id,
          type: item.type,
          provider: input.provider,
          payload: {
            ...itemPayload,
            imported: true,
            nativeSessionId: input.nativeSessionId,
            nativeItemId: item.nativeItemId,
            ...(existing === undefined
              ? {}
              : { supersedesEventId: existing.canonical_event_id, sourceOccurredAt: item.occurredAt })
          },
          occurredAt: existing === undefined ? item.occurredAt : now
        });
        this.database
          .prepare(
            `INSERT INTO imported_items(
               history_source_id, native_item_id, canonical_event_id, content_digest, imported_at
             ) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(history_source_id, native_item_id) DO UPDATE SET
               canonical_event_id = excluded.canonical_event_id,
               content_digest = excluded.content_digest,
               imported_at = excluded.imported_at`
          )
          .run(sourceRow.id, item.nativeItemId, event.id, item.contentDigest, now);
        if (existing === undefined) inserted += 1;
        else corrected += 1;
      }
      const importedItemCount = (this.database
        .prepare("SELECT COUNT(*) AS count FROM imported_items WHERE history_source_id = ?")
        .get(sourceRow.id) as { count: number }).count;
      this.database
        .prepare(
          `UPDATE history_sources SET
             source_created_at = ?, source_updated_at = ?, source_digest = ?,
             import_status = 'complete', imported_item_count = ?, last_error = NULL,
             last_synced_at = ?, metadata_json = ?
           WHERE id = ?`
        )
        .run(
          input.sourceCreatedAt ?? null,
          input.sourceUpdatedAt ?? null,
          input.sourceDigest,
          importedItemCount,
          now,
          JSON.stringify(metadata),
          sourceRow.id
        );
      if (input.sourceUpdatedAt !== undefined && input.sourceUpdatedAt !== null) {
        const currentUpdatedAt = this.getConversation(conversation.id).updatedAt;
        if (currentUpdatedAt < input.sourceUpdatedAt) {
          this.database
            .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
            .run(input.sourceUpdatedAt, conversation.id);
        }
      }
      this.upsertProviderBinding({
        conversationId: conversation.id,
        provider: input.provider,
        nativeSessionId: input.nativeSessionId,
        synchronizedThroughSequence: this.getConversation(conversation.id).nextSequence - 1,
        metadata: { imported: true }
      });
      return {
        source: historySourceFromRow(
          this.database.prepare("SELECT * FROM history_sources WHERE id = ?").get(sourceRow.id) as HistorySourceRow
        ),
        conversation: this.getConversation(conversation.id),
        inserted,
        corrected,
        unchanged
      };
    })();
  }

  setActiveProvider(conversationId: string, provider: Provider): ConversationRecord {
    const conversation = this.getConversation(conversationId);
    const fallbackRoute = conversation.fallbackRoute.includes(provider)
      ? conversation.fallbackRoute
      : [provider];
    const result = this.database
      .prepare(
        "UPDATE conversations SET active_provider = ?, fallback_route_json = ?, updated_at = ? WHERE id = ?"
      )
      .run(provider, JSON.stringify(fallbackRoute), this.now().toISOString(), conversationId);
    if (result.changes !== 1) throw new Error(`Unknown conversation: ${conversationId}`);
    return this.getConversation(conversationId);
  }

  startTurn(input: { id: string; conversationId: string; provider: Provider }): void {
    this.database
      .prepare(
        `INSERT INTO turns(id, conversation_id, provider, status, started_at, completed_at)
         VALUES (?, ?, ?, 'running', ?, NULL)`
      )
      .run(input.id, input.conversationId, input.provider, this.now().toISOString());
  }

  finishTurn(turnId: string, status: "completed" | "failed" | "interrupted"): void {
    const result = this.database
      .prepare("UPDATE turns SET status = ?, completed_at = ? WHERE id = ? AND status = 'running'")
      .run(status, this.now().toISOString(), turnId);
    if (result.changes !== 1) throw new Error("Turn is missing or no longer running");
  }

  getIdempotentResponse(scope: string, key: string, requestHash: string): unknown | null {
    const row = this.database
      .prepare(
        `SELECT request_hash, response_json, expires_at
           FROM idempotency_records WHERE scope = ? AND key = ?`
      )
      .get(scope, key) as
      | { request_hash: string; response_json: string; expires_at: string }
      | undefined;
    if (row === undefined || Date.parse(row.expires_at) <= this.now().getTime()) return null;
    if (row.request_hash !== requestHash) {
      throw new Error("Idempotency key was reused with a different request");
    }
    return JSON.parse(row.response_json) as unknown;
  }

  putIdempotentResponse(input: {
    scope: string;
    key: string;
    requestHash: string;
    response: unknown;
    lifetimeMs?: number;
  }): void {
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + (input.lifetimeMs ?? 24 * 60 * 60 * 1_000));
    this.database
      .prepare(
        `INSERT INTO idempotency_records(
           scope, key, request_hash, response_json, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.scope,
        input.key,
        input.requestHash,
        JSON.stringify(input.response),
        createdAt.toISOString(),
        expiresAt.toISOString()
      );
  }

  appendEvent(input: AppendEventInput): EventEnvelope {
    return this.database.transaction(() => this.appendEventInternal(input))();
  }

  listEvents(conversationId: string, query: EventQuery = {}): EventEnvelope[] {
    const limit = boundedLimit(query.limit, MAX_EVENT_QUERY_LIMIT);
    const conditions = ["conversation_id = ?"];
    const values: unknown[] = [conversationId];
    if (query.after !== undefined) {
      conditions.push("sequence > ?");
      values.push(query.after);
    }
    if (query.before !== undefined) {
      conditions.push("sequence < ?");
      values.push(query.before);
    }
    if (query.type !== undefined) {
      conditions.push("type = ?");
      values.push(query.type);
    }
    if (query.provider !== undefined) {
      conditions.push("provider = ?");
      values.push(query.provider);
    }
    if (query.displayOnly === true) {
      conditions.push("type IN (?, ?, ?)");
      values.push("user.message", "assistant.message.completed", "provider.handoff.completed");
    }
    values.push(limit);
    const rows = this.database
      .prepare(
        `SELECT * FROM events WHERE ${conditions.join(" AND ")}
         ORDER BY sequence ASC LIMIT ?`
      )
      .all(...values) as EventRow[];
    return rows.map(eventFromRow);
  }

  listRecentEvents(conversationId: string, query: Omit<EventQuery, "after"> = {}): EventEnvelope[] {
    const limit = boundedLimit(query.limit, MAX_EVENT_QUERY_LIMIT);
    const conditions = ["conversation_id = ?"];
    const values: unknown[] = [conversationId];
    if (query.before !== undefined) {
      conditions.push("sequence < ?");
      values.push(query.before);
    }
    if (query.type !== undefined) {
      conditions.push("type = ?");
      values.push(query.type);
    }
    if (query.provider !== undefined) {
      conditions.push("provider = ?");
      values.push(query.provider);
    }
    if (query.displayOnly === true) {
      conditions.push("type IN (?, ?, ?)");
      values.push("user.message", "assistant.message.completed", "provider.handoff.completed");
    }
    values.push(limit);
    const rows = this.database
      .prepare(
        `SELECT * FROM events WHERE ${conditions.join(" AND ")}
         ORDER BY sequence DESC LIMIT ?`
      )
      .all(...values) as EventRow[];
    return rows.reverse().map(eventFromRow);
  }

  getEvent(eventId: string, conversationId?: string): EventEnvelope {
    const row = (conversationId === undefined
      ? this.database.prepare("SELECT * FROM events WHERE id = ?").get(eventId)
      : this.database
          .prepare("SELECT * FROM events WHERE id = ? AND conversation_id = ?")
          .get(eventId, conversationId)) as EventRow | undefined;
    if (row === undefined) {
      throw new Error(`Unknown event: ${eventId}`);
    }
    return eventFromRow(row);
  }

  searchEvents(
    projectId: string,
    conversationId: string,
    query: string,
    limit = 20
  ): SearchResult[] {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length === 0 || normalizedQuery.length > 1_000) {
      throw new Error("Search query must contain between 1 and 1000 characters");
    }
    const rows = this.database
      .prepare(
        `SELECT e.*, snippet(events_fts, 5, '[', ']', '…', 18) AS snippet,
                bm25(events_fts) AS rank
           FROM events_fts
           JOIN events e ON e.id = events_fts.event_id
          WHERE events_fts MATCH ?
            AND events_fts.project_id = ?
            AND events_fts.conversation_id = ?
          ORDER BY rank
          LIMIT ?`
      )
      .all(normalizedQuery, projectId, conversationId, boundedLimit(limit, MAX_SEARCH_LIMIT)) as Array<
      EventRow & { snippet: string; rank: number }
    >;
    return rows.map((row) => ({
      event: eventFromRow(row),
      snippet: row.snippet,
      rank: row.rank
    }));
  }

  latestEventByType(conversationId: string, type: EventType): EventEnvelope | null {
    const row = this.database
      .prepare(
        `SELECT * FROM events
          WHERE conversation_id = ? AND type = ?
          ORDER BY sequence DESC LIMIT 1`
      )
      .get(conversationId, type) as EventRow | undefined;
    return row === undefined ? null : eventFromRow(row);
  }

  listDecisions(
    conversationId: string,
    status: "active" | "superseded" | "all" = "all"
  ): DecisionRecord[] {
    const rows = (status === "all"
      ? this.database
          .prepare("SELECT * FROM decisions WHERE conversation_id = ? ORDER BY created_at, id")
          .all(conversationId)
      : this.database
          .prepare(
            "SELECT * FROM decisions WHERE conversation_id = ? AND status = ? ORDER BY created_at, id"
          )
          .all(conversationId, status)) as Array<{
      id: string;
      conversation_id: string;
      text: string;
      status: "active" | "superseded";
      source_event_ids_json: string;
      superseded_by_id: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      text: row.text,
      status: row.status,
      sourceEventIds: JSON.parse(row.source_event_ids_json) as string[],
      supersededById: row.superseded_by_id,
      createdAt: row.created_at
    }));
  }

  addDecision(input: {
    id: string;
    conversationId: string;
    text: string;
    sourceEventIds: string[];
    provider: Provider | null;
    turnId: string;
  }): DecisionRecord {
    return this.database.transaction(() => {
      this.assertSourceEvents(input.conversationId, input.sourceEventIds);
      const createdAt = this.now().toISOString();
      this.database
        .prepare(
          `INSERT INTO decisions(
             id, conversation_id, text, status, source_event_ids_json,
             superseded_by_id, created_at
           ) VALUES (?, ?, ?, 'active', ?, NULL, ?)`
        )
        .run(
          input.id,
          input.conversationId,
          input.text,
          JSON.stringify(input.sourceEventIds),
          createdAt
        );
      this.appendEventInternal({
        conversationId: input.conversationId,
        turnId: input.turnId,
        type: "context.decision.recorded",
        provider: input.provider,
        payload: {
          decisionId: input.id,
          text: input.text,
          status: "active",
          sourceEventIds: input.sourceEventIds
        },
        occurredAt: createdAt
      });
      return this.listDecisions(input.conversationId).find((item) => item.id === input.id) as DecisionRecord;
    })();
  }

  supersedeDecision(input: {
    conversationId: string;
    decisionId: string;
    replacementId: string;
    text: string;
    sourceEventIds: string[];
    turnId: string;
  }): DecisionRecord {
    return this.database.transaction(() => {
      const existing = this.listDecisions(input.conversationId, "active").find(
        (item) => item.id === input.decisionId
      );
      if (existing === undefined) {
        throw new Error("Decision is missing or already superseded");
      }
      const replacement = this.addDecision({
        id: input.replacementId,
        conversationId: input.conversationId,
        text: input.text,
        sourceEventIds: input.sourceEventIds,
        provider: null,
        turnId: input.turnId
      });
      this.database
        .prepare(
          "UPDATE decisions SET status = 'superseded', superseded_by_id = ? WHERE id = ?"
        )
        .run(replacement.id, existing.id);
      this.appendEventInternal({
        conversationId: input.conversationId,
        turnId: input.turnId,
        type: "context.decision.recorded",
        provider: null,
        payload: {
          decisionId: existing.id,
          status: "superseded",
          supersededById: replacement.id,
          sourceEventIds: input.sourceEventIds
        }
      });
      return replacement;
    })();
  }

  listTasks(
    conversationId: string,
    status: "open" | "completed" | "all" = "all"
  ): TaskRecord[] {
    const rows = (status === "all"
      ? this.database
          .prepare("SELECT * FROM tasks WHERE conversation_id = ? ORDER BY created_at, id")
          .all(conversationId)
      : this.database
          .prepare(
            "SELECT * FROM tasks WHERE conversation_id = ? AND status = ? ORDER BY created_at, id"
          )
          .all(conversationId, status)) as Array<{
      id: string;
      conversation_id: string;
      text: string;
      status: "open" | "completed";
      source_event_ids_json: string;
      created_at: string;
      completed_at: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      text: row.text,
      status: row.status,
      sourceEventIds: JSON.parse(row.source_event_ids_json) as string[],
      createdAt: row.created_at,
      completedAt: row.completed_at
    }));
  }

  addTask(input: {
    id: string;
    conversationId: string;
    text: string;
    sourceEventIds: string[];
    turnId: string;
  }): TaskRecord {
    return this.database.transaction(() => {
      this.assertSourceEvents(input.conversationId, input.sourceEventIds);
      const createdAt = this.now().toISOString();
      this.database
        .prepare(
          `INSERT INTO tasks(
             id, conversation_id, text, status, source_event_ids_json, created_at
           ) VALUES (?, ?, ?, 'open', ?, ?)`
        )
        .run(
          input.id,
          input.conversationId,
          input.text,
          JSON.stringify(input.sourceEventIds),
          createdAt
        );
      this.appendEventInternal({
        conversationId: input.conversationId,
        turnId: input.turnId,
        type: "context.task.changed",
        provider: null,
        payload: {
          taskId: input.id,
          text: input.text,
          status: "open",
          sourceEventIds: input.sourceEventIds
        },
        occurredAt: createdAt
      });
      return this.listTasks(input.conversationId).find((item) => item.id === input.id) as TaskRecord;
    })();
  }

  completeTask(input: {
    conversationId: string;
    taskId: string;
    sourceEventIds: string[];
    turnId: string;
  }): TaskRecord {
    return this.database.transaction(() => {
      this.assertSourceEvents(input.conversationId, input.sourceEventIds);
      const existing = this.listTasks(input.conversationId, "open").find(
        (item) => item.id === input.taskId
      );
      if (existing === undefined) {
        throw new Error("Task is missing or already completed");
      }
      const completedAt = this.now().toISOString();
      this.database
        .prepare("UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?")
        .run(completedAt, input.taskId);
      this.appendEventInternal({
        conversationId: input.conversationId,
        turnId: input.turnId,
        type: "context.task.changed",
        provider: null,
        payload: {
          taskId: input.taskId,
          status: "completed",
          sourceEventIds: input.sourceEventIds
        },
        occurredAt: completedAt
      });
      return this.listTasks(input.conversationId).find((item) => item.id === input.taskId) as TaskRecord;
    })();
  }

  verifyEventChain(conversationId: string): {
    valid: boolean;
    checked: number;
    firstInvalidSequence: number | null;
  } {
    const rows = this.database
      .prepare("SELECT * FROM events WHERE conversation_id = ? ORDER BY sequence ASC")
      .all(conversationId) as EventRow[];
    const events = rows.map(eventFromRow);
    let previousHash = GENESIS_HASH;
    for (const event of events) {
      const { eventHash, ...hashInput } = event;
      const valid = event.previousHash === previousHash && hashEvent(hashInput) === eventHash;
      if (!valid) {
        return {
          valid: false,
          checked: event.sequence,
          firstInvalidSequence: event.sequence
        };
      }
      previousHash = event.eventHash;
    }
    return { valid: true, checked: events.length, firstInvalidSequence: null };
  }

  schemaVersion(): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    return row.version;
  }

  private migrate(): void {
    this.database.exec(SCHEMA_SQL);
    const row = this.database
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    if (row.version > SCHEMA_VERSION) {
      throw new Error(`Database schema ${row.version} is newer than supported ${SCHEMA_VERSION}`);
    }
    // Legacy browse-only history projects remain fail-closed. Older releases
    // promoted them during the version-four migration; version six below
    // withdraws those inherited grants unless a laptop-local enrollment audit
    // proves the project was explicitly authorized.
    if (row.version < 5) {
      const columns = this.database.pragma("table_info(conversations)") as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "pinned")) {
        this.database.exec(
          "ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))"
        );
      }
    }
    if (row.version < 6) {
      const inheritedHistoryProjects = this.database
        .prepare(
          `SELECT DISTINCT projects.id, projects.repo_root
             FROM projects
             JOIN conversations ON conversations.project_id = projects.id
             JOIN history_sources ON history_sources.conversation_id = conversations.id
            WHERE projects.allowed_paths_json != '[]'
              AND NOT EXISTS (
                SELECT 1 FROM audit_log
                 WHERE audit_log.subject_id = projects.id
                   AND audit_log.action = 'project.enrolled'
                   AND audit_log.result = 'success'
              )`
        )
        .all() as Array<{ id: string; repo_root: string }>;
      for (const project of inheritedHistoryProjects) {
        this.database
          .prepare("UPDATE projects SET allowed_paths_json = '[]' WHERE id = ?")
          .run(project.id);
        this.writeAudit("project.history_scope_withdrawn", project.id, "success", {
          repoRoot: project.repo_root,
          reason: "explicit_laptop_enrollment_required"
        });
      }
    }
    if (row.version < 7) {
      const projectColumns = this.database.pragma("table_info(projects)") as Array<{ name: string }>;
      if (!projectColumns.some((column) => column.name === "root_device")) {
        this.database.exec("ALTER TABLE projects ADD COLUMN root_device TEXT");
      }
      if (!projectColumns.some((column) => column.name === "root_inode")) {
        this.database.exec("ALTER TABLE projects ADD COLUMN root_inode TEXT");
      }
      const leaseColumns = this.database.pragma("table_info(workspace_leases)") as Array<{ name: string }>;
      if (!leaseColumns.some((column) => column.name === "scope_kind")) {
        this.database.exec(
          "ALTER TABLE workspace_leases ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'path' CHECK (scope_kind IN ('git', 'path'))"
        );
      }
      const scopedProjects = this.database
        .prepare("SELECT id, repo_root FROM projects WHERE allowed_paths_json != '[]'")
        .all() as Array<{ id: string; repo_root: string }>;
      for (const project of scopedProjects) {
        try {
          const identity = captureWorkspaceIdentity(project.repo_root);
          this.database
            .prepare("UPDATE projects SET root_device = ?, root_inode = ? WHERE id = ?")
            .run(identity.device, identity.inode, project.id);
        } catch (error) {
          this.database
            .prepare(
              "UPDATE projects SET allowed_paths_json = '[]', root_device = NULL, root_inode = NULL WHERE id = ?"
            )
            .run(project.id);
          this.writeAudit("project.scope_withdrawn", project.id, "success", {
            repoRoot: project.repo_root,
            reason: error instanceof Error ? error.message : "Project identity could not be captured"
          });
        }
      }
    }
    if (row.version < SCHEMA_VERSION) {
      this.database.transaction(() => {
        if (row.version < 8) this.redactLegacyCanonicalData();
        if (row.version < 9) {
          const columns = this.database.pragma("table_info(conversations)") as Array<{ name: string }>;
          if (!columns.some((column) => column.name === "fallback_route_json")) {
            this.database.exec(
              "ALTER TABLE conversations ADD COLUMN fallback_route_json TEXT NOT NULL DEFAULT '[]'"
            );
          }
          this.database.exec(
            `UPDATE conversations
                SET fallback_route_json = CASE active_provider
                  WHEN 'codex' THEN '["codex"]'
                  WHEN 'claude' THEN '["claude"]'
                  WHEN 'hermes' THEN '["hermes"]'
                  ELSE '[]'
                END
              WHERE fallback_route_json = '[]'`
          );
        }
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(SCHEMA_VERSION, this.now().toISOString());
      })();
    }
  }

  /**
   * Version eight removes credential shapes written before title, history,
   * and provider-failure redaction was enforced. Rewriting a payload changes
   * every later event hash, so each affected conversation is re-chained and
   * re-indexed atomically. An audit row records the old and new chain heads
   * without retaining the removed plaintext.
   */
  private redactLegacyCanonicalData(): void {
    const conversations = this.database
      .prepare("SELECT id, project_id, title FROM conversations ORDER BY id")
      .all() as Array<{ id: string; project_id: string; title: string }>;
    let redactedTitles = 0;
    let redactedEvents = 0;

    for (const conversation of conversations) {
      const title = redactText(conversation.title);
      const rows = this.database
        .prepare("SELECT * FROM events WHERE conversation_id = ? ORDER BY sequence")
        .all(conversation.id) as EventRow[];
      const payloads = rows.map((event) => {
        const original = JSON.parse(event.payload_json) as Record<string, unknown>;
        return redactCanonicalEventPayload(event.type, original);
      });
      const changedEvents = payloads.filter((payload) => payload.redacted).length;
      if (!title.redacted && changedEvents === 0) {
        // Rebuild even when payloads are already clean: older versions could
        // leave stale plaintext in FTS independently of the canonical row.
        this.rebuildConversationSearchIndex(
          conversation.id,
          conversation.project_id,
          rows,
          payloads.map((item) => item.value)
        );
        continue;
      }

      if (title.redacted) {
        this.database.prepare("UPDATE conversations SET title = ? WHERE id = ?")
          .run(title.value.slice(0, 500), conversation.id);
        redactedTitles += 1;
      }

      const oldChainHead = rows.at(-1)?.event_hash ?? GENESIS_HASH;
      let previousHash = GENESIS_HASH;
      for (const [index, row] of rows.entries()) {
        const payload = payloads[index]!.value;
        const hashInput = {
          id: row.id,
          conversationId: row.conversation_id,
          turnId: row.turn_id,
          sequence: row.sequence,
          type: row.type,
          provider: row.provider,
          occurredAt: row.occurred_at,
          payload,
          previousHash
        };
        const event = EventEnvelopeSchema.parse({
          ...hashInput,
          eventHash: hashEvent(hashInput as Parameters<typeof hashEvent>[0])
        });
        this.database
          .prepare(
            `UPDATE events
                SET payload_json = ?, previous_hash = ?, event_hash = ?
              WHERE id = ?`
          )
          .run(JSON.stringify(event.payload), event.previousHash, event.eventHash, event.id);
        previousHash = event.eventHash;
      }
      this.rebuildConversationSearchIndex(
        conversation.id,
        conversation.project_id,
        rows,
        payloads.map((item) => item.value)
      );
      redactedEvents += changedEvents;
      this.writeAudit("security.legacy_redaction_migrated", conversation.id, "success", {
        redactedTitle: title.redacted,
        redactedEvents: changedEvents,
        oldChainHead,
        newChainHead: previousHash
      });
    }

    let redactedHistorySources = 0;
    const historySources = this.database
      .prepare("SELECT id, last_error, metadata_json FROM history_sources")
      .all() as Array<{ id: string; last_error: string | null; metadata_json: string }>;
    for (const source of historySources) {
      const error = source.last_error === null ? null : redactText(source.last_error);
      const metadata = redactPayload(JSON.parse(source.metadata_json) as Record<string, unknown>);
      if (error?.redacted !== true && !metadata.redacted) continue;
      this.database
        .prepare("UPDATE history_sources SET last_error = ?, metadata_json = ? WHERE id = ?")
        .run(error?.value ?? null, JSON.stringify(metadata.value), source.id);
      redactedHistorySources += 1;
    }

    let redactedBindings = 0;
    const bindings = this.database
      .prepare("SELECT conversation_id, provider, metadata_json FROM provider_bindings")
      .all() as Array<{ conversation_id: string; provider: Provider; metadata_json: string }>;
    for (const binding of bindings) {
      const metadata = redactPayload(JSON.parse(binding.metadata_json) as Record<string, unknown>);
      if (!metadata.redacted) continue;
      this.database
        .prepare(
          "UPDATE provider_bindings SET metadata_json = ? WHERE conversation_id = ? AND provider = ?"
        )
        .run(JSON.stringify(metadata.value), binding.conversation_id, binding.provider);
      redactedBindings += 1;
    }

    if (redactedTitles + redactedEvents + redactedHistorySources + redactedBindings > 0) {
      this.writeAudit("security.legacy_redaction_completed", null, "success", {
        redactedTitles,
        redactedEvents,
        redactedHistorySources,
        redactedBindings
      });
    }
  }

  private rebuildConversationSearchIndex(
    conversationId: string,
    projectId: string,
    rows: EventRow[],
    payloads: Array<Record<string, unknown>>
  ): void {
    this.database.prepare("DELETE FROM events_fts WHERE conversation_id = ?").run(conversationId);
    for (const [index, row] of rows.entries()) {
      const searchableText = extractSearchableText(payloads[index]);
      if (searchableText.length === 0) continue;
      this.database
        .prepare(
          `INSERT INTO events_fts(
             event_id, conversation_id, project_id, type, provider, text
           ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(row.id, row.conversation_id, projectId, row.type, row.provider, searchableText);
    }
  }

  private appendEventInternal(input: AppendEventInput): EventEnvelope {
    const conversation = this.getConversation(input.conversationId);
    const payload = redactCanonicalEventPayload(input.type, input.payload).value;
    const previousRow = this.database
      .prepare(
        `SELECT event_hash FROM events
          WHERE conversation_id = ?
          ORDER BY sequence DESC LIMIT 1`
      )
      .get(input.conversationId) as { event_hash: string } | undefined;
    const occurredAt = input.occurredAt ?? this.now().toISOString();
    const hashInput = {
      id: input.id ?? createId("evt"),
      conversationId: input.conversationId,
      turnId: input.turnId ?? null,
      sequence: conversation.nextSequence,
      type: input.type,
      provider: input.provider ?? null,
      occurredAt,
      payload,
      previousHash: previousRow?.event_hash ?? GENESIS_HASH
    };
    const event = EventEnvelopeSchema.parse({
      ...hashInput,
      eventHash: hashEvent(hashInput)
    });
    this.database
      .prepare(
        `INSERT INTO events(
           id, conversation_id, turn_id, sequence, type, provider, payload_json,
           previous_hash, event_hash, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.conversationId,
        event.turnId,
        event.sequence,
        event.type,
        event.provider,
        JSON.stringify(event.payload),
        event.previousHash,
        event.eventHash,
        event.occurredAt
      );
    const project = this.getProject(conversation.projectId);
    const searchableText = extractSearchableText(event.payload);
    if (searchableText.length > 0) {
      this.database
        .prepare(
          `INSERT INTO events_fts(
             event_id, conversation_id, project_id, type, provider, text
           ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          event.id,
          event.conversationId,
          project.id,
          event.type,
          event.provider,
          searchableText
        );
    }
    const update = this.database
      .prepare(
        `UPDATE conversations
            SET next_sequence = ?, updated_at = ?
          WHERE id = ? AND next_sequence = ?`
      )
      .run(event.sequence + 1, occurredAt, event.conversationId, event.sequence);
    if (update.changes !== 1) {
      throw new Error("Conversation sequence changed during event append");
    }
    return event;
  }

  private assertSourceEvents(conversationId: string, eventIds: string[]): void {
    if (eventIds.length === 0 || eventIds.length > 100) {
      throw new Error("Source event IDs must contain between 1 and 100 entries");
    }
    const uniqueIds = [...new Set(eventIds)];
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM events
          WHERE conversation_id = ? AND id IN (${placeholders})`
      )
      .get(conversationId, ...uniqueIds) as { count: number };
    if (row.count !== uniqueIds.length) {
      throw new Error("Every source event must belong to the same conversation");
    }
  }
}

function eventFromRow(row: EventRow): EventEnvelope {
  return EventEnvelopeSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    sequence: row.sequence,
    type: row.type,
    provider: row.provider,
    payload: JSON.parse(row.payload_json) as unknown,
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
    occurredAt: row.occurred_at
  });
}

function providerBindingFromRow(row: {
  conversation_id: string;
  provider: Provider;
  native_session_id: string | null;
  synchronized_through_sequence: number;
  status: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}): ProviderBindingRecord {
  return {
    conversationId: row.conversation_id,
    provider: row.provider,
    nativeSessionId: row.native_session_id,
    synchronizedThroughSequence: row.synchronized_through_sequence,
    status: row.status,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function historySourceFromRow(row: HistorySourceRow): HistorySourceRecord {
  return {
    id: row.id,
    provider: row.provider,
    nativeSessionId: row.native_session_id,
    conversationId: row.conversation_id,
    sourceCreatedAt: row.source_created_at,
    sourceUpdatedAt: row.source_updated_at,
    sourceDigest: row.source_digest,
    importStatus: row.import_status,
    importedItemCount: row.imported_item_count,
    lastError: row.last_error,
    lastSyncedAt: row.last_synced_at,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>
  };
}

function compareHistoryItems(left: HistoryImportItem, right: HistoryImportItem): number {
  const time = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
  return time === 0 ? left.nativeItemId.localeCompare(right.nativeItemId) : time;
}

function workspaceLeaseFromRow(row: WorkspaceLeaseRow, now: Date): WorkspaceLeaseRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    worktreePath: row.worktree_path,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    provider: row.provider,
    mode: row.mode,
    scopeKind: row.scope_kind,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    stale: Date.parse(row.expires_at) <= now.getTime()
  };
}

function assertLeaseLifetime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 10 * 60_000) {
    throw new Error("Workspace lease lifetime is outside the allowed range");
  }
}

function boundedLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) {
    return Math.min(100, maximum);
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Limit must be a positive integer");
  }
  return Math.min(value, maximum);
}

function normalizeFallbackRoute(value: unknown): Provider[] {
  if (!Array.isArray(value) || value.length > 3) {
    throw new Error("Fallback route must contain at most three harnesses");
  }
  const route: Provider[] = [];
  for (const provider of value) {
    if (provider !== "codex" && provider !== "claude" && provider !== "hermes") {
      throw new Error("Fallback route contains an unknown harness");
    }
    if (route.includes(provider)) throw new Error("Fallback route cannot repeat a harness");
    route.push(provider);
  }
  return route;
}

function parseFallbackRoute(value: string): Provider[] {
  try {
    return normalizeFallbackRoute(JSON.parse(value) as unknown);
  } catch {
    throw new Error("Stored fallback route is invalid");
  }
}

function extractSearchableText(value: unknown): string {
  const values: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      values.push(item);
    } else if (Array.isArray(item)) {
      item.forEach(visit);
    } else if (item !== null && typeof item === "object") {
      Object.values(item as Record<string, unknown>).forEach(visit);
    }
  };
  visit(value);
  return values.join(" ").slice(0, 1_000_000);
}

function redactCanonicalEventPayload(type: string, payload: Record<string, unknown>) {
  if (payload.imported === true) return redactImportedEventPayload(payload);
  if (["conversation.created", "conversation.renamed", "turn.failed"].includes(type)) {
    return redactPayload(payload);
  }
  return { value: payload, redacted: false, markers: [] as string[] };
}

function redactImportedEventPayload(payload: Record<string, unknown>) {
  // These fields are canonical import coordinates, not provider-supplied
  // secrets. The generic denylist intentionally matches session identifiers,
  // so remove the coordinates before scanning and restore them afterwards.
  const structuralKeys = [
    "imported",
    "nativeSessionId",
    "nativeItemId",
    "supersedesEventId",
    "sourceOccurredAt"
  ] as const;
  const body = { ...payload };
  const structural: Record<string, unknown> = {};
  for (const key of structuralKeys) {
    if (!(key in body)) continue;
    structural[key] = body[key];
    delete body[key];
  }
  const redaction = redactPayload(body);
  return {
    ...redaction,
    value: { ...redaction.value, ...structural }
  };
}
