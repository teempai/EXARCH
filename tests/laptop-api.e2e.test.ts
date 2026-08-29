import { WebSocket } from "ws";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CanonicalStore,
  DeviceAuthenticator,
  createTestDeviceKeyPair
} from "../packages/core/src/index.js";
import type { RequestSignatureInput } from "../packages/protocol/src/index.js";
import {
  ConversationCoordinator,
  DeterministicProviderAdapter,
  LaptopApiServer
} from "../services/daemon/src/index.js";
import { HistorySyncService } from "../services/daemon/src/history/history-sync.js";

describe.sequential("laptop API end to end", () => {
  let store: CanonicalStore;
  let server: LaptopApiServer;
  let baseUrl: string;
  let counter = 0;
  let preparedDeviceId: string | undefined;
  let relayCleanupCompleted = false;
  const keys = createTestDeviceKeyPair();
  const unauthorizedKeys = createTestDeviceKeyPair();
  const codex = new DeterministicProviderAdapter("codex");
  const approvalClaude = new ApprovalFixtureAdapter();

  beforeAll(async () => {
    store = new CanonicalStore(":memory:");
    store.registerDevice({
      id: "device_api",
      displayName: "API test phone",
      signingPublicKey: keys.publicKey,
      approvalPublicKey: keys.publicKey,
      capabilities: ["mobile-control"]
    });
    store.registerDevice({
      id: "device_without_control",
      displayName: "Unprivileged local identity",
      signingPublicKey: unauthorizedKeys.publicKey,
      approvalPublicKey: unauthorizedKeys.publicKey,
      capabilities: []
    });
    const coordinator = new ConversationCoordinator(store, [
      codex,
      approvalClaude,
      new DeterministicProviderAdapter("hermes")
    ]);
    server = new LaptopApiServer(
      coordinator,
      new DeviceAuthenticator(store),
      "127.0.0.1",
      new HistorySyncService(store, []),
      {
        prepare: async (deviceId) => { preparedDeviceId = deviceId; },
        complete: async () => { relayCleanupCompleted = true; }
      }
    );
    baseUrl = (await server.start()).baseUrl;
  });

  afterAll(async () => {
    await server.stop();
    store.close();
  });

  it("rejects an unpaired request", async () => {
    const response = await fetch(`${baseUrl}/api/v1/health`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });

    const unknownChallenge = await fetch(`${baseUrl}/api/v1/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "not-enrolled" })
    });
    expect(unknownChallenge.status).toBe(200);
    expect(await unknownChallenge.json()).toMatchObject({
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expiresAt: expect.any(String)
    });
  });

  it("rejects an authenticated device without a remote-control capability", async () => {
    const response = await signedFetchAs(
      "GET",
      "/api/v1/health",
      "device_without_control",
      unauthorizedKeys,
      1
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  /**
   * The upgrade path authenticated and then discarded the record, so this
   * device — refused every HTTP route above — was handed the live event
   * stream. The counter continues from the previous test: the capability
   * check runs after verification, which has already advanced it.
   */
  it("rejects that same device on the event-stream upgrade", async () => {
    const conversationId = "conversation_does_not_need_to_exist";
    const path = `/api/v1/conversations/${conversationId}/events?after=0`;
    const headers = await signedHeadersAs(
      "GET",
      path,
      "device_without_control",
      unauthorizedKeys,
      2
    );
    const status = await new Promise<number>((resolve, reject) => {
      const webSocket = new WebSocket(`${baseUrl.replace("http", "ws")}${path}`, { headers });
      const timer = setTimeout(() => reject(new Error("Upgrade neither opened nor failed")), 3_000);
      webSocket.once("unexpected-response", (_request, response) => {
        clearTimeout(timer);
        resolve(response.statusCode ?? 0);
      });
      webSocket.once("open", () => {
        clearTimeout(timer);
        webSocket.close();
        reject(new Error("Upgrade succeeded for a device without remote control"));
      });
      webSocket.once("error", () => {});
    });
    expect(status).toBe(401);
  });

  it("uses a laptop-enrolled project to create a conversation, then runs a text-only turn", async () => {
    const health = await signedFetch("GET", "/api/v1/health");
    expect(health.status).toBe(200);

    const project = store.createProject({
      name: "API project",
      repoRoot: mkdtempSync(join(tmpdir(), "exarch-api-project-"))
    });

    const projects = await signedFetch("GET", "/api/v1/projects");
    expect((await projects.json()) as Array<{ id: string }>).toEqual([
      expect.objectContaining({ id: project.id })
    ]);

    const remoteEnrollment = await signedFetch("POST", "/api/v1/projects", {
      name: "Remote enrollment is forbidden",
      repoRoot: mkdtempSync(join(tmpdir(), "exarch-api-remote-project-"))
    });
    expect(remoteEnrollment.status).toBe(404);
    expect(store.listProjects()).toHaveLength(1);

    const importedRoot = mkdtempSync(join(tmpdir(), "exarch-api-history-project-"));
    const importedProject = store.createImportedProject({
      name: "Native history",
      repoRoot: importedRoot
    });
    expect(importedProject.allowedPaths).toEqual([]);

    const importedConversation = await signedFetch("POST", "/api/v1/conversations", {
      projectId: importedProject.id,
      title: "Must remain browse-only",
      provider: "codex"
    });
    expect(importedConversation.status).toBe(400);

    const providers = await signedFetch("GET", "/api/v1/providers");
    expect((await providers.json()) as Array<{ health: { provider: string } }>).toHaveLength(3);
    const initialImportStatus = await signedFetch("GET", "/api/v1/history-import/status");
    expect(await initialImportStatus.json()).toMatchObject({ state: "idle", providers: [] });
    const refreshedImportStatus = await signedFetch("POST", "/api/v1/history-import/refresh", {});
    expect(refreshedImportStatus.status).toBe(202);
    expect(await refreshedImportStatus.json()).toMatchObject({ state: "running", providers: [] });
    await expect.poll(async () => {
      const status = await signedFetch("GET", "/api/v1/history-import/status");
      return (await status.json() as { state: string }).state;
    }).toBe("complete");

    const conversationResponse = await signedFetch("POST", "/api/v1/conversations", {
      projectId: project.id,
      title: "API conversation",
      provider: "codex"
    });
    const conversation = (await conversationResponse.json()) as { id: string };

    const conversationDetail = await signedFetch(
      "GET",
      `/api/v1/conversations/${conversation.id}`
    );
    expect(await conversationDetail.json()).toMatchObject({ id: conversation.id, activeProvider: "codex" });
    const fallbackRoute = await signedFetch(
      "POST",
      `/api/v1/conversations/${conversation.id}/fallback-route`,
      { route: ["codex", "claude", "hermes"] }
    );
    expect(await fallbackRoute.json()).toMatchObject({
      id: conversation.id,
      fallbackRoute: ["codex", "claude", "hermes"]
    });
    expect((await signedFetch(
      "POST",
      `/api/v1/conversations/${conversation.id}/fallback-route`,
      { route: ["codex", "codex"] }
    )).status).toBe(400);
    const policy = await signedFetch(
      "GET",
      `/api/v1/providers/codex/effective-policy?conversationId=${conversation.id}`
    );
    expect(await policy.json()).toMatchObject({ provider: "codex", status: "verified" });

    const conversations = await signedFetch(
      "GET",
      `/api/v1/conversations?projectId=${encodeURIComponent(project.id)}`
    );
    expect((await conversations.json()) as Array<{ id: string }>).toEqual([
      expect.objectContaining({ id: conversation.id })
    ]);

    const syncPage = await signedFetch("GET", "/api/v1/conversations/sync?limit=1");
    const syncPayload = (await syncPage.json()) as {
      conversations: Array<{ id: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(syncPayload.conversations).toHaveLength(1);
    expect(syncPayload.nextCursor).toEqual(expect.any(String));
    const nextSyncPage = await signedFetch(
      "GET",
      `/api/v1/conversations/sync?limit=1&cursor=${encodeURIComponent(syncPayload.nextCursor as string)}`
    );
    expect(nextSyncPage.status).toBe(200);
    const legacyCursor = Buffer.from(JSON.stringify({
      version: 1,
      updatedAt: "2026-08-23T00:00:00.000Z",
      id: "conv_legacy_cursor"
    })).toString("base64url");
    const legacySyncPage = await signedFetch(
      "GET",
      `/api/v1/conversations/sync?cursor=${encodeURIComponent(legacyCursor)}`
    );
    expect(legacySyncPage.status).toBe(200);
    expect((await legacySyncPage.json()) as { conversations: Array<{ id: string }> }).toMatchObject({
      conversations: [expect.objectContaining({ id: conversation.id })]
    });
    expect((await signedFetch("GET", "/api/v1/conversations/sync?cursor=bad%25cursor")).status).toBe(400);
    expect((await signedFetch("GET", "/api/v1/conversations/sync?limit=0")).status).toBe(400);

    const listPage = await signedFetch("GET", "/api/v1/conversations/page?limit=1");
    expect(listPage.status).toBe(200);
    const listPayload = (await listPage.json()) as {
      conversations: Array<{ id: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(listPayload.conversations).toHaveLength(1);
    expect(listPayload.conversations[0]?.id).toBe(conversation.id);
    expect((await signedFetch("GET", "/api/v1/conversations/page?cursor=bad%25cursor")).status).toBe(400);
    expect((await signedFetch("GET", "/api/v1/conversations/page?limit=0")).status).toBe(400);

    const pinResponse = await signedFetch(
      "POST",
      `/api/v1/conversations/${conversation.id}/pin`,
      { pinned: true }
    );
    expect(pinResponse.status).toBe(200);
    expect(await pinResponse.json()).toMatchObject({ id: conversation.id, pinned: true });
    const pinSync = await signedFetch(
      "GET",
      `/api/v1/conversations/sync?cursor=${encodeURIComponent(syncPayload.nextCursor as string)}`
    );
    expect((await pinSync.json()) as { conversations: Array<{ id: string; pinned: boolean }> })
      .toMatchObject({ conversations: [expect.objectContaining({ id: conversation.id, pinned: true })] });

    const messageResponse = await signedFetch(
      "POST",
      `/api/v1/conversations/${conversation.id}/messages`,
      {
        clientMessageId: "message_api_1",
        text: "Implement replay",
        provider: "codex",
        effectivePolicyRevision: codex.policy.revision
      }
    );
    expect(messageResponse.status).toBe(201);
    const result = (await messageResponse.json()) as { events: Array<{ type: string }> };
    expect(result.events.some((event) => event.type === "assistant.message.completed")).toBe(true);

    const eventResponse = await signedFetch(
      "GET",
      `/api/v1/conversations/${conversation.id}/events?after=0&limit=100`
    );
    const events = (await eventResponse.json()) as Array<{ sequence: number; type: string }>;
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index + 1)
    );
    expect(events.filter((event) => event.type === "user.message")).toHaveLength(1);
    expect(
      (await signedFetch("GET", `/api/v1/conversations/${conversation.id}/events`)).status
    ).toBe(200);
    const recentMessagesResponse = await signedFetch(
      "GET",
      `/api/v1/conversations/${conversation.id}/events?before=${events.length + 1}&limit=1&view=messages`
    );
    expect(recentMessagesResponse.status).toBe(200);
    expect((await recentMessagesResponse.json()) as Array<{ type: string }>).toEqual([
      expect.objectContaining({ type: "assistant.message.completed" })
    ]);

    const search = await signedFetch(
      "GET",
      `/api/v1/conversations/${conversation.id}/context/search?q=Implement&limit=10`
    );
    expect((await search.json()) as Array<{ event: { type: string } }>).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: expect.objectContaining({ type: "user.message" }) })
      ])
    );
    const changes = await signedFetch(
      "GET",
      `/api/v1/conversations/${conversation.id}/changes`
    );
    expect(await changes.json()).toMatchObject({ isRepository: false, patch: "" });

    const conflict = await signedFetch(
      "POST",
      `/api/v1/conversations/${conversation.id}/messages`,
      {
        clientMessageId: "message_api_2",
        text: "Run",
        provider: "codex",
        effectivePolicyRevision: `sha256:${"0".repeat(64)}`
      }
    );
    expect(conflict.status).toBe(409);

    const switchResponse = await signedFetch(
      "POST",
      `/api/v1/conversations/${conversation.id}/provider`,
      { provider: "hermes" }
    );
    expect(switchResponse.status).toBe(200);
    expect(store.getConversation(conversation.id).activeProvider).toBe("hermes");

    const invalid = await signedFetch("POST", "/api/v1/conversations", {
      projectId: project.id,
      title: "Invalid",
      provider: "unknown"
    });
    expect(invalid.status).toBe(400);

    const missing = await signedFetch("GET", "/api/v1/not-found");
    expect(missing.status).toBe(404);
  });

  it("replays committed events over an authenticated WebSocket", async () => {
    const conversationsResponse = await signedFetch("GET", "/api/v1/conversations");
    const conversations = (await conversationsResponse.json()) as Array<{ id: string }>;
    const conversationId = conversations[0]?.id;
    expect(conversationId).toBeDefined();
    const path = `/api/v1/conversations/${conversationId as string}/events?after=0`;
    const headers = await signedHeaders("GET", path, Buffer.alloc(0));
    const event = await new Promise<{ type: string; event: { sequence: number } }>((resolve, reject) => {
      const webSocket = new WebSocket(`${baseUrl.replace("http", "ws")}${path}`, { headers });
      const timer = setTimeout(() => reject(new Error("WebSocket replay timed out")), 3_000);
      webSocket.once("message", (data) => {
        clearTimeout(timer);
        const parsed = JSON.parse(data.toString()) as { type: string; event: { sequence: number } };
        webSocket.close();
        resolve(parsed);
      });
      webSocket.once("error", reject);
    });
    expect(event.type).toBe("event");
    expect(event.event.sequence).toBe(1);
  });

  it("requires the separate approval-key signature and relays only an offered choice", async () => {
    const projectsResponse = await signedFetch("GET", "/api/v1/projects");
    const project = ((await projectsResponse.json()) as Array<{ id: string }>)[0];
    expect(project).toBeDefined();
    const conversationResponse = await signedFetch("POST", "/api/v1/conversations", {
      projectId: project?.id,
      title: "Approval conversation",
      provider: "claude"
    });
    const conversation = (await conversationResponse.json()) as { id: string };
    const pendingMessage = signedFetch(
      "POST",
      `/api/v1/conversations/${conversation.id}/messages`,
      {
        clientMessageId: "message_approval_1",
        text: "needs approval",
        provider: "claude",
        effectivePolicyRevision: approvalClaude.policy.revision
      }
    );
    await waitUntil(() => store.listApprovals(conversation.id, "pending").length === 1);
    const approvalsResponse = await signedFetch(
      "GET",
      `/api/v1/approvals?conversationId=${encodeURIComponent(conversation.id)}&status=pending`
    );
    const approval = ((await approvalsResponse.json()) as Array<{
      id: string;
      request: { approvalDigest: string; choices: string[] };
    }>)[0];
    expect(approval?.request.choices).toEqual(["allow", "deny"]);
    expect(
      (
        await signedFetch(
          "GET",
          `/api/v1/approvals?conversationId=${encodeURIComponent(conversation.id)}`
        )
      ).status
    ).toBe(200);
    const decidedAt = new Date().toISOString();
    const choice = "allow";
    const signature = keys.signApproval({
      approvalId: approval?.id as string,
      approvalDigest: approval?.request.approvalDigest as string,
      choice,
      deviceId: "device_api",
      decidedAt
    });
    const decisionResponse = await signedFetch(
      "POST",
      `/api/v1/approvals/${approval?.id as string}/decision`,
      { choice, decidedAt, signature }
    );
    expect(decisionResponse.status).toBe(200);
    expect((await pendingMessage).status).toBe(201);
    expect(store.getApproval(approval?.id as string)).toMatchObject({
      status: "decided",
      decision: { choice: "allow", deviceId: "device_api" }
    });
    expect(
      store.listEvents(conversation.id).some((event) => event.type === "approval.decided")
    ).toBe(true);
  });

  it("bounds request bodies and rejects malformed routes and query values", async () => {
    const malformedChallenge = await fetch(`${baseUrl}/api/v1/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(malformedChallenge.status).toBe(400);

    const oversized = await fetch(`${baseUrl}/api/v1/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.alloc(1024 * 1024 + 1, 1)
    });
    expect(oversized.status).toBe(413);

    expect((await signedFetch("GET", "/api/v1/approvals")).status).toBe(400);
    expect(
      (await signedFetch("GET", "/api/v1/approvals?conversationId=missing&status=bogus")).status
    ).toBe(400);
    expect(
      (await signedFetch("GET", "/api/v1/conversations/missing/events?after=-1")).status
    ).toBe(400);
    expect(
      (await signedFetch("GET", "/api/v1/conversations/missing/events?limit=1.5")).status
    ).toBe(400);
    expect(
      (await signedFetch("GET", "/api/v1/conversations/missing/events?after=1&before=2")).status
    ).toBe(400);
    expect(
      (await signedFetch("GET", "/api/v1/conversations/missing/events?view=raw")).status
    ).toBe(400);
    expect(
      (await signedFetch("GET", "/api/v1/conversations/missing/context/search")).status
    ).toBe(500);
    expect(
      (await signedFetch("GET", "/api/v1/providers/unknown/effective-policy")).status
    ).toBe(400);
    expect((await signedFetch("POST", "/api/v1/conversations/missing/interrupt", {})).status).toBe(
      500
    );

    const existingApproval = store.listApprovals(
      store.listConversations().find((conversation) => conversation.title === "Approval conversation")
        ?.id as string
    )[0];
    expect(existingApproval).toBeDefined();
    const badDecision = await signedFetch(
      "POST",
      `/api/v1/approvals/${existingApproval?.id as string}/decision`,
      {
        choice: "allow",
        decidedAt: new Date().toISOString(),
        signature: Buffer.alloc(64, 7).toString("base64url")
      }
    );
    expect(badDecision.status).toBe(401);
  });

  it("refuses a non-loopback bind configuration", () => {
    const coordinator = new ConversationCoordinator(store, [codex]);
    expect(
      () => new LaptopApiServer(coordinator, new DeviceAuthenticator(store), "0.0.0.0")
    ).toThrow(/loopback/);
  });

  it("durably withdraws phone authority before acknowledging relay cleanup", async () => {
    preparedDeviceId = undefined;
    relayCleanupCompleted = false;
    const response = await signedFetch("POST", "/api/v1/pairing/revoke", {});
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: true,
      authorizationRevoked: true,
      contextPreserved: true
    });
    expect(preparedDeviceId).toBe("device_api");
    expect(relayCleanupCompleted).toBe(false);
    await waitUntil(() => relayCleanupCompleted);
  });

  async function signedFetch(method: string, path: string, value?: unknown): Promise<Response> {
    const body = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value));
    const headers = await signedHeaders(method, path, body);
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...headers, ...(value === undefined ? {} : { "content-type": "application/json" }) },
      ...(value === undefined ? {} : { body })
    });
  }

  async function signedHeadersAs(
    method: string,
    path: string,
    deviceId: string,
    signer: typeof keys,
    deviceCounter: number
  ): Promise<Record<string, string>> {
    const body = Buffer.alloc(0);
    const challengeResponse = await fetch(`${baseUrl}/api/v1/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId })
    });
    const challenge = (await challengeResponse.json()) as { nonce: string; expiresAt: string };
    const timestamp = new Date().toISOString();
    const signatureInput: RequestSignatureInput = {
      method,
      path,
      body,
      nonce: challenge.nonce,
      counter: deviceCounter,
      timestamp,
      challengeExpiresAt: challenge.expiresAt
    };
    return {
      "x-exarch-device-id": deviceId,
      "x-exarch-nonce": challenge.nonce,
      "x-exarch-counter": String(deviceCounter),
      "x-exarch-timestamp": timestamp,
      "x-exarch-signature": signer.signRequest(signatureInput)
    };
  }

  async function signedFetchAs(
    method: string,
    path: string,
    deviceId: string,
    signer: typeof keys,
    deviceCounter: number
  ): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: await signedHeadersAs(method, path, deviceId, signer, deviceCounter)
    });
  }

  async function signedHeaders(method: string, path: string, body: Buffer) {
    const challengeResponse = await fetch(`${baseUrl}/api/v1/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "device_api" })
    });
    const challenge = (await challengeResponse.json()) as { nonce: string; expiresAt: string };
    counter += 1;
    const timestamp = new Date().toISOString();
    const signatureInput: RequestSignatureInput = {
      method,
      path,
      body,
      nonce: challenge.nonce,
      counter,
      timestamp,
      challengeExpiresAt: challenge.expiresAt
    };
    return {
      "x-exarch-device-id": "device_api",
      "x-exarch-nonce": challenge.nonce,
      "x-exarch-counter": String(counter),
      "x-exarch-timestamp": timestamp,
      "x-exarch-signature": keys.signRequest(signatureInput)
    };
  }
});

class ApprovalFixtureAdapter extends DeterministicProviderAdapter {
  private pending: (() => void) | null = null;

  constructor() {
    super("claude");
  }

  override async *startTurn(input: Parameters<DeterministicProviderAdapter["startTurn"]>[0]) {
    yield {
      type: "approval.requested" as const,
      payload: {
        providerRequestId: "native-approval-1",
        actionCommitment: `sha256:${"d".repeat(64)}`,
        choices: ["allow", "deny"],
        command: "fixture"
      }
    };
    await new Promise<void>((resolve) => {
      this.pending = resolve;
    });
    yield* super.startTurn(input);
  }

  override async respondToApproval(input: {
    turnId: string;
    requestId: string;
    choice: string;
  }): Promise<void> {
    if (input.requestId !== "native-approval-1" || !["allow", "deny"].includes(input.choice)) {
      throw new Error("invalid fixture approval");
    }
    const resolve = this.pending;
    this.pending = null;
    resolve?.();
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
