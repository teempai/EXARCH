import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  MessageRequestSchema,
  approvalDigest,
  approvalDigestPayload,
  canonicalJson,
  createId,
  type EventEnvelope,
  type MessageRequest,
  type Provider,
  type ProviderCapacity
} from "../../../packages/protocol/src/index.js";
import {
  CanonicalStore,
  redactPayload
} from "../../../packages/core/src/index.js";
import {
  GitWorkspaceManager,
  type WorkspaceTurnLease
} from "./git-workspace-manager.js";
import {
  ProviderCapacityExhaustedError,
  type ProviderAdapter,
  type ProviderHealth
} from "./providers/provider-adapter.js";
import { unreportedCapacity } from "./providers/provider-capacity.js";
import type { ContextAccessManager, TurnContextAccess } from "./context-access.js";

export class PolicyRevisionConflictError extends Error {
  constructor(readonly policy: Awaited<ReturnType<ProviderAdapter["observeEffectivePolicy"]>>) {
    super("Effective laptop policy changed immediately before submission");
    this.name = "PolicyRevisionConflictError";
  }
}
export class ProviderUnavailableError extends Error {
  constructor(readonly health: ProviderHealth) {
    super(`${providerDisplayName(health.provider)} cannot be used: ${health.detail}`);
    this.name = "ProviderUnavailableError";
  }
}
export class ApprovalDeliveryError extends Error {}
export class WorkspaceUnavailableError extends Error {}
export class ProviderHandoffRequiredError extends Error {}
export class ProviderOutputLimitError extends Error {}

export interface SubmitMessageResult {
  conversationId: string;
  turnId: string;
  fromSequence: number;
  toSequence: number;
  events: EventEnvelope[];
}

export interface ConversationCoordinatorOptions {
  now?: () => Date;
  approvalLifetimeMs?: number;
  contextAccess?: ContextAccessManager;
  providerEventLimit?: number;
  providerByteLimit?: number;
}

export class ConversationCoordinator {
  private readonly adapters = new Map<Provider, ProviderAdapter>();
  private readonly activeTurns = new Map<string, { turnId: string; abort: AbortController }>();
  private readonly events = new EventEmitter();
  private readonly workspace: GitWorkspaceManager;
  private readonly now: () => Date;
  private readonly approvalLifetimeMs: number;
  private readonly contextAccess: ContextAccessManager | undefined;
  private readonly approvalTimers = new Map<string, NodeJS.Timeout>();
  private readonly providerEventLimit: number;
  private readonly providerByteLimit: number;

  constructor(
    readonly store: CanonicalStore,
    adapters: ProviderAdapter[],
    workspace = new GitWorkspaceManager(store),
    options: ConversationCoordinatorOptions = {}
  ) {
    adapters.forEach((adapter) => this.adapters.set(adapter.provider, adapter));
    this.workspace = workspace;
    this.now = options.now ?? (() => new Date());
    this.approvalLifetimeMs = options.approvalLifetimeMs ?? 5 * 60_000;
    this.contextAccess = options.contextAccess;
    this.providerEventLimit = options.providerEventLimit ?? 50_000;
    this.providerByteLimit = options.providerByteLimit ?? 64 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.approvalLifetimeMs) ||
      this.approvalLifetimeMs < 10 ||
      this.approvalLifetimeMs > 10 * 60_000
    ) {
      throw new Error("Approval lifetime is outside the allowed range");
    }
    if (!Number.isSafeInteger(this.providerEventLimit) || this.providerEventLimit < 1) {
      throw new Error("Provider event limit is invalid");
    }
    if (!Number.isSafeInteger(this.providerByteLimit) || this.providerByteLimit < 1) {
      throw new Error("Provider byte limit is invalid");
    }
    this.events.setMaxListeners(100);
  }

  async providers() {
    return Promise.all(
      [...this.adapters.values()].map((adapter) => this.providerSnapshot(adapter))
    );
  }

  async provider(provider: Provider, conversationId?: string) {
    const adapter = this.requireAdapter(provider);
    const cwd = conversationId === undefined
      ? undefined
      : this.executionCwd(conversationId);
    return this.providerSnapshot(adapter, cwd);
  }

  private executionCwd(conversationId: string): string {
    const conversation = this.store.getConversation(conversationId);
    return this.store.assertProjectExecutionScope(conversation.projectId);
  }

  private async providerSnapshot(adapter: ProviderAdapter, cwd?: string) {
    const [health, policy, models, capacity] = await Promise.all([
      adapter.probe(),
      adapter.observeEffectivePolicy(cwd),
      adapter.listModels?.().catch(() => []) ?? Promise.resolve([]),
      this.observeCapacity(adapter)
    ]);
    return { health, policy, models, capacity };
  }

  private async observeCapacity(adapter: ProviderAdapter): Promise<ProviderCapacity> {
    return adapter.observeCapacity?.().catch(() => unreportedCapacity(adapter.provider))
      ?? unreportedCapacity(adapter.provider);
  }

  async changes(conversationId: string) {
    const conversation = this.store.getConversation(conversationId);
    const project = this.store.getProject(conversation.projectId);
    const cwd = this.store.assertProjectExecutionScope(project.id);
    return this.workspace.readChanges(cwd, undefined, project.allowedPaths);
  }

  async submitMessage(
    conversationId: string,
    rawMessage: unknown
  ): Promise<SubmitMessageResult> {
    const message = MessageRequestSchema.parse(rawMessage);
    const adapter = this.requireAdapter(message.provider);
    const conversation = this.store.getConversation(conversationId);
    if (conversation.activeProvider !== message.provider) {
      throw new ProviderHandoffRequiredError(
        `Switch the conversation to ${message.provider} before submitting`
      );
    }
    const project = this.store.getProject(conversation.projectId);
    // Scope admission precedes provider probing, policy observation, session
    // binding, Git inspection, and process launch. History-created
    // conversations therefore remain readable but cannot cause any provider to
    // consume their recorded cwd before a laptop-local enrollment.
    const providerCwd = this.store.assertProjectExecutionScope(project.id);
    const binding = this.store.getProviderBinding(conversationId, message.provider);
    if (binding?.nativeSessionId !== null && binding?.nativeSessionId !== undefined) {
      adapter.bindSession?.(
        conversationId,
        binding.nativeSessionId,
        binding.metadata,
        binding.synchronizedThroughSequence
      );
    }
    const health = await adapter.probe();
    if (!health.available) throw new ProviderUnavailableError(health);
    const policy = await adapter.observeEffectivePolicy(project.repoRoot);
    if (policy.revision !== message.effectivePolicyRevision) {
      throw new PolicyRevisionConflictError(policy);
    }
    if (this.activeTurns.has(conversationId)) {
      throw new Error("Conversation already has an active turn");
    }

    const requestHash = `sha256:${createHash("sha256").update(canonicalJson(message)).digest("hex")}`;
    const scope = `conversation:${conversationId}:message`;
    const prior = this.store.getIdempotentResponse(scope, message.clientMessageId, requestHash);
    if (prior !== null) return prior as SubmitMessageResult;

    const capacity = await this.observeCapacity(adapter);
    if (capacity.status === "exhausted") {
      throw new ProviderCapacityExhaustedError(message.provider, capacity, true);
    }

    const turnId = createId("turn");
    const fromSequence = conversation.nextSequence;
    const abort = new AbortController();
    let workspaceTurn: WorkspaceTurnLease;
    try {
      workspaceTurn = await this.workspace.acquire({
        projectId: project.id,
        worktreePath: project.repoRoot,
        conversationId,
        turnId,
        provider: message.provider,
        allowedPaths: project.allowedPaths
      });
    } catch (error) {
      throw new WorkspaceUnavailableError(
        error instanceof Error ? error.message : "Workspace lease could not be acquired"
      );
    }
    this.activeTurns.set(conversationId, { turnId, abort });
    const providerContextEvents = selectProviderContextEvents(
      this.store.listRecentEvents(conversationId, { limit: 100, activeImportsOnly: true }),
      binding?.synchronizedThroughSequence ?? 0
    );
    let workspaceReleased = false;
    let turnContext: TurnContextAccess | undefined;
    let userMessageAppended = false;
    const appendUserMessage = () => {
      if (userMessageAppended) return;
      this.append({
        conversationId,
        turnId,
        type: "user.message",
        provider: message.provider,
        payload: {
          text: message.text,
          clientMessageId: message.clientMessageId,
          ...(message.model == null ? {} : { model: message.model })
        }
      });
      userMessageAppended = true;
    };
    const heartbeat = setInterval(() => {
      try {
        this.workspace.heartbeat(workspaceTurn.lease.id, turnId);
      } catch {
        abort.abort();
      }
    }, 30_000);
    heartbeat.unref?.();

    try {
      this.store.startTurn({ id: turnId, conversationId, provider: message.provider });
      this.append({
        conversationId,
        turnId,
        type: "repository.checkpointed",
        provider: message.provider,
        payload: { ...workspaceTurn.checkpoint }
      });
      if (providerContextEvents.length > 0) {
        turnContext = await this.contextAccess?.create({
          projectId: project.id,
          conversationId,
          turnId
        });
      }
      this.append({
        conversationId,
        turnId,
        type: "provider.policy.observed",
        provider: message.provider,
        payload: policy
      });
      this.append({
        conversationId,
        turnId,
        type: "turn.started",
        provider: message.provider,
        payload: { clientMessageId: message.clientMessageId }
      });
      let providerEventCount = 0;
      let providerBytes = 0;
      for await (const providerEvent of adapter.startTurn({
        conversationId,
        turnId,
        text: message.text,
        ...(message.model == null ? {} : { model: message.model }),
        cwd: providerCwd,
        context: {
          recentEvents: providerContextEvents,
          synchronizedThroughSequence: binding?.synchronizedThroughSequence ?? 0,
          ...(turnContext === undefined ? {} : { cliCommand: turnContext.command })
        },
        signal: abort.signal
      })) {
        providerEventCount += 1;
        providerBytes += Buffer.byteLength(canonicalJson(providerEvent), "utf8");
        if (providerEventCount > this.providerEventLimit || providerBytes > this.providerByteLimit) {
          await adapter.interruptTurn(turnId);
          throw new ProviderOutputLimitError("Provider output exceeded the per-turn resource limit");
        }
        // A provider can bind a native session before it accepts the turn.
        // Delay the canonical user message until actual provider activity so a
        // capacity rejection can be switched and retried without duplication.
        if (providerEvent.type !== "provider.session.bound") appendUserMessage();
        const redaction = redactPayload(providerEvent.payload);
        if (providerEvent.type === "approval.requested") {
          const payload = redaction.value;
          const providerRequestId = requiredProviderRequestId(payload.providerRequestId);
          const actionCommitment = requiredActionCommitment(payload.actionCommitment);
          const choices = requiredApprovalChoices(payload.choices);
          const approvalId = createId("approval");
          const expiresAt = new Date(this.now().getTime() + this.approvalLifetimeMs).toISOString();
          const request = { ...payload, providerRequestId, actionCommitment, choices };
          const digestInput = {
            approvalId,
            conversationId,
            turnId,
            provider: message.provider,
            providerRequestId,
            cwd: project.repoRoot,
            request,
            choices,
            expiresAt
          };
          const digest = approvalDigest(digestInput);
          // The device verifies by hashing these bytes and then checking the
          // fields inside them against what it displayed, so it never has to
          // reproduce this encoding to know what it is agreeing to.
          const digestPayload = approvalDigestPayload(digestInput).toString("base64url");
          this.store.createApproval({
            id: approvalId,
            conversationId,
            turnId,
            provider: message.provider,
            request: { ...request, approvalDigest: digest, approvalDigestPayload: digestPayload },
            expiresAt
          });
          this.scheduleApprovalExpiry({
            approvalId,
            turnId,
            provider: message.provider,
            providerRequestId,
            actionCommitment,
            choices,
            expiresAt,
            conversationId
          });
          const stored = this.append({
            conversationId,
            turnId,
            type: "approval.requested",
            provider: message.provider,
            payload: {
              approvalId,
              approvalDigest: digest,
              approvalDigestPayload: digestPayload,
              providerRequestId,
              cwd: project.repoRoot,
              choices,
              expiresAt,
              request
            }
          });
          if (redaction.redacted) {
            this.append({
              conversationId,
              turnId,
              type: "security.redaction.applied",
              provider: message.provider,
              payload: { targetEventId: stored.id, markers: redaction.markers }
            });
          }
          continue;
        }
        const stored = this.append({
          conversationId,
          turnId,
          type: providerEvent.type,
          provider: message.provider,
          payload: redaction.value
        });
        if (providerEvent.type === "provider.session.bound") {
          const nativeSessionId = redaction.value.nativeSessionId;
          if (typeof nativeSessionId === "string") {
            this.store.upsertProviderBinding({
              conversationId,
              provider: message.provider,
              nativeSessionId,
              synchronizedThroughSequence: stored.sequence,
              metadata: redaction.value
            });
          }
        }
        if (redaction.redacted) {
          this.append({
            conversationId,
            turnId,
            type: "security.redaction.applied",
            provider: message.provider,
            payload: { targetEventId: stored.id, markers: redaction.markers }
          });
        }
      }
      appendUserMessage();
      const afterCheckpoint = await this.workspace.finalize(workspaceTurn.lease.id, turnId);
      workspaceReleased = true;
      this.append({
        conversationId,
        turnId,
        type: "repository.checkpointed",
        provider: message.provider,
        payload: { ...afterCheckpoint }
      });
      this.append({
        conversationId,
        turnId,
        type: "turn.completed",
        provider: message.provider,
        payload: {}
      });
      this.store.finishTurn(turnId, "completed");
      const completedBinding = this.store.getProviderBinding(conversationId, message.provider);
      if (completedBinding !== null) {
        this.store.upsertProviderBinding({
          conversationId,
          provider: message.provider,
          nativeSessionId: completedBinding.nativeSessionId,
          synchronizedThroughSequence: this.store.getConversation(conversationId).nextSequence - 1,
          status: completedBinding.status,
          metadata: completedBinding.metadata
        });
      }
      const events = this.store.listEvents(conversationId, { after: fromSequence - 1, limit: 500 });
      const result = {
        conversationId,
        turnId,
        fromSequence,
        toSequence: events.at(-1)?.sequence ?? fromSequence,
        events
      };
      this.store.putIdempotentResponse({
        scope,
        key: message.clientMessageId,
        requestHash,
        response: result
      });
      return result;
    } catch (error) {
      const capacityError = error instanceof ProviderCapacityExhaustedError ? error : null;
      let reconciliationRequired = false;
      if (!workspaceReleased) {
        try {
          const afterCheckpoint = await this.workspace.finalize(workspaceTurn.lease.id, turnId);
          workspaceReleased = true;
          this.append({
            conversationId,
            turnId,
            type: "repository.checkpointed",
            provider: message.provider,
            payload: { ...afterCheckpoint }
          });
        } catch {
          reconciliationRequired = true;
        }
      }
      const failureRedaction = redactPayload({
        reason: error instanceof Error ? error.message : "Provider failure",
        workspaceReconciliationRequired: reconciliationRequired,
        ...(capacityError === null
          ? {}
          : {
              failureKind: "provider_capacity_exhausted",
              retrySafe: !userMessageAppended,
              capacity: capacityError.capacity
            })
      });
      const failedEvent = this.append({
        conversationId,
        turnId,
        type: "turn.failed",
        provider: message.provider,
        payload: failureRedaction.value
      });
      if (failureRedaction.redacted) {
        this.append({
          conversationId,
          turnId,
          type: "security.redaction.applied",
          provider: message.provider,
          payload: { targetEventId: failedEvent.id, markers: failureRedaction.markers }
        });
      }
      this.store.finishTurn(turnId, abort.signal.aborted ? "interrupted" : "failed");
      if (capacityError !== null) {
        const capacity = failureRedaction.value.capacity as ProviderCapacity;
        throw new ProviderCapacityExhaustedError(
          capacityError.provider,
          capacity,
          !userMessageAppended
        );
      }
      if (failureRedaction.redacted) {
        throw new Error(String(failureRedaction.value.reason ?? "Provider failure"));
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      this.activeTurns.delete(conversationId);
      try {
        await turnContext?.dispose();
      } catch {
        this.store.writeAudit("context.capability_cleanup", turnId, "failed", { conversationId });
      }
    }
  }

  async switchProvider(conversationId: string, target: Provider): Promise<EventEnvelope[]> {
    if (this.activeTurns.has(conversationId)) {
      throw new Error("Interrupt the active turn before switching providers");
    }
    const adapter = this.requireAdapter(target);
    const health = await adapter.probe();
    if (!health.available) throw new ProviderUnavailableError(health);
    const conversation = this.store.getConversation(conversationId);
    const project = this.store.getProject(conversation.projectId);
    if (this.store.listWorkspaceLeases().some((lease) => lease.projectId === project.id)) {
      throw new WorkspaceUnavailableError("Workspace has an unresolved lease");
    }
    const started = this.append({
      conversationId,
      type: "provider.handoff.started",
      provider: target,
      payload: { source: conversation.activeProvider, target }
    });
    const policy = await adapter.observeEffectivePolicy(project.repoRoot);
    this.append({
      conversationId,
      type: "provider.policy.observed",
      provider: target,
      payload: policy
    });
    this.store.setActiveProvider(conversationId, target);
    const completed = this.append({
      conversationId,
      type: "provider.handoff.completed",
      provider: target,
      payload: { source: conversation.activeProvider, target, policyRevision: policy.revision }
    });
    return [started, completed];
  }

  async interrupt(conversationId: string): Promise<void> {
    const active = this.activeTurns.get(conversationId);
    if (active === undefined) throw new Error("Conversation has no active turn");
    active.abort.abort();
    const conversation = this.store.getConversation(conversationId);
    if (conversation.activeProvider !== null) {
      await this.requireAdapter(conversation.activeProvider).interruptTurn(active.turnId);
    }
    this.append({
      conversationId,
      turnId: active.turnId,
      type: "turn.interrupt.requested",
      provider: conversation.activeProvider,
      payload: {}
    });
  }

  async deliverApprovalDecision(input: {
    approvalId: string;
    choice: string;
    deviceId: string;
    decidedAt: string;
    signature: string;
  }) {
    const approval = this.store.getApproval(input.approvalId);
    const providerRequestId = requiredProviderRequestId(approval.request.providerRequestId);
    const actionCommitment = requiredActionCommitment(approval.request.actionCommitment);
    const adapter = this.requireAdapter(approval.provider);
    const decided = this.store.recordApprovalDecision(input);
    const timer = this.approvalTimers.get(input.approvalId);
    if (timer !== undefined) clearTimeout(timer);
    this.approvalTimers.delete(input.approvalId);
    try {
      await adapter.respondToApproval({
        turnId: approval.turnId,
        requestId: providerRequestId,
        actionCommitment,
        choice: input.choice
      });
    } catch (error) {
      this.store.markApprovalDeliveryFailed(approval.id);
      // A recorded decision that the provider could not accept must not leave
      // its native turn waiting forever. The decision remains auditable as a
      // delivery failure and the provider turn is stopped best-effort.
      try {
        await adapter.interruptTurn(approval.turnId);
      } catch {
        // The original delivery error is the actionable failure returned to
        // the client; interruption remains best-effort and audit state is kept.
      }
      throw new ApprovalDeliveryError(
        error instanceof Error ? error.message : "Provider rejected approval delivery"
      );
    }
    this.append({
      conversationId: approval.conversationId,
      turnId: approval.turnId,
      type: "approval.decided",
      provider: approval.provider,
      payload: {
        approvalId: approval.id,
        choice: input.choice,
        deviceId: input.deviceId,
        decidedAt: input.decidedAt
      }
    });
    return decided;
  }

  subscribe(conversationId: string, listener: (event: EventEnvelope) => void): () => void {
    const eventName = `conversation:${conversationId}`;
    this.events.on(eventName, listener);
    return () => this.events.off(eventName, listener);
  }

  private append(input: Parameters<CanonicalStore["appendEvent"]>[0]): EventEnvelope {
    const event = this.store.appendEvent(input);
    this.events.emit(`conversation:${event.conversationId}`, event);
    return event;
  }

  private requireAdapter(provider: Provider): ProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (adapter === undefined) {
      throw new ProviderUnavailableError({
        provider,
        available: false,
        version: null,
        detail: `${providerDisplayName(provider)} is not configured in the EXARCH service.`,
        reason: "not_configured"
      });
    }
    return adapter;
  }

  private scheduleApprovalExpiry(input: {
    approvalId: string;
    conversationId: string;
    turnId: string;
    provider: Provider;
    providerRequestId: string;
    actionCommitment: string;
    choices: string[];
    expiresAt: string;
  }): void {
    const delay = Math.max(0, Date.parse(input.expiresAt) - this.now().getTime());
    const timer = setTimeout(() => {
      this.approvalTimers.delete(input.approvalId);
      void this.expireApproval(input);
    }, delay);
    timer.unref?.();
    this.approvalTimers.set(input.approvalId, timer);
  }

  private async expireApproval(input: {
    approvalId: string;
    conversationId: string;
    turnId: string;
    provider: Provider;
    providerRequestId: string;
    actionCommitment: string;
    choices: string[];
  }): Promise<void> {
    const approval = this.store.expireApproval(input.approvalId);
    if (approval.status !== "expired") return;
    let choice: string | null = null;
    try {
      choice = denialChoice(input.choices);
    } catch (error) {
      this.store.writeAudit("approval.expiry_choice_missing", input.approvalId, "failed", {
        reason: error instanceof Error ? error.message : "Provider has no denial choice"
      });
    }
    this.append({
      conversationId: input.conversationId,
      turnId: input.turnId,
      type: "approval.decided",
      provider: input.provider,
      payload: { approvalId: input.approvalId, choice, outcome: "expired", deviceId: null }
    });
    try {
      const adapter = this.requireAdapter(input.provider);
      if (choice === null) await adapter.interruptTurn(input.turnId);
      else {
        await adapter.respondToApproval({
          turnId: input.turnId,
          requestId: input.providerRequestId,
          actionCommitment: input.actionCommitment,
          choice
        });
      }
    } catch (error) {
      this.store.writeAudit("approval.expiry_delivery_failed", input.approvalId, "failed", {
        reason: error instanceof Error ? error.message : "Provider expiry delivery failed"
      });
    }
  }
}

function providerDisplayName(provider: Provider): string {
  if (provider === "claude") return "Claude Code";
  if (provider === "hermes") return "Hermes";
  return "Codex";
}

const PROVIDER_CONTEXT_EVENT_TYPES = new Set<EventEnvelope["type"]>([
  "user.message",
  "assistant.message.completed",
  "tool.completed",
  "tool.failed",
  "file.changed",
  "artifact.created",
  "context.snapshot.created",
  "context.decision.recorded",
  "context.task.changed",
  "provider.handoff.completed"
]);

function selectProviderContextEvents(
  events: EventEnvelope[],
  synchronizedThroughSequence: number
): EventEnvelope[] {
  return events.filter(
    (event) =>
      event.sequence > synchronizedThroughSequence &&
      PROVIDER_CONTEXT_EVENT_TYPES.has(event.type)
  );
}

function requiredProviderRequestId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) {
    throw new Error("Provider approval request is missing a bounded request ID");
  }
  return value;
}

function requiredActionCommitment(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error("Provider approval request is missing its action commitment");
  }
  return value;
}

function requiredApprovalChoices(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) {
    throw new Error("Provider approval request has no bounded choices");
  }
  const choices = value.filter((choice): choice is string => typeof choice === "string");
  if (choices.length !== value.length || new Set(choices).size !== choices.length) {
    throw new Error("Provider approval choices are invalid");
  }
  return choices;
}

function denialChoice(choices: string[]): string {
  for (const candidate of ["deny", "decline", "cancel"]) {
    if (choices.includes(candidate)) return candidate;
  }
  throw new Error("Provider approval has no one-shot denial choice");
}
