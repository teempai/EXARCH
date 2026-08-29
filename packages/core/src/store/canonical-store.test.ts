import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  GENESIS_HASH,
  hashEvent,
  type EventType,
  type Provider
} from "../../../protocol/src/index.js";
import { CanonicalStore } from "./canonical-store.js";
import { SCHEMA_VERSION } from "./schema.js";

describe("CanonicalStore", () => {
  let store: CanonicalStore;

  beforeEach(() => {
    store = new CanonicalStore(":memory:", {
      now: sequentialClock("2026-08-23T10:00:00.000Z")
    });
  });

  afterEach(() => {
    store.close();
  });

  it("creates the complete initial schema", () => {
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    const tables = store.database
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "projects",
        "conversations",
        "conversation_changes",
        "turns",
        "events",
        "provider_bindings",
        "history_sources",
        "imported_items",
        "context_snapshots",
        "decisions",
        "tasks",
        "artifacts",
        "approvals",
        "workspace_leases",
        "provider_processes",
        "devices",
        "security_rules",
        "audit_log",
        "schema_migrations"
      ])
    );
  });

  it("persists an ordered per-thread fallback route without allowing ambiguity", () => {
    const project = store.createProject({
      name: "Fallback",
      repoRoot: mkdtempSync(join(tmpdir(), "exarch-fallback-project-"))
    });
    const conversation = store.createConversation({
      projectId: project.id,
      title: "Fallback",
      activeProvider: "codex"
    });
    expect(conversation.fallbackRoute).toEqual(["codex"]);
    expect(
      store.setConversationFallbackRoute(conversation.id, ["codex", "claude", "hermes"])
        .fallbackRoute
    ).toEqual(["codex", "claude", "hermes"]);
    expect(() => store.setConversationFallbackRoute(conversation.id, ["claude", "hermes"]))
      .toThrow(/active harness/);
    expect(() => store.setConversationFallbackRoute(conversation.id, ["codex", "codex"]))
      .toThrow(/repeat/);

    store.setActiveProvider(conversation.id, "claude");
    expect(store.getConversation(conversation.id).fallbackRoute).toEqual(["codex", "claude", "hermes"]);
    store.setActiveProvider(conversation.id, "hermes");
    expect(store.getConversation(conversation.id).fallbackRoute).toEqual(["codex", "claude", "hermes"]);
    store.setConversationFallbackRoute(conversation.id, ["hermes"]);
    store.setActiveProvider(conversation.id, "codex");
    expect(store.getConversation(conversation.id).fallbackRoute).toEqual(["codex"]);
  });

  it("migrates existing threads to a disabled-by-default fallback route", () => {
    const path = join(mkdtempSync(join(tmpdir(), "exarch-fallback-migration-")), "context.sqlite");
    const legacy = new CanonicalStore(path);
    const seeded = seedConversation(legacy, "fallback-legacy");
    legacy.database.exec("ALTER TABLE conversations DROP COLUMN fallback_route_json");
    legacy.database.prepare("UPDATE schema_migrations SET version = 8").run();
    legacy.close();

    const migrated = new CanonicalStore(path);
    try {
      expect(migrated.schemaVersion()).toBe(9);
      expect(migrated.getConversation(seeded.conversationId).fallbackRoute).toEqual(["codex"]);
    } finally {
      migrated.close();
    }
  });

  it("migrates a version-one store by adding import ledgers and sync cursors without rewriting events", () => {
    const path = join(mkdtempSync(join(tmpdir(), "exarch-schema-migration-")), "context.sqlite");
    const legacy = new CanonicalStore(path);
    const seeded = seedConversation(legacy, "legacy");
    legacy.database.exec("DROP TABLE imported_items; DROP TABLE history_sources;");
    legacy.database.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
    legacy.database.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)")
      .run("2026-08-20T00:00:00.000Z");
    legacy.close();

    const migrated = new CanonicalStore(path);
    try {
      expect(migrated.schemaVersion()).toBe(SCHEMA_VERSION);
      expect(migrated.getConversation(seeded.conversationId).title).toBe("Conversation legacy");
      expect(migrated.listHistorySources()).toEqual([]);
    } finally {
      migrated.close();
    }
  });

  it("redacts legacy imported and failure data while preserving a valid event chain", () => {
    const path = join(mkdtempSync(join(tmpdir(), "exarch-redaction-migration-")), "context.sqlite");
    const legacy = new CanonicalStore(path);
    const repoRoot = mkdtempSync(join(tmpdir(), "exarch-redaction-project-"));
    const project = legacy.createImportedProject({ name: "Legacy import", repoRoot });
    const leaked = "ghp_abcdefghijklmnopqrstuvwxyz01234567";
    const intentionalUserText = "sk-user-owned-context-abcdefghijklmnop";
    const imported = legacy.importHistoryThread({
      provider: "codex",
      nativeSessionId: "legacy-secret-session",
      projectId: project.id,
      title: `Deploy with ${leaked}`,
      sourceDigest: `sha256:${"3".repeat(64)}`,
      metadata: { token: leaked },
      items: [{
        nativeItemId: "legacy-item",
        type: "assistant.message.completed",
        payload: { text: `provider printed ${leaked}` },
        occurredAt: "2026-08-20T00:01:00.000Z",
        contentDigest: `sha256:${"4".repeat(64)}`
      }]
    });
    legacy.recordHistoryImportFailure({
      provider: "codex",
      nativeSessionId: "legacy-secret-session",
      error: `provider failed with ${leaked}`
    });
    legacy.appendEvent({
      conversationId: imported.conversation.id,
      type: "turn.failed",
      provider: "codex",
      payload: { error: `provider failed with ${leaked}` }
    });
    legacy.appendEvent({
      conversationId: imported.conversation.id,
      type: "user.message",
      provider: "codex",
      payload: { text: intentionalUserText }
    });
    // Seed the exact pre-hardening representation directly: current write
    // paths already redact these values, while a version-seven database did
    // not. Re-chain it so the migration starts from a valid legacy ledger.
    legacy.database.prepare("UPDATE conversations SET title = ? WHERE id = ?")
      .run(`Deploy with ${leaked}`, imported.conversation.id);
    legacy.database.prepare(
      "UPDATE events SET payload_json = ? WHERE conversation_id = ? AND type = 'conversation.created'"
    ).run(JSON.stringify({
      projectId: project.id,
      title: `Deploy with ${leaked}`,
      imported: true,
      nativeSessionId: "legacy-secret-session"
    }), imported.conversation.id);
    const importedEvent = legacy.database.prepare(
      "SELECT canonical_event_id FROM imported_items WHERE native_item_id = 'legacy-item'"
    ).get() as { canonical_event_id: string };
    legacy.database.prepare("UPDATE events SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify({
        text: `provider printed ${leaked}`,
        imported: true,
        nativeSessionId: "legacy-secret-session",
        nativeItemId: "legacy-item"
      }), importedEvent.canonical_event_id);
    legacy.database.prepare(
      "UPDATE events SET payload_json = ? WHERE conversation_id = ? AND type = 'turn.failed'"
    ).run(
      JSON.stringify({ error: `provider failed with ${leaked}` }),
      imported.conversation.id
    );
    legacy.database.prepare(
      "UPDATE history_sources SET last_error = ?, metadata_json = ? WHERE id = ?"
    ).run(`provider failed with ${leaked}`, JSON.stringify({ token: leaked }), imported.source.id);
    legacy.database.prepare(
      "UPDATE provider_bindings SET metadata_json = ? WHERE conversation_id = ? AND provider = 'codex'"
    ).run(JSON.stringify({ token: leaked }), imported.conversation.id);
    legacy.database.prepare("UPDATE events_fts SET text = ? WHERE event_id = ?")
      .run(`provider printed ${leaked}`, importedEvent.canonical_event_id);
    legacy.database.prepare(
      "UPDATE events_fts SET text = ? WHERE conversation_id = ? AND type = 'turn.failed'"
    ).run(`provider failed with ${leaked}`, imported.conversation.id);
    const oldHead = rechainStoredEvents(legacy, imported.conversation.id);
    legacy.database.prepare("DELETE FROM schema_migrations WHERE version > 7").run();
    legacy.database.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (7, ?)")
      .run("2026-08-27T00:00:00.000Z");
    legacy.close();

    const migrated = new CanonicalStore(path);
    try {
      const conversation = migrated.getConversation(imported.conversation.id);
      const events = migrated.listEvents(conversation.id, { limit: 100 });
      const indexed = migrated.database
        .prepare("SELECT text FROM events_fts WHERE conversation_id = ?")
        .all(conversation.id) as Array<{ text: string }>;
      const source = migrated.listHistorySources("codex")[0]!;

      expect(conversation.title).toContain("[REDACTED:GITHUB_TOKEN]");
      expect(JSON.stringify({ conversation, events, indexed, source })).not.toContain(leaked);
      expect(JSON.stringify(events)).toContain(intentionalUserText);
      expect(events.some((event) => event.payload.nativeSessionId === "legacy-secret-session")).toBe(true);
      expect(migrated.verifyEventChain(conversation.id).valid).toBe(true);
      expect(events.at(-1)?.eventHash).not.toBe(oldHead);
      expect(
        migrated.database
          .prepare("SELECT action FROM audit_log WHERE subject_id = ?")
          .all(conversation.id)
      ).toContainEqual({ action: "security.legacy_redaction_migrated" });
    } finally {
      migrated.close();
    }
  });

  it("appends immutable, ordered, hash-chained events", () => {
    const { conversationId } = seedConversation(store);
    const event = store.appendEvent({
      conversationId,
      turnId: "turn_1",
      type: "user.message",
      provider: "codex",
      payload: { text: "Keep this exact context" }
    });
    const events = store.listEvents(conversationId);

    expect(events).toHaveLength(2);
    expect(events[0]?.sequence).toBe(1);
    expect(events[0]?.previousHash).toBe(GENESIS_HASH);
    expect(event.sequence).toBe(2);
    expect(event.previousHash).toBe(events[0]?.eventHash);
    expect(store.verifyEventChain(conversationId)).toEqual({
      valid: true,
      checked: 2,
      firstInvalidSequence: null
    });
  });

  it("redacts credential shapes from locally-created conversation titles", () => {
    const project = store.createProject({
      name: "Title safety",
      repoRoot: mkdtempSync(join(tmpdir(), "exarch-title-safety-"))
    });
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz01234567";
    const conversation = store.createConversation({
      projectId: project.id,
      title: `Deploy with ${secret}`,
      activeProvider: "codex"
    });
    store.appendEvent({
      conversationId: conversation.id,
      type: "turn.failed",
      provider: "codex",
      payload: { reason: `provider exposed ${secret}` }
    });
    const events = store.listEvents(conversation.id);

    expect(conversation.title).toContain("[REDACTED:GITHUB_TOKEN]");
    expect(JSON.stringify({ conversation, events })).not.toContain(secret);
    expect(events.map((event) => event.type)).toEqual([
      "conversation.created",
      "security.redaction.applied",
      "turn.failed"
    ]);
    expect(store.verifyEventChain(conversation.id).valid).toBe(true);
  });

  it("keeps history projects browse-only until a laptop-local enrollment", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "exarch-history-project-"));
    const resolvedRepoRoot = realpathSync(repoRoot);
    const imported = store.createImportedProject({ name: "Imported", repoRoot });
    expect(imported.allowedPaths).toEqual([]);

    const enrolled = store.enrollProject({ name: "Approved on laptop", repoRoot });
    expect(enrolled).toMatchObject({
      id: imported.id,
      name: "Approved on laptop",
      repoRoot: resolvedRepoRoot,
      allowedPaths: [resolvedRepoRoot]
    });
    expect(store.listProjects()).toHaveLength(1);
  });

  it("withdraws legacy history-inherited scopes without changing project identity", () => {
    const path = join(mkdtempSync(join(tmpdir(), "exarch-scope-migration-")), "context.sqlite");
    const legacy = new CanonicalStore(path);
    const repoRoot = mkdtempSync(join(tmpdir(), "exarch-legacy-history-project-"));
    const project = legacy.createImportedProject({ name: "Legacy import", repoRoot });
    legacy.importHistoryThread({
      provider: "codex",
      nativeSessionId: "legacy-native",
      projectId: project.id,
      title: "Legacy",
      sourceDigest: `sha256:${"1".repeat(64)}`,
      items: []
    });
    legacy.database.prepare("UPDATE projects SET allowed_paths_json = ? WHERE id = ?")
      .run(JSON.stringify([realpathSync(repoRoot)]), project.id);
    legacy.database.prepare("DELETE FROM schema_migrations WHERE version > 5").run();
    legacy.database.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (5, ?)")
      .run("2026-08-23T00:00:00.000Z");
    legacy.close();

    const migrated = new CanonicalStore(path);
    try {
      expect(migrated.getProject(project.id)).toMatchObject({
        id: project.id,
        repoRoot: realpathSync(repoRoot),
        allowedPaths: []
      });
      expect(migrated.schemaVersion()).toBe(SCHEMA_VERSION);
      expect(
        migrated.database
          .prepare("SELECT action FROM audit_log WHERE subject_id = ? ORDER BY occurred_at DESC")
          .all(project.id)
      ).toEqual(expect.arrayContaining([{ action: "project.history_scope_withdrawn" }]));
    } finally {
      migrated.close();
    }
  });

  it("preserves a history project that was explicitly enrolled on the laptop", () => {
    const path = join(mkdtempSync(join(tmpdir(), "exarch-enrolled-migration-")), "context.sqlite");
    const legacy = new CanonicalStore(path);
    const repoRoot = mkdtempSync(join(tmpdir(), "exarch-enrolled-history-project-"));
    const project = legacy.createImportedProject({ name: "Imported", repoRoot });
    legacy.importHistoryThread({
      provider: "claude",
      nativeSessionId: "enrolled-native",
      projectId: project.id,
      title: "Enrolled",
      sourceDigest: `sha256:${"2".repeat(64)}`,
      items: []
    });
    legacy.enrollProject({ name: "Approved", repoRoot });
    legacy.database.prepare("DELETE FROM schema_migrations WHERE version > 5").run();
    legacy.database.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (5, ?)")
      .run("2026-08-23T00:00:00.000Z");
    legacy.close();

    const migrated = new CanonicalStore(path);
    try {
      expect(migrated.getProject(project.id).allowedPaths).toEqual([realpathSync(repoRoot)]);
    } finally {
      migrated.close();
    }
  });

  it("pages conversation metadata changes with a stable monotonic cursor", () => {
    const first = seedConversation(store, "sync-a");
    const second = seedConversation(store, "sync-b");
    const firstPage = store.listConversationChanges(null, 1);
    expect(firstPage.conversations).toHaveLength(1);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = store.listConversationChanges(firstPage.nextCursor, 1);
    expect(secondPage.conversations).toHaveLength(1);
    expect(secondPage.hasMore).toBe(false);
    expect(new Set([
      firstPage.conversations[0]?.id,
      secondPage.conversations[0]?.id
    ])).toEqual(new Set([first.conversationId, second.conversationId]));
    expect(store.listConversationChanges(secondPage.nextCursor, 10).conversations).toEqual([]);

    store.setActiveProvider(first.conversationId, "hermes");
    const delta = store.listConversationChanges(secondPage.nextCursor, 10);
    expect(delta.conversations.map((conversation) => conversation.id)).toEqual([first.conversationId]);
  });

  it("pages the visible conversation list with pins first and stable recency ordering", () => {
    const oldest = seedConversation(store, "page-oldest");
    const newest = seedConversation(store, "page-newest");
    store.database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run("2026-08-20T00:00:00.000Z", oldest.conversationId);
    store.database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run("2026-08-22T00:00:00.000Z", newest.conversationId);
    store.setConversationPinned(oldest.conversationId, true);

    const first = store.listConversationPage(null, 1);
    expect(first.conversations.map((conversation) => conversation.id)).toEqual([oldest.conversationId]);
    expect(first.hasMore).toBe(true);
    const second = store.listConversationPage(first.nextCursor, 1);
    expect(second.conversations.map((conversation) => conversation.id)).toEqual([newest.conversationId]);
    expect(second.hasMore).toBe(false);
  });

  it("syncs newly imported conversations even when their source timestamp is old", () => {
    const current = seedConversation(store, "current");
    const cursor = store.listConversationChanges(null, 10).nextCursor;
    expect(cursor).not.toBeNull();

    store.importHistoryThread({
      provider: "codex",
      nativeSessionId: "old-native-thread",
      projectId: current.projectId,
      title: "Old imported thread",
      sourceCreatedAt: "2020-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2020-01-02T00:00:00.000Z",
      sourceDigest: "sha256:old-thread",
      items: []
    });

    const delta = store.listConversationChanges(cursor, 10);
    expect(delta.conversations.map((conversation) => conversation.title)).toEqual([
      "Old imported thread"
    ]);
  });

  it("syncs canonical pins without changing conversation recency", () => {
    const seeded = seedConversation(store, "pin-sync");
    const before = store.getConversation(seeded.conversationId);
    const cursor = store.listConversationChanges(null, 10).nextCursor;
    expect(cursor).not.toBeNull();

    const pinned = store.setConversationPinned(seeded.conversationId, true);
    expect(pinned.pinned).toBe(true);
    expect(pinned.updatedAt).toBe(before.updatedAt);

    const delta = store.listConversationChanges(cursor, 10);
    expect(delta.conversations).toEqual([pinned]);
    expect(store.listConversations()[0]?.pinned).toBe(true);
  });

  it("detects mutation of a committed event", () => {
    const { conversationId } = seedConversation(store);
    store.appendEvent({
      conversationId,
      type: "user.message",
      provider: "codex",
      payload: { text: "original" }
    });
    store.database
      .prepare("UPDATE events SET payload_json = ? WHERE conversation_id = ? AND sequence = 2")
      .run(JSON.stringify({ text: "tampered" }), conversationId);

    expect(store.verifyEventChain(conversationId)).toEqual({
      valid: false,
      checked: 2,
      firstInvalidSequence: 2
    });
  });

  it("scopes full-text search to both project and conversation", () => {
    const first = seedConversation(store, "first");
    const second = seedConversation(store, "second");
    store.appendEvent({
      conversationId: first.conversationId,
      type: "assistant.message.completed",
      provider: "codex",
      payload: { text: "the falcon decision is local" }
    });
    store.appendEvent({
      conversationId: second.conversationId,
      type: "assistant.message.completed",
      provider: "claude",
      payload: { text: "the falcon belongs elsewhere" }
    });

    const results = store.searchEvents(first.projectId, first.conversationId, "falcon");
    expect(results).toHaveLength(1);
    expect(results[0]?.event.conversationId).toBe(first.conversationId);
    expect(results[0]?.snippet).toContain("falcon");
    expect(store.searchEvents(second.projectId, first.conversationId, "falcon")).toEqual([]);
  });

  it("enforces query bounds", () => {
    const { conversationId } = seedConversation(store);
    for (let index = 0; index < 550; index += 1) {
      store.appendEvent({
        conversationId,
        type: "tool.output.delta",
        provider: "hermes",
        payload: { text: `line ${index}` }
      });
    }
    expect(store.listEvents(conversationId, { limit: 10_000 })).toHaveLength(500);
    expect(() => store.listEvents(conversationId, { limit: 0 })).toThrow(/positive integer/);
    expect(store.listRecentEvents(conversationId, { limit: 2 }).map((event) => event.sequence)).toEqual([
      550,
      551
    ]);
    expect(store.listRecentEvents(conversationId, { before: 550, limit: 2 }).map((event) => event.sequence)).toEqual([
      548,
      549
    ]);
    expect(() => store.searchEvents("project", conversationId, "")).toThrow(/between 1 and 1000/);
    expect(store.verifyEventChain(conversationId)).toEqual({
      valid: true,
      checked: 551,
      firstInvalidSequence: null
    });
  });

  it("pages recent display messages without transferring internal turn events", () => {
    const { conversationId } = seedConversation(store);
    store.appendEvent({
      conversationId,
      type: "user.message",
      provider: "codex",
      payload: { text: "first" }
    });
    store.appendEvent({
      conversationId,
      type: "tool.output.delta",
      provider: "codex",
      payload: { text: "large internal output" }
    });
    store.appendEvent({
      conversationId,
      type: "assistant.message.completed",
      provider: "codex",
      payload: { text: "second" }
    });
    store.appendEvent({
      conversationId,
      type: "provider.handoff.completed",
      provider: "claude",
      payload: {}
    });

    const latest = store.listRecentEvents(conversationId, { limit: 2, displayOnly: true });
    expect(latest.map((event) => event.type)).toEqual([
      "assistant.message.completed",
      "provider.handoff.completed"
    ]);
    expect(store.listRecentEvents(conversationId, {
      before: latest[0]!.sequence,
      limit: 2,
      displayOnly: true
    }).map((event) => event.type)).toEqual(["user.message"]);
    expect(store.listEvents(conversationId, {
      after: latest.at(-1)!.sequence,
      limit: 10,
      displayOnly: true
    })).toEqual([]);
  });

  it("records, supersedes, and completes provenance-bound context", () => {
    const { conversationId } = seedConversation(store);
    const source = store.appendEvent({
      conversationId,
      turnId: "turn_1",
      type: "user.message",
      provider: "codex",
      payload: { text: "Choose the relay protocol" }
    });
    const decision = store.addDecision({
      id: "decision_1",
      conversationId,
      text: "Use authenticated encryption",
      sourceEventIds: [source.id],
      provider: "codex",
      turnId: "turn_1"
    });
    const replacement = store.supersedeDecision({
      conversationId,
      decisionId: decision.id,
      replacementId: "decision_2",
      text: "Use an audited authenticated-encryption construction",
      sourceEventIds: [source.id],
      turnId: "turn_1"
    });
    const task = store.addTask({
      id: "task_1",
      conversationId,
      text: "Implement handshake tests",
      sourceEventIds: [source.id],
      turnId: "turn_1"
    });
    const completed = store.completeTask({
      conversationId,
      taskId: task.id,
      sourceEventIds: [source.id],
      turnId: "turn_1"
    });

    expect(store.listDecisions(conversationId, "active")).toEqual([replacement]);
    expect(store.listDecisions(conversationId, "superseded")[0]).toEqual(
      expect.objectContaining({ id: decision.id, supersededById: replacement.id })
    );
    expect(completed.status).toBe("completed");
    expect(store.listTasks(conversationId, "open")).toEqual([]);
    expect(store.latestEventByType(conversationId, "context.task.changed")?.payload).toEqual(
      expect.objectContaining({ taskId: task.id, status: "completed" })
    );
    expect(store.verifyEventChain(conversationId).valid).toBe(true);
  });

  it("rejects cross-conversation provenance and repeat state transitions", () => {
    const first = seedConversation(store, "first");
    const second = seedConversation(store, "second");
    const foreignSource = store.appendEvent({
      conversationId: second.conversationId,
      type: "user.message",
      provider: "claude",
      payload: { text: "foreign" }
    });
    expect(() =>
      store.addDecision({
        id: "decision_cross_scope",
        conversationId: first.conversationId,
        text: "invalid",
        sourceEventIds: [foreignSource.id],
        provider: null,
        turnId: "turn_1"
      })
    ).toThrow(/same conversation/);

    const localSource = store.appendEvent({
      conversationId: first.conversationId,
      type: "user.message",
      provider: "codex",
      payload: { text: "local" }
    });
    const task = store.addTask({
      id: "task_repeat",
      conversationId: first.conversationId,
      text: "complete once",
      sourceEventIds: [localSource.id],
      turnId: "turn_1"
    });
    store.completeTask({
      conversationId: first.conversationId,
      taskId: task.id,
      sourceEventIds: [localSource.id],
      turnId: "turn_1"
    });
    expect(() =>
      store.completeTask({
        conversationId: first.conversationId,
        taskId: task.id,
        sourceEventIds: [localSource.id],
        turnId: "turn_1"
      })
    ).toThrow(/already completed/);
  });

  it("filters event queries and scopes event lookup", () => {
    const first = seedConversation(store, "first");
    const second = seedConversation(store, "second");
    const codex = store.appendEvent({
      conversationId: first.conversationId,
      type: "assistant.message.completed",
      provider: "codex",
      payload: { text: "one" }
    });
    store.appendEvent({
      conversationId: first.conversationId,
      type: "tool.completed",
      provider: "hermes",
      payload: { text: "two" }
    });
    expect(
      store.listEvents(first.conversationId, {
        after: 1,
        before: 3,
        type: "assistant.message.completed",
        provider: "codex"
      })
    ).toEqual([codex]);
    expect(() => store.getEvent(codex.id, second.conversationId)).toThrow(/Unknown event/);
  });

  it("fails closed when encrypted storage is required without a key", () => {
    expect(() => new CanonicalStore(":memory:", { requireEncrypted: true })).toThrow(
      /no database encryption key/
    );
  });

  it("encrypts a file-backed database and rejects the wrong key", () => {
    const path = join(mkdtempSync(join(tmpdir(), "exarch-encrypted-")), "context.sqlite");
    const key = Buffer.alloc(32, 0x41);
    const encrypted = new CanonicalStore(path, { requireEncrypted: true, encryptionKey: key });
    encrypted.createProject({
      name: "Secret Project Marker",
      repoRoot: mkdtempSync(join(tmpdir(), "exarch-store-private-"))
    });
    encrypted.close();
    expect(readFileSync(path).includes(Buffer.from("Secret Project Marker", "utf8"))).toBe(false);
    expect(
      () => new CanonicalStore(path, { requireEncrypted: true, encryptionKey: Buffer.alloc(32, 0x42) })
    ).toThrow();
    const reopened = new CanonicalStore(path, { requireEncrypted: true, encryptionKey: key });
    expect(reopened.listProjects()[0]?.name).toBe("Secret Project Marker");
    reopened.close();
  });

  it("records one bounded decision for a pending unexpired approval", () => {
    const now = new Date("2026-08-23T12:00:00Z");
    const store = new CanonicalStore(":memory:", { now: () => now });
    const project = store.createProject({
      name: "Approval",
      repoRoot: mkdtempSync(join(tmpdir(), "exarch-store-approval-"))
    });
    const conversation = store.createConversation({
      projectId: project.id,
      title: "Approval",
      activeProvider: "hermes"
    });
    const approval = store.createApproval({
      id: "approval_1",
      conversationId: conversation.id,
      turnId: "turn_1",
      provider: "hermes",
      request: { choices: ["once", "deny"], providerRequestId: "native_1" },
      expiresAt: "2026-08-23T12:05:00Z"
    });
    expect(approval.status).toBe("pending");
    expect(
      store.recordApprovalDecision({
        approvalId: approval.id,
        choice: "once",
        deviceId: "device_1",
        decidedAt: now.toISOString(),
        signature: "signature"
      })
    ).toMatchObject({ status: "decided", decision: { choice: "once", deviceId: "device_1" } });
    expect(() =>
      store.recordApprovalDecision({
        approvalId: approval.id,
        choice: "deny",
        deviceId: "device_1",
        decidedAt: now.toISOString(),
        signature: "signature"
      })
    ).toThrow("not pending");
    expect(store.markApprovalDeliveryFailed(approval.id).status).toBe("delivery_failed");
    store.close();
  });

  it("serializes mutating workspace leases and quarantines stale owners", () => {
    let now = new Date("2026-08-23T12:00:00Z");
    const store = new CanonicalStore(":memory:", { now: () => now });
    const seeded = seedConversation(store, "lease");
    const lease = store.acquireWorkspaceLease({
      id: "lease_1",
      projectId: seeded.projectId,
      worktreePath: "/tmp/exarch-lease",
      conversationId: seeded.conversationId,
      turnId: "turn_1",
      provider: "codex",
      mode: "mutating",
      lifetimeMs: 2_000
    });
    expect(lease.stale).toBe(false);
    expect(() =>
      store.acquireWorkspaceLease({
        projectId: seeded.projectId,
        worktreePath: "/tmp/exarch-lease",
        conversationId: seeded.conversationId,
        turnId: "turn_2",
        provider: "claude",
        mode: "read-only"
      })
    ).toThrow(/conflicting lease/);
    expect(() => store.heartbeatWorkspaceLease(lease.id, "wrong_turn")).toThrow(/owner mismatch/);
    now = new Date("2026-08-23T12:00:01Z");
    expect(store.heartbeatWorkspaceLease(lease.id, "turn_1", 2_000).heartbeatAt).toBe(
      now.toISOString()
    );
    expect(() => store.releaseStaleWorkspaceLeaseAfterReconciliation(lease.id)).toThrow(/Active/);
    expect(() => store.releaseWorkspaceLease(lease.id, "wrong_turn")).toThrow(/another turn/);

    now = new Date("2026-08-23T12:00:04Z");
    expect(store.getWorkspaceLease(lease.id).stale).toBe(true);
    expect(() => store.heartbeatWorkspaceLease(lease.id, "turn_1")).toThrow(/reconciliation/);
    expect(() =>
      store.acquireWorkspaceLease({
        projectId: seeded.projectId,
        worktreePath: "/tmp/exarch-lease",
        conversationId: seeded.conversationId,
        turnId: "turn_2",
        provider: "hermes",
        mode: "mutating"
      })
    ).toThrow(/stale lease/);
    store.releaseStaleWorkspaceLeaseAfterReconciliation(lease.id);
    expect(store.listWorkspaceLeases()).toEqual([]);

    expect(() =>
      store.acquireWorkspaceLease({
        projectId: seeded.projectId,
        worktreePath: "/tmp/exarch-lease",
        conversationId: seeded.conversationId,
        turnId: "turn_invalid",
        provider: "codex",
        mode: "mutating",
        lifetimeMs: 1
      })
    ).toThrow(/lifetime/);
    store.close();
  });

  it("prunes audit rows past the window but keeps the most recent regardless of age", () => {
    const insert = store.database.prepare(
      "INSERT INTO audit_log(id, action, subject_id, result, metadata_json, occurred_at) VALUES (?, ?, ?, ?, '{}', ?)"
    );
    for (let index = 0; index < 40; index += 1) {
      insert.run(`audit_old_${index}`, "request.authentication_failed", "device_x", "denied", "2020-01-01T00:00:00.000Z");
    }
    insert.run("audit_fresh", "request.authenticated", "device_x", "success", new Date().toISOString());

    const removed = store.pruneAuditLog({ retainDays: 30, retainRows: 10 });

    const remaining = store.database
      .prepare("SELECT id FROM audit_log ORDER BY occurred_at DESC, id DESC")
      .all() as Array<{ id: string }>;
    // The floor is a count of rows to keep, not a count of old rows to keep,
    // so the in-window row occupies one of the ten slots and thirty-one of the
    // forty stale rows go.
    expect(removed).toBe(31);
    expect(remaining).toHaveLength(10);
    expect(remaining[0]?.id).toBe("audit_fresh");
  });

  it("refuses a retention window or floor that would empty the table", () => {
    expect(() => store.pruneAuditLog({ retainDays: 0 })).toThrow(/positive number of days/);
    expect(() => store.pruneAuditLog({ retainRows: 0 })).toThrow(/positive row count/);
  });

  it("treats overlapping non-Git paths as one mutation scope", () => {
    const seeded = seedConversation(store, "overlap");
    const root = "/tmp/exarch-overlap";
    const active = store.acquireWorkspaceLease({
      projectId: seeded.projectId,
      worktreePath: root,
      conversationId: seeded.conversationId,
      turnId: "turn_root",
      provider: "codex",
      mode: "mutating",
      scopeKind: "path"
    });
    expect(() =>
      store.acquireWorkspaceLease({
        projectId: seeded.projectId,
        worktreePath: `${root}/nested`,
        conversationId: seeded.conversationId,
        turnId: "turn_nested",
        provider: "claude",
        mode: "mutating",
        scopeKind: "path"
      })
    ).toThrow(/conflicting lease/);
    expect(() =>
      store.acquireWorkspaceLease({
        projectId: seeded.projectId,
        worktreePath: "/tmp/exarch-independent",
        conversationId: seeded.conversationId,
        turnId: "turn_independent",
        provider: "hermes",
        mode: "mutating",
        scopeKind: "path"
      })
    ).not.toThrow();
    store.releaseWorkspaceLease(active.id, "turn_root");
  });

  it("rejects a recreated project root until it is explicitly re-enrolled", () => {
    const root = mkdtempSync(join(tmpdir(), "exarch-project-identity-"));
    const moved = `${root}-moved`;
    const project = store.enrollProject({ name: "Stable", repoRoot: root });
    expect(store.assertProjectExecutionScope(project.id)).toBe(realpathSync(root));

    renameSync(root, moved);
    mkdirSync(root);

    expect(() => store.assertProjectExecutionScope(project.id)).toThrow(/identity changed/);
    expect(store.enrollProject({ name: "Re-enrolled", repoRoot: root }).id).toBe(project.id);
    expect(store.assertProjectExecutionScope(project.id)).toBe(realpathSync(root));
  });

  /**
   * Bounds are checked when a project is written, so a row created under
   * looser rules keeps whatever it was granted then. History import is the
   * route that matters: it creates projects from a `cwd` string read out of a
   * harness transcript, with nobody at the laptop acting.
   */
  it("withdraws execution scope from a project whose root is no longer usable", () => {
    const usable = realpathSync(mkdtempSync(join(tmpdir(), "exarch-revalidate-")));
    const good = store.createProject({ name: "still fine", repoRoot: usable });

    // Write a row directly, the way one created before the bounds tightened
    // would look. createProject would refuse this today.
    const stale = "project_stale";
    store.database
      .prepare(
        `INSERT INTO projects(id, name, repo_root, allowed_paths_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(stale, "home", homedir(), JSON.stringify([homedir()]), "2026-08-01T00:00:00.000Z");
    expect(store.getProject(stale).allowedPaths).toEqual([homedir()]);

    const result = store.revalidateProjectScopes();

    expect(result.withdrawn).toEqual([stale]);
    expect(store.getProject(stale).allowedPaths).toEqual([]);
    // The row survives, so its conversations and their hash chain do too.
    expect(store.getProject(stale).repoRoot).toBe(homedir());
    expect(store.getProject(good.id).allowedPaths).toEqual([usable]);

    const audit = store.database
      .prepare("SELECT action, subject_id FROM audit_log WHERE action = 'project.scope_withdrawn'")
      .all() as Array<{ action: string; subject_id: string }>;
    expect(audit).toEqual([{ action: "project.scope_withdrawn", subject_id: stale }]);
  });

  it("leaves a healthy project untouched and reports what it checked", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "exarch-revalidate-ok-")));
    store.createProject({ name: "fine", repoRoot: root });
    const result = store.revalidateProjectScopes();
    expect(result.withdrawn).toEqual([]);
    expect(result.checked).toBeGreaterThan(0);
  });

});

function seedConversation(
  store: CanonicalStore,
  suffix = "default",
  repoRoot = mkdtempSync(join(tmpdir(), `exarch-store-${suffix}-`))
): { projectId: string; conversationId: string } {
  const project = store.createProject({
    id: `project_${suffix}`,
    name: `Project ${suffix}`,
    repoRoot
  });
  const conversation = store.createConversation({
    id: `conv_${suffix}`,
    projectId: project.id,
    title: `Conversation ${suffix}`,
    activeProvider: "codex"
  });
  return { projectId: project.id, conversationId: conversation.id };
}

function sequentialClock(start: string): () => Date {
  let timestamp = Date.parse(start);
  return () => {
    const result = new Date(timestamp);
    timestamp += 1;
    return result;
  };
}

function rechainStoredEvents(store: CanonicalStore, conversationId: string): string {
  const rows = store.database
    .prepare("SELECT * FROM events WHERE conversation_id = ? ORDER BY sequence")
    .all(conversationId) as Array<{
      id: string;
      conversation_id: string;
      turn_id: string | null;
      sequence: number;
      type: EventType;
      provider: Provider | null;
      payload_json: string;
      occurred_at: string;
    }>;
  let previousHash = GENESIS_HASH;
  for (const row of rows) {
    const eventHash = hashEvent({
      id: row.id,
      conversationId: row.conversation_id,
      turnId: row.turn_id,
      sequence: row.sequence,
      type: row.type,
      provider: row.provider,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      previousHash
    });
    store.database
      .prepare("UPDATE events SET previous_hash = ?, event_hash = ? WHERE id = ?")
      .run(previousHash, eventHash, row.id);
    previousHash = eventHash;
  }
  return previousHash;
}
