import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CanonicalStore } from "../../../../packages/core/src/index.js";
import type { HistoryReader, NativeHistoryThread } from "./types.js";
import { HistorySyncService } from "./history-sync.js";

// An imported thread names its own working directory, so the fixture uses a
// real one: project creation resolves and bounds the path it is given.
const importedProject = mkdtempSync(join(tmpdir(), "exarch-imported-project-"));

describe("HistorySyncService", () => {
  const stores: CanonicalStore[] = [];
  afterEach(() => stores.splice(0).forEach((store) => store.close()));

  it("imports idempotently, redacts secrets, and appends corrections", async () => {
    const store = new CanonicalStore(":memory:");
    stores.push(store);
    const thread = fixtureThread();
    const reader: HistoryReader = { provider: "codex", readHistory: async () => [thread] };
    const sync = new HistorySyncService(store, [reader]);

    const first = await sync.syncAll();
    expect(first).toMatchObject({ state: "complete" });
    expect(first.providers[0]).toMatchObject({ discovered: 1, imported: 1, insertedItems: 3 });
    const source = store.listHistorySources("codex")[0];
    expect(source).toMatchObject({ nativeSessionId: "native-1", importedItemCount: 3 });
    expect(store.listProjects()[0]).toMatchObject({
      repoRoot: realpathSync(importedProject),
      allowedPaths: []
    });
    const binding = store.getProviderBinding(source!.conversationId, "codex");
    expect(binding?.nativeSessionId).toBe("native-1");
    const initialEvents = store.listEvents(source!.conversationId, { limit: 100 });
    const initialChanges = store.listConversationChanges(null, 100);
    const initialCursor = initialChanges.nextCursor;
    expect(JSON.stringify(initialEvents)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(initialEvents.map((event) => event.type)).toContain("security.redaction.applied");

    const second = await sync.syncAll();
    expect(second.providers[0]).toMatchObject({ insertedItems: 0, correctedItems: 0, unchangedItems: 3 });
    expect(store.listEvents(source!.conversationId, { limit: 100 })).toHaveLength(initialEvents.length);
    expect(store.listConversationChanges(initialCursor, 100).conversations).toEqual([]);

    const movedProject = mkdtempSync(join(tmpdir(), "exarch-imported-project-moved-"));
    thread.cwd = movedProject;
    await sync.syncAll();
    expect(store.getConversation(source!.conversationId).projectId).toBe(
      store.getProjectByRepoRoot(movedProject)?.id
    );

    thread.items[1]!.payload = { text: "Corrected answer" };
    const fourth = await sync.syncAll();
    expect(fourth.providers[0]).toMatchObject({ correctedItems: 1 });
    const latest = store.listEvents(source!.conversationId, { limit: 100 }).at(-1);
    expect(latest?.payload).toMatchObject({ text: "Corrected answer" });
    expect(latest?.payload.supersedesEventId).toEqual(expect.any(String));
    expect(store.verifyEventChain(source!.conversationId).valid).toBe(true);
  });

  it("redacts imported titles before hashing, persistence, events, and search indexing", async () => {
    const store = new CanonicalStore(":memory:");
    stores.push(store);
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz01234567";
    const thread = fixtureThread();
    thread.nativeSessionId = "secret-title";
    thread.title = `Deploy with ${secret}`;
    const sync = new HistorySyncService(store, [{
      provider: "codex",
      readHistory: async () => [thread]
    }]);

    await sync.syncAll();
    const source = store.listHistorySources("codex")[0]!;
    const conversation = store.getConversation(source.conversationId);
    const events = store.listEvents(conversation.id, { limit: 100 });
    const indexed = store.database
      .prepare("SELECT text FROM events_fts WHERE conversation_id = ?")
      .all(conversation.id) as Array<{ text: string }>;

    expect(conversation.title).toContain("[REDACTED:GITHUB_TOKEN]");
    expect(JSON.stringify({ conversation, events, indexed })).not.toContain(secret);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "security.redaction.applied",
        payload: expect.objectContaining({ target: "conversation.title" })
      })
    ]));
    const digestBefore = source.sourceDigest;
    await sync.syncAll();
    expect(store.listHistorySources("codex")[0]?.sourceDigest).toBe(digestBefore);
  });

  it("isolates a failed provider while retaining successful imports", async () => {
    const store = new CanonicalStore(":memory:");
    stores.push(store);
    const ok: HistoryReader = { provider: "claude", readHistory: async () => [{ ...fixtureThread(), provider: "claude" }] };
    const failed: HistoryReader = { provider: "hermes", readHistory: async () => { throw new Error("export unavailable"); } };
    const status = await new HistorySyncService(store, [ok, failed]).syncAll();
    expect(status.state).toBe("partial");
    expect(status.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "claude", state: "complete" }),
      expect.objectContaining({ provider: "hermes", state: "failed", error: "export unavailable" })
    ]));
    expect(store.listConversations()).toHaveLength(1);
  });

  it("continues with later threads when one native thread is malformed", async () => {
    const store = new CanonicalStore(":memory:");
    stores.push(store);
    const malformed = fixtureThread();
    malformed.nativeSessionId = "broken";
    malformed.items[0]!.occurredAt = "not-a-timestamp";
    const good = fixtureThread();
    good.nativeSessionId = "good";
    const reader: HistoryReader = { provider: "codex", readHistory: async () => [malformed, good] };
    const status = await new HistorySyncService(store, [reader]).syncAll();
    expect(status.state).toBe("partial");
    expect(status.providers[0]).toMatchObject({
      state: "partial",
      discovered: 2,
      imported: 1,
      failedThreads: 1
    });
    expect(store.listHistorySources("codex").map((source) => source.nativeSessionId)).toEqual(["good"]);
  });

  it("imports streamed history incrementally", async () => {
    const store = new CanonicalStore(":memory:");
    stores.push(store);
    const reader: HistoryReader = {
      provider: "codex",
      readHistory: async () => { throw new Error("array history should not be loaded"); },
      async *streamHistory() {
        const first = fixtureThread();
        yield first;
        yield { ...fixtureThread(), nativeSessionId: "native-2", title: "Second thread" };
      }
    };
    const status = await new HistorySyncService(store, [reader]).syncAll();
    expect(status.providers[0]).toMatchObject({ state: "complete", discovered: 2, imported: 2 });
    expect(store.listHistorySources("codex")).toHaveLength(2);
  });

  it("debounces native file changes and imports only the changed thread", async () => {
    const store = new CanonicalStore(":memory:");
    stores.push(store);
    let notify: ((key: string) => void) | undefined;
    let stopped = false;
    const changedKeys: string[][] = [];
    const reader: HistoryReader = {
      provider: "claude",
      readHistory: async () => [],
      watchHistory(onChange) {
        notify = onChange;
        return () => { stopped = true; };
      },
      async readHistoryChanges(keys) {
        changedKeys.push([...keys]);
        return [{ ...fixtureThread(), provider: "claude", nativeSessionId: "changed-native" }];
      }
    };
    const sync = new HistorySyncService(store, [reader]);
    sync.startMonitoring({ debounceMs: 5, reconciliationIntervalMs: 60_000 });
    notify?.("first.jsonl");
    notify?.("first.jsonl");
    notify?.("second.jsonl");

    await expect.poll(() => store.listHistorySources("claude").length).toBe(1);
    await sync.stopMonitoring();
    expect(changedKeys).toEqual([["first.jsonl", "second.jsonl"]]);
    expect(stopped).toBe(true);
  });

  it("coalesces stale mobile checks and runs only lightweight change readers", async () => {
    const store = new CanonicalStore(":memory:");
    stores.push(store);
    let now = new Date("2026-08-23T10:00:00.000Z");
    let checks = 0;
    const reader: HistoryReader = {
      provider: "claude",
      readHistory: async () => [],
      checkForHistoryChanges: async () => {
        checks += 1;
        return [];
      }
    };
    const sync = new HistorySyncService(store, [reader], () => now);
    sync.startMonitoring({ reconciliationIntervalMs: 60_000, staleCheckIntervalMs: 10_000 });

    sync.requestChangeCheckIfStale();
    sync.requestChangeCheckIfStale();
    await sync.stopMonitoring();
    expect(checks).toBe(1);

    now = new Date("2026-08-23T10:00:11.000Z");
    sync.requestChangeCheckIfStale();
    await sync.stopMonitoring();
    expect(checks).toBe(2);
  });
});

function fixtureThread(): NativeHistoryThread {
  return {
    provider: "codex",
    nativeSessionId: "native-1",
    title: "Imported thread",
    cwd: importedProject,
    archived: false,
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:01:00.000Z",
    metadata: { source: "cli" },
    items: [
      {
        nativeItemId: "user-1",
        type: "user.message",
        payload: { text: "Use sk-abcdefghijklmnopqrstuvwxyz" },
        occurredAt: "2026-08-20T10:00:00.000Z"
      },
      {
        nativeItemId: "assistant-1",
        type: "assistant.message.completed",
        payload: { text: "Original answer" },
        occurredAt: "2026-08-20T10:01:00.000Z"
      }
    ]
  };
}

/**
 * A transcript's `cwd` is a string in a file under ~/.claude/projects, which
 * anything running as the user can write. Import used to turn that string into
 * a project with execution scope, so planting a transcript enrolled a
 * directory the phone could then start a turn in.
 */
describe("history import and workspace bounds", () => {
  it("retains broad history for browsing without granting it execution scope", async () => {
    const store = new CanonicalStore(":memory:");
    const reader = {
      provider: "claude" as const,
      async readHistory() {
        return [
          {
            provider: "claude" as const,
            nativeSessionId: "planted",
            title: "innocuous",
            cwd: homedir(),
            archived: false,
            createdAt: "2026-08-25T00:00:00.000Z",
            updatedAt: "2026-08-25T00:00:00.000Z",
            metadata: {},
            items: []
          }
        ];
      }
    };

    const status = await new HistorySyncService(store, [reader as never]).syncAll();

    expect(store.listProjects()).toEqual([
      expect.objectContaining({ repoRoot: realpathSync(homedir()), allowedPaths: [] })
    ]);
    expect(status.providers[0]).toMatchObject({
      state: "complete",
      imported: 1,
      failedThreads: 0,
      error: null
    });
    store.close();
  });
});
