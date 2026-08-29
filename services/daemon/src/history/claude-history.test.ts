import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeHistoryReader, mapClaudeTranscript } from "./claude-history.js";

describe("Claude native history", () => {
  it("uses native titles and the stable first session working directory", () => {
    const raw = [
      {
        uuid: "user-1",
        sessionId: "session-1",
        timestamp: "2026-08-23T10:00:00.000Z",
        cwd: "/Users/example/projects",
        message: { role: "user", content: "Please perform a detailed security review" }
      },
      {
        uuid: "assistant-1",
        sessionId: "session-1",
        timestamp: "2026-08-23T10:01:00.000Z",
        cwd: "/Users/example/projects/EXARCH",
        aiTitle: "Generated security title",
        customTitle: "Mobile-remote-agent security review",
        message: { role: "assistant", content: "Review complete" }
      }
    ].map((record) => JSON.stringify(record)).join("\n");

    const thread = mapClaudeTranscript(raw, "fallback", "/fallback");
    expect(thread).toMatchObject({
      nativeSessionId: "session-1",
      title: "Mobile-remote-agent security review",
      cwd: "/Users/example/projects",
      metadata: { titleSource: "customTitle" }
    });
  });

  it("falls back from the AI title to the first user message", () => {
    const withAI = mapClaudeTranscript(
      `${JSON.stringify({ aiTitle: "Native AI title", cwd: "/project", message: { role: "user", content: "Prompt title" } })}\n`,
      "ai-session",
      "/fallback"
    );
    const withoutNativeTitle = mapClaudeTranscript(
      `${JSON.stringify({ cwd: "/project", message: { role: "user", content: "  Prompt   title  " } })}\n`,
      "prompt-session",
      "/fallback"
    );
    expect(withAI?.title).toBe("Native AI title");
    expect(withoutNativeTitle?.title).toBe("Prompt title");
  });

  it("checks and reads only transcripts whose file fingerprint changed", async () => {
    const config = mkdtempSync(join(tmpdir(), "exarch-claude-history-"));
    const project = join(config, "projects", "encoded-project");
    mkdirSync(project, { recursive: true });
    const first = join(project, "first.jsonl");
    const second = join(project, "second.jsonl");
    writeFileSync(first, transcript("first", "First title"));
    writeFileSync(second, transcript("second", "Second title"));
    const reader = new ClaudeHistoryReader(config, "/fallback");

    expect(await reader.readHistory()).toHaveLength(2);
    expect(await reader.checkForHistoryChanges()).toEqual([]);

    appendFileSync(first, `${JSON.stringify({
      uuid: "first-assistant",
      sessionId: "first",
      timestamp: "2026-08-23T10:02:00.000Z",
      cwd: "/project",
      message: { role: "assistant", content: "New answer" }
    })}\n`);
    const changed = await reader.checkForHistoryChanges();
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ nativeSessionId: "first", title: "First title" });
    expect(changed[0]?.items.at(-1)?.payload).toMatchObject({ text: "New answer" });
    expect(await reader.checkForHistoryChanges()).toEqual([]);
  });
});

function transcript(sessionId: string, title: string): string {
  return `${JSON.stringify({
    uuid: `${sessionId}-user`,
    sessionId,
    timestamp: "2026-08-23T10:00:00.000Z",
    cwd: "/project",
    customTitle: title,
    message: { role: "user", content: `Prompt for ${sessionId}` }
  })}\n`;
}
