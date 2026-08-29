import { describe, expect, it } from "vitest";
import { redactPayload } from "../../../../packages/core/src/index.js";
import {
  ProviderCapacityExhaustedError,
  providerApprovalActionCommitment,
  providerApprovalHandle,
  providerEventSize,
  providerProbeFailure
} from "./provider-adapter.js";

describe("provider approval identity", () => {
  it("keeps exact raw actions distinct when their display redacts identically", () => {
    const first = { method: "run", params: { password: "first-secret" } };
    const second = { method: "run", params: { password: "second-secret" } };

    expect(redactPayload(first).value).toEqual(redactPayload(second).value);
    expect(providerApprovalActionCommitment(first)).not.toBe(
      providerApprovalActionCommitment(second)
    );
  });

  it("preserves native request ID type in opaque approval handles", () => {
    expect(providerApprovalHandle({ id: 1 })).not.toBe(providerApprovalHandle({ id: "1" }));
  });
});

describe("provider diagnostics", () => {
  it("distinguishes missing executables, timeout codes, and timeout messages", () => {
    expect(providerProbeFailure("codex", "Codex", Object.assign(new Error("missing"), {
      code: "ENOENT"
    }))).toMatchObject({ available: false, reason: "not_installed" });

    expect(providerProbeFailure("claude", "Claude Code", Object.assign(new Error("late"), {
      code: "ETIMEDOUT"
    }))).toMatchObject({ available: false, reason: "probe_timed_out" });

    expect(providerProbeFailure("hermes", "Hermes", Object.assign(new Error("Version check timed out"), {
      code: 60
    }))).toMatchObject({ available: false, reason: "probe_timed_out" });
  });

  it("uses bounded truthful detail for ordinary and opaque probe failures", () => {
    expect(providerProbeFailure("codex", "Codex", new Error("process exited 1"))).toMatchObject({
      reason: "probe_failed",
      detail: "Codex version check failed: process exited 1"
    });
    expect(providerProbeFailure("claude", "Claude Code", new Error("   "))).toMatchObject({
      reason: "probe_failed",
      detail: "Claude Code version check failed: unknown process error"
    });
    expect(providerProbeFailure("hermes", "Hermes", null)).toMatchObject({
      reason: "probe_failed",
      detail: "Hermes version check failed: unknown process error"
    });
    expect(providerProbeFailure("hermes", "Hermes", "opaque failure")).toMatchObject({
      reason: "probe_failed",
      detail: "Hermes version check failed: unknown process error"
    });
    expect(providerProbeFailure("hermes", "Hermes", { detail: "opaque" })).toMatchObject({
      reason: "probe_failed",
      detail: "Hermes version check failed: unknown process error"
    });
  });

  it("retains structured capacity state and measures normalized event bytes", () => {
    const capacity = {
      provider: "codex" as const,
      status: "exhausted" as const,
      detail: "Weekly capacity exhausted",
      observedAt: "2026-08-29T00:00:00.000Z",
      source: "provider-native",
      windows: []
    };
    expect(new ProviderCapacityExhaustedError("codex", capacity)).toMatchObject({
      name: "ProviderCapacityExhaustedError",
      message: capacity.detail,
      provider: "codex",
      retrySafe: false
    });
    expect(new ProviderCapacityExhaustedError("codex", capacity, true).retrySafe).toBe(true);

    const event = { type: "assistant.message.completed" as const, payload: { text: "hello" } };
    expect(providerEventSize(event)).toBe(Buffer.byteLength(JSON.stringify(event), "utf8"));
  });
});
