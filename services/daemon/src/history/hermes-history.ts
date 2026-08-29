import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HistoryReader, NativeHistoryItem, NativeHistoryThread } from "./types.js";
import { isRecord, textContent, timestamp } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_EXPORT_BYTES = 256 * 1024 * 1024;

export interface HermesHistoryReaderOptions {
  executable: string;
  executableArgsPrefix?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export class HermesHistoryReader implements HistoryReader {
  readonly provider = "hermes" as const;

  constructor(private readonly options: HermesHistoryReaderOptions) {}

  async readHistory(): Promise<NativeHistoryThread[]> {
    const { stdout } = await execFileAsync(
      this.options.executable,
      [
        ...(this.options.executableArgsPrefix ?? []),
        "sessions",
        "export",
        "--format",
        "jsonl",
        "--redact",
        "-"
      ],
      {
        cwd: this.options.cwd,
        env: this.options.env ?? process.env,
        timeout: 120_000,
        maxBuffer: MAX_EXPORT_BYTES,
        encoding: "utf8"
      }
    );
    return parseHermesExport(stdout, this.options.cwd);
  }
}

export function parseHermesExport(raw: string, fallbackCwd: string): NativeHistoryThread[] {
  const threads: NativeHistoryThread[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const parsed: unknown = JSON.parse(line);
    const mapped = mapHermesSession(parsed, fallbackCwd);
    if (mapped !== null) threads.push(mapped);
  }
  return threads;
}

export function mapHermesSession(raw: unknown, fallbackCwd: string): NativeHistoryThread | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string"
    ? raw.id
    : typeof raw.session_id === "string"
      ? raw.session_id
      : null;
  if (id === null) return null;
  const createdAt = timestamp(raw.started_at ?? raw.created_at, new Date(0).toISOString());
  const updatedAt = timestamp(raw.last_active ?? raw.updated_at ?? raw.ended_at, createdAt);
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const items: NativeHistoryItem[] = [];
  let firstUserText = "";
  for (const [index, value] of messages.entries()) {
    if (!isRecord(value)) continue;
    const messageId = typeof value.id === "string" || typeof value.id === "number"
      ? String(value.id)
      : `${id}:message-${index}`;
    const role = typeof value.role === "string" ? value.role : "unknown";
    const occurredAt = timestamp(value.timestamp, createdAt);
    const text = textContent(value.content);
    if (role === "user") {
      if (firstUserText === "" && text.length > 0) firstUserText = text;
      items.push({
        nativeItemId: `${messageId}:message`,
        type: "user.message",
        payload: { text, nativeType: "user" },
        occurredAt
      });
    } else if (role === "assistant") {
      if (text.length > 0) {
        items.push({
          nativeItemId: `${messageId}:message`,
          type: "assistant.message.completed",
          payload: { text, nativeType: "assistant" },
          occurredAt
        });
      }
      const toolCalls = decodeArray(value.tool_calls);
      for (const [toolIndex, toolCall] of toolCalls.entries()) {
        items.push({
          nativeItemId: `${messageId}:tool-call-${toolId(toolCall, toolIndex)}`,
          type: "tool.started",
          payload: { nativeType: "tool_call", toolCall },
          occurredAt
        });
      }
    } else if (role === "tool") {
      items.push({
        nativeItemId: `${messageId}:tool-result`,
        type: value.is_error === true ? "tool.failed" : "tool.completed",
        payload: {
          nativeType: "tool_result",
          toolCallId: value.tool_call_id ?? null,
          toolName: value.tool_name ?? null,
          content: value.content ?? null
        },
        occurredAt
      });
    }
  }
  return {
    provider: "hermes",
    nativeSessionId: id,
    title:
      (typeof raw.title === "string" ? raw.title.trim() : "") ||
      firstUserText.trim().replace(/\s+/g, " ").slice(0, 120) ||
      "Hermes thread",
    cwd: typeof raw.cwd === "string" && raw.cwd.length > 0 ? raw.cwd : fallbackCwd,
    archived: raw.archived === true,
    createdAt,
    updatedAt,
    metadata: {
      format: "hermes-session-export-v1",
      source: raw.source ?? null,
      model: raw.model ?? null,
      provider: raw.billing_provider ?? raw.provider ?? null,
      endReason: raw.end_reason ?? null
    },
    items
  };
}

function decodeArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toolId(value: unknown, fallback: number): string {
  return isRecord(value) && (typeof value.id === "string" || typeof value.id === "number")
    ? String(value.id)
    : String(fallback);
}
