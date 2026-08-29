import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  approvalDecisionSignaturePayload,
  approvalDigest,
  approvalDigestPayload
} from "./approvals.js";

describe("approval protocol", () => {
  it("binds the complete provider request, choices, expiry, decision, and device", () => {
    const digest = approvalDigest({
      approvalId: "approval-1",
      conversationId: "conv-1",
      turnId: "turn-1",
      provider: "codex",
      providerRequestId: "native-1",
      cwd: "/Users/example/project",
      request: { command: "pwd" },
      choices: ["accept", "decline"],
      expiresAt: "2026-08-23T12:05:00.000Z"
    });
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const payload = JSON.parse(
      approvalDecisionSignaturePayload({
        approvalId: "approval-1",
        approvalDigest: digest,
        choice: "accept",
        deviceId: "device-1",
        decidedAt: "2026-08-23T12:01:00.000Z"
      }).toString("utf8")
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      version: 1,
      approvalId: "approval-1",
      approvalDigest: digest,
      choice: "accept",
      deviceId: "device-1"
    });
  });

  it("publishes the exact bytes the digest covers so a client can verify without re-encoding", () => {
    const input = {
      approvalId: "approval-2",
      conversationId: "conv-2",
      turnId: "turn-2",
      provider: "claude" as const,
      providerRequestId: "native-2",
      cwd: "/Users/example/project",
      request: { toolName: "Bash", input: { command: "rm -rf build" } },
      choices: ["allow", "deny"],
      expiresAt: "2026-08-23T12:05:00.000Z"
    };
    const payload = approvalDigestPayload(input);
    expect(`sha256:${createHash("sha256").update(payload).digest("hex")}`).toBe(approvalDigest(input));

    // A device recovers the bound fields by parsing the same bytes, so it never
    // has to reproduce this encoding to know what it is signing.
    const decoded = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
    expect(decoded).toMatchObject({
      version: 1,
      approvalId: "approval-2",
      cwd: "/Users/example/project",
      choices: ["allow", "deny"]
    });
    expect(decoded.request).toEqual(input.request);
  });

  it("changes the digest when the working directory changes", () => {
    const base = {
      approvalId: "approval-3",
      conversationId: "conv-3",
      turnId: "turn-3",
      provider: "codex" as const,
      providerRequestId: "native-3",
      request: { command: "ls" },
      choices: ["accept", "decline"],
      expiresAt: "2026-08-23T12:05:00.000Z"
    };
    expect(approvalDigest({ ...base, cwd: "/Users/example/project" })).not.toBe(
      approvalDigest({ ...base, cwd: "/Users/example/other" })
    );
  });
});
