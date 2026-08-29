import { basename, resolve } from "node:path";
import {
  CanonicalStore,
  redactPayload,
  redactText,
  type HistoryImportItem
} from "../../../../packages/core/src/index.js";
import {
  canonicalJson,
  type Provider
} from "../../../../packages/protocol/src/index.js";
import { createHash } from "node:crypto";
import type { HistoryReader, NativeHistoryThread } from "./types.js";

export interface ProviderImportStatus {
  provider: Provider;
  state: "idle" | "running" | "complete" | "partial" | "failed";
  discovered: number;
  imported: number;
  failedThreads: number;
  insertedItems: number;
  correctedItems: number;
  unchangedItems: number;
  error: string | null;
}

export interface HistoryImportStatus {
  state: "idle" | "running" | "complete" | "partial" | "failed";
  startedAt: string | null;
  completedAt: string | null;
  providers: ProviderImportStatus[];
}

export interface HistoryMonitoringOptions {
  debounceMs?: number;
  reconciliationIntervalMs?: number;
  staleCheckIntervalMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_RECONCILIATION_INTERVAL_MS = 5 * 60_000;
const DEFAULT_STALE_CHECK_INTERVAL_MS = 10_000;
const DATABASE_BUSY_RETRY_DELAYS_MS = [50, 150, 500] as const;

export class HistorySyncService {
  private running: Promise<HistoryImportStatus> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private current: HistoryImportStatus;
  private monitoring = false;
  private stopWatchers: Array<() => void> = [];
  private pendingChanges = new Map<HistoryReader, Set<string>>();
  private changeTimer: NodeJS.Timeout | null = null;
  private reconciliationTimer: NodeJS.Timeout | null = null;
  private changeCheckRunning: Promise<void> | null = null;
  private lastChangeCheckAt = 0;
  private debounceMs = DEFAULT_DEBOUNCE_MS;
  private staleCheckIntervalMs = DEFAULT_STALE_CHECK_INTERVAL_MS;

  constructor(
    private readonly store: CanonicalStore,
    private readonly readers: HistoryReader[],
    private readonly now: () => Date = () => new Date()
  ) {
    this.current = {
      state: "idle",
      startedAt: null,
      completedAt: null,
      providers: readers.map((reader) => emptyProviderStatus(reader.provider))
    };
  }

  status(): HistoryImportStatus {
    return structuredClone(this.current);
  }

  syncAll(): Promise<HistoryImportStatus> {
    if (this.running === null) {
      // Publish the running state synchronously. API callers can now start a
      // full refresh and receive an immediate acknowledgement instead of
      // holding an HTTP request open while every native history is read.
      this.current = {
        state: "running",
        startedAt: this.now().toISOString(),
        completedAt: null,
        providers: this.readers.map((reader) => ({
          ...emptyProviderStatus(reader.provider),
          state: "running"
        }))
      };
      this.running = this.enqueue(() => this.run()).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  startMonitoring(options: HistoryMonitoringOptions = {}): void {
    if (this.monitoring) return;
    this.monitoring = true;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.staleCheckIntervalMs = options.staleCheckIntervalMs ?? DEFAULT_STALE_CHECK_INTERVAL_MS;
    for (const reader of this.readers) {
      if (reader.watchHistory === undefined || reader.readHistoryChanges === undefined) continue;
      this.stopWatchers.push(reader.watchHistory((key) => this.queueHistoryChange(reader, key)));
    }
    const interval = options.reconciliationIntervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS;
    this.reconciliationTimer = setInterval(() => {
      void this.syncAll().catch(() => {});
    }, interval);
    this.reconciliationTimer.unref?.();
  }

  async stopMonitoring(): Promise<void> {
    this.monitoring = false;
    if (this.changeTimer !== null) clearTimeout(this.changeTimer);
    if (this.reconciliationTimer !== null) clearInterval(this.reconciliationTimer);
    this.changeTimer = null;
    this.reconciliationTimer = null;
    for (const stop of this.stopWatchers.splice(0)) stop();
    this.pendingChanges.clear();
    await Promise.allSettled([
      this.running ?? Promise.resolve(),
      this.changeCheckRunning ?? Promise.resolve(),
      this.operationQueue
    ]);
  }

  /**
   * Called from mobile conversation synchronization. The request returns its
   * cached canonical page immediately; this only schedules a lightweight
   * native-file inventory when the previous check is stale.
   */
  requestChangeCheckIfStale(): void {
    const now = this.now().getTime();
    if (now - this.lastChangeCheckAt < this.staleCheckIntervalMs || this.changeCheckRunning !== null) return;
    this.lastChangeCheckAt = now;
    this.changeCheckRunning = this.enqueue(async () => {
      for (const reader of this.readers) {
        if (reader.checkForHistoryChanges === undefined) continue;
        await this.importIncremental(reader, () => reader.checkForHistoryChanges!());
      }
    }).finally(() => {
      this.changeCheckRunning = null;
    });
    void this.changeCheckRunning.catch(() => {});
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => {}, () => {});
    return result;
  }

  private queueHistoryChange(reader: HistoryReader, key: string): void {
    if (!this.monitoring) return;
    const keys = this.pendingChanges.get(reader) ?? new Set<string>();
    keys.add(key);
    this.pendingChanges.set(reader, keys);
    if (this.changeTimer !== null) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.flushHistoryChanges(), this.debounceMs);
    this.changeTimer.unref?.();
  }

  private flushHistoryChanges(): void {
    this.changeTimer = null;
    const changes = [...this.pendingChanges.entries()].map(([reader, keys]) => [reader, [...keys]] as const);
    this.pendingChanges.clear();
    this.lastChangeCheckAt = this.now().getTime();
    const update = this.enqueue(async () => {
      for (const [reader, keys] of changes) {
        if (reader.readHistoryChanges === undefined) continue;
        await this.importIncremental(reader, () => reader.readHistoryChanges!(keys));
      }
    });
    void update.catch(() => {});
  }

  private async importIncremental(
    reader: HistoryReader,
    load: () => Promise<NativeHistoryThread[]>
  ): Promise<void> {
    const status: ProviderImportStatus = { ...emptyProviderStatus(reader.provider), state: "running" };
    try {
      const threads = await load();
      for (const thread of threads) {
        status.discovered += 1;
        try {
          const result = await this.importThreadWithBusyRetry(thread);
          status.imported += 1;
          status.insertedItems += result.inserted;
          status.correctedItems += result.corrected;
          status.unchangedItems += result.unchanged;
        } catch (error) {
          status.failedThreads += 1;
          const message = errorMessage(error);
          const detail = `${thread.nativeSessionId}: ${message}`;
          status.error = status.error === null ? detail : `${status.error}; ${detail}`.slice(0, 2_000);
          this.store.recordHistoryImportFailure({
            provider: reader.provider,
            nativeSessionId: thread.nativeSessionId,
            error: message
          });
        }
      }
      status.state = status.failedThreads === 0 ? "complete" : "partial";
    } catch (error) {
      status.state = "failed";
      status.error = errorMessage(error);
    }
    // A queued full refresh owns the public status from the moment it is
    // accepted. Do not let an older incremental operation briefly overwrite
    // that status with "complete" before the full refresh has actually run.
    if (this.running === null) {
      const existing = this.current.providers.findIndex((candidate) => candidate.provider === reader.provider);
      if (existing === -1) this.current.providers.push(status);
      else this.current.providers[existing] = status;
      this.current.state = aggregateState(this.current.providers);
      this.current.startedAt ??= this.now().toISOString();
      this.current.completedAt = this.now().toISOString();
    }
  }

  private async run(): Promise<HistoryImportStatus> {
    for (const reader of this.readers) {
      const status = this.current.providers.find((candidate) => candidate.provider === reader.provider);
      if (status === undefined) continue;
      try {
        const threads = reader.streamHistory?.() ?? await reader.readHistory();
        for await (const thread of threads) {
          status.discovered += 1;
          try {
            const result = await this.importThreadWithBusyRetry(thread);
            status.imported += 1;
            status.insertedItems += result.inserted;
            status.correctedItems += result.corrected;
            status.unchangedItems += result.unchanged;
          } catch (error) {
            status.failedThreads += 1;
            const message = errorMessage(error);
            const detail = `${thread.nativeSessionId}: ${message}`;
            status.error = status.error === null ? detail : `${status.error}; ${detail}`.slice(0, 2_000);
            this.store.recordHistoryImportFailure({
              provider: reader.provider,
              nativeSessionId: thread.nativeSessionId,
              error: message
            });
          }
        }
        status.state = status.failedThreads === 0 ? "complete" : "partial";
      } catch (error) {
        status.state = "failed";
        status.error = errorMessage(error);
      }
    }
    const failures = this.current.providers.filter((status) => status.state === "failed").length;
    const partials = this.current.providers.filter((status) => status.state === "partial").length;
    this.current.state = failures === 0 && partials === 0
      ? "complete"
      : failures === this.current.providers.length
        ? "failed"
        : "partial";
    this.current.completedAt = this.now().toISOString();
    this.lastChangeCheckAt = this.now().getTime();
    return this.status();
  }

  private importThread(thread: NativeHistoryThread) {
    const cwd = resolve(thread.cwd);
    // This is a laptop-local trust path: the native harness, not the phone,
    // supplies the working directory. The store validates and inherits only
    // that exact directory, and also promotes legacy empty-scope imports.
    const project = this.store.createImportedProject({
      name: basename(cwd) || `${thread.provider} history`,
      repoRoot: cwd
    });
    const metadataRedaction = redactPayload(thread.metadata);
    const titleRedaction = redactText(thread.title);
    const title = titleRedaction.value.slice(0, 500) || `${thread.provider} thread`;
    const items: HistoryImportItem[] = [];
    if (titleRedaction.redacted) {
      const payload = { target: "conversation.title", markers: titleRedaction.markers };
      items.push({
        nativeItemId: "__exarch:conversation-title:redaction",
        type: "security.redaction.applied",
        payload,
        occurredAt: thread.createdAt ?? thread.updatedAt ?? thread.items[0]?.occurredAt ?? "1970-01-01T00:00:00.000Z",
        contentDigest: digest(payload)
      });
    }
    for (const item of thread.items) {
      const redaction = redactPayload(item.payload);
      items.push({
        nativeItemId: item.nativeItemId,
        type: item.type,
        payload: redaction.value,
        occurredAt: item.occurredAt,
        contentDigest: digest({ type: item.type, payload: redaction.value, occurredAt: item.occurredAt })
      });
      if (redaction.redacted) {
        const payload = { targetNativeItemId: item.nativeItemId, markers: redaction.markers };
        items.push({
          nativeItemId: `${item.nativeItemId}:redaction`,
          type: "security.redaction.applied",
          payload,
          occurredAt: item.occurredAt,
          contentDigest: digest(payload)
        });
      }
    }
    const sourceDigest = digest({
      provider: thread.provider,
      nativeSessionId: thread.nativeSessionId,
      title,
      cwd,
      archived: thread.archived,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      metadata: metadataRedaction.value,
      items: items.map((item) => ({ id: item.nativeItemId, digest: item.contentDigest }))
    });
    return this.store.importHistoryThread({
      provider: thread.provider,
      nativeSessionId: thread.nativeSessionId,
      projectId: project.id,
      title,
      archived: thread.archived,
      sourceCreatedAt: thread.createdAt,
      sourceUpdatedAt: thread.updatedAt,
      sourceDigest,
      metadata: {
        ...metadataRedaction.value,
        cwd,
        metadataRedacted: metadataRedaction.redacted,
        titleRedacted: titleRedaction.redacted,
        titleRedactionMarkers: titleRedaction.markers
      },
      items
    });
  }

  private async importThreadWithBusyRetry(thread: NativeHistoryThread) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return this.importThread(thread);
      } catch (error) {
        const delayMs = DATABASE_BUSY_RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined || !isDatabaseBusy(error)) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}

function aggregateState(providers: ProviderImportStatus[]): HistoryImportStatus["state"] {
  if (providers.some((status) => status.state === "running")) return "running";
  if (providers.every((status) => status.state === "idle")) return "idle";
  const failures = providers.filter((status) => status.state === "failed").length;
  const partials = providers.filter((status) => status.state === "partial").length;
  const idle = providers.filter((status) => status.state === "idle").length;
  if (failures === 0 && partials === 0 && idle === 0) return "complete";
  return failures === providers.length ? "failed" : "partial";
}

function emptyProviderStatus(provider: Provider): ProviderImportStatus {
  return {
    provider,
    state: "idle",
    discovered: 0,
    imported: 0,
    failedThreads: 0,
    insertedItems: 0,
    correctedItems: 0,
    unchangedItems: 0,
    error: null
  };
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function isDatabaseBusy(error: unknown): boolean {
  const code = error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
  const message = errorMessage(error).toLowerCase();
  return code === "SQLITE_BUSY" || message.includes("database is locked");
}
