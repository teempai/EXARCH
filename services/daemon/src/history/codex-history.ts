import type { NativeHistoryItem, NativeHistoryThread } from "./types.js";
import { isRecord, textContent, timestamp } from "./types.js";

export interface CodexHistoryRpc {
  request<T>(method: string, params?: unknown): Promise<T>;
}

interface ThreadListResponse {
  data: unknown[];
  nextCursor?: string | null;
}

const MAX_THREADS = 20_000;

export async function readCodexHistory(
  rpc: CodexHistoryRpc,
  fallbackCwd: string
): Promise<NativeHistoryThread[]> {
  const threads: NativeHistoryThread[] = [];
  for await (const thread of streamCodexHistory(rpc, fallbackCwd)) threads.push(thread);
  return threads;
}

export async function* streamCodexHistory(
  rpc: CodexHistoryRpc,
  fallbackCwd: string
): AsyncIterable<NativeHistoryThread> {
  let threadCount = 0;
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    do {
      const page: ThreadListResponse = await rpc.request<ThreadListResponse>("thread/list", {
        archived,
        cursor,
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc"
      });
      for (const summary of page.data) {
        if (!isRecord(summary) || typeof summary.id !== "string") continue;
        const response = await rpc.request<{ thread: unknown }>("thread/read", {
          threadId: summary.id,
          includeTurns: true
        });
        const mapped = mapCodexThread(response.thread, archived, fallbackCwd);
        if (mapped !== null) {
          threadCount += 1;
          if (threadCount > MAX_THREADS) throw new Error("Codex history exceeds the safe thread limit");
          yield mapped;
        }
      }
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
      if (cursor !== null && seenCursors.has(cursor)) throw new Error("Codex history returned a repeated cursor");
      if (cursor !== null) seenCursors.add(cursor);
    } while (cursor !== null);
  }
}

export function mapCodexThread(
  raw: unknown,
  archived: boolean,
  fallbackCwd: string
): NativeHistoryThread | null {
  if (!isRecord(raw) || typeof raw.id !== "string") return null;
  const createdAt = timestamp(raw.createdAt, new Date(0).toISOString());
  const updatedAt = timestamp(raw.updatedAt, createdAt);
  const items: NativeHistoryItem[] = [];
  const turns = Array.isArray(raw.turns) ? raw.turns : [];
  for (const [turnIndex, value] of turns.entries()) {
    if (!isRecord(value)) continue;
    const turnId = typeof value.id === "string" ? value.id : `turn-${turnIndex}`;
    const turnTime = timestamp(value.startedAt, createdAt);
    const nativeItems = Array.isArray(value.items) ? value.items : [];
    for (const [itemIndex, nativeItem] of nativeItems.entries()) {
      if (!isRecord(nativeItem)) continue;
      const nativeItemId = typeof nativeItem.id === "string"
        ? nativeItem.id
        : `${turnId}:item-${itemIndex}`;
      items.push(mapCodexItem(nativeItemId, turnId, nativeItem, turnTime));
    }
  }
  const preview = typeof raw.preview === "string" ? raw.preview.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  return {
    provider: "codex",
    nativeSessionId: raw.id,
    title: name || preview.slice(0, 120) || "Codex thread",
    cwd: typeof raw.cwd === "string" && raw.cwd.length > 0 ? raw.cwd : fallbackCwd,
    archived,
    createdAt,
    updatedAt,
    metadata: {
      source: raw.source ?? null,
      status: raw.status ?? null,
      sessionId: raw.sessionId ?? null,
      parentThreadId: raw.parentThreadId ?? null,
      ephemeral: raw.ephemeral === true
    },
    items
  };
}

function mapCodexItem(
  nativeItemId: string,
  nativeTurnId: string,
  item: Record<string, unknown>,
  occurredAt: string
): NativeHistoryItem {
  const nativeType = typeof item.type === "string" ? item.type : "unknown";
  if (nativeType === "userMessage") {
    return {
      nativeItemId,
      type: "user.message",
      payload: { text: textContent(item.content), nativeType, nativeTurnId },
      occurredAt
    };
  }
  if (nativeType === "agentMessage") {
    return {
      nativeItemId,
      type: "assistant.message.completed",
      payload: { text: typeof item.text === "string" ? item.text : "", nativeType, nativeTurnId },
      occurredAt
    };
  }
  const failed = item.status === "failed" || item.status === "declined" || item.error !== undefined;
  return {
    nativeItemId,
    type: failed ? "tool.failed" : "tool.completed",
    payload: { nativeType, nativeTurnId, item },
    occurredAt
  };
}
