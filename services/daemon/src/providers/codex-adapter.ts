import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  canonicalJson,
  type EffectivePolicy,
  type ProviderCapacity,
  type ProviderCapacityWindow
} from "../../../../packages/protocol/src/index.js";
import { AsyncQueue } from "../process/async-queue.js";
import { JsonLineRpcClient, type RpcNotification, type RpcServerRequest } from "../process/json-line-rpc.js";
import { ManagedLineProcess } from "../process/managed-line-process.js";
import { readCodexHistory, streamCodexHistory } from "../history/codex-history.js";
import type { HistoryReader, NativeHistoryThread } from "../history/types.js";
import {
  ProviderCapacityExhaustedError,
  PROVIDER_EVENT_BUFFER_BYTES,
  PROVIDER_EVENT_BUFFER_ITEMS,
  PROVIDER_PENDING_APPROVAL_LIMIT,
  providerApprovalActionCommitment,
  providerApprovalHandle,
  providerEventSize,
  providerProbeFailure,
  type NormalizedProviderEvent,
  type ProviderAdapter,
  type ProviderApprovalDecisionInput,
  type ProviderHealth,
  type ProviderModel,
  type ProviderTurnInput
} from "./provider-adapter.js";
import {
  capacityStatus,
  capacityWindow,
  exhaustedCapacity,
  isCapacityExhaustionMessage,
  unreportedCapacity
} from "./provider-capacity.js";
import { buildProviderPrompt } from "./provider-prompt.js";

const execFileAsync = promisify(execFile);
const CURRENT_PROTOCOL_VERSION = "0.150.0-alpha.12.2";
const SUPPORTED_VERSIONS = new Set(["0.149.0-alpha.4.1", CURRENT_PROTOCOL_VERSION]);
// Codex app-server returns a complete thread/read result as one JSONL frame.
// Keep this bounded, but large enough for long local sessions; history sync
// consumes these frames one thread at a time rather than retaining the archive.
const CODEX_MAX_LINE_BYTES = 256 * 1024 * 1024;

interface CodexAdapterOptions {
  executable?: string;
  executableArgsPrefix?: string[];
  defaultCwd?: string;
  env?: NodeJS.ProcessEnv;
  rpcFactory?: (cwd: string) => JsonLineRpcClient;
}

interface ThreadStartResult {
  thread: { id: string };
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  sandbox?: unknown;
  model?: unknown;
  modelProvider?: unknown;
}

interface TurnStartResult {
  turn: { id: string };
}

interface ConfigReadResult {
  config?: Record<string, unknown>;
  origins?: Record<string, unknown>;
  layers?: unknown;
}

interface ModelListResult {
  data?: unknown[];
}

interface RateLimitsResult {
  rateLimits?: unknown;
  rateLimitsByLimitId?: unknown;
}

interface ActiveNativeTurn {
  canonicalTurnId: string;
  nativeThreadId: string;
  nativeTurnId: string;
}

interface PendingCodexApproval {
  id: string | number;
  canonicalTurnId: string;
  method: string;
  params: Record<string, unknown>;
  choices: string[];
  actionCommitment: string;
}

interface NativeThreadBinding {
  id: string;
  synchronizedThroughSequence: number;
}

export class CodexAdapter implements ProviderAdapter, HistoryReader {
  readonly provider = "codex" as const;
  private readonly executable: string;
  private readonly executableArgsPrefix: string[];
  private readonly defaultCwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private detectedProtocolVersion: string | null = null;
  private rpc: JsonLineRpcClient | null = null;
  private initializePromise: Promise<JsonLineRpcClient> | null = null;
  private readonly threads = new Map<string, NativeThreadBinding>();
  private readonly loadedThreads = new Set<string>();
  private readonly turns = new Map<string, ActiveNativeTurn>();
  private readonly approvals = new Map<string, PendingCodexApproval>();
  private latestCapacity: ProviderCapacity = unreportedCapacity(
    "codex",
    "Codex subscription capacity has not been read yet."
  );

  constructor(private readonly options: CodexAdapterOptions = {}) {
    this.executable = options.executable ?? firstExisting([
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      join(homedir(), ".local", "bin", "codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex"
    ]) ?? "codex";
    this.executableArgsPrefix = options.executableArgsPrefix ?? [];
    this.defaultCwd = options.defaultCwd ?? process.cwd();
    this.env = options.env ?? process.env;
  }

  async probe(): Promise<ProviderHealth> {
    try {
      const { stdout } = await execFileAsync(this.executable, [...this.executableArgsPrefix, "--version"], {
        cwd: this.defaultCwd,
        env: this.env,
        timeout: 5_000,
        maxBuffer: 64 * 1024
      });
      const match = stdout.match(/codex-cli\s+([^\s]+)/);
      const version = match?.[1] ?? null;
      const supported = version !== null && SUPPORTED_VERSIONS.has(version);
      this.detectedProtocolVersion = supported ? version : null;
      return {
        provider: this.provider,
        available: supported,
        version,
        reason: supported ? "ready" : "unsupported_version",
        detail:
          supported
            ? "ready (verified app-server protocol version)"
            : `unsupported Codex version ${version ?? "(unrecognized)"}; EXARCH supports ${[...SUPPORTED_VERSIONS].join(" or ")}`
      };
    } catch (error) {
      return providerProbeFailure(this.provider, "Codex", error);
    }
  }

  async observeEffectivePolicy(cwd = this.defaultCwd): Promise<EffectivePolicy> {
    try {
      const rpc = await this.ensureRpc(cwd);
      const result = await rpc.request<ConfigReadResult>("config/read", { cwd, includeLayers: true });
      const config = result.config ?? {};
      const native = {
        approval_policy: config.approval_policy ?? null,
        approvals_reviewer: config.approvals_reviewer ?? null,
        sandbox_mode: config.sandbox_mode ?? null,
        default_permissions: config.default_permissions ?? null,
        model: config.model ?? null,
        model_provider: config.model_provider ?? null,
        origins: selectOrigins(result.origins ?? {}, [
          "approval_policy",
          "approvals_reviewer",
          "sandbox_mode",
          "default_permissions"
        ])
      };
      const complete =
        typeof native.approval_policy === "string" &&
        typeof native.approvals_reviewer === "string" &&
        typeof native.sandbox_mode === "string";
      return policyFromNative(native, complete ? "verified" : "partial");
    } catch (error) {
      const native = { error: error instanceof Error ? error.message : "policy observation failed" };
      return policyFromNative(native, "unavailable");
    }
  }

  async listModels(): Promise<ProviderModel[]> {
    const rpc = await this.ensureRpc(this.defaultCwd);
    const result = await rpc.request<ModelListResult>("model/list", {});
    const data = Array.isArray(result.data) ? result.data.slice(0, 100) : [];
    return data.flatMap((value) => {
      if (!isRecord(value) || value.hidden === true) return [];
      const id = typeof value.model === "string"
        ? value.model
        : typeof value.id === "string" ? value.id : null;
      if (id === null || id.length === 0 || id.length > 200) return [];
      return [{
        id,
        displayName:
          typeof value.displayName === "string" && value.displayName.length <= 200
            ? value.displayName
            : id,
        description:
          typeof value.description === "string" && value.description.length <= 500
            ? value.description
            : null
      }];
    });
  }

  async observeCapacity(): Promise<ProviderCapacity> {
    try {
      const rpc = await this.ensureRpc(this.defaultCwd);
      const result = await rpc.request<RateLimitsResult>("account/rateLimits/read", {});
      this.latestCapacity = codexCapacity(result);
    } catch {
      // Capacity is advisory. A protocol/auth failure must not make an
      // otherwise healthy harness unavailable or erase a prior observation.
    }
    return this.latestCapacity;
  }

  async readHistory(): Promise<NativeHistoryThread[]> {
    return readCodexHistory(await this.ensureRpc(this.defaultCwd), this.defaultCwd);
  }

  async *streamHistory(): AsyncIterable<NativeHistoryThread> {
    yield* streamCodexHistory(await this.ensureRpc(this.defaultCwd), this.defaultCwd);
  }

  bindSession(
    conversationId: string,
    nativeSessionId: string,
    _metadata: Record<string, unknown>,
    synchronizedThroughSequence: number
  ): void {
    this.threads.set(conversationId, { id: nativeSessionId, synchronizedThroughSequence });
  }

  async *startTurn(input: ProviderTurnInput): AsyncIterable<NormalizedProviderEvent> {
    const rpc = await this.ensureRpc(input.cwd);
    let binding = this.threads.get(input.conversationId);
    if (binding === undefined) {
      const started = await rpc.request<ThreadStartResult>("thread/start", { cwd: input.cwd });
      binding = { id: started.thread.id, synchronizedThroughSequence: 0 };
      this.threads.set(input.conversationId, binding);
      this.loadedThreads.add(binding.id);
      yield {
        type: "provider.session.bound",
        payload: {
          nativeSessionId: binding.id,
          protocolVersion: this.detectedProtocolVersion ?? CURRENT_PROTOCOL_VERSION
        }
      };
    } else if (!this.loadedThreads.has(binding.id)) {
      await rpc.request("thread/resume", { threadId: binding.id, cwd: input.cwd });
      this.loadedThreads.add(binding.id);
    }
    const nativeThreadId = binding.id;

    const queue = new AsyncQueue<NormalizedProviderEvent>({
      maxItems: PROVIDER_EVENT_BUFFER_ITEMS,
      maxBytes: PROVIDER_EVENT_BUFFER_BYTES,
      sizeOf: providerEventSize
    });
    let assistantStarted = false;
    let nativeTurnId: string | null = null;
    const offNotification = rpc.onNotification((notification) => {
      if (belongsToTurn(notification.params, nativeThreadId, nativeTurnId)) {
        mapNotification(notification, queue, () => this.latestCapacity, () => {
          if (assistantStarted) return false;
          assistantStarted = true;
          return true;
        });
      }
    });
    const offRequest = rpc.onServerRequest((request) => {
      if (!belongsToTurn(request.params, nativeThreadId, nativeTurnId)) return;
      this.mapApprovalRequest(request, input, queue);
    });
    const abort = () => void this.interruptTurn(input.turnId);
    input.signal.addEventListener("abort", abort, { once: true });

    try {
      const started = await rpc.request<TurnStartResult>("turn/start", {
        threadId: nativeThreadId,
        input: [{ type: "text", text: providerPrompt(input) }],
        ...(input.model === undefined ? {} : { model: input.model })
      });
      nativeTurnId = started.turn.id;
      this.turns.set(input.turnId, {
        canonicalTurnId: input.turnId,
        nativeThreadId,
        nativeTurnId
      });
      if (input.signal.aborted) await this.interruptTurn(input.turnId);
      const newest = input.context.recentEvents
        .flatMap((event) => (isRecord(event) && typeof event.sequence === "number" ? [event.sequence] : []))
        .at(-1);
      if (newest !== undefined) binding.synchronizedThroughSequence = newest;
      for await (const event of queue) yield event;
    } finally {
      offNotification();
      offRequest();
      input.signal.removeEventListener("abort", abort);
      this.turns.delete(input.turnId);
      for (const [requestId, approval] of this.approvals) {
        if (approval.canonicalTurnId === input.turnId) this.approvals.delete(requestId);
      }
    }
  }

  async interruptTurn(turnId: string): Promise<void> {
    const turn = this.turns.get(turnId);
    if (turn === undefined || this.rpc === null) return;
    await this.rpc.request("turn/interrupt", {
      threadId: turn.nativeThreadId,
      turnId: turn.nativeTurnId
    });
  }

  async respondToApproval(input: ProviderApprovalDecisionInput): Promise<void> {
    const pending = this.approvals.get(input.requestId);
    if (pending === undefined || this.rpc === null) throw new Error("Codex approval is not pending");
    if (pending.canonicalTurnId !== input.turnId) throw new Error("Approval turn mismatch");
    if (!pending.choices.includes(input.choice)) throw new Error("Approval choice is not offered");
    const actionCommitment = providerApprovalActionCommitment(codexApprovalAction(pending));
    if (input.actionCommitment !== pending.actionCommitment || input.actionCommitment !== actionCommitment) {
      throw new Error("Codex approval action commitment mismatch");
    }
    this.approvals.delete(input.requestId);
    if (pending.method === "item/permissions/requestApproval") {
      if (input.choice === "accept") {
        await this.rpc.respond(pending.id, { permissions: pending.params.permissions ?? {}, scope: "turn" });
      } else {
        await this.rpc.respondError(pending.id, -32001, "Permission request denied by user");
      }
    } else {
      await this.rpc.respond(pending.id, { decision: input.choice });
    }
  }

  async close(): Promise<void> {
    const rpc = this.rpc;
    this.rpc = null;
    this.initializePromise = null;
    if (rpc !== null) await rpc.process.terminate();
  }

  private mapApprovalRequest(
    request: RpcServerRequest,
    input: ProviderTurnInput,
    queue: AsyncQueue<NormalizedProviderEvent>
  ): void {
    const kind = codexApprovalKind(request.method);
    if (kind === null) return;
    const choices = ["accept", "decline", "cancel"];
    if ([...this.approvals.values()].some((approval) => approval.id === request.id)) {
      queue.fail(new Error("Duplicate Codex approval request ID"));
      return;
    }
    const requestId = providerApprovalHandle({
      provider: this.provider,
      turnId: input.turnId,
      nativeRequestId: { type: typeof request.id, value: request.id }
    });
    if (this.approvals.size >= PROVIDER_PENDING_APPROVAL_LIMIT) {
      queue.fail(new Error("Codex pending approval limit exceeded"));
      return;
    }
    const pending: PendingCodexApproval = {
      id: request.id,
      canonicalTurnId: input.turnId,
      method: request.method,
      params: isRecord(request.params) ? request.params : {},
      choices,
      actionCommitment: ""
    };
    pending.actionCommitment = providerApprovalActionCommitment(codexApprovalAction(pending));
    this.approvals.set(requestId, pending);
    queue.push({
      type: "approval.requested",
      payload: {
        providerRequestId: requestId,
        kind,
        nativeMethod: request.method,
        actionCommitment: pending.actionCommitment,
        choices,
        request: request.params,
        canonicalTurnId: input.turnId
      }
    });
  }

  private ensureRpc(cwd: string): Promise<JsonLineRpcClient> {
    if (this.rpc !== null) return Promise.resolve(this.rpc);
    if (this.initializePromise !== null) return this.initializePromise;
    this.initializePromise = (async () => {
      const rpc =
        this.options.rpcFactory?.(cwd) ??
        new JsonLineRpcClient(
          new ManagedLineProcess({
            executable: this.executable,
            args: [...this.executableArgsPrefix, "app-server", "--listen", "stdio://"],
            cwd,
            env: this.env,
            maxLineBytes: CODEX_MAX_LINE_BYTES
          })
        );
      await rpc.start();
      await rpc.request("initialize", {
        clientInfo: { name: "exarch", version: "0.1.0" },
        capabilities: { experimentalApi: false }
      });
      await rpc.notify("initialized", {});
      rpc.onNotification((notification) => {
        if (notification.method === "account/rateLimits/updated" && isRecord(notification.params)) {
          this.latestCapacity = codexCapacity({
            rateLimits: notification.params.rateLimits,
            rateLimitsByLimitId: notification.params.rateLimitsByLimitId
          });
        }
      });
      this.rpc = rpc;
      return rpc;
    })();
    return this.initializePromise.catch((error: unknown) => {
      this.initializePromise = null;
      throw error;
    });
  }
}

function codexApprovalAction(pending: PendingCodexApproval): Record<string, unknown> {
  return {
    provider: "codex",
    turnId: pending.canonicalTurnId,
    nativeRequestId: { type: typeof pending.id, value: pending.id },
    method: pending.method,
    params: pending.params,
    choices: pending.choices
  };
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path));
}

function policyFromNative(
  native: Record<string, unknown>,
  status: EffectivePolicy["status"]
): EffectivePolicy {
  const revision = `sha256:${createHash("sha256").update(canonicalJson(native)).digest("hex")}`;
  return {
    provider: "codex",
    status,
    revision,
    observedAt: new Date().toISOString(),
    source: `codex app-server config/read (${CURRENT_PROTOCOL_VERSION})`,
    native,
    normalized: {
      mayExecuteWithoutPrompt:
        native.approval_policy === "never"
          ? true
          : typeof native.approval_policy === "string"
            ? false
            : null,
      sandbox: typeof native.sandbox_mode === "string" ? native.sandbox_mode : null,
      reviewer: typeof native.approvals_reviewer === "string" ? native.approvals_reviewer : null
    }
  };
}

function selectOrigins(origins: Record<string, unknown>, names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.flatMap((name) => (name in origins ? [[name, origins[name]]] : [])));
}

function belongsToTurn(params: unknown, threadId: string, turnId: string | null): boolean {
  if (!isRecord(params)) return false;
  if (params.threadId !== threadId) return false;
  return turnId === null || params.turnId === undefined || params.turnId === turnId;
}

function mapNotification(
  notification: RpcNotification,
  queue: AsyncQueue<NormalizedProviderEvent>,
  currentCapacity: () => ProviderCapacity,
  markAssistantStarted: () => boolean
): void {
  const params = isRecord(notification.params) ? notification.params : {};
  if (notification.method === "item/agentMessage/delta" && typeof params.delta === "string") {
    if (markAssistantStarted()) queue.push({ type: "assistant.message.started", payload: {} });
    queue.push({ type: "assistant.message.delta", payload: { text: params.delta } });
  } else if (notification.method === "item/commandExecution/outputDelta") {
    queue.push({ type: "tool.output.delta", payload: params });
  } else if (notification.method === "item/started") {
    queue.push({ type: "tool.started", payload: { item: params.item } });
  } else if (notification.method === "item/completed") {
    const item = isRecord(params.item) ? params.item : {};
    if (item.type === "agentMessage") {
      queue.push({ type: "assistant.message.completed", payload: { text: item.text ?? "" } });
    } else {
      queue.push({ type: "tool.completed", payload: { item } });
    }
  } else if (notification.method === "turn/completed") {
    const turn = isRecord(params.turn) ? params.turn : {};
    const turnError = isRecord(turn.error) ? turn.error : {};
    const errorMessage = typeof turnError.message === "string"
      ? turnError.message
      : "Codex turn failed";
    if (
      turn.status === "failed" &&
      (codexUsageLimitExceeded(turnError.codexErrorInfo) || isCapacityExhaustionMessage(errorMessage))
    ) {
      queue.fail(new ProviderCapacityExhaustedError(
        "codex",
        exhaustedCapacity("codex", errorMessage, currentCapacity())
      ));
    } else if (turn.status === "failed") queue.fail(new Error("Codex turn failed"));
    else queue.end();
  } else if (notification.method === "error") {
    const nativeError = isRecord(params.error) ? params.error : params;
    const message = typeof nativeError.message === "string" ? nativeError.message : "Codex error";
    if (
      codexUsageLimitExceeded(nativeError.codexErrorInfo) ||
      isCapacityExhaustionMessage(message)
    ) {
      queue.fail(new ProviderCapacityExhaustedError(
        "codex",
        exhaustedCapacity("codex", message, currentCapacity())
      ));
    } else {
      queue.fail(new Error(message));
    }
  }
}

function codexCapacity(result: RateLimitsResult): ProviderCapacity {
  const byId = isRecord(result.rateLimitsByLimitId) ? result.rateLimitsByLimitId : null;
  const snapshots: Array<[string, unknown]> = byId !== null && Object.keys(byId).length > 0
    ? Object.entries(byId)
    : [["codex", result.rateLimits]];
  const windows: ProviderCapacityWindow[] = [];
  let explicitlyReached = false;
  for (const [fallbackId, rawSnapshot] of snapshots) {
    if (!isRecord(rawSnapshot)) continue;
    const limitId = typeof rawSnapshot.limitId === "string" ? rawSnapshot.limitId : fallbackId;
    const limitName = typeof rawSnapshot.limitName === "string" ? rawSnapshot.limitName : "Codex";
    explicitlyReached ||= rawSnapshot.rateLimitReachedType != null || rawSnapshot.spendControlReached === true;
    const candidateWindows: Array<[string, unknown]> = [
      ["primary", rawSnapshot.primary],
      ["secondary", rawSnapshot.secondary]
    ];
    for (const [kind, rawWindow] of candidateWindows) {
      if (!isRecord(rawWindow)) continue;
      const duration = typeof rawWindow.windowDurationMins === "number" ? rawWindow.windowDurationMins : null;
      const label = codexWindowLabel(limitName, kind, duration);
      windows.push(capacityWindow({
        id: `${limitId}:${kind}`,
        label,
        usedPercent: typeof rawWindow.usedPercent === "number" ? rawWindow.usedPercent : null,
        resetsAt: typeof rawWindow.resetsAt === "number" ? rawWindow.resetsAt : null
      }));
    }
  }
  const status = explicitlyReached ? "exhausted" : capacityStatus(windows);
  return {
    provider: "codex",
    status,
    observedAt: new Date().toISOString(),
    source: "codex app-server account/rateLimits/read",
    detail: status === "exhausted"
      ? "Codex reported that its current usage capacity is exhausted."
      : windows.length === 0
        ? "Codex did not report a metered subscription window."
        : "Live subscription capacity reported by Codex on this Mac.",
    windows
  };
}

function codexWindowLabel(limitName: string, kind: string, durationMins: number | null): string {
  if (durationMins === 300) return `${limitName} · 5 hours`;
  if (durationMins === 10_080) return `${limitName} · weekly`;
  if (durationMins !== null) return `${limitName} · ${durationMins} minutes`;
  return `${limitName} · ${kind}`;
}

function codexUsageLimitExceeded(value: unknown): boolean {
  return value === "usageLimitExceeded";
}

function codexApprovalKind(method: string): string | null {
  if (method === "item/commandExecution/requestApproval") return "commandExecution";
  if (method === "item/fileChange/requestApproval") return "fileChange";
  if (method === "item/permissions/requestApproval") return "permissions";
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function providerPrompt(input: ProviderTurnInput): string {
  const context = input.context.recentEvents.map((event) => {
    const value = event as Record<string, unknown>;
    return {
      sequence: value.sequence,
      type: value.type,
      provider: value.provider,
      payload: value.payload
    };
  });
  return buildProviderPrompt({ text: input.text, context, cliCommand: input.context.cliCommand });
}
