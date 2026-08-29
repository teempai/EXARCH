import { readdirSync, watch, type FSWatcher } from "node:fs";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { NativeHistoryItem, NativeHistoryThread } from "./types.js";
import type { HistoryReader } from "./types.js";
import { isRecord, textContent, timestamp } from "./types.js";

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_TRANSCRIPT_BYTES = 512 * 1024 * 1024;
const MAX_TRANSCRIPTS = 20_000;

interface ClaudeTranscriptFile {
  path: string;
  size: number;
  mtimeMs: number;
  mtime: string;
}

export class ClaudeHistoryReader implements HistoryReader {
  readonly provider = "claude" as const;
  private readonly fingerprints = new Map<string, string>();

  constructor(
    private readonly configDirectory: string,
    private readonly fallbackCwd: string
  ) {}

  async readHistory(): Promise<NativeHistoryThread[]> {
    const files = await discoverClaudeTranscripts(this.configDirectory);
    const threads = await readClaudeTranscriptFiles(files, this.fallbackCwd);
    this.replaceFingerprints(files);
    return threads;
  }

  async readHistoryChanges(keys: readonly string[]): Promise<NativeHistoryThread[]> {
    if (keys.includes("*")) return this.checkForHistoryChanges();
    const files = await changedClaudeTranscripts(this.configDirectory, keys);
    const threads = await readClaudeTranscriptFiles(files, this.fallbackCwd);
    this.updateFingerprints(files);
    return threads;
  }

  async checkForHistoryChanges(): Promise<NativeHistoryThread[]> {
    const files = await discoverClaudeTranscripts(this.configDirectory);
    const changed = files.filter((file) => this.fingerprints.get(file.path) !== fingerprint(file));
    const threads = await readClaudeTranscriptFiles(changed, this.fallbackCwd);
    this.updateFingerprints(changed);
    return threads;
  }

  watchHistory(onChange: (key: string) => void): () => void {
    const projectsDirectory = join(this.configDirectory, "projects");
    const projectWatchers = new Map<string, FSWatcher>();
    let rootWatcher: FSWatcher | null = null;
    let closed = false;
    const installProjectWatchers = () => {
      if (closed) return;
      let entries;
      try {
        entries = readdirSync(projectsDirectory, { withFileTypes: true });
      } catch {
        onChange("*");
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const directory = join(projectsDirectory, entry.name);
        if (projectWatchers.has(directory)) continue;
        try {
          const watcher = watch(directory, { encoding: "utf8" }, (_event, filename) => {
            if (typeof filename === "string" && filename.endsWith(".jsonl")) {
              onChange(join(directory, filename));
            } else {
              onChange("*");
            }
          });
          watcher.on("error", () => {
            watcher.close();
            projectWatchers.delete(directory);
            onChange("*");
          });
          projectWatchers.set(directory, watcher);
        } catch {
          onChange("*");
        }
      }
    };
    try {
      rootWatcher = watch(projectsDirectory, { encoding: "utf8" }, () => {
        installProjectWatchers();
        onChange("*");
      });
      rootWatcher.on("error", () => {
        rootWatcher?.close();
        rootWatcher = null;
        onChange("*");
      });
      installProjectWatchers();
      return () => {
        closed = true;
        rootWatcher?.close();
        rootWatcher = null;
        for (const watcher of projectWatchers.values()) watcher.close();
        projectWatchers.clear();
      };
    } catch {
      // Startup and periodic reconciliation still cover a missing/unwatchable
      // history directory without making the daemon unavailable.
      return () => {};
    }
  }

  private replaceFingerprints(files: ClaudeTranscriptFile[]): void {
    this.fingerprints.clear();
    this.updateFingerprints(files);
  }

  private updateFingerprints(files: ClaudeTranscriptFile[]): void {
    for (const file of files) this.fingerprints.set(file.path, fingerprint(file));
  }
}

export async function readClaudeHistory(
  configDirectory: string,
  fallbackCwd: string
): Promise<NativeHistoryThread[]> {
  const files = await discoverClaudeTranscripts(configDirectory);
  return readClaudeTranscriptFiles(files, fallbackCwd);
}

async function discoverClaudeTranscripts(configDirectory: string): Promise<ClaudeTranscriptFile[]> {
  const projectsDirectory = join(configDirectory, "projects");
  let projectEntries;
  try {
    projectEntries = await readdir(projectsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const files: ClaudeTranscriptFile[] = [];
  for (const project of projectEntries) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    const directory = join(projectsDirectory, project.name);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(directory, entry.name);
      const details = await stat(path);
      files.push({
        path,
        size: details.size,
        mtimeMs: details.mtimeMs,
        mtime: details.mtime.toISOString()
      });
      if (files.length > MAX_TRANSCRIPTS) throw new Error("Claude history exceeds the safe transcript limit");
    }
  }
  return boundedClaudeTranscripts(files);
}

async function changedClaudeTranscripts(
  configDirectory: string,
  keys: readonly string[]
): Promise<ClaudeTranscriptFile[]> {
  const projectsDirectory = resolve(configDirectory, "projects");
  const files: ClaudeTranscriptFile[] = [];
  for (const key of new Set(keys)) {
    const path = resolve(key);
    const difference = relative(projectsDirectory, path);
    const segments = difference.split(sep);
    if (difference.startsWith("..") || segments.length !== 2 || !path.endsWith(".jsonl")) continue;
    try {
      const parent = await lstat(resolve(path, ".."));
      const details = await lstat(path);
      if (!parent.isDirectory() || parent.isSymbolicLink() || !details.isFile() || details.isSymbolicLink()) continue;
      files.push({
        path,
        size: details.size,
        mtimeMs: details.mtimeMs,
        mtime: details.mtime.toISOString()
      });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return boundedClaudeTranscripts(files);
}

function boundedClaudeTranscripts(files: ClaudeTranscriptFile[]): ClaudeTranscriptFile[] {
  let totalBytes = 0;
  const bounded: ClaudeTranscriptFile[] = [];
  for (const file of files) {
    if (file.size > MAX_TRANSCRIPT_BYTES) continue;
    totalBytes += file.size;
    if (totalBytes > MAX_TOTAL_TRANSCRIPT_BYTES) {
      throw new Error("Claude history exceeds the safe total size limit");
    }
    bounded.push(file);
  }
  return bounded;
}

async function readClaudeTranscriptFiles(
  files: ClaudeTranscriptFile[],
  fallbackCwd: string
): Promise<NativeHistoryThread[]> {
  const threads: NativeHistoryThread[] = [];
  for (const file of files) {
    const raw = await readFile(file.path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_TRANSCRIPT_BYTES) continue;
    const mapped = mapClaudeTranscript(
      raw,
      basename(file.path, ".jsonl"),
      fallbackCwd,
      file.mtime
    );
    if (mapped !== null) threads.push(mapped);
  }
  return threads;
}

function fingerprint(file: ClaudeTranscriptFile): string {
  return `${file.size}:${file.mtimeMs}`;
}

export function mapClaudeTranscript(
  raw: string,
  fallbackSessionId: string,
  fallbackCwd: string,
  fallbackTimestamp = new Date().toISOString()
): NativeHistoryThread | null {
  const records: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) records.push(value);
    } catch {
      // Claude may leave a partial final line if the process is interrupted.
    }
  }
  if (records.length === 0) return null;
  const sessionId = records.find((record) => typeof record.sessionId === "string")?.sessionId;
  const nativeSessionId = typeof sessionId === "string" ? sessionId : fallbackSessionId;
  // A Claude session can traverse several repositories. Its first recorded
  // working directory is the stable native project root; the last record is
  // merely where the most recent tool happened to run.
  const cwdValue = records.find((record) => typeof record.cwd === "string")?.cwd;
  const cwd = typeof cwdValue === "string" && cwdValue.length > 0 ? cwdValue : fallbackCwd;
  const items: NativeHistoryItem[] = [];
  let firstUserText = "";
  for (const [recordIndex, record] of records.entries()) {
    const message = isRecord(record.message) ? record.message : null;
    if (message === null) continue;
    const role = typeof message.role === "string" ? message.role : record.type;
    const baseId = typeof record.uuid === "string" ? record.uuid : `${nativeSessionId}:${recordIndex}`;
    const occurredAt = timestamp(record.timestamp, fallbackTimestamp);
    const content = message.content;
    const text = textContent(content);
    if (role === "user" && text.length > 0) {
      if (firstUserText === "") firstUserText = text;
      items.push({
        nativeItemId: `${baseId}:text`,
        type: "user.message",
        payload: { text, nativeType: "user", parentUuid: record.parentUuid ?? null },
        occurredAt
      });
    } else if (role === "assistant" && text.length > 0) {
      items.push({
        nativeItemId: `${baseId}:text`,
        type: "assistant.message.completed",
        payload: { text, nativeType: "assistant", model: message.model ?? null },
        occurredAt
      });
    }
    if (!Array.isArray(content)) continue;
    for (const [partIndex, part] of content.entries()) {
      if (!isRecord(part)) continue;
      if (part.type === "tool_use") {
        items.push({
          nativeItemId: `${baseId}:tool-use:${typeof part.id === "string" ? part.id : partIndex}`,
          type: "tool.started",
          payload: { nativeType: "tool_use", toolCallId: part.id ?? null, name: part.name ?? null, input: part.input ?? null },
          occurredAt
        });
      } else if (part.type === "tool_result") {
        items.push({
          nativeItemId: `${baseId}:tool-result:${typeof part.tool_use_id === "string" ? part.tool_use_id : partIndex}`,
          type: part.is_error === true ? "tool.failed" : "tool.completed",
          payload: {
            nativeType: "tool_result",
            toolCallId: part.tool_use_id ?? null,
            content: part.content ?? null
          },
          occurredAt
        });
      }
    }
  }
  const times = records.map((record) => timestamp(record.timestamp, fallbackTimestamp)).sort();
  const customTitle = latestTitle(records, "customTitle");
  const aiTitle = latestTitle(records, "aiTitle");
  return {
    provider: "claude",
    nativeSessionId,
    title:
      customTitle ||
      aiTitle ||
      firstUserText.trim().replace(/\s+/g, " ").slice(0, 120) ||
      "Claude Code thread",
    cwd,
    archived: false,
    createdAt: times[0] ?? fallbackTimestamp,
    updatedAt: times.at(-1) ?? fallbackTimestamp,
    metadata: {
      format: "claude-code-jsonl",
      recordCount: records.length,
      titleSource: customTitle ? "customTitle" : aiTitle ? "aiTitle" : "first-user-message"
    },
    items
  };
}

function latestTitle(records: Record<string, unknown>[], field: "customTitle" | "aiTitle"): string {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const value = records[index]?.[field];
    if (typeof value === "string" && value.trim().length > 0) return value.trim().slice(0, 500);
  }
  return "";
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
