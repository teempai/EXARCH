import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../../protocol/src/index.js";

export const CONTEXT_OPERATIONS = [
  "current",
  "recent",
  "search",
  "event.show",
  "events.range",
  "decisions.list",
  "decisions.add",
  "decisions.supersede",
  "tasks.list",
  "tasks.add",
  "tasks.complete",
  "repo-state",
  "handoffs"
] as const;

export const CONTEXT_READ_OPERATIONS = [
  "current",
  "recent",
  "search",
  "event.show",
  "events.range",
  "decisions.list",
  "tasks.list",
  "repo-state",
  "handoffs"
] as const satisfies readonly (typeof CONTEXT_OPERATIONS)[number][];

export type ContextOperation = (typeof CONTEXT_OPERATIONS)[number];

export const ContextCapabilityClaimsSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    projectId: z.string().min(1),
    conversationId: z.string().min(1),
    turnId: z.string().min(1),
    operations: z.array(z.enum(CONTEXT_OPERATIONS)).min(1),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true })
  })
  .strict();

export type ContextCapabilityClaims = z.infer<typeof ContextCapabilityClaimsSchema>;
export type ContextCapabilityIssueInput = Omit<
  ContextCapabilityClaims,
  "version" | "issuedAt" | "expiresAt"
> & { lifetimeMs: number };

export class ContextCapabilityIssuer {
  /**
   * Capability identifier -> the expiry it was issued with. A revoked entry can
   * be dropped once that moment passes, because `verify` rejects an expired
   * capability on its own, so the set stays bounded by the number of turns that
   * are still inside their own lifetime.
   */
  private readonly revoked = new Map<string, number>();
  private readonly signingSecret: Buffer;

  constructor(
    secret: Buffer,
    private readonly now: () => Date = () => new Date(),
    instanceNonce: Buffer = randomBytes(32)
  ) {
    if (secret.byteLength < 32) {
      throw new Error("Context capability secret must contain at least 32 bytes");
    }
    if (instanceNonce.byteLength < 32) {
      throw new Error("Context capability instance nonce must contain at least 32 bytes");
    }
    // A copied token must not become valid again after a daemon restart merely
    // because the long-lived Keychain secret is the same. Each issuer instance
    // derives a process-epoch signing key that is intentionally never persisted.
    this.signingSecret = createHmac("sha256", secret)
      .update("exarch/context-capability-instance/1\0")
      .update(instanceNonce)
      .digest();
  }

  static generateSecret(): Buffer {
    return randomBytes(32);
  }

  /**
   * Ends a capability before its expiry. Deleting the capability file is not
   * enough on its own: anything that read the token while the turn was running
   * — the provider child, or whatever it was induced to run — otherwise keeps
   * using it for the remainder of the lifetime (SECURITY.md threat 5.8).
   */
  revoke(capabilityId: string, expiresAt?: string): void {
    if (typeof capabilityId !== "string" || capabilityId.length === 0) return;
    const expiry = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
    this.revoked.set(capabilityId, Number.isFinite(expiry) ? expiry : Number.POSITIVE_INFINITY);
    this.pruneRevoked();
  }

  isRevoked(capabilityId: string): boolean {
    this.pruneRevoked();
    return this.revoked.has(capabilityId);
  }

  private pruneRevoked(): void {
    const now = this.now().getTime();
    for (const [id, expiry] of this.revoked) {
      if (expiry <= now) this.revoked.delete(id);
    }
  }

  issue(input: ContextCapabilityIssueInput): string {
    return this.issueGrant(input).token;
  }

  issueGrant(input: ContextCapabilityIssueInput): {
    token: string;
    claims: ContextCapabilityClaims;
  } {
    if (!Number.isSafeInteger(input.lifetimeMs) || input.lifetimeMs < 1 || input.lifetimeMs > 3_600_000) {
      throw new Error("Context capability lifetime must be between 1ms and 1 hour");
    }
    const issuedAt = this.now();
    const claims = ContextCapabilityClaimsSchema.parse({
      version: 1,
      id: input.id,
      projectId: input.projectId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      operations: [...new Set(input.operations)],
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + input.lifetimeMs).toISOString()
    });
    const encodedClaims = Buffer.from(canonicalJson(claims)).toString("base64url");
    return { token: `${encodedClaims}.${this.sign(encodedClaims)}`, claims };
  }

  verify(
    token: string,
    expected: {
      projectId: string;
      conversationId: string;
      turnId: string;
      operation: ContextOperation;
    }
  ): ContextCapabilityClaims {
    const parts = token.split(".");
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new Error("Malformed context capability");
    }
    const expectedSignature = Buffer.from(this.sign(parts[0]), "base64url");
    const actualSignature = Buffer.from(parts[1], "base64url");
    if (
      expectedSignature.byteLength !== actualSignature.byteLength ||
      !timingSafeEqual(expectedSignature, actualSignature)
    ) {
      throw new Error("Invalid context capability signature");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    } catch {
      throw new Error("Malformed context capability payload");
    }
    const claims = ContextCapabilityClaimsSchema.parse(parsed);
    if (Date.parse(claims.expiresAt) <= this.now().getTime()) {
      throw new Error("Expired context capability");
    }
    this.pruneRevoked();
    if (this.revoked.has(claims.id)) {
      throw new Error("Revoked context capability");
    }
    if (
      claims.projectId !== expected.projectId ||
      claims.conversationId !== expected.conversationId ||
      claims.turnId !== expected.turnId
    ) {
      throw new Error("Context capability scope mismatch");
    }
    if (!claims.operations.includes(expected.operation)) {
      throw new Error(`Context capability does not permit ${expected.operation}`);
    }
    return claims;
  }

  private sign(encodedClaims: string): string {
    return createHmac("sha256", this.signingSecret).update(encodedClaims).digest("base64url");
  }
}
