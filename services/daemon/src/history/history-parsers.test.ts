import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mapCodexThread, readCodexHistory } from "./codex-history.js";
import { mapClaudeTranscript, readClaudeHistory } from "./claude-history.js";
import { HermesHistoryReader, mapHermesSession, parseHermesExport } from "./hermes-history.js";
import { textContent, timestamp } from "./types.js";

const temporaryDirectories: string[] = [];
afterEach(() => temporaryDirectories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("history parsers", () => {
  it("maps Codex turns without flattening native provenance", () => {
    const thread = mapCodexThread({
      id: "codex-1",
      name: "Native Codex",
      cwd: "/repo",
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_100,
      turns: [{ id: "turn-1", startedAt: 1_700_000_000, items: [
        { id: "u1", type: "userMessage", content: [{ type: "text", text: "hello" }] },
        { id: "a1", type: "agentMessage", text: "world" },
        { id: "t1", type: "commandExecution", status: "completed", command: "pwd" }
      ] }]
    }, false, "/fallback");
    expect(thread).toMatchObject({ nativeSessionId: "codex-1", title: "Native Codex", cwd: "/repo" });
    expect(thread?.items.map((item) => item.type)).toEqual([
      "user.message",
      "assistant.message.completed",
      "tool.completed"
    ]);
  });

  it("paginates active and archived Codex history through the read protocol", async () => {
    const listCalls: Array<Record<string, unknown>> = [];
    const rpc = {
      async request<T>(method: string, params: unknown): Promise<T> {
        const input = params as Record<string, unknown>;
        if (method === "thread/list") {
          listCalls.push(input);
          if (input.archived === false && input.cursor === null) {
            return { data: [{ id: "one" }, { ignored: true }], nextCursor: "next" } as T;
          }
          if (input.archived === false) return { data: [{ id: "two" }], nextCursor: null } as T;
          return { data: [{ id: "archived" }], nextCursor: null } as T;
        }
        return {
          thread: {
            id: input.threadId,
            preview: `Preview ${String(input.threadId)}`,
            turns: []
          }
        } as T;
      }
    };
    const threads = await readCodexHistory(rpc, "/fallback");
    expect(threads.map((thread) => thread.nativeSessionId)).toEqual(["one", "two", "archived"]);
    expect(threads.at(-1)?.archived).toBe(true);
    expect(listCalls).toHaveLength(3);
    expect(mapCodexThread(null, false, "/fallback")).toBeNull();
  });

  it("uses safe Codex fallbacks and preserves failed native tools", () => {
    const thread = mapCodexThread({
      id: "fallback",
      preview: "  Preview title  ",
      createdAt: "invalid",
      turns: [null, { items: [
        null,
        { type: "userMessage", content: [{ type: "input_text", text: "prompt" }, 4] },
        { type: "agentMessage" },
        { type: "fileChange", status: "failed", error: "no" },
        { status: "complete" }
      ] }]
    }, true, "/fallback");
    expect(thread).toMatchObject({ title: "Preview title", cwd: "/fallback", archived: true });
    expect(thread?.items.map((item) => item.type)).toEqual([
      "user.message",
      "assistant.message.completed",
      "tool.failed",
      "tool.completed"
    ]);
  });

  it("maps Claude text, tool use, and tool results", () => {
    const transcript = [
      { type: "user", uuid: "u1", sessionId: "claude-1", cwd: "/repo", timestamp: "2026-08-20T10:00:00Z", message: { role: "user", content: "Fix it" } },
      { type: "assistant", uuid: "a1", sessionId: "claude-1", timestamp: "2026-08-20T10:01:00Z", message: { role: "assistant", model: "sonnet", content: [{ type: "text", text: "Working" }, { type: "tool_use", id: "call-1", name: "Read", input: { path: "x" } }] } },
      { type: "user", uuid: "r1", sessionId: "claude-1", timestamp: "2026-08-20T10:02:00Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }] } }
    ].map((value) => JSON.stringify(value)).join("\n");
    const thread = mapClaudeTranscript(`${transcript}\n{`, "fallback", "/fallback");
    expect(thread).toMatchObject({ nativeSessionId: "claude-1", title: "Fix it", cwd: "/repo" });
    expect(thread?.items.map((item) => item.type)).toEqual([
      "user.message",
      "assistant.message.completed",
      "tool.started",
      "tool.completed"
    ]);
  });

  it("discovers only top-level Claude project transcripts", async () => {
    const root = mkdtempSync(join(tmpdir(), "exarch-claude-history-"));
    temporaryDirectories.push(root);
    expect(await readClaudeHistory(join(root, "missing"), "/fallback")).toEqual([]);
    const config = join(root, "config");
    const project = join(config, "projects", "encoded-project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "session.jsonl"), `${JSON.stringify({
      type: "user",
      sessionId: "session",
      cwd: "/repo",
      timestamp: "2026-08-20T10:00:00Z",
      message: { role: "user", content: "hello" }
    })}\n`);
    writeFileSync(join(project, "ignore.txt"), "not history");
    mkdirSync(join(project, "subagents"));
    writeFileSync(join(project, "subagents", "child.jsonl"), "{}\n");
    symlinkSync(project, join(config, "projects", "linked-project"));
    const threads = await readClaudeHistory(config, "/fallback");
    expect(threads).toHaveLength(1);
    expect(threads[0]?.nativeSessionId).toBe("session");
  });

  it("tolerates sparse Claude records and preserves failed tool results", () => {
    expect(mapClaudeTranscript("\n{broken", "fallback", "/fallback")).toBeNull();
    const raw = [
      { timestamp: 1_700_000_000, message: { role: "assistant", content: "plain answer" } },
      { timestamp: "bad", message: { role: "user", content: [null, { type: "tool_use", input: {} }, { type: "tool_result", is_error: true }] } },
      { type: "system", message: { role: "system", content: 42 } },
      { notAMessage: true }
    ].map((value) => JSON.stringify(value)).join("\n");
    const thread = mapClaudeTranscript(raw, "fallback", "/fallback", "2026-01-01T00:00:00.000Z");
    expect(thread).toMatchObject({ nativeSessionId: "fallback", cwd: "/fallback", title: "Claude Code thread" });
    expect(thread?.items.map((item) => item.type)).toEqual([
      "assistant.message.completed",
      "tool.started",
      "tool.failed"
    ]);
  });

  it("maps Hermes redacted session exports", () => {
    const raw = JSON.stringify({
      id: "hermes-1",
      title: "Hermes native",
      cwd: "/repo",
      started_at: 1_700_000_000,
      last_active: 1_700_000_100,
      messages: [
        { id: 1, role: "user", content: "hello", timestamp: 1_700_000_000 },
        { id: 2, role: "assistant", content: "done", tool_calls: JSON.stringify([{ id: "call-1", name: "terminal" }]), timestamp: 1_700_000_050 },
        { id: 3, role: "tool", tool_call_id: "call-1", content: "ok", timestamp: 1_700_000_060 }
      ]
    });
    const thread = parseHermesExport(`${raw}\n`, "/fallback")[0];
    expect(thread).toMatchObject({ nativeSessionId: "hermes-1", title: "Hermes native", cwd: "/repo" });
    expect(thread?.items.map((item) => item.type)).toEqual([
      "user.message",
      "assistant.message.completed",
      "tool.started",
      "tool.completed"
    ]);
  });

  it("runs the Hermes redacted export command without a shell", async () => {
    const fixture = fileURLToPath(new URL("../../../../tests/fixtures/hermes-history.mjs", import.meta.url));
    const threads = await new HermesHistoryReader({
      executable: process.execPath,
      executableArgsPrefix: [fixture],
      cwd: "/tmp"
    }).readHistory();
    expect(threads).toHaveLength(1);
    expect(threads[0]?.nativeSessionId).toBe("fixture-hermes");
  });

  it("handles sparse Hermes exports and alternate session IDs", () => {
    expect(mapHermesSession(null, "/fallback")).toBeNull();
    expect(mapHermesSession({}, "/fallback")).toBeNull();
    const thread = mapHermesSession({
      session_id: "alternate",
      messages: [
        null,
        { role: "user", content: [{ type: "text", text: "title from user" }] },
        { role: "assistant", content: "", tool_calls: "invalid" },
        { role: "assistant", tool_calls: [{ name: "tool" }] },
        { role: "tool", is_error: true, content: "failed" },
        { role: "system", content: "ignored" }
      ]
    }, "/fallback");
    expect(thread).toMatchObject({ nativeSessionId: "alternate", title: "title from user", cwd: "/fallback" });
    expect(thread?.items.map((item) => item.type)).toEqual(["user.message", "tool.started", "tool.failed"]);
    expect(() => parseHermesExport("not-json", "/fallback")).toThrow();
  });

  it("normalizes timestamps and textual content conservatively", () => {
    const fallback = "2026-01-01T00:00:00.000Z";
    expect(timestamp(1_700_000_000_000, fallback)).toBe("2023-11-14T22:13:20.000Z");
    expect(timestamp("2026-08-20T10:00:00Z", fallback)).toBe("2026-08-20T10:00:00.000Z");
    expect(timestamp({}, fallback)).toBe(fallback);
    expect(textContent("plain")).toBe("plain");
    expect(textContent({})).toBe("");
    expect(textContent([{ type: "text", text: "one" }, { type: "input_text", text: "two" }, null])).toBe("one\ntwo");
  });
});
