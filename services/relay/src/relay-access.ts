import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "../../../packages/protocol/src/index.js";
import { RelayTicketAuthority, createRoutingId, type RelayRole } from "./relay-ticket.js";
import {
  MemoryRelayRevocationStore,
  type RelayRevocationStore
} from "./relay-revocation-store.js";

interface AccessPayload {
  version: 1;
  kind: "relay-access";
  routingId: string;
  role: RelayRole;
  expiresAt: string;
  tokenId: string;
}

export interface LegacyRelayAccessVerifier {
  secret: Buffer;
  domain: string;
}

export interface RelayRouteCredentials {
  routingId: string;
  expiresAt: string;
  hostAccessToken: string;
  deviceAccessToken: string;
  hostTicket: string;
  deviceTicket: string;
}

export class RelayAccessAuthority {
  private readonly ticketBuckets = new Map<string, { windowStartedAt: number; count: number }>();

  constructor(
    private readonly secret: Buffer,
    private readonly tickets: RelayTicketAuthority,
    private readonly now: () => Date = () => new Date(),
    private readonly revokedRoutes: RelayRevocationStore = new MemoryRelayRevocationStore(),
    private readonly legacyVerifiers: readonly LegacyRelayAccessVerifier[] = []
  ) {
    if (secret.byteLength < 32) throw new Error("Relay access secret must contain at least 32 bytes");
    if (legacyVerifiers.some((verifier) => verifier.secret.byteLength < 32 || verifier.domain.length < 1)) {
      throw new Error("Legacy relay access verifiers are invalid");
    }
  }

  issueRoute(lifetimeMs = 90 * 24 * 60 * 60_000): RelayRouteCredentials {
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 60_000 || lifetimeMs > 366 * 24 * 60 * 60_000) {
      throw new Error("Relay access lifetime is outside the allowed range");
    }
    const routingId = createRoutingId();
    const expiresAt = new Date(this.now().getTime() + lifetimeMs).toISOString();
    return {
      routingId,
      expiresAt,
      hostAccessToken: this.issueAccess(routingId, "host", expiresAt),
      deviceAccessToken: this.issueAccess(routingId, "device", expiresAt),
      hostTicket: this.tickets.issue(routingId, "host"),
      deviceTicket: this.tickets.issue(routingId, "device")
    };
  }

  issueTicket(accessToken: string): { routingId: string; role: RelayRole; ticket: string } {
    const payload = this.verifyAccess(accessToken);
    this.consumeTicketBudget(payload.tokenId);
    return {
      routingId: payload.routingId,
      role: payload.role,
      ticket: this.tickets.issue(payload.routingId, payload.role)
    };
  }

  private consumeTicketBudget(tokenId: string): void {
    const now = this.now().getTime();
    const existing = this.ticketBuckets.get(tokenId);
    const bucket = existing === undefined || now - existing.windowStartedAt >= 10_000
      ? { windowStartedAt: now, count: 0 }
      : existing;
    if (existing === undefined && this.ticketBuckets.size >= 10_000) {
      for (const [id, candidate] of this.ticketBuckets) {
        if (now - candidate.windowStartedAt >= 10_000) this.ticketBuckets.delete(id);
      }
      if (this.ticketBuckets.size >= 10_000) throw new Error("Relay ticket issuance capacity is exhausted");
    }
    bucket.count += 1;
    if (bucket.count > 20) throw new Error("Relay ticket issuance rate exceeded");
    this.ticketBuckets.set(tokenId, bucket);
  }

  async revokeRoute(hostAccessToken: string, expectedRoutingId: string): Promise<void> {
    const payload = this.verifyAccess(hostAccessToken, true);
    if (payload.role !== "host" || payload.routingId !== expectedRoutingId) {
      throw new Error("Only the matching host capability can revoke a relay route");
    }
    await this.revokedRoutes.add(payload.routingId);
  }

  isRouteRevoked(routingId: string): boolean {
    return this.revokedRoutes.has(routingId);
  }

  private issueAccess(routingId: string, role: RelayRole, expiresAt: string): string {
    const payload: AccessPayload = {
      version: 1,
      kind: "relay-access",
      routingId,
      role,
      expiresAt,
      tokenId: randomBytes(24).toString("base64url")
    };
    const encoded = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
    return `${encoded}.${this.sign(encoded)}`;
  }

  private verifyAccess(token: string, allowRevokedRoute = false): AccessPayload {
    const [encoded, suppliedSignature, extra] = token.split(".");
    if (encoded === undefined || suppliedSignature === undefined || extra !== undefined) {
      throw new Error("Relay access token is malformed");
    }
    const supplied = Buffer.from(suppliedSignature, "base64url");
    const validSignature = [
      Buffer.from(this.sign(encoded), "base64url"),
      ...this.legacyVerifiers.map((verifier) =>
        Buffer.from(this.sign(encoded, verifier.secret, verifier.domain), "base64url")
      )
    ].some((expected) => expected.byteLength === supplied.byteLength && timingSafeEqual(expected, supplied));
    if (!validSignature) {
      throw new Error("Relay access token signature is invalid");
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    } catch {
      throw new Error("Relay access token payload is invalid");
    }
    if (!isAccessPayload(value)) throw new Error("Relay access token payload is invalid");
    if (Date.parse(value.expiresAt) <= this.now().getTime()) throw new Error("Relay access token expired");
    if (!allowRevokedRoute && this.revokedRoutes.has(value.routingId)) throw new Error("Relay route revoked");
    return value;
  }

  private sign(encoded: string, secret = this.secret, domain = "exarch/relay-access/1\0"): string {
    return createHmac("sha256", secret)
      .update(domain, "utf8")
      .update(encoded, "utf8")
      .digest("base64url");
  }
}

function isAccessPayload(value: unknown): value is AccessPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    candidate.kind === "relay-access" &&
    typeof candidate.routingId === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(candidate.routingId) &&
    (candidate.role === "host" || candidate.role === "device") &&
    typeof candidate.expiresAt === "string" &&
    Number.isFinite(Date.parse(candidate.expiresAt)) &&
    typeof candidate.tokenId === "string" &&
    /^[A-Za-z0-9_-]{32}$/.test(candidate.tokenId) &&
    Object.keys(candidate).length === 6
  );
}
