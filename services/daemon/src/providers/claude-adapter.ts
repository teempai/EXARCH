import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { promisify } from "node:util";
import {
  canonicalJson,
  type EffectivePolicy,
  type ProviderCapacity,
  type ProviderCapacityWindow
} from "../../../../packages/protocol/src/index.js";
import { AsyncQueue } from "../process/async-queue.js";
import { ManagedLineProcess } from "../process/managed-line-process.js";
import { ClaudePermissionBridge } from "./claude-permission-bridge.js";
import { ClaudeHistoryReader } from "../history/claude-history.js";
import type { HistoryReader, NativeHistoryThread } from "../history/types.js";
import {
  ProviderCapacityExhaustedError,
  PROVIDER_EVENT_BUFFER_BYTES,
  PROVIDER_EVENT_BUFFER_ITEMS,
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
  releaseExpiredCapacity,
  unreportedCapacity
} from "./provider-capacity.js";
import { buildProviderPrompt } from "./provider-prompt.js";

const execFileAsync = promisify(execFile);
const SUPPORTED_VERSION = "2.1.87";
const MAX_SETTINGS_BYTES = 1024 * 1024;

interface ClaudeAdapterOptions {
  executable?: string;
  executableArgsPrefix?: string[];
  defaultCwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

interface ClaudeSession {
  process: ManagedLineProcess;
  permissionBridge: ClaudePermissionBridge;
  queue: AsyncQueue<NormalizedProviderEvent> | null;
  canonicalTurnId: string | null;
  nativeSessionId: string | null;
  assistantStarted: boolean;
  assistantCompleted: boolean;
  streamedText: string;
  model: string | null;
}

export class ClaudeAdapter implements ProviderAdapter, HistoryReader {
  readonly provider = "claude" as const;
  private readonly executable: string;
  private readonly executableArgsPrefix: string[];
  private readonly defaultCwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly historyReader: ClaudeHistoryReader;
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly restoredSessionIds = new Map<string, string>();
  private readonly turns = new Map<string, ClaudeSession>();
  private readonly capacityWindows = new Map<string, ProviderCapacityWindow>();
  private latestCapacity: ProviderCapacity = unreportedCapacity(
    "claude",
    "Capacity appears after EXARCH starts an authenticated Claude Code session and receives a rate-limit update. A separately running Claude Code app or terminal session does not report capacity to EXARCH."
  );

  constructor(options: ClaudeAdapterOptions = {}) {
    this.executable = options.executable ?? firstExisting([
      join(homedir(), ".local", "bin", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude"
    ]) ?? "claude";
    this.executableArgsPrefix = options.executableArgsPrefix ?? [];
    this.defaultCwd = options.defaultCwd ?? process.cwd();
    this.env = withExecutableOnPath(options.env ?? process.env, this.executable);
    this.home = options.home ?? this.env.HOME ?? homedir();
    this.historyReader = new ClaudeHistoryReader(
      this.env.CLAUDE_CONFIG_DIR ?? join(this.home, ".claude"),
      this.defaultCwd
    );
  }

  async probe(): Promise<ProviderHealth> {
    try {
      const { stdout } = await execFileAsync(
        this.executable,
        [...this.executableArgsPrefix, "--version"],
        { cwd: this.defaultCwd, env: this.env, timeout: 5_000, maxBuffer: 64 * 1024 }
      );
      const version = stdout.match(/([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? null;
      if (version !== SUPPORTED_VERSION) {
        return {
          provider: "claude",
          available: false,
          version,
          reason: "unsupported_version",
          detail: `unsupported Claude Code version; expected ${SUPPORTED_VERSION}`
        };
      }
      const authentication = await this.observeAuthentication();
      if (authentication?.loggedIn === false) {
        return {
          provider: "claude",
          available: false,
          version,
          reason: "authentication_required",
          detail:
            "Claude Code is installed, but the CLI EXARCH launches is not signed in. Run `claude auth login --claudeai` on this Mac, then rescan harnesses."
        };
      }
      return {
        provider: "claude",
        available: true,
        version,
        reason: "ready",
        detail: "ready (pinned stream-json protocol; authenticated CLI)"
      };
    } catch (error) {
      return providerProbeFailure("claude", "Claude Code", error);
    }
  }

  private async observeAuthentication(): Promise<{ loggedIn: boolean } | null> {
    try {
      const { stdout } = await execFileAsync(
        this.executable,
        [...this.executableArgsPrefix, "auth", "status", "--json"],
        { cwd: this.defaultCwd, env: this.env, timeout: 5_000, maxBuffer: 64 * 1024 }
      );
      return parseClaudeAuthentication(stdout);
    } catch (error) {
      // Claude exits non-zero when the command succeeds but reports an
      // unauthenticated first-party session. Parse its bounded stdout before
      // classifying the probe itself as failed.
      const stdout = error !== null && typeof error === "object" && "stdout" in error
        ? error.stdout
        : null;
      const parsed = parseClaudeAuthentication(typeof stdout === "string" ? stdout : "");
      if (parsed !== null) return parsed;
      throw error;
    }
  }

  async observeEffectivePolicy(cwd = this.defaultCwd): Promise<EffectivePolicy> {
    const observation = observeClaudeSettings(this.home, cwd);
    const revision = `sha256:${createHash("sha256")
      .update(canonicalJson(observation.native))
      .digest("hex")}`;
    return {
      provider: "claude",
      status: observation.status,
      revision,
      observedAt: new Date().toISOString(),
      source: "Claude Code settings hierarchy (read-only; runtime resolution is partial)",
      native: observation.native,
      normalized: {
        mayExecuteWithoutPrompt:
          observation.defaultMode === "bypassPermissions" ? true : null,
        sandbox: null,
        reviewer: observation.defaultMode
      }
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    return [
      { id: "sonnet", displayName: "Sonnet", description: "Latest Claude Sonnet model" },
      { id: "opus", displayName: "Opus", description: "Latest Claude Opus model" },
      { id: "haiku", displayName: "Haiku", description: "Latest Claude Haiku model" }
    ];
  }

  async observeCapacity(): Promise<ProviderCapacity> {
    this.latestCapacity = releaseExpiredCapacity(this.latestCapacity);
    return this.latestCapacity;
  }

  readHistory(): Promise<NativeHistoryThread[]> {
    return this.historyReader.readHistory();
  }

  readHistoryChanges(keys: readonly string[]): Promise<NativeHistoryThread[]> {
    return this.historyReader.readHistoryChanges(keys);
  }

  checkForHistoryChanges(): Promise<NativeHistoryThread[]> {
    return this.historyReader.checkForHistoryChanges();
  }

  watchHistory(onChange: (key: string) => void): () => void {
    return this.historyReader.watchHistory(onChange);
  }

  bindSession(
    conversationId: string,
    nativeSessionId: string,
    _metadata: Record<string, unknown>,
    _synchronizedThroughSequence: number
  ): void {
    this.restoredSessionIds.set(conversationId, nativeSessionId);
  }

  async *startTurn(input: ProviderTurnInput): AsyncIterable<NormalizedProviderEvent> {
    const session = await this.ensureSession(input.conversationId, input.cwd, input.model);
    if (session.queue !== null) throw new Error("Claude session already has an active turn");
    const queue = new AsyncQueue<NormalizedProviderEvent>({
      maxItems: PROVIDER_EVENT_BUFFER_ITEMS,
      maxBytes: PROVIDER_EVENT_BUFFER_BYTES,
      sizeOf: providerEventSize
    });
    session.queue = queue;
    session.canonicalTurnId = input.turnId;
    session.assistantStarted = false;
    session.assistantCompleted = false;
    session.streamedText = "";
    this.turns.set(input.turnId, session);

    const abort = () => void this.interruptTurn(input.turnId);
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      await session.process.writeLine(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: providerPrompt(input) }]
          }
        })
      );
      for await (const event of queue) yield event;
    } finally {
      input.signal.removeEventListener("abort", abort);
      session.queue = null;
      session.canonicalTurnId = null;
      this.turns.delete(input.turnId);
    }
  }

  async interruptTurn(turnId: string): Promise<void> {
    const session = this.turns.get(turnId);
    if (session === undefined) return;
    session.queue?.fail(new Error("Turn interrupted"));
    await session.process.terminate(500);
    for (const [conversationId, candidate] of this.sessions) {
      if (candidate === session) this.sessions.delete(conversationId);
    }
  }

  async respondToApproval(input: ProviderApprovalDecisionInput): Promise<void> {
    const session = this.turns.get(input.turnId);
    if (session === undefined) throw new Error("Claude turn has no pending approval bridge");
    await session.permissionBridge.respond(input.requestId, input.choice, input.actionCommitment);
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map(async (session) => {
        await session.process.terminate();
        await session.permissionBridge.close();
      })
    );
  }

  private async ensureSession(
    conversationId: string,
    cwd: string,
    model?: string
  ): Promise<ClaudeSession> {
    const current = this.sessions.get(conversationId);
    const selectedModel = model ?? null;
    if (current !== undefined && current.process.running && current.model === selectedModel) return current;
    if (current !== undefined) {
      await current.process.terminate();
      await current.permissionBridge.close();
      this.sessions.delete(conversationId);
    }
    let session: ClaudeSession;
    const restoredSessionId = this.restoredSessionIds.get(conversationId) ?? null;
    const permissionBridge = new ClaudePermissionBridge((request) => {
      session.queue?.push({
        type: "approval.requested",
        payload: {
          providerRequestId: request.providerRequestId,
          actionCommitment: request.actionCommitment,
          choices: ["allow", "deny"],
          toolName: request.toolName,
          input: request.input
        }
      });
    });
    const permission = await permissionBridge.start();
    const process = new ManagedLineProcess({
      executable: this.executable,
      args: [
        ...this.executableArgsPrefix,
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        ...(restoredSessionId === null ? [] : ["--resume", restoredSessionId]),
        ...(selectedModel === null ? [] : ["--model", selectedModel]),
        "--mcp-config",
        permission.configPath,
        "--allowedTools",
        permission.toolName,
        "--permission-prompt-tool",
        permission.toolName
      ],
      cwd,
      env: this.env
    });
    session = {
      process,
      permissionBridge,
      queue: null,
      canonicalTurnId: null,
      nativeSessionId: restoredSessionId,
      assistantStarted: false,
      assistantCompleted: false,
      streamedText: "",
      model: selectedModel
    };
    process.onLine((line) => this.handleLine(session, line));
    process.onTransportError((error) => session.queue?.fail(error));
    process.onExit((exit) => {
      session.queue?.fail(new Error(`Claude Code exited (${exit.code ?? exit.signal ?? "unknown"})`));
      void session.permissionBridge.close();
    });
    try {
      await process.start();
    } catch (error) {
      await permissionBridge.close();
      throw error;
    }
    this.sessions.set(conversationId, session);
    return session;
  }

  private handleLine(session: ClaudeSession, line: string): void {
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      session.queue?.fail(new Error("Claude Code emitted malformed stream JSON"));
      return;
    }
    if (!isRecord(message) || typeof message.type !== "string") return;
    if (message.type === "rate_limit_event") {
      const capacity = this.updateCapacity(message.rate_limit_info);
      if (capacity.status === "exhausted" && session.queue !== null) {
        session.queue.fail(new ProviderCapacityExhaustedError("claude", capacity));
      }
      return;
    }
    if (session.queue === null) return;
    if (typeof message.session_id === "string" && session.nativeSessionId === null) {
      session.nativeSessionId = message.session_id;
      session.queue.push({
        type: "provider.session.bound",
        payload: { nativeSessionId: message.session_id, protocolVersion: SUPPORTED_VERSION }
      });
    }
    if (message.type === "stream_event") this.handleStreamEvent(session, message.event);
    else if (message.type === "assistant") this.handleAssistant(session, message.message);
    else if (message.type === "user") this.handleToolResults(session, message.message);
    else if (message.type === "result") {
      if (message.is_error === true || message.subtype !== "success") {
        const detail = [message.subtype, message.result, message.error]
          .filter((value): value is string => typeof value === "string")
          .join(": ");
        const failure = `Claude Code turn failed: ${detail || "unknown"}`;
        if (isCapacityExhaustionMessage(failure)) {
          const capacity = exhaustedCapacity("claude", failure, this.latestCapacity);
          this.latestCapacity = capacity;
          session.queue.fail(new ProviderCapacityExhaustedError("claude", capacity));
        } else {
          session.queue.fail(new Error(failure));
        }
      } else {
        if (!session.assistantCompleted && typeof message.result === "string") {
          if (!session.assistantStarted) {
            session.assistantStarted = true;
            session.queue.push({ type: "assistant.message.started", payload: {} });
            session.queue.push({ type: "assistant.message.delta", payload: { text: message.result } });
          }
          session.queue.push({ type: "assistant.message.completed", payload: { text: message.result } });
        }
        session.queue.end();
      }
    }
  }

  private updateCapacity(raw: unknown): ProviderCapacity {
    if (!isRecord(raw)) return this.latestCapacity;
    const type = typeof raw.rateLimitType === "string" ? raw.rateLimitType : "subscription";
    const usedPercent = typeof raw.utilization === "number" ? raw.utilization * 100 : null;
    this.capacityWindows.set(type, capacityWindow({
      id: type,
      label: claudeWindowLabel(type),
      usedPercent,
      resetsAt: typeof raw.resetsAt === "number" ? raw.resetsAt : null
    }));
    const windows = [...this.capacityWindows.values()];
    const nativeStatus = raw.status;
    const status = nativeStatus === "rejected"
      ? "exhausted"
      : nativeStatus === "allowed_warning"
        ? "warning"
        : capacityStatus(windows);
    this.latestCapacity = {
      provider: "claude",
      status,
      observedAt: new Date().toISOString(),
      source: "Claude Code rate_limit_event",
      detail: status === "exhausted"
        ? "Claude Code reported that its current subscription capacity is exhausted."
        : "Live subscription capacity reported by Claude Code on this Mac.",
      windows
    };
    return this.latestCapacity;
  }

  private handleStreamEvent(session: ClaudeSession, rawEvent: unknown): void {
    if (!isRecord(rawEvent)) return;
    if (rawEvent.type === "content_block_delta" && isRecord(rawEvent.delta)) {
      if (rawEvent.delta.type === "text_delta" && typeof rawEvent.delta.text === "string") {
        if (!session.assistantStarted) {
          session.assistantStarted = true;
          session.queue?.push({ type: "assistant.message.started", payload: {} });
        }
        session.streamedText += rawEvent.delta.text;
        session.queue?.push({ type: "assistant.message.delta", payload: { text: rawEvent.delta.text } });
      }
    } else if (rawEvent.type === "content_block_start" && isRecord(rawEvent.content_block)) {
      const block = rawEvent.content_block;
      if (block.type === "tool_use") {
        session.queue?.push({
          type: "tool.started",
          payload: { toolId: block.id, name: block.name, input: block.input }
        });
      }
    }
  }

  private handleAssistant(session: ClaudeSession, rawMessage: unknown): void {
    if (!isRecord(rawMessage) || !Array.isArray(rawMessage.content)) return;
    const text = rawMessage.content
      .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
      .flatMap((block) => (typeof block.text === "string" ? [block.text] : []))
      .join("");
    if (text !== "") {
      if (!session.assistantStarted) {
        session.assistantStarted = true;
        session.queue?.push({ type: "assistant.message.started", payload: {} });
        session.queue?.push({ type: "assistant.message.delta", payload: { text } });
      }
      session.assistantCompleted = true;
      session.queue?.push({ type: "assistant.message.completed", payload: { text } });
    }
  }

  private handleToolResults(session: ClaudeSession, rawMessage: unknown): void {
    if (!isRecord(rawMessage) || !Array.isArray(rawMessage.content)) return;
    for (const block of rawMessage.content) {
      if (isRecord(block) && block.type === "tool_result") {
        session.queue?.push({
          type: block.is_error === true ? "tool.failed" : "tool.completed",
          payload: { toolId: block.tool_use_id, content: block.content }
        });
      }
    }
  }
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path));
}

function observeClaudeSettings(home: string, cwd: string): {
  native: Record<string, unknown>;
  status: EffectivePolicy["status"];
  defaultMode: string | null;
} {
  const projectRoot = findProjectRoot(cwd);
  const projectSettingsPath = join(projectRoot, ".claude", "settings.json");
  const userSettingsPath = join(home, ".claude", "settings.json");
  // `repositoryControlled` marks a layer that lives inside the checkout, which
  // the daemon does not author and a hostile repository can write.
  const candidates = [
    {
      kind: "managed",
      path: "/Library/Application Support/ClaudeCode/managed-settings.json",
      repositoryControlled: false
    },
    {
      kind: "local",
      path: join(projectRoot, ".claude", "settings.local.json"),
      repositoryControlled: true
    },
    ...(resolve(projectSettingsPath) === resolve(userSettingsPath)
      ? []
      : [{ kind: "project", path: projectSettingsPath, repositoryControlled: true }]),
    { kind: "user", path: userSettingsPath, repositoryControlled: false }
  ];
  const layers: Array<Record<string, unknown>> = [];
  let invalid = false;
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    try {
      const stat = statSync(candidate.path);
      if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) throw new Error("settings file is invalid or oversized");
      const raw = readFileSync(candidate.path);
      const parsed = JSON.parse(raw.toString("utf8")) as unknown;
      if (!isRecord(parsed)) throw new Error("settings root is not an object");
      const permissions = isRecord(parsed.permissions) ? parsed.permissions : {};
      layers.push({
        kind: candidate.kind,
        path: candidate.path,
        repositoryControlled: candidate.repositoryControlled,
        sha256: createHash("sha256").update(raw).digest("hex"),
        permissions: {
          defaultMode: typeof permissions.defaultMode === "string" ? permissions.defaultMode : null,
          allow: stringArray(permissions.allow),
          ask: stringArray(permissions.ask),
          deny: stringArray(permissions.deny),
          additionalDirectories: stringArray(permissions.additionalDirectories)
        },
        hooksPresent: isRecord(parsed.hooks) && Object.keys(parsed.hooks).length > 0
      });
    } catch {
      invalid = true;
      layers.push({
        kind: candidate.kind,
        path: candidate.path,
        repositoryControlled: candidate.repositoryControlled,
        invalid: true
      });
    }
  }
  const firstMode = (filter?: (layer: Record<string, unknown>) => boolean): string | undefined =>
    layers.flatMap((layer) => {
      if (filter !== undefined && !filter(layer)) return [];
      const permissions = isRecord(layer.permissions) ? layer.permissions : {};
      return typeof permissions.defaultMode === "string" ? [permissions.defaultMode] : [];
    })[0];

  // Claude documents scalar precedence as managed > command line > local >
  // project > user. Project-controlled settings therefore really can affect
  // the mode the spawned CLI sees; hiding that value would make the phone show
  // a safer policy than the provider actually applies. Surface both the
  // effective value and its repository-controlled provenance instead.
  const defaultMode = firstMode() ?? "default";
  const effectiveSource = layers.find((layer) => {
    const permissions = isRecord(layer.permissions) ? layer.permissions : {};
    return typeof permissions.defaultMode === "string";
  }) ?? null;
  const repositoryRequestedMode =
    firstMode((layer) => layer.repositoryControlled === true) ?? null;
  return {
    native: {
      defaultMode,
      repositoryRequestedMode,
      effectiveDefaultModeSource: effectiveSource === null
        ? null
        : {
            kind: effectiveSource.kind,
            path: effectiveSource.path,
            repositoryControlled: effectiveSource.repositoryControlled
          },
      precedence: ["managed", "command-line", "local", "project", "user"],
      launchPermissionOverrides: [],
      layers
    },
    status: invalid ? "unavailable" : "partial",
    defaultMode
  };
}

function findProjectRoot(cwd: string): string {
  let current = resolve(cwd);
  const root = parse(current).root;
  while (current !== root) {
    if (existsSync(join(current, ".git"))) return current;
    current = dirname(current);
  }
  return resolve(cwd);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function withExecutableOnPath(env: NodeJS.ProcessEnv, executable: string): NodeJS.ProcessEnv {
  const directory = dirname(executable);
  const current = env.PATH ?? "";
  return { ...env, PATH: current.split(":").includes(directory) ? current : `${directory}:${current}` };
}

function claudeWindowLabel(type: string): string {
  switch (type) {
    case "five_hour": return "Current session · 5 hours";
    case "seven_day": return "Current week · all models";
    case "seven_day_opus": return "Current week · Opus";
    case "seven_day_sonnet": return "Current week · Sonnet";
    case "overage": return "Extra usage";
    default: return "Subscription capacity";
  }
}

function providerPrompt(input: ProviderTurnInput): string {
  const context = input.context.recentEvents.map((event) => {
    if (!isRecord(event)) return event;
    return {
      sequence: event.sequence,
      type: event.type,
      provider: event.provider,
      payload: event.payload
    };
  });
  return buildProviderPrompt({ text: input.text, context, cliCommand: input.context.cliCommand });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseClaudeAuthentication(stdout: string): { loggedIn: boolean } | null {
  try {
    const value = JSON.parse(stdout) as unknown;
    if (!isRecord(value) || typeof value.loggedIn !== "boolean") return null;
    return { loggedIn: value.loggedIn };
  } catch {
    return null;
  }
}
