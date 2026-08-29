import { describe, expect, it } from "vitest";
import { ContextCapabilityIssuer, type ContextOperation } from "./capability.js";

describe("ContextCapabilityIssuer", () => {
  const claims = {
    id: "cap_1",
    projectId: "project_1",
    conversationId: "conv_1",
    turnId: "turn_1",
    operations: ["current", "search"] as ContextOperation[],
    lifetimeMs: 60_000
  };

  it("authorizes only the signed scope and operations", () => {
    const issuer = new ContextCapabilityIssuer(Buffer.alloc(32, 7), () => new Date("2026-08-23T12:00:00Z"));
    const token = issuer.issue(claims);
    expect(
      issuer.verify(token, {
        projectId: "project_1",
        conversationId: "conv_1",
        turnId: "turn_1",
        operation: "search"
      }).id
    ).toBe("cap_1");
    expect(() =>
      issuer.verify(token, {
        projectId: "project_2",
        conversationId: "conv_1",
        turnId: "turn_1",
        operation: "search"
      })
    ).toThrow(/scope mismatch/);
    expect(() =>
      issuer.verify(token, {
        projectId: "project_1",
        conversationId: "conv_1",
        turnId: "turn_1",
        operation: "tasks.add"
      })
    ).toThrow(/does not permit/);
  });

  it("rejects modification and expiration", () => {
    let now = new Date("2026-08-23T12:00:00Z");
    const issuer = new ContextCapabilityIssuer(Buffer.alloc(32, 8), () => now);
    const token = issuer.issue(claims);
    const [payload, encodedSignature] = token.split(".") as [string, string];
    const changedSignature = Buffer.from(encodedSignature, "base64url");
    changedSignature[0] = (changedSignature[0] ?? 0) ^ 0x01;
    const modified = `${payload}.${changedSignature.toString("base64url")}`;
    expect(() =>
      issuer.verify(modified, {
        projectId: "project_1",
        conversationId: "conv_1",
        turnId: "turn_1",
        operation: "current"
      })
    ).toThrow(/signature/);
    now = new Date("2026-08-23T12:01:00Z");
    expect(() =>
      issuer.verify(token, {
        projectId: "project_1",
        conversationId: "conv_1",
        turnId: "turn_1",
        operation: "current"
      })
    ).toThrow(/Expired/);
  });

  it("bounds secret and lifetime strength", () => {
    expect(() => new ContextCapabilityIssuer(Buffer.alloc(31))).toThrow(/at least 32/);
    const issuer = new ContextCapabilityIssuer(Buffer.alloc(32));
    expect(() => issuer.issue({ ...claims, lifetimeMs: 3_600_001 })).toThrow(/1 hour/);
  });

  it("rejects malformed token encodings", () => {
    const issuer = new ContextCapabilityIssuer(Buffer.alloc(32, 5));
    expect(() =>
      issuer.verify("not-a-token", {
        projectId: "project_1",
        conversationId: "conv_1",
        turnId: "turn_1",
        operation: "current"
      })
    ).toThrow(/Malformed/);
  });

  it("refuses a revoked capability even though it is still unexpired", () => {
    const issuer = new ContextCapabilityIssuer(Buffer.alloc(32, 7));
    const token = issuer.issue({ ...claims, lifetimeMs: 60_000 });
    const expected = {
      projectId: claims.projectId,
      conversationId: claims.conversationId,
      turnId: claims.turnId,
      operation: "current" as const
    };
    expect(issuer.verify(token, expected).id).toBe(claims.id);

    issuer.revoke(claims.id, new Date(Date.now() + 60_000).toISOString());
    expect(issuer.isRevoked(claims.id)).toBe(true);
    expect(() => issuer.verify(token, expected)).toThrow(/Revoked/);
  });

  it("drops revocations once the capability they cover has expired anyway", () => {
    let now = new Date("2026-08-23T12:00:00.000Z");
    const issuer = new ContextCapabilityIssuer(Buffer.alloc(32, 3), () => now);
    issuer.revoke("audit_expired", new Date("2026-08-23T12:00:30.000Z").toISOString());
    expect(issuer.isRevoked("audit_expired")).toBe(true);

    // Past the covered expiry the entry is no longer load-bearing, because
    // verify() would reject the capability on age alone.
    now = new Date("2026-08-23T12:01:00.000Z");
    issuer.revoke("audit_other", new Date("2026-08-23T12:31:00.000Z").toISOString());
    expect(issuer.isRevoked("audit_expired")).toBe(false);
    expect(issuer.isRevoked("audit_other")).toBe(true);
  });

  it("invalidates every prior-process capability when a new issuer starts", () => {
    const secret = Buffer.alloc(32, 0x44);
    const now = () => new Date("2026-08-23T12:00:00.000Z");
    const first = new ContextCapabilityIssuer(secret, now, Buffer.alloc(32, 1));
    const restarted = new ContextCapabilityIssuer(secret, now, Buffer.alloc(32, 2));
    const token = first.issue(claims);
    const expected = {
      projectId: claims.projectId,
      conversationId: claims.conversationId,
      turnId: claims.turnId,
      operation: "current" as const
    };
    expect(first.verify(token, expected).id).toBe(claims.id);
    expect(() => restarted.verify(token, expected)).toThrow(/signature/);
  });
});
