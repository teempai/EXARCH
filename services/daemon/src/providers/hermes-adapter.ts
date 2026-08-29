import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  canonicalJson,
  type EffectivePolicy,
  type ProviderCapacity
} from "../../../../packages/protocol/src/index.js";
import { AsyncQueue } from "../process/async-queue.js";
import { JsonLineRpcClient, type RpcNotification } from "../process/json-line-rpc.js";
import { ManagedLineProcess } from "../process/managed-line-process.js";
import { HermesHistoryReader } from "../history/hermes-history.js";
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
  exhaustedCapacity,
  isCapacityExhaustionMessage,
  releaseExpiredCapacity,
  unreportedCapacity
} from "./provider-capacity.js";
import { buildProviderPrompt } from "./provider-prompt.js";

const execFileAsync = promisify(execFile);
const SUPPORTED_VERSION = "0.20.5";
const MAX_CONFIG_BYTES = 1024 * 1024;

interface HermesAdapterOptions {
  executable?: string;
  executableArgsPrefix?: string[];
  installRoot?: string;
  gatewayExecutable?: string;
  gatewayArgs?: string[];
  defaultCwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface HermesBinding {
  sessionId: string;
  storedSessionId: string;
  model: string | null;
}

interface ActiveHermesTurn {
  canonicalTurnId: string;
  queue: AsyncQueue<NormalizedProviderEvent>;
  sessionId: string;
}

interface PendingHermesApproval {
  canonicalTurnId: string;
  requestId: string;
  sessionId: string;
  choices: string[];
  payload: Record<string, unknown>;
  actionCommitment: string;
}

export class HermesAdapter implements ProviderAdapter, HistoryReader {
  readonly provider = "hermes" as const;
  private readonly executable: string;
  private readonly executableArgsPrefix: string[];
  private readonly installRoot: string;
  private readonly gatewayExecutable: string;
  private readonly gatewayArgs: string[];
  private readonly defaultCwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private rpc: JsonLineRpcClient | null = null;
  private gatewayPromise: Promise<JsonLineRpcClient> | null = null;
  private readonly bindings = new Map<string, HermesBinding>();
  private readonly activeBySession = new Map<string, ActiveHermesTurn>();
  private readonly activeByTurn = new Map<string, ActiveHermesTurn>();
  private readonly approvals = new Map<string, PendingHermesApproval>();
  private latestCapacity: ProviderCapacity = unreportedCapacity(
    "hermes",
    "Hermes capacity depends on its active inference provider and is not currently reported."
  );

  constructor(options: HermesAdapterOptions = {}) {
    this.executable = options.executable ?? firstExisting([
      join(homedir(), ".local", "bin", "hermes"),
      "/opt/homebrew/bin/hermes",
      "/usr/local/bin/hermes"
    ]) ?? "hermes";
    this.executableArgsPrefix = options.executableArgsPrefix ?? [];
    this.installRoot = options.installRoot ?? join(homedir(), ".hermes", "hermes-agent");
    this.gatewayExecutable =
      options.gatewayExecutable ?? join(this.installRoot, "venv", "bin", "python");
    this.gatewayArgs = options.gatewayArgs ?? ["-P", "-m", "tui_gateway.entry"];
    this.defaultCwd = options.defaultCwd ?? process.cwd();
    this.env = options.env ?? process.env;
  }

  async probe(): Promise<ProviderHealth> {
    try {
      const { stdout } = await execFileAsync(
        this.executable,
        [...this.executableArgsPrefix, "--version"],
        { cwd: this.defaultCwd, env: this.env, timeout: 5_000, maxBuffer: 128 * 1024 }
      );
      const version = stdout.match(/Hermes Agent v([^\s]+)/)?.[1] ?? null;
      return {
        provider: "hermes",
        available: version === SUPPORTED_VERSION,
        version,
        reason: version === SUPPORTED_VERSION ? "ready" : "unsupported_version",
        detail:
          version === SUPPORTED_VERSION
            ? "ready (pinned structured gateway protocol)"
            : `unsupported Hermes version; expected ${SUPPORTED_VERSION}`
      };
    } catch (error) {
      return providerProbeFailure("hermes", "Hermes", error);
    }
  }

  async observeEffectivePolicy(cwd = this.defaultCwd): Promise<EffectivePolicy> {
    try {
      const [{ stdout: modeOutput }, { stdout: pathOutput }] = await Promise.all([
        execFileAsync(
          this.executable,
          [...this.executableArgsPrefix, "config", "get", "approvals.mode", "--json"],
          { cwd, env: this.env, timeout: 5_000, maxBuffer: 64 * 1024 }
        ),
        execFileAsync(this.executable, [...this.executableArgsPrefix, "config", "path"], {
          cwd,
          env: this.env,
          timeout: 5_000,
          maxBuffer: 64 * 1024
        })
      ]);
      const parsedMode = JSON.parse(modeOutput.trim()) as unknown;
      if (typeof parsedMode !== "string" || !["manual", "smart", "off"].includes(parsedMode)) {
        throw new Error("Hermes returned an unknown approvals mode");
      }
      const configPath = pathOutput.trim();
      const configSha256 = hashBoundedFile(configPath);
      const envYolo = isTruthy(this.env.HERMES_YOLO);
      const native = {
        approvals_mode: parsedMode,
        process_yolo: envYolo,
        config_path: configPath,
        config_sha256: configSha256,
        launch_overrides: []
      };
      return hermesPolicy(native, "verified");
    } catch (error) {
      return hermesPolicy(
        { error: error instanceof Error ? error.message : "policy observation failed" },
        "unavailable"
      );
    }
  }

  async listModels(): Promise<ProviderModel[]> {
    const { stdout } = await execFileAsync(
      this.executable,
      [...this.executableArgsPrefix, "config", "get", "model", "--json"],
      { cwd: this.defaultCwd, env: this.env, timeout: 5_000, maxBuffer: 64 * 1024 }
    );
    const configured = JSON.parse(stdout.trim()) as unknown;
    const provider = isRecord(configured) && typeof configured.provider === "string"
      ? configured.provider
      : null;
    const selected = isRecord(configured) && typeof configured.default === "string"
      ? configured.default
      : null;
    const models = provider === null ? [] : this.cachedModels(provider);
    if (selected !== null && !models.includes(selected)) models.unshift(selected);
    return models.slice(0, 100).map((id) => ({ id, displayName: id, description: null }));
  }

  async observeCapacity(): Promise<ProviderCapacity> {
    this.latestCapacity = releaseExpiredCapacity(this.latestCapacity);
    return this.latestCapacity;
  }

  private cachedModels(provider: string): string[] {
    const path = join(dirname(this.installRoot), "provider_models_cache.json");
    if (!existsSync(path)) return [];
    const details = statSync(path);
    if (!details.isFile() || details.size > MAX_CONFIG_BYTES) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed[provider])) return [];
    const models = parsed[provider].models;
    if (!Array.isArray(models)) return [];
    return models.filter((value): value is string =>
      typeof value === "string" && value.length > 0 && value.length <= 200
    );
  }

  readHistory(): Promise<NativeHistoryThread[]> {
    return new HermesHistoryReader({
      executable: this.executable,
      executableArgsPrefix: this.executableArgsPrefix,
      cwd: this.defaultCwd,
      env: this.env
    }).readHistory();
  }

  bindSession(
    conversationId: string,
    nativeSessionId: string,
    _metadata: Record<string, unknown>,
    _synchronizedThroughSequence: number
  ): void {
    if (this.bindings.has(conversationId)) return;
    this.bindings.set(conversationId, {
      sessionId: "",
      storedSessionId: nativeSessionId,
      model: null
    });
  }

  async *startTurn(input: ProviderTurnInput): AsyncIterable<NormalizedProviderEvent> {
    const rpc = await this.ensureGateway(input.cwd);
    let binding = this.bindings.get(input.conversationId);
    const selectedModel = input.model ?? null;
    if (binding !== undefined && binding.model !== selectedModel) {
      this.bindings.delete(input.conversationId);
      binding = undefined;
    }
    let created = false;
    if (binding !== undefined && binding.sessionId === "") {
      const response = await rpc.request<Record<string, unknown>>("session.resume", {
        session_id: binding.storedSessionId,
        omit_messages: true
      });
      if (typeof response.session_id !== "string") throw new Error("Hermes session.resume omitted session_id");
      binding.sessionId = response.session_id;
    }
    if (binding === undefined) {
      const response = await rpc.request<Record<string, unknown>>("session.create", {
        cwd: input.cwd,
        source: "exarch",
        close_on_disconnect: false,
        ...(selectedModel === null ? {} : { model: selectedModel })
      });
      if (typeof response.session_id !== "string") throw new Error("Hermes session.create omitted session_id");
      binding = {
        sessionId: response.session_id,
        storedSessionId:
          typeof response.stored_session_id === "string" ? response.stored_session_id : response.session_id,
        model: selectedModel
      };
      this.bindings.set(input.conversationId, binding);
      created = true;
      yield {
        type: "provider.session.bound",
        payload: {
          nativeSessionId: binding.storedSessionId,
          gatewaySessionId: binding.sessionId,
          protocolVersion: SUPPORTED_VERSION
        }
      };
    }

    const queue = new AsyncQueue<NormalizedProviderEvent>({
      maxItems: PROVIDER_EVENT_BUFFER_ITEMS,
      maxBytes: PROVIDER_EVENT_BUFFER_BYTES,
      sizeOf: providerEventSize
    });
    const active = { canonicalTurnId: input.turnId, queue, sessionId: binding.sessionId };
    this.activeBySession.set(binding.sessionId, active);
    this.activeByTurn.set(input.turnId, active);
    const abort = () => void this.interruptTurn(input.turnId);
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      if (input.signal.aborted) {
        await this.interruptTurn(input.turnId);
      } else {
        await rpc.request("prompt.submit", {
          session_id: binding.sessionId,
          text: providerPrompt(input)
        });
      }
      for await (const event of queue) yield event;
    } finally {
      input.signal.removeEventListener("abort", abort);
      this.activeBySession.delete(binding.sessionId);
      this.activeByTurn.delete(input.turnId);
      for (const [requestId, approval] of this.approvals) {
        if (approval.canonicalTurnId === input.turnId) this.approvals.delete(requestId);
      }
    }
  }

  async interruptTurn(turnId: string): Promise<void> {
    const active = this.activeByTurn.get(turnId);
    if (active === undefined || this.rpc === null) return;
    await this.rpc.request("session.interrupt", { session_id: active.sessionId });
    active.queue.fail(new Error("Turn interrupted"));
  }

  async respondToApproval(input: ProviderApprovalDecisionInput): Promise<void> {
    const pending = this.approvals.get(input.requestId);
    if (pending === undefined || this.rpc === null) throw new Error("Hermes approval is not pending");
    if (pending.canonicalTurnId !== input.turnId) throw new Error("Approval turn mismatch");
    if (!pending.choices.includes(input.choice)) throw new Error("Approval choice is not offered");
    const actionCommitment = providerApprovalActionCommitment(hermesApprovalAction(pending));
    if (input.actionCommitment !== pending.actionCommitment || input.actionCommitment !== actionCommitment) {
      throw new Error("Hermes approval action commitment mismatch");
    }
    this.approvals.delete(input.requestId);
    await this.rpc.request("approval.respond", {
      session_id: pending.sessionId,
      request_id: pending.requestId,
      choice: input.choice
    });
  }

  async close(): Promise<void> {
    const rpc = this.rpc;
    this.rpc = null;
    this.gatewayPromise = null;
    if (rpc !== null) await rpc.process.terminate();
  }

  private ensureGateway(cwd: string): Promise<JsonLineRpcClient> {
    if (this.rpc !== null) return Promise.resolve(this.rpc);
    if (this.gatewayPromise !== null) return this.gatewayPromise;
    this.gatewayPromise = (async () => {
      const env = {
        ...this.env,
        PYTHONSAFEPATH: "1",
        PYTHONPATH: this.installRoot,
        HERMES_PYTHON_SRC_ROOT: this.installRoot,
        HERMES_CWD: cwd
      };
      const rpc = new JsonLineRpcClient(
        new ManagedLineProcess({
          executable: this.gatewayExecutable,
          args: this.gatewayArgs,
          cwd: this.installRoot,
          env
        }),
        120_000,
        true
      );
      const ready = waitForNotification(rpc, "gateway.ready", 20_000);
      rpc.onNotification((notification) => this.handleNotification(notification));
      await rpc.start();
      await ready;
      this.rpc = rpc;
      return rpc;
    })();
    return this.gatewayPromise.catch((error: unknown) => {
      this.gatewayPromise = null;
      throw error;
    });
  }

  private handleNotification(notification: RpcNotification): void {
    if (notification.method !== "event" || !isRecord(notification.params)) return;
    const event = notification.params;
    if (typeof event.type !== "string" || typeof event.session_id !== "string") return;
    const active = this.activeBySession.get(event.session_id);
    if (active === undefined) return;
    const payload = isRecord(event.payload) ? event.payload : {};
    if (event.type === "message.start") {
      active.queue.push({ type: "assistant.message.started", payload: {} });
    } else if (event.type === "message.delta" && typeof payload.text === "string") {
      active.queue.push({ type: "assistant.message.delta", payload: { text: payload.text } });
    } else if (event.type === "message.complete") {
      active.queue.push({
        type: "assistant.message.completed",
        payload: { text: typeof payload.text === "string" ? payload.text : "" }
      });
      active.queue.end();
    } else if (event.type === "tool.start") {
      active.queue.push({ type: "tool.started", payload });
    } else if (event.type === "tool.complete") {
      active.queue.push({ type: payload.error ? "tool.failed" : "tool.completed", payload });
    } else if (event.type === "approval.request") {
      const nativeRequestId = typeof payload.request_id === "string" ? payload.request_id : null;
      if (nativeRequestId === null || nativeRequestId.length === 0 || nativeRequestId.length > 200) {
        active.queue.fail(new Error("Hermes approval request omitted request_id"));
        return;
      }
      const nativeChoices = Array.isArray(payload.choices)
        ? payload.choices.filter((choice): choice is string => typeof choice === "string")
        : ["once", "deny"];
      const choices = nativeChoices.filter((choice) => choice === "once" || choice === "deny");
      const requestId = providerApprovalHandle({
        provider: this.provider,
        sessionId: active.sessionId,
        nativeRequestId
      });
      if (this.approvals.has(requestId)) {
        active.queue.fail(new Error("Duplicate Hermes approval request ID"));
        return;
      }
      if (this.approvals.size >= PROVIDER_PENDING_APPROVAL_LIMIT) {
        active.queue.fail(new Error("Hermes pending approval limit exceeded"));
        return;
      }
      const pending: PendingHermesApproval = {
        canonicalTurnId: active.canonicalTurnId,
        requestId: nativeRequestId,
        sessionId: active.sessionId,
        choices,
        payload,
        actionCommitment: ""
      };
      pending.actionCommitment = providerApprovalActionCommitment(hermesApprovalAction(pending));
      this.approvals.set(requestId, pending);
      active.queue.push({
        type: "approval.requested",
        payload: {
          ...payload,
          providerRequestId: requestId,
          choices,
          actionCommitment: pending.actionCommitment
        }
      });
    } else if (event.type === "error") {
      const message = typeof payload.message === "string" ? payload.message : "Hermes error";
      if (isCapacityExhaustionMessage(message)) {
        const capacity = exhaustedCapacity("hermes", message, this.latestCapacity);
        this.latestCapacity = capacity;
        active.queue.fail(new ProviderCapacityExhaustedError("hermes", capacity));
      } else {
        active.queue.fail(new Error(message));
      }
    }
  }
}

function hermesApprovalAction(pending: PendingHermesApproval): Record<string, unknown> {
  return {
    provider: "hermes",
    turnId: pending.canonicalTurnId,
    sessionId: pending.sessionId,
    nativeRequestId: pending.requestId,
    payload: pending.payload,
    choices: pending.choices
  };
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path));
}

function waitForNotification(
  rpc: JsonLineRpcClient,
  type: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Hermes gateway did not emit ${type}`));
    }, timeoutMs);
    timer.unref?.();
    const off = rpc.onNotification((notification) => {
      if (
        notification.method === "event" &&
        isRecord(notification.params) &&
        notification.params.type === type
      ) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

function hermesPolicy(
  native: Record<string, unknown>,
  status: EffectivePolicy["status"]
): EffectivePolicy {
  const revision = `sha256:${createHash("sha256").update(canonicalJson(native)).digest("hex")}`;
  const mode = typeof native.approvals_mode === "string" ? native.approvals_mode : null;
  return {
    provider: "hermes",
    status,
    revision,
    observedAt: new Date().toISOString(),
    source: `hermes config get approvals.mode (${SUPPORTED_VERSION})`,
    native,
    normalized: {
      mayExecuteWithoutPrompt: mode === "off" || native.process_yolo === true ? true : mode === null ? null : false,
      sandbox: null,
      reviewer: mode
    }
  };
}

function hashBoundedFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error("Hermes config is invalid or oversized");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function providerPrompt(input: ProviderTurnInput): string {
  return buildProviderPrompt({
    text: input.text,
    context: input.context.recentEvents,
    cliCommand: input.context.cliCommand
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
