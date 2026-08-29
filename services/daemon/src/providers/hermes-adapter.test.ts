import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HermesAdapter } from "./hermes-adapter.js";

const fixture = fileURLToPath(new URL("../../../../tests/fixtures/line-rpc-provider.mjs", import.meta.url));
const adapters: HermesAdapter[] = [];

function adapter(env: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), "exarch-hermes-"));
  mkdirSync(join(directory, "hermes-agent"));
  const config = join(directory, "config.yaml");
  writeFileSync(config, "approvals:\n  mode: smart\n");
  writeFileSync(
    join(directory, "provider_models_cache.json"),
    JSON.stringify({ openrouter: { models: ["openai/gpt-5.6-terra", "x-ai/grok-4.6"] } })
  );
  const value = new HermesAdapter({
    executable: process.execPath,
    executableArgsPrefix: [fixture],
    gatewayExecutable: process.execPath,
    gatewayArgs: [fixture],
    installRoot: join(directory, "hermes-agent"),
    defaultCwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
      FIXTURE_MODE: "hermes",
      HERMES_FIXTURE_CONFIG: config,
      EXPECTED_GATEWAY_CWD: realpathSync(join(directory, "hermes-agent")),
      EXPECTED_PYTHONSAFEPATH: "1",
      NODE_OPTIONS: undefined
    }
  });
  adapters.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((value) => value.close()));
});

describe("HermesAdapter", () => {
  it("pins the structured gateway version and observes the canonical approval resolver", async () => {
    const value = adapter();
    await expect(value.probe()).resolves.toMatchObject({
      provider: "hermes",
      available: true,
      version: "0.20.5"
    });
    const policy = await value.observeEffectivePolicy(process.cwd());
    expect(policy).toMatchObject({
      status: "verified",
      native: { approvals_mode: "smart", process_yolo: false, launch_overrides: [] },
      normalized: { mayExecuteWithoutPrompt: false, reviewer: "smart" }
    });
  });

  it("lists models from the configured Hermes provider cache", async () => {
    await expect(adapter().listModels()).resolves.toMatchObject([
      { id: "openai/gpt-5.6-terra" },
      { id: "x-ai/grok-4.6" }
    ]);
  });

  it("rejects gateway protocol drift and reports missing Hermes", async () => {
    await expect(adapter({ FIXTURE_VARIANT: "unsupported" }).probe()).resolves.toMatchObject({
      available: false,
      version: "9.9.9"
    });
    const missing = new HermesAdapter({ executable: "/definitely/missing/hermes" });
    await expect(missing.probe()).resolves.toMatchObject({ available: false, version: null });
    await expect(missing.observeEffectivePolicy()).resolves.toMatchObject({ status: "unavailable" });
  });

  it("makes bypass authority conspicuous and rejects unknown modes", async () => {
    await expect(adapter({ FIXTURE_VARIANT: "off" }).observeEffectivePolicy()).resolves.toMatchObject({
      status: "verified",
      normalized: { mayExecuteWithoutPrompt: true, reviewer: "off" }
    });
    await expect(
      adapter({ FIXTURE_VARIANT: "invalid_mode" }).observeEffectivePolicy()
    ).resolves.toMatchObject({ status: "unavailable" });
  });

  it("relays one-time native approval choices and structured turn events", async () => {
    const value = adapter({ EXPECTED_MODEL: "openai/gpt-5" });
    const events = [];
    for await (const event of value.startTurn({
      conversationId: "conv-hermes",
      turnId: "turn-hermes",
      text: "prompt-only-on-stdin",
      model: "openai/gpt-5",
      cwd: process.cwd(),
      context: { recentEvents: [], synchronizedThroughSequence: 0 },
      signal: new AbortController().signal
    })) {
      events.push(event);
      if (event.type === "approval.requested") {
        expect(event.payload.choices).toEqual(["once", "deny"]);
        await expect(value.respondToApproval({
          turnId: "turn-hermes",
          requestId: event.payload.providerRequestId as string,
          actionCommitment: `sha256:${"0".repeat(64)}`,
          choice: "once"
        })).rejects.toThrow("commitment mismatch");
        await value.respondToApproval({
          turnId: "turn-hermes",
          requestId: event.payload.providerRequestId as string,
          actionCommitment: event.payload.actionCommitment as string,
          choice: "once"
        });
      }
    }
    expect(events.map((event) => event.type)).toEqual([
      "provider.session.bound",
      "tool.started",
      "approval.requested",
      "tool.completed",
      "assistant.message.started",
      "assistant.message.delta",
      "assistant.message.completed"
    ]);
  });

  it("fails a turn closed instead of overwriting a duplicate native approval ID", async () => {
    const value = adapter({ FIXTURE_VARIANT: "duplicate_approval" });
    await expect(async () => {
      for await (const _event of value.startTurn(turnInput("duplicate"))) {
        // Drain until duplicate detection fails the provider queue.
      }
    }).rejects.toThrow("Duplicate Hermes approval request ID");
  });

  it("resumes a persisted Hermes stored session before prompting", async () => {
    const text = "What about ”exarch”?";
    const value = adapter({ EXPECTED_PROMPT: text });
    value.bindSession("conv-restored", "stored-session-1", { imported: true }, 20);
    const events = [];
    for await (const event of value.startTurn({
      conversationId: "conv-restored",
      turnId: "turn-restored",
      text,
      cwd: process.cwd(),
      context: {
        recentEvents: [],
        synchronizedThroughSequence: 20,
        cliCommand: "exarch-context --capability-file /private/token"
      },
      signal: new AbortController().signal
    })) {
      events.push(event);
      if (event.type === "approval.requested") {
        await value.respondToApproval({
          turnId: "turn-restored",
          requestId: event.payload.providerRequestId as string,
          actionCommitment: event.payload.actionCommitment as string,
          choice: "once"
        });
      }
    }
    expect(events.map((event) => event.type)).not.toContain("provider.session.bound");
    expect(events.at(-1)?.type).toBe("assistant.message.completed");
  });

  it("rejects choices Hermes offered only as persistent grants", async () => {
    const value = adapter();
    const iterator = value.startTurn({
      conversationId: "conv-hermes-deny-persistent",
      turnId: "turn-hermes-deny-persistent",
      text: "test",
      cwd: process.cwd(),
      context: { recentEvents: [], synchronizedThroughSequence: 0 },
      signal: new AbortController().signal
    })[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("provider.session.bound");
    expect((await iterator.next()).value?.type).toBe("tool.started");
    const approval = (await iterator.next()).value;
    expect(approval?.type).toBe("approval.requested");
    await expect(
      value.respondToApproval({
        turnId: "turn-hermes-deny-persistent",
        requestId: approval?.payload.providerRequestId as string,
        actionCommitment: approval?.payload.actionCommitment as string,
        choice: "always"
      })
    ).rejects.toThrow("not offered");
    await value.respondToApproval({
      turnId: "turn-hermes-deny-persistent",
      requestId: approval?.payload.providerRequestId as string,
      actionCommitment: approval?.payload.actionCommitment as string,
      choice: "deny"
    });
    while (!(await iterator.next()).done) {
      // Drain the completed fixture turn.
    }
  });

  it("maps native tool failure, gateway failure, and interruption", async () => {
    const toolError = adapter({ FIXTURE_VARIANT: "tool_error" });
    const toolTypes = [];
    for await (const event of approvingTurn(toolError, "tool-error")) toolTypes.push(event.type);
    expect(toolTypes).toContain("tool.failed");

    const gatewayError = adapter({ FIXTURE_VARIANT: "gateway_error" });
    await expect(async () => {
      for await (const _event of gatewayError.startTurn(turnInput("gateway-error"))) {
        // Drain until error.
      }
    }).rejects.toThrow("gateway failed");

    const hanging = adapter({ FIXTURE_VARIANT: "hang" });
    const controller = new AbortController();
    const iterator = hanging.startTurn({ ...turnInput("interrupt"), signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    expect((await iterator.next()).value?.type).toBe("provider.session.bound");
    controller.abort();
    await expect(iterator.next()).rejects.toThrow("Turn interrupted");
  });

  it("classifies active-provider exhaustion for harness failover", async () => {
    const exhausted = adapter({ FIXTURE_VARIANT: "usage_limit" });
    await expect(async () => {
      for await (const _event of exhausted.startTurn(turnInput("usage-limit"))) {
        // Drain through the Hermes provider error.
      }
    }).rejects.toMatchObject({ name: "ProviderCapacityExhaustedError", provider: "hermes" });
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

async function* approvingTurn(value: HermesAdapter, text: string) {
  for await (const event of value.startTurn(turnInput(text))) {
    yield event;
    if (event.type === "approval.requested") {
      await value.respondToApproval({
        turnId: `turn-${text}`,
        requestId: event.payload.providerRequestId as string,
        actionCommitment: event.payload.actionCommitment as string,
        choice: "once"
      });
    }
  }
}
