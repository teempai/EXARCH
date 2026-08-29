import type { EventType, Provider } from "../../../../packages/protocol/src/index.js";

export interface NativeHistoryItem {
  nativeItemId: string;
  type: EventType;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface NativeHistoryThread {
  provider: Provider;
  nativeSessionId: string;
  title: string;
  cwd: string;
  archived: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  metadata: Record<string, unknown>;
  items: NativeHistoryItem[];
}

export interface HistoryReader {
  readonly provider: Provider;
  readHistory(): Promise<NativeHistoryThread[]>;
  streamHistory?(): AsyncIterable<NativeHistoryThread>;
  readHistoryChanges?(keys: readonly string[]): Promise<NativeHistoryThread[]>;
  checkForHistoryChanges?(): Promise<NativeHistoryThread[]>;
  watchHistory?(onChange: (key: string) => void): () => void;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function timestamp(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return new Date(milliseconds).toISOString();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return fallback;
}

export function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!isRecord(part)) return [];
      if (part.type === "text" && typeof part.text === "string") return [part.text];
      if (part.type === "input_text" && typeof part.text === "string") return [part.text];
      return [];
    })
    .join("\n");
}
