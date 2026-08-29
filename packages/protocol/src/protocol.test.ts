import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json.js";
import { MessageRequestSchema, ProviderCapacitySchema } from "./messages.js";
import { PairingChallengeFrameSchema, pairingSas } from "./pairing.js";

const revision = `sha256:${"a".repeat(64)}`;

describe("canonical JSON", () => {
  it("sorts object keys recursively without changing array order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 }, values: [3, 1] })).toBe(
      '{"a":{"b":3,"y":2},"values":[3,1],"z":1}'
    );
  });

  it("rejects values JSON cannot represent deterministically", () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ value: undefined })).toThrow(/undefined/);
  });
});

describe("message protocol", () => {
  const canonicalMessage = {
    clientMessageId: "msg_1",
    text: "Run the tests",
    provider: "codex",
    effectivePolicyRevision: revision
  } as const;

  it("accepts the same text-only request regardless of how text was produced", () => {
    const typed = MessageRequestSchema.parse(canonicalMessage);
    const dictated = MessageRequestSchema.parse({ ...canonicalMessage });
    expect(dictated).toEqual(typed);
    expect(Buffer.from(JSON.stringify(dictated))).toEqual(Buffer.from(JSON.stringify(typed)));
  });

  it.each([
    ["modality", "voice"],
    ["audio", "base64"],
    ["partialTranscript", "Run the"],
    ["voiceMode", true]
  ])("rejects backend voice field %s", (field, value) => {
    expect(() => MessageRequestSchema.parse({ ...canonicalMessage, [field]: value })).toThrow();
  });

  it("rejects unrecognized providers and malformed policy revisions", () => {
    expect(() =>
      MessageRequestSchema.parse({ ...canonicalMessage, provider: "other" })
    ).toThrow();
    expect(() =>
      MessageRequestSchema.parse({ ...canonicalMessage, effectivePolicyRevision: "latest" })
    ).toThrow();
  });
});

describe("provider capacity protocol", () => {
  it("accepts bounded, source-attributed capacity windows", () => {
    expect(ProviderCapacitySchema.parse({
      provider: "claude",
      status: "warning",
      observedAt: "2026-08-24T00:00:00.000Z",
      source: "Claude Code rate_limit_event",
      detail: "Live subscription capacity reported by Claude Code on this Mac.",
      windows: [{
        id: "seven_day",
        label: "Weekly",
        usedPercent: 82,
        remainingPercent: 18,
        resetsAt: "2026-08-25T00:00:00.000Z"
      }]
    }).windows[0]?.remainingPercent).toBe(18);
  });

  it("rejects fabricated out-of-range percentages", () => {
    expect(() => ProviderCapacitySchema.parse({
      provider: "codex",
      status: "available",
      observedAt: "2026-08-24T00:00:00.000Z",
      source: "test",
      detail: "test",
      windows: [{
        id: "weekly",
        label: "Weekly",
        usedPercent: -1,
        remainingPercent: 101,
        resetsAt: null
      }]
    })).toThrow();
  });
});

describe("pairing protocol", () => {
  it("derives an 18-digit SAS from 60 bits of the authenticated transcript", () => {
    const sas = pairingSas(`sha256:${"ff".repeat(32)}`);

    expect(sas).toBe("446744073709551615");
    expect(PairingChallengeFrameSchema.parse({
      version: 1,
      type: "pair.challenge",
      transcriptHash: `sha256:${"f".repeat(64)}`,
      sas,
      hostSignature: "s".repeat(32)
    }).sas).toBe(sas);
  });

  it("rejects the former six-digit SAS format", () => {
    expect(() => PairingChallengeFrameSchema.parse({
      version: 1,
      type: "pair.challenge",
      transcriptHash: `sha256:${"f".repeat(64)}`,
      sas: "123456",
      hostSignature: "s".repeat(32)
    })).toThrow();
  });
});
