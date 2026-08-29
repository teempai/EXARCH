import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "./codex-adapter.js";

const fixture = fileURLToPath(new URL("../../../../tests/fixtures/line-rpc-provider.mjs", import.meta.url));
const adapters: CodexAdapter[] = [];

function adapter(env: NodeJS.ProcessEnv = {}) {
  const value = new CodexAdapter({
    executable: process.execPath,
    executableArgsPrefix: [fixture],
    defaultCwd: process.cwd(),
    env: { ...process.env, ...env, FIXTURE_MODE: "codex", NODE_OPTIONS: undefined }
  });
  adapters.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((value) => value.close()));
});

describe("CodexAdapter", () => {
  it("pins verified app-server versions", async () => {
    const value = adapter();
    await expect(value.probe()).resolves.toMatchObject({
      provider: "codex",
      available: true,
      version: "0.150.0-alpha.12.2",
      reason: "ready"
    });
    await expect(adapter({ FIXTURE_VARIANT: "legacy_supported" }).probe()).resolves.toMatchObject({
      available: true,
      version: "0.149.0-alpha.4.1",
      reason: "ready"
    });
  });

  it("lists visible models reported by the app server", async () => {
    await expect(adapter().listModels()).resolves.toEqual([
      { id: "fixture-model", displayName: "Fixture Model", description: "For tests" }
    ]);
  });

  it("reports live five-hour and weekly subscription capacity", async () => {
    await expect(adapter().observeCapacity()).resolves.toMatchObject({
      provider: "codex",
      status: "available",
      windows: [
        { id: "codex:primary", label: "Codex · 5 hours", remainingPercent: 75 },
        { id: "codex:secondary", label: "Codex · weekly", remainingPercent: 38 }
      ]
    });
    await expect(adapter({ FIXTURE_VARIANT: "capacity_exhausted" }).observeCapacity()).resolves.toMatchObject({
      status: "exhausted"
    });
  });

  it("rejects protocol drift and reports a missing executable", async () => {
    await expect(adapter({ FIXTURE_VARIANT: "unsupported" }).probe()).resolves.toMatchObject({
      available: false,
      version: "9.9.9",
      reason: "unsupported_version"
    });
    const missing = new CodexAdapter({ executable: "/definitely/missing/codex", defaultCwd: process.cwd() });
    await expect(missing.probe()).resolves.toMatchObject({
      available: false,
      version: null,
      reason: "not_installed"
    });
    await expect(missing.observeEffectivePolicy()).resolves.toMatchObject({ status: "unavailable" });
  });

  it("observes only policy-safe config fields and stable provenance", async () => {
    const value = adapter();
    const policy = await value.observeEffectivePolicy(process.cwd());
    expect(policy).toMatchObject({
      provider: "codex",
      status: "verified",
      normalized: { mayExecuteWithoutPrompt: false, sandbox: "workspace-write", reviewer: "user" }
    });
    expect(policy.native).not.toHaveProperty("ignored_secret");
    expect(policy.native.origins).not.toHaveProperty("ignored_secret");
    const second = await value.observeEffectivePolicy(process.cwd());
    expect(second.revision).toBe(policy.revision);
  });

  it("labels incomplete and failed policy introspection honestly", async () => {
    await expect(adapter({ FIXTURE_VARIANT: "partial" }).observeEffectivePolicy()).resolves.toMatchObject({
      status: "partial",
      normalized: { sandbox: null, reviewer: null }
    });
    await expect(adapter({ FIXTURE_VARIANT: "config_error" }).observeEffectivePolicy()).resolves.toMatchObject({
      status: "unavailable"
    });
  });

  it("streams native tool and assistant events and binds the native session", async () => {
    const value = adapter({ EXPECTED_MODEL: "gpt-5.6-sol" });
    const events = [];
    for await (const event of value.startTurn({
      conversationId: "conv-1",
      turnId: "turn-1",
      text: "prompt only over stdin",
      model: "gpt-5.6-sol",
      cwd: process.cwd(),
      context: { recentEvents: [], synchronizedThroughSequence: 0 },
      signal: new AbortController().signal
    })) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual([
      "provider.session.bound",
      "tool.started",
      "tool.output.delta",
      "tool.completed",
      "assistant.message.started",
      "assistant.message.delta",
      "assistant.message.completed"
    ]);
    expect(events.at(-1)?.payload).toEqual({ text: "hello" });
  });

  it("resumes a persisted native session without creating a replacement", async () => {
    const text = "What about ”exarch”?";
    const value = adapter({ EXPECTED_PROMPT: text });
    value.bindSession("conv-restored", "native-thread-1", { imported: true }, 42);
    const events = [];
    for await (const event of value.startTurn({
      conversationId: "conv-restored",
      turnId: "turn-restored",
      text,
      cwd: process.cwd(),
      context: {
        recentEvents: [],
        synchronizedThroughSequence: 42,
        cliCommand: "exarch-context --capability-file /private/token"
      },
      signal: new AbortController().signal
    })) events.push(event);
    expect(events.map((event) => event.type)).not.toContain("provider.session.bound");
    expect(events.at(-1)?.type).toBe("assistant.message.completed");
  });

  it("relays only non-persistent Codex approval decisions", async () => {
    const value = adapter();
    const events = [];
    for await (const event of value.startTurn({
      conversationId: "conv-approval",
      turnId: "turn-approval",
      text: "approval fixture",
      cwd: process.cwd(),
      context: { recentEvents: [], synchronizedThroughSequence: 0 },
      signal: new AbortController().signal
    })) {
      events.push(event);
      if (event.type === "approval.requested") {
        expect(event.payload.choices).toEqual(["accept", "decline", "cancel"]);
        await expect(value.respondToApproval({
          turnId: "turn-approval",
          requestId: event.payload.providerRequestId as string,
          actionCommitment: `sha256:${"0".repeat(64)}`,
          choice: "accept"
        })).rejects.toThrow("commitment mismatch");
        await value.respondToApproval({
          turnId: "turn-approval",
          requestId: event.payload.providerRequestId as string,
          actionCommitment: event.payload.actionCommitment as string,
          choice: "accept"
        });
      }
    }
    expect(events.map((event) => event.type)).toContain("assistant.message.completed");
  });

  it("rejects duplicate native IDs while preserving typed ID identity", async () => {
    const duplicate = adapter();
    await expect(async () => {
      for await (const _event of duplicate.startTurn({
        conversationId: "conv-duplicate",
        turnId: "turn-duplicate",
        text: "duplicate approval fixture",
        cwd: process.cwd(),
        context: { recentEvents: [], synchronizedThroughSequence: 0 },
        signal: new AbortController().signal
      })) {
        // Drain until the duplicate fails the turn.
      }
    }).rejects.toThrow("Duplicate Codex approval request ID");

    const typed = adapter();
    const handles: string[] = [];
    for await (const event of typed.startTurn({
      conversationId: "conv-typed",
      turnId: "turn-typed",
      text: "typed approval fixture",
      cwd: process.cwd(),
      context: { recentEvents: [], synchronizedThroughSequence: 0 },
      signal: new AbortController().signal
    })) {
      if (event.type === "approval.requested") handles.push(event.payload.providerRequestId as string);
    }
    expect(new Set(handles).size).toBe(3);
  });

  it("rejects a native approval ID reused by concurrent turns on one RPC connection", async () => {
    const value = adapter();
    const first = value.startTurn({
      conversationId: "conv-concurrent-1",
      turnId: "turn-concurrent-1",
      text: "approval fixture first turn",
      cwd: process.cwd(),
      context: { recentEvents: [], synchronizedThroughSequence: 0 },
      signal: new AbortController().signal
    })[Symbol.asyncIterator]();

    let firstApprovalSeen = false;
    while (!firstApprovalSeen) {
      const next = await first.next();
      if (next.done) throw new Error("First turn completed before requesting approval");
      firstApprovalSeen = next.value.type === "approval.requested";
    }

    const second = value.startTurn({
      conversationId: "conv-concurrent-2",
      turnId: "turn-concurrent-2",
      text: "approval fixture second turn",
      cwd: process.cwd(),
      context: { recentEvents: [], synchronizedThroughSequence: 0 },
      signal: new AbortController().signal
    });
    await expect(async () => {
      for await (const _event of second) {
        // Drain until the reused connection-wide ID fails closed.
      }
    }).rejects.toThrow("Duplicate Codex approval request ID");
    await first.return?.();
  });

  it("propagates native failure and interruption", async () => {
    const failed = adapter();
    const failedEvents = failed.startTurn({
      conversationId: "conv-failed",
      turnId: "turn-failed",
      text: "failure fixture",
      cwd: process.cwd(),
      context: { recentEvents: [], synchronizedThroughSequence: 0 },
      signal: new AbortController().signal
    });
    await expect(async () => {
      for await (const _event of failedEvents) {
        // Drain until the native failure.
      }
    }).rejects.toThrow("Codex turn failed");

    const interrupted = adapter();
    const controller = new AbortController();
    const iterator = interrupted.startTurn({
      conversationId: "conv-interrupt",
      turnId: "turn-interrupt",
      text: "interrupt fixture",
      cwd: process.cwd(),
      context: { recentEvents: [], synchronizedThroughSequence: 0 },
      signal: controller.signal
    })[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("provider.session.bound");
    controller.abort();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("classifies native usage exhaustion for safe harness failover", async () => {
    const exhausted = adapter({ FIXTURE_VARIANT: "usage_limit" });
    await expect(async () => {
      for await (const _event of exhausted.startTurn({
        conversationId: "conv-limit",
        turnId: "turn-limit",
        text: "continue",
        cwd: process.cwd(),
        context: { recentEvents: [], synchronizedThroughSequence: 0 },
        signal: new AbortController().signal
      })) {
        // Drain through the structured Codex error notification.
      }
    }).rejects.toMatchObject({ name: "ProviderCapacityExhaustedError", provider: "codex" });
  });
});
