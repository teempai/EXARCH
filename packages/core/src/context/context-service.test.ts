import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextCapabilityIssuer } from "./capability.js";
import { requestContext } from "./context-client.js";
import { ContextService } from "./context-service.js";
import { ContextRequestSchema } from "./protocol.js";
import { CanonicalStore } from "../store/canonical-store.js";

describe("ContextService", () => {
  let store: CanonicalStore;
  let service: ContextService;
  let issuer: ContextCapabilityIssuer;
  let socketPath: string;
  let projectId: string;
  let conversationId: string;
  let sourceEventId: string;

  beforeEach(async () => {
    const directory = await mkdtemp(join(tmpdir(), "exarch-context-test-"));
    socketPath = join(directory, "control.sock");
    store = new CanonicalStore(":memory:");
    const project = store.createProject({ name: "Test", repoRoot: directory });
    const conversation = store.createConversation({ projectId: project.id, title: "Test", activeProvider: "codex" });
    projectId = project.id;
    conversationId = conversation.id;
    sourceEventId = store.appendEvent({
      conversationId,
      turnId: "turn_1",
      type: "user.message",
      provider: "codex",
      payload: { text: "The launch decision is blue" }
    }).id;
    issuer = new ContextCapabilityIssuer(Buffer.alloc(32, 9));
    service = new ContextService(socketPath, store, issuer);
    await service.start();
  });

  afterEach(async () => {
    await service.stop();
    store.close();
  });

  it("creates a user-only Unix socket and returns scoped search", async () => {
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    const response = await send("search", { query: "launch" }, ["search"]);
    expect(response.ok).toBe(true);
    expect(response.data).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ id: sourceEventId }) })
    ]);
  });

  it("supports provenance-bound decision and task mutations", async () => {
    const decision = await send(
      "decisions.add",
      { text: "Use blue", sourceEventIds: [sourceEventId] },
      ["decisions.add"]
    );
    expect(decision.ok).toBe(true);
    const task = await send(
      "tasks.add",
      { text: "Implement blue", sourceEventIds: [sourceEventId] },
      ["tasks.add"]
    );
    expect(task.ok).toBe(true);
    expect(store.listDecisions(conversationId, "active")[0]?.sourceEventIds).toEqual([sourceEventId]);
    expect(store.listTasks(conversationId, "open")[0]?.sourceEventIds).toEqual([sourceEventId]);
    const decisionId = (decision.data as { id: string }).id;
    const taskId = (task.data as { id: string }).id;
    expect(
      (
        await send(
          "decisions.supersede",
          {
            decisionId,
            text: "Use green",
            sourceEventIds: [sourceEventId]
          },
          ["decisions.supersede"]
        )
      ).ok
    ).toBe(true);
    expect(
      (
        await send(
          "tasks.complete",
          { taskId, sourceEventIds: [sourceEventId] },
          ["tasks.complete"]
        )
      ).ok
    ).toBe(true);
    expect(store.verifyEventChain(conversationId).valid).toBe(true);
  });

  it("rejects wrong-project and missing-operation capabilities", async () => {
    const wrongProject = await send("current", {}, ["current"], "project_wrong");
    expect(wrongProject).toEqual(
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "forbidden_or_invalid" }) })
    );
    const missingOperation = await send("search", { query: "launch" }, ["current"]);
    expect(missingOperation.ok).toBe(false);
  });

  it("rejects arbitrary or ambiguous protocol fields", () => {
    expect(() =>
      ContextRequestSchema.parse({
        version: 1,
        requestId: "request",
        capability: "token",
        projectId,
        conversationId,
        turnId: "turn_1",
        operation: "current",
        arguments: {},
        sql: "SELECT * FROM devices"
      })
    ).toThrow();
  });

  it("serves the bounded read surface and validates ranges and statuses", async () => {
    store.appendEvent({
      conversationId,
      turnId: "turn_1",
      type: "repository.checkpointed",
      provider: "codex",
      payload: { branch: "main", commit: "abc" }
    });
    store.appendEvent({
      conversationId,
      turnId: "turn_1",
      type: "provider.handoff.completed",
      provider: "hermes",
      payload: { source: "codex", target: "hermes" }
    });
    expect((await send("current", {}, ["current"])).ok).toBe(true);
    expect((await send("recent", { limit: 2 }, ["recent"])).ok).toBe(true);
    expect((await send("recent", { before: 3 }, ["recent"])).ok).toBe(true);
    expect(
      (await send("event.show", { eventId: sourceEventId }, ["event.show"])).data
    ).toEqual(expect.objectContaining({ id: sourceEventId }));
    expect((await send("events.range", { from: 1, to: 3 }, ["events.range"])).ok).toBe(true);
    expect((await send("decisions.list", { status: "active" }, ["decisions.list"])).data).toEqual([]);
    expect((await send("decisions.list", {}, ["decisions.list"])).ok).toBe(true);
    expect((await send("tasks.list", { status: "open" }, ["tasks.list"])).data).toEqual([]);
    expect((await send("repo-state", {}, ["repo-state"])).data).toEqual(
      expect.objectContaining({ type: "repository.checkpointed" })
    );
    expect((await send("handoffs", { limit: 10 }, ["handoffs"])).data).toEqual([
      expect.objectContaining({ type: "provider.handoff.completed" })
    ]);
    expect((await send("events.range", { from: 4, to: 2 }, ["events.range"])).ok).toBe(false);
    expect((await send("tasks.list", { status: "invalid" }, ["tasks.list"])).ok).toBe(false);
    expect((await send("decisions.list", { status: "invalid" }, ["decisions.list"])).ok).toBe(false);
    expect((await send("recent", { limit: 0 }, ["recent"])).ok).toBe(false);
    expect((await send("search", { query: "" }, ["search"])).ok).toBe(false);
    expect((await send("event.show", { eventId: "" }, ["event.show"])).ok).toBe(false);
  });

  async function send(
    operation: Parameters<typeof issue>[0],
    arguments_: Record<string, unknown>,
    operations: Parameters<typeof issue>[1],
    requestProjectId = projectId
  ) {
    return requestContext(
      socketPath,
      ContextRequestSchema.parse({
        version: 1,
        requestId: `request_${operation}`,
        capability: issue(operation, operations),
        projectId: requestProjectId,
        conversationId,
        turnId: "turn_1",
        operation,
        arguments: arguments_
      })
    );
  }

  function issue(
    _operation: import("./capability.js").ContextOperation,
    operations: import("./capability.js").ContextOperation[]
  ): string {
    return issuer.issue({
      id: "cap_test",
      projectId,
      conversationId,
      turnId: "turn_1",
      operations,
      lifetimeMs: 60_000
    });
  }
});
