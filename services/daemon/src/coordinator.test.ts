import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanonicalStore } from "../../../packages/core/src/index.js";
import type { EventEnvelope, ProviderCapacity } from "../../../packages/protocol/src/index.js";
import {
  ApprovalDeliveryError,
  ConversationCoordinator,
  PolicyRevisionConflictError,
  ProviderHandoffRequiredError,
  ProviderOutputLimitError,
  ProviderUnavailableError,
  WorkspaceUnavailableError
} from "./coordinator.js";
import { DeterministicProviderAdapter } from "./providers/deterministic-adapter.js";
import { ProviderCapacityExhaustedError } from "./providers/provider-adapter.js";
import { GitWorkspaceManager } from "./git-workspace-manager.js";

describe("ConversationCoordinator", () => {
  it("rejects browse-only history cwd before provider policy or health observation", async () => {
    const store = new CanonicalStore(":memory:");
    const codex = new ScopeProbeAdapter();
    const coordinator = new ConversationCoordinator(store, [codex]);
    const project = store.createImportedProject({
      name: "History only",
      repoRoot: mkdtempSync(join(tmpdir(), "exarch-history-only-"))
    });
    const conversationId = store.createConversation({
      projectId: project.id,
      title: "Imported",
      activeProvider: "codex"
    }).id;

    await expect(coordinator.provider("codex", conversationId)).rejects.toThrow(/scope is empty/);
    await expect(
      coordinator.submitMessage(conversationId, messageFor(codex, "browse_only"))
    ).rejects.toThrow(/scope is empty/);
    expect(codex.probeCalls).toBe(0);
    expect(codex.policyCalls).toBe(0);
    expect(store.listEvents(conversationId).map((event) => event.type)).toEqual([
      "conversation.created"
    ]);
    store.close();
  });

  it("runs a canonical turn and deduplicates the client message", async () => {
    const store = new CanonicalStore(":memory:");
    const codex = new DeterministicProviderAdapter("codex");
    const coordinator = new ConversationCoordinator(store, [codex]);
    const conversationId = seed(store);
    const message = {
      clientMessageId: "message_1",
      text: "Run tests",
      provider: "codex" as const,
      effectivePolicyRevision: codex.policy.revision
    };
    const first = await coordinator.submitMessage(conversationId, message);
    const second = await coordinator.submitMessage(conversationId, message);

    expect(second).toEqual(first);
    expect(first.events.map((event) => event.type)).toEqual([
      "repository.checkpointed",
      "provider.policy.observed",
      "turn.started",
      "user.message",
      "assistant.message.started",
      "assistant.message.delta",
      "assistant.message.completed",
      "repository.checkpointed",
      "turn.completed"
    ]);
    expect(
      store.listEvents(conversationId).filter((event) => event.type === "user.message")
    ).toHaveLength(1);
    await expect(
      coordinator.submitMessage(conversationId, { ...message, text: "Different" })
    ).rejects.toThrow(/Idempotency key/);
    store.close();
  });

  it("does not manufacture canonical context for a synchronized native session", async () => {
    const store = new CanonicalStore(":memory:");
    const inputs: Parameters<DeterministicProviderAdapter["startTurn"]>[0][] = [];
    const codex = new DeterministicProviderAdapter("codex", (input) => {
      inputs.push(input);
      return "ok";
    });
    const coordinator = new ConversationCoordinator(store, [codex]);
    const conversationId = seed(store);
    store.upsertProviderBinding({
      conversationId,
      provider: "codex",
      nativeSessionId: "native-thread-1",
      synchronizedThroughSequence: store.getConversation(conversationId).nextSequence - 1
    });

    const text = "What about ”exarch”?";
    await coordinator.submitMessage(conversationId, {
      clientMessageId: "exact_native_prompt",
      text,
      provider: "codex",
      effectivePolicyRevision: codex.policy.revision
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.text).toBe(text);
    expect(inputs[0]?.context.recentEvents).toEqual([]);
    expect(inputs[0]?.context.cliCommand).toBeUndefined();
    store.close();
  });

  it("rejects exhausted providers before persisting or executing the message", async () => {
    const store = new CanonicalStore(":memory:");
    const codex = new ExhaustedAdapter();
    const coordinator = new ConversationCoordinator(store, [codex]);
    const conversationId = seed(store);

    await expect(
      coordinator.submitMessage(conversationId, messageFor(codex, "capacity_preflight"))
    ).rejects.toMatchObject({
      name: "ProviderCapacityExhaustedError",
      provider: "codex",
      retrySafe: true
    });
    expect(store.listEvents(conversationId).map((event) => event.type)).toEqual(["conversation.created"]);
    store.close();
  });

  it("keeps a capacity rejection retry-safe when only a native session was bound", async () => {
    const store = new CanonicalStore(":memory:");
    const codex = new BindThenExhaustAdapter();
    const coordinator = new ConversationCoordinator(store, [codex]);
    const conversationId = seed(store);

    await expect(
      coordinator.submitMessage(conversationId, messageFor(codex, "capacity_after_bind"))
    ).rejects.toMatchObject({ retrySafe: true });
    const events = store.listEvents(conversationId);
    expect(events.map((event) => event.type)).not.toContain("user.message");
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      payload: { failureKind: "provider_capacity_exhausted", retrySafe: true }
    });
    store.close();
  });

  it("never marks a capacity failure retry-safe after provider work begins", async () => {
    const store = new CanonicalStore(":memory:");
    const codex = new WorkThenExhaustAdapter();
    const coordinator = new ConversationCoordinator(store, [codex]);
    const conversationId = seed(store);

    await expect(
      coordinator.submitMessage(conversationId, messageFor(codex, "capacity_after_work"))
    ).rejects.toMatchObject({ retrySafe: false });
    const events = store.listEvents(conversationId);
    expect(events.map((event) => event.type)).toContain("user.message");
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      payload: { failureKind: "provider_capacity_exhausted", retrySafe: false }
    });
    store.close();
  });

  it("selects canonical deltas only for a genuine provider handoff", async () => {
    const store = new CanonicalStore(":memory:");
    const codex = new DeterministicProviderAdapter("codex");
    const hermesInputs: Parameters<DeterministicProviderAdapter["startTurn"]>[0][] = [];
    const hermes = new DeterministicProviderAdapter("hermes", (input) => {
      hermesInputs.push(input);
      return "ok";
    });
    const coordinator = new ConversationCoordinator(store, [codex, hermes]);
    const conversationId = seed(store);
    const initialSequence = store.getConversation(conversationId).nextSequence - 1;
    store.upsertProviderBinding({
      conversationId,
      provider: "codex",
      nativeSessionId: "native-codex-1",
      synchronizedThroughSequence: initialSequence
    });
    store.upsertProviderBinding({
      conversationId,
      provider: "hermes",
      nativeSessionId: "native-hermes-1",
      synchronizedThroughSequence: initialSequence
    });
    await coordinator.submitMessage(conversationId, {
      clientMessageId: "codex_before_handoff",
      text: "Prior Codex message",
      provider: "codex",
      effectivePolicyRevision: codex.policy.revision
    });
    await coordinator.switchProvider(conversationId, "hermes");
    await coordinator.submitMessage(conversationId, {
      clientMessageId: "hermes_after_handoff",
      text: "Continue in Hermes",
      provider: "hermes",
      effectivePolicyRevision: hermes.policy.revision
    });

    const context = (hermesInputs[0]?.context.recentEvents ?? []) as EventEnvelope[];
    expect(context.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "user.message",
        "assistant.message.completed",
        "provider.handoff.completed"
      ])
    );
    const contextTypes = context.map((event) => event.type);
    for (const operationalType of [
      "repository.checkpointed",
      "provider.policy.observed",
      "turn.started",
      "turn.completed"
    ]) {
      expect(contextTypes).not.toContain(operationalType);
    }
    expect(
      context.filter((event) => event.type === "user.message").map((event) => event.payload.text)
    ).toEqual(["Prior Codex message"]);
    store.close();
  });

  it("binds submission to the observed policy revision", async () => {
    const store = new CanonicalStore(":memory:");
    const codex = new DeterministicProviderAdapter("codex");
    const coordinator = new ConversationCoordinator(store, [codex]);
    const conversationId = seed(store);
    await expect(
      coordinator.submitMessage(conversationId, {
        clientMessageId: "message_1",
        text: "Run tests",
        provider: "codex",
        effectivePolicyRevision: `sha256:${"0".repeat(64)}`
      })
    ).rejects.toMatchObject({
      name: "PolicyRevisionConflictError",
      policy: { provider: "codex", revision: codex.policy.revision }
    });
    expect(store.listEvents(conversationId)).toHaveLength(1);
    store.close();
  });

  it("redacts provider output before persistence", async () => {
    const store = new CanonicalStore(":memory:");
    const codex = new DeterministicProviderAdapter("codex", () =>
      "Never store sk-abcdefghijklmnop in output"
    );
    const coordinator = new ConversationCoordinator(store, [codex]);
    const conversationId = seed(store);
    await coordinator.submitMessage(conversationId, {
      clientMessageId: "message_1",
      text: "Show output",
      provider: "codex",
      effectivePolicyRevision: codex.policy.revision
    });
    const serialized = JSON.stringify(store.listEvents(conversationId));
    expect(serialized).not.toContain("sk-abcdefghijklmnop");
    expect(serialized).toContain("security.redaction.applied");
    store.close();
  });

  it("switches harnesses without creating a new conversation", async () => {
    const store = new CanonicalStore(":memory:");
    const codex = new DeterministicProviderAdapter("codex");
    const hermes = new DeterministicProviderAdapter("hermes");
    const coordinator = new ConversationCoordinator(store, [codex, hermes]);
    const conversationId = seed(store);
    const events = await coordinator.switchProvider(conversationId, "hermes");
    expect(events.map((event) => event.type)).toEqual([
      "provider.handoff.started",
      "provider.handoff.completed"
    ]);
    expect(store.getConversation(conversationId).activeProvider).toBe("hermes");
    expect(store.listConversations()).toHaveLength(1);
    store.close();
  });

  it("requires an explicit handoff before a message changes harness", async () => {
    const store = new CanonicalStore(":memory:");
    const codex = new DeterministicProviderAdapter("codex");
    const claude = new DeterministicProviderAdapter("claude");
    const coordinator = new ConversationCoordinator(store, [codex, claude]);
    const conversationId = seed(store);
    await expect(
      coordinator.submitMessage(conversationId, messageFor(claude, "implicit_handoff"))
    ).rejects.toBeInstanceOf(ProviderHandoffRequiredError);
    expect(store.listWorkspaceLeases()).toEqual([]);
    store.close();
  });

  it("fails closed for missing and unavailable providers", async () => {
    const store = new CanonicalStore(":memory:");
    const unavailable = new DeterministicProviderAdapter("codex");
    unavailable.probe = async () => ({
      provider: "codex",
      available: false,
      version: null,
      detail: "missing",
      reason: "not_installed"
    });
    const conversationId = seed(store);
    const coordinator = new ConversationCoordinator(store, [unavailable]);
    await expect(
      coordinator.submitMessage(conversationId, messageFor(unavailable, "unavailable_message"))
    ).rejects.toMatchObject({
      message: "Codex cannot be used: missing",
      health: { provider: "codex", reason: "not_installed" }
    });
    await expect(coordinator.switchProvider(conversationId, "codex")).rejects.toBeInstanceOf(
      ProviderUnavailableError
    );
    await expect(coordinator.switchProvider(conversationId, "claude")).rejects.toThrow(
      /Claude Code is not configured/
    );
    store.close();
  });

  it("interrupts an active turn and blocks provider switching until it stops", async () => {
    const store = new CanonicalStore(":memory:");
    const codex = new BlockingAdapter();
    const hermes = new DeterministicProviderAdapter("hermes");
    const coordinator = new ConversationCoordinator(store, [codex, hermes]);
    const conversationId = seed(store);
    const pending = coordinator.submitMessage(conversationId, messageFor(codex, "blocking_message"));
    await waitUntil(() => store.listEvents(conversationId).some((event) => event.type === "assistant.message.started"));
    await expect(coordinator.switchProvider(conversationId, "hermes")).rejects.toThrow(
      /Interrupt the active turn/
    );
    await coordinator.interrupt(conversationId);
    await expect(pending).rejects.toThrow(/Turn interrupted/);
    expect(codex.interruptedTurns.size).toBe(1);
    await expect(coordinator.interrupt(conversationId)).rejects.toThrow(/no active turn/);
    expect(store.listEvents(conversationId).some((event) => event.type === "turn.interrupt.requested")).toBe(
      true
    );
    store.close();
  });

  it("marks failed provider output and invalid native approvals", async () => {
    const store = new CanonicalStore(":memory:");
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz01234567";
    const failed = new DeterministicProviderAdapter("codex", () => {
      throw new Error(`provider exploded with ${secret}`);
    });
    const conversationId = seed(store);
    const coordinator = new ConversationCoordinator(store, [failed]);
    await expect(
      coordinator.submitMessage(conversationId, messageFor(failed, "failed_message"))
    ).rejects.toThrow(/provider exploded with \[REDACTED:GITHUB_TOKEN\]/);
    const failureEvents = store.listEvents(conversationId);
    expect(JSON.stringify(failureEvents)).not.toContain(secret);
    const failedEvent = failureEvents.find((event) => event.type === "turn.failed");
    expect(failedEvent?.payload.reason).toContain("[REDACTED:GITHUB_TOKEN]");
    expect(failureEvents.at(-1)).toMatchObject({
      type: "security.redaction.applied",
      payload: { targetEventId: failedEvent?.id }
    });

    const invalid = new InvalidApprovalAdapter();
    const secondConversation = store.createConversation({
      projectId: store.getConversation(conversationId).projectId,
      title: "Invalid approval",
      activeProvider: "claude"
    }).id;
    const invalidCoordinator = new ConversationCoordinator(store, [invalid]);
    await expect(
      invalidCoordinator.submitMessage(secondConversation, messageFor(invalid, "invalid_approval"))
    ).rejects.toThrow(/choices/);
    expect(store.listApprovals(secondConversation)).toHaveLength(0);
    store.close();
  });

  it("records an auditable delivery failure when the provider rejects a decision", async () => {
    const store = new CanonicalStore(":memory:");
    const claude = new PendingApprovalAdapter();
    const coordinator = new ConversationCoordinator(store, [claude]);
    const conversationId = seed(store);
    store.setActiveProvider(conversationId, "claude");
    await coordinator.submitMessage(conversationId, messageFor(claude, "approval_message"));
    const approval = store.listApprovals(conversationId, "pending")[0];
    expect(approval).toBeDefined();
    // The device verifies by hashing the published bytes, so the digest has to
    // be exactly the SHA-256 of them, and they have to carry the working
    // directory the provider was given.
    const digestPayload = Buffer.from(approval?.request.approvalDigestPayload as string, "base64url");
    expect(`sha256:${createHash("sha256").update(digestPayload).digest("hex")}`).toBe(
      approval?.request.approvalDigest
    );
    const bound = JSON.parse(digestPayload.toString("utf8")) as Record<string, unknown>;
    const projectRoot = store.getProject(store.getConversation(conversationId).projectId).repoRoot;
    expect(bound).toMatchObject({ version: 1, approvalId: approval?.id, cwd: projectRoot });
    await expect(
      coordinator.deliverApprovalDecision({
        approvalId: approval?.id as string,
        choice: "allow",
        deviceId: "device_test",
        decidedAt: new Date().toISOString(),
        signature: "signature"
      })
    ).rejects.toBeInstanceOf(ApprovalDeliveryError);
    expect(store.getApproval(approval?.id as string).status).toBe("delivery_failed");
    expect(claude.interruptedTurns).toContain(approval?.turnId);
    store.close();
  });

  it("retains the lease and blocks handoff when post-turn reconciliation fails", async () => {
    const store = new CanonicalStore(":memory:");
    const codex = new DeterministicProviderAdapter("codex");
    const hermes = new DeterministicProviderAdapter("hermes");
    const workspace = new FailingFinalizeWorkspace(store);
    const coordinator = new ConversationCoordinator(store, [codex, hermes], workspace);
    const conversationId = seed(store);
    await expect(
      coordinator.submitMessage(conversationId, messageFor(codex, "reconciliation_failure"))
    ).rejects.toThrow(/checkpoint failed/);
    expect(store.listWorkspaceLeases()).toHaveLength(1);
    expect(store.listEvents(conversationId).at(-1)).toMatchObject({
      type: "turn.failed",
      payload: { workspaceReconciliationRequired: true }
    });
    await expect(coordinator.switchProvider(conversationId, "hermes")).rejects.toBeInstanceOf(
      WorkspaceUnavailableError
    );
    store.close();
  });

  it("expires an unanswered approval with the provider-native denial choice", async () => {
    const store = new CanonicalStore(":memory:");
    const claude = new ExpiringApprovalAdapter();
    const workspace = new GitWorkspaceManager(store);
    const coordinator = new ConversationCoordinator(store, [claude], workspace, {
      approvalLifetimeMs: 20
    });
    const conversationId = seed(store);
    store.setActiveProvider(conversationId, "claude");
    const result = await coordinator.submitMessage(
      conversationId,
      messageFor(claude, "expiring_approval")
    );
    expect(claude.choice).toBe("deny");
    expect(store.listApprovals(conversationId)[0]?.status).toBe("expired");
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "approval.decided",
        payload: expect.objectContaining({ outcome: "expired", choice: "deny", deviceId: null })
      })
    );
    store.close();
  });

  it("interrupts providers that exceed the aggregate per-turn event budget", async () => {
    const store = new CanonicalStore(":memory:");
    const codex = new ExcessOutputAdapter();
    const coordinator = new ConversationCoordinator(store, [codex], undefined, {
      providerEventLimit: 2,
      providerByteLimit: 1_024
    });
    const conversationId = seed(store);

    await expect(
      coordinator.submitMessage(conversationId, messageFor(codex, "provider_output_limit"))
    ).rejects.toBeInstanceOf(ProviderOutputLimitError);
    expect(codex.interruptedTurns.size).toBe(1);
    expect(store.listEvents(conversationId).at(-1)).toMatchObject({
      type: "turn.failed",
      payload: { reason: "Provider output exceeded the per-turn resource limit" }
    });
    store.close();
  });
});

class FailingFinalizeWorkspace extends GitWorkspaceManager {
  override async finalize(): Promise<never> {
    throw new Error("checkpoint failed");
  }
}

class BlockingAdapter extends DeterministicProviderAdapter {
  constructor() {
    super("codex");
  }

  override async *startTurn(input: Parameters<DeterministicProviderAdapter["startTurn"]>[0]) {
    yield { type: "assistant.message.started" as const, payload: {} };
    await new Promise<void>((resolve) => {
      input.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("Turn interrupted");
  }
}

class InvalidApprovalAdapter extends DeterministicProviderAdapter {
  constructor() {
    super("claude");
  }

  override async *startTurn() {
    yield {
      type: "approval.requested" as const,
      payload: {
        providerRequestId: "native-invalid",
        actionCommitment: `sha256:${"a".repeat(64)}`,
        choices: ["allow", "allow"]
      }
    };
  }
}

class PendingApprovalAdapter extends DeterministicProviderAdapter {
  constructor() {
    super("claude");
  }

  override async *startTurn() {
    yield {
      type: "approval.requested" as const,
      payload: {
        providerRequestId: "native-pending",
        actionCommitment: `sha256:${"b".repeat(64)}`,
        choices: ["allow", "deny"]
      }
    };
  }
}

class ExpiringApprovalAdapter extends DeterministicProviderAdapter {
  choice: string | null = null;
  private resolve: (() => void) | null = null;

  constructor() {
    super("claude");
  }

  override async *startTurn() {
    yield {
      type: "approval.requested" as const,
      payload: {
        providerRequestId: "native-expiring",
        actionCommitment: `sha256:${"c".repeat(64)}`,
        choices: ["allow", "deny"]
      }
    };
    await new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }

  override async respondToApproval(input: { choice: string }): Promise<void> {
    this.choice = input.choice;
    this.resolve?.();
  }
}

class ExhaustedAdapter extends DeterministicProviderAdapter {
  constructor() {
    super("codex");
  }

  async observeCapacity(): Promise<ProviderCapacity> {
    return testCapacity("exhausted");
  }
}

class BindThenExhaustAdapter extends DeterministicProviderAdapter {
  constructor() {
    super("codex");
  }

  async observeCapacity(): Promise<ProviderCapacity> {
    return testCapacity("available");
  }

  override async *startTurn() {
    yield {
      type: "provider.session.bound" as const,
      payload: { nativeSessionId: "native-capacity-test" }
    };
    throw new ProviderCapacityExhaustedError("codex", testCapacity("exhausted"));
  }
}

class WorkThenExhaustAdapter extends DeterministicProviderAdapter {
  constructor() {
    super("codex");
  }

  async observeCapacity(): Promise<ProviderCapacity> {
    return testCapacity("available");
  }

  override async *startTurn() {
    yield { type: "assistant.message.started" as const, payload: {} };
    throw new ProviderCapacityExhaustedError("codex", testCapacity("exhausted"));
  }
}

class ScopeProbeAdapter extends DeterministicProviderAdapter {
  probeCalls = 0;
  policyCalls = 0;

  constructor() {
    super("codex");
  }

  override async probe() {
    this.probeCalls += 1;
    return super.probe();
  }

  override async observeEffectivePolicy(cwd?: string) {
    this.policyCalls += 1;
    return super.observeEffectivePolicy(cwd);
  }
}

class ExcessOutputAdapter extends DeterministicProviderAdapter {
  constructor() {
    super("codex");
  }

  override async *startTurn() {
    for (let index = 0; index < 4; index += 1) {
      yield { type: "assistant.message.delta" as const, payload: { text: String(index) } };
    }
  }
}

function testCapacity(status: ProviderCapacity["status"]): ProviderCapacity {
  return {
    provider: "codex",
    status,
    observedAt: "2026-08-24T00:00:00.000Z",
    source: "test",
    detail: status === "exhausted" ? "Codex usage limit reached." : "Capacity available.",
    windows: [{
      id: "weekly",
      label: "Weekly",
      usedPercent: status === "exhausted" ? 100 : 20,
      remainingPercent: status === "exhausted" ? 0 : 80,
      resetsAt: "2026-08-25T00:00:00.000Z"
    }]
  };
}

function messageFor(adapter: DeterministicProviderAdapter, clientMessageId: string) {
  return {
    clientMessageId,
    text: "Test",
    provider: adapter.provider,
    effectivePolicyRevision: adapter.policy.revision
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for coordinator state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function seed(store: CanonicalStore): string {
  const project = store.createProject({
    name: "Test",
    repoRoot: mkdtempSync(join(tmpdir(), "exarch-coordinator-"))
  });
  return store.createConversation({
    projectId: project.id,
    title: "Conversation",
    activeProvider: "codex"
  }).id;
}
