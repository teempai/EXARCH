import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeAdapter } from "./claude-adapter.js";

const fixture = fileURLToPath(new URL("../../../../tests/fixtures/line-rpc-provider.mjs", import.meta.url));
const adapters: ClaudeAdapter[] = [];

function adapter(
  home = mkdtempSync(join(tmpdir(), "exarch-claude-home-")),
  env: NodeJS.ProcessEnv = {}
) {
  const value = new ClaudeAdapter({
    executable: process.execPath,
    executableArgsPrefix: [fixture],
    defaultCwd: process.cwd(),
    env: { ...process.env, ...env, FIXTURE_MODE: "claude", NODE_OPTIONS: undefined },
    home
  });
  adapters.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((value) => value.close()));
});

describe("ClaudeAdapter", () => {
  it("pins the supported Claude Code stream protocol", async () => {
    await expect(adapter().probe()).resolves.toMatchObject({
      provider: "claude",
      available: true,
      version: "2.1.87",
      reason: "ready"
    });
  });

  it("does not report an unauthenticated Claude CLI as ready", async () => {
    await expect(adapter(undefined, { FIXTURE_VARIANT: "unauthenticated" }).probe()).resolves.toMatchObject({
      provider: "claude",
      available: false,
      version: "2.1.87",
      reason: "authentication_required",
      detail: expect.stringContaining("claude auth login --claudeai")
    });
  });

  it("offers Claude's documented latest-model aliases", async () => {
    await expect(adapter().listModels()).resolves.toMatchObject([
      { id: "sonnet" },
      { id: "opus" },
      { id: "haiku" }
    ]);
    await expect(adapter().observeCapacity()).resolves.toMatchObject({
      status: "not_reported",
      detail: expect.stringContaining("A separately running Claude Code app or terminal session")
    });
  });

  it("rejects stream protocol drift and reports a missing executable", async () => {
    await expect(adapter(undefined, { FIXTURE_VARIANT: "unsupported" }).probe()).resolves.toMatchObject({
      available: false,
      version: "9.9.9"
    });
    const missing = new ClaudeAdapter({ executable: "/definitely/missing/claude" });
    await expect(missing.probe()).resolves.toMatchObject({ available: false, version: null });
  });

  it("reports the documented settings hierarchy without returning hooks or secrets", async () => {
    const home = mkdtempSync(join(tmpdir(), "exarch-claude-policy-"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { defaultMode: "acceptEdits", allow: ["Read"], deny: ["Bash(rm:*)"] },
        hooks: { PreToolUse: [{ command: "secret-command" }] },
        apiKeyHelper: "secret-helper"
      })
    );
    const policy = await adapter(home).observeEffectivePolicy(process.cwd());
    expect(policy.status).toBe("partial");
    expect(policy.native).toMatchObject({ defaultMode: "acceptEdits", launchPermissionOverrides: [] });
    expect(JSON.stringify(policy.native)).not.toContain("secret-command");
    expect(JSON.stringify(policy.native)).not.toContain("secret-helper");
    expect(JSON.stringify(policy.native)).toContain("hooksPresent");
  });

  it("marks bypass mode and invalid settings explicitly", async () => {
    const bypassHome = mkdtempSync(join(tmpdir(), "exarch-claude-bypass-"));
    mkdirSync(join(bypassHome, ".claude"));
    writeFileSync(
      join(bypassHome, ".claude", "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } })
    );
    await expect(adapter(bypassHome).observeEffectivePolicy()).resolves.toMatchObject({
      status: "partial",
      normalized: { mayExecuteWithoutPrompt: true, reviewer: "bypassPermissions" }
    });

    const invalidHome = mkdtempSync(join(tmpdir(), "exarch-claude-invalid-"));
    mkdirSync(join(invalidHome, ".claude"));
    writeFileSync(join(invalidHome, ".claude", "settings.json"), "not-json");
    await expect(adapter(invalidHome).observeEffectivePolicy()).resolves.toMatchObject({
      status: "unavailable"
    });
  });

  it("does not read the same home settings file as both project and user policy", async () => {
    const home = mkdtempSync(join(tmpdir(), "exarch-claude-home-policy-"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "default" } })
    );
    const policy = await adapter(home).observeEffectivePolicy(home);
    expect(policy.native.layers).toEqual([
      expect.objectContaining({ kind: "user", repositoryControlled: false })
    ]);
  });

  it("reports a checkout-controlled effective mode with explicit provenance", async () => {
    const home = mkdtempSync(join(tmpdir(), "exarch-claude-user-"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "default" } })
    );

    // A hostile checkout writes the layer that used to outrank the user's own.
    const repository = mkdtempSync(join(tmpdir(), "exarch-claude-repo-"));
    mkdirSync(join(repository, ".git"));
    mkdirSync(join(repository, ".claude"));
    writeFileSync(
      join(repository, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } })
    );

    const policy = await adapter(home).observeEffectivePolicy(repository);
    // Claude's documented scalar precedence makes local/project settings
    // effective. The display must not pretend the safer user mode won.
    expect(policy.normalized.reviewer).toBe("bypassPermissions");
    expect(policy.normalized.mayExecuteWithoutPrompt).toBe(true);
    expect(policy.native.repositoryRequestedMode).toBe("bypassPermissions");
    expect(policy.native.effectiveDefaultModeSource).toMatchObject({
      kind: "local",
      repositoryControlled: true
    });
    expect(policy.native.layers).toContainEqual(
      expect.objectContaining({ kind: "local", repositoryControlled: true })
    );
  });

  it("streams tool and text events while keeping the prompt off argv", async () => {
    const value = adapter(undefined, { EXPECTED_MODEL: "claude-sonnet-4" });
    const events = [];
    for await (const event of value.startTurn({
      conversationId: "conv-claude",
      turnId: "turn-claude",
      text: "prompt-only-on-stdin",
      model: "claude-sonnet-4",
      cwd: process.cwd(),
      context: { recentEvents: [], synchronizedThroughSequence: 0 },
      signal: new AbortController().signal
    })) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual([
      "provider.session.bound",
      "tool.started",
      "tool.completed",
      "assistant.message.started",
      "assistant.message.delta",
      "assistant.message.completed"
    ]);
    expect(events.at(-1)?.payload).toEqual({ text: "hello" });
    await expect(value.observeCapacity()).resolves.toMatchObject({
      provider: "claude",
      status: "available",
      windows: [{ id: "seven_day", remainingPercent: 58 }]
    });
  });

  it("resumes the persisted Claude session ID", async () => {
    const text = "What about ”exarch”?";
    const value = adapter(undefined, {
      EXPECTED_RESUME: "claude-session-1",
      EXPECTED_PROMPT: text
    });
    value.bindSession("conv-restored", "claude-session-1", { imported: true }, 30);
    const events = [];
    for await (const event of value.startTurn({
      conversationId: "conv-restored",
      turnId: "turn-restored",
      text,
      cwd: process.cwd(),
      context: {
        recentEvents: [],
        synchronizedThroughSequence: 30,
        cliCommand: "exarch-context --capability-file /private/token"
      },
      signal: new AbortController().signal
    })) events.push(event);
    expect(events.map((event) => event.type)).not.toContain("provider.session.bound");
    expect(events.at(-1)?.type).toBe("assistant.message.completed");
  });

  it("relays unresolved native permissions and resumes with the signed choice", async () => {
    const value = adapter(undefined, { FIXTURE_VARIANT: "approval" });
    const input = turnInput("approval");
    const iterator = value.startTurn(input)[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("provider.session.bound");
    expect((await iterator.next()).value?.type).toBe("tool.started");
    const approval = (await iterator.next()).value;
    expect(approval).toMatchObject({
      type: "approval.requested",
      payload: { choices: ["allow", "deny"], toolName: "Bash", input: { command: "pwd" } }
    });
    await value.respondToApproval({
      turnId: input.turnId,
      requestId: approval?.payload.providerRequestId as string,
      actionCommitment: approval?.payload.actionCommitment as string,
      choice: "allow"
    });
    const remaining = [];
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) remaining.push(event);
    expect(remaining.map((event) => event.type)).toEqual([
      "tool.completed",
      "assistant.message.started",
      "assistant.message.delta",
      "assistant.message.completed"
    ]);
    expect(remaining.at(-1)?.payload).toEqual({ text: "approved" });
  });

  it("handles result-only output, tool failure, provider failure, and interruption", async () => {
    const resultOnly = adapter(undefined, { FIXTURE_VARIANT: "result_only" });
    const resultEvents = [];
    for await (const event of resultOnly.startTurn(turnInput("result-only"))) resultEvents.push(event);
    expect(resultEvents.map((event) => event.type)).toEqual([
      "provider.session.bound",
      "assistant.message.started",
      "assistant.message.delta",
      "assistant.message.completed"
    ]);

    const toolError = adapter(undefined, { FIXTURE_VARIANT: "tool_error" });
    const toolEvents = [];
    for await (const event of toolError.startTurn(turnInput("tool-error"))) toolEvents.push(event);
    expect(toolEvents.map((event) => event.type)).toContain("tool.failed");

    const failed = adapter(undefined, { FIXTURE_VARIANT: "error_result" });
    await expect(async () => {
      for await (const _event of failed.startTurn(turnInput("failed"))) {
        // Drain until failure.
      }
    }).rejects.toThrow("turn failed");

    const hanging = adapter(undefined, { FIXTURE_VARIANT: "hang" });
    const controller = new AbortController();
    const iterator = hanging.startTurn({ ...turnInput("interrupt"), signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    expect((await iterator.next()).value?.type).toBe("provider.session.bound");
    controller.abort();
    await expect(iterator.next()).rejects.toThrow("Turn interrupted");
  });

  it("classifies Claude Code rate-limit events for harness failover", async () => {
    const exhausted = adapter(undefined, { FIXTURE_VARIANT: "usage_limit" });
    await expect(async () => {
      for await (const _event of exhausted.startTurn(turnInput("usage-limit"))) {
        // Drain through the structured rate_limit_event.
      }
    }).rejects.toMatchObject({ name: "ProviderCapacityExhaustedError", provider: "claude" });
    await expect(exhausted.observeCapacity()).resolves.toMatchObject({ status: "exhausted" });
  });
});

function turnInput(text: string) {
  return {
    conversationId: `conv-${text}`,
    turnId: `turn-${text}`,
    text,
    cwd: process.cwd(),
    context: { recentEvents: [], synchronizedThroughSequence: 0 },
    signal: new AbortController().signal
  };
}
