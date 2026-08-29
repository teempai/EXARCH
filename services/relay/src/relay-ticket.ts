import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "../../../packages/protocol/src/index.js";

export type RelayRole = "host" | "device";

interface RelayTicketPayload {
  version: 1;
  routingId: string;
  role: RelayRole;
  expiresAt: string;
  nonce: string;
}

export class RelayTicketAuthority {
  /**
   * Ticket nonce -> the expiry of the ticket it belonged to. A ticket lives at
   * most five minutes, so an entry past its expiry is redundant: consume()
   * rejects the ticket on age before it ever reaches the replay check. Keeping
   * them anyway made this set grow by one entry per connection for the lifetime
   * of the process.
   */
  private readonly consumed = new Map<string, number>();
  private nextPruneAt = 0;

  constructor(
    private readonly secret: Buffer,
    private readonly now: () => Date = () => new Date(),
    private readonly limits: { maxTrackedTickets?: number; pruneIntervalMs?: number } = {}
  ) {
    if (secret.byteLength < 32) throw new Error("Relay ticket secret must contain at least 32 bytes");
    if (!Number.isSafeInteger(this.maxTrackedTickets) || this.maxTrackedTickets < 1) {
      throw new Error("Relay ticket replay limit is invalid");
    }
    if (!Number.isSafeInteger(this.pruneIntervalMs) || this.pruneIntervalMs < 1) {
      throw new Error("Relay ticket prune interval is invalid");
    }
  }

  issue(routingId: string, role: RelayRole, lifetimeMs = 60_000): string {
    validateRoutingId(routingId);
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1_000 || lifetimeMs > 5 * 60_000) {
      throw new Error("Relay ticket lifetime is outside the allowed range");
    }
    const payload: RelayTicketPayload = {
      version: 1,
      routingId,
      role,
      expiresAt: new Date(this.now().getTime() + lifetimeMs).toISOString(),
      nonce: randomBytes(24).toString("base64url")
    };
    const encoded = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
    return `${encoded}.${this.sign(encoded)}`;
  }

  consume(ticket: string, routingId: string, role: RelayRole): void {
    validateRoutingId(routingId);
    const [encoded, suppliedSignature, extra] = ticket.split(".");
    if (encoded === undefined || suppliedSignature === undefined || extra !== undefined) {
      throw new Error("Relay ticket is malformed");
    }
    const expected = Buffer.from(this.sign(encoded), "base64url");
    const supplied = Buffer.from(suppliedSignature, "base64url");
    if (expected.byteLength !== supplied.byteLength || !timingSafeEqual(expected, supplied)) {
      throw new Error("Relay ticket signature is invalid");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    } catch {
      throw new Error("Relay ticket payload is invalid");
    }
    if (!isTicketPayload(payload)) throw new Error("Relay ticket payload is invalid");
    if (payload.routingId !== routingId || payload.role !== role) {
      throw new Error("Relay ticket scope does not match the connection");
    }
    const expiresAt = Date.parse(payload.expiresAt);
    if (expiresAt <= this.now().getTime()) throw new Error("Relay ticket expired");
    if (this.consumed.has(payload.nonce)) throw new Error("Relay ticket was already used");
    this.pruneConsumed();
    if (this.consumed.size >= this.maxTrackedTickets) {
      throw new Error("Relay ticket replay capacity is exhausted");
    }
    this.consumed.set(payload.nonce, expiresAt);
  }

  /** Visible for tests; the count of replay entries still doing work. */
  get trackedTicketCount(): number {
    return this.consumed.size;
  }

  private pruneConsumed(): void {
    const now = this.now().getTime();
    if (now < this.nextPruneAt) return;
    for (const [nonce, expiry] of this.consumed) {
      if (expiry <= now) this.consumed.delete(nonce);
    }
    this.nextPruneAt = now + this.pruneIntervalMs;
  }

  private get maxTrackedTickets(): number {
    return this.limits.maxTrackedTickets ?? 10_000;
  }

  private get pruneIntervalMs(): number {
    return this.limits.pruneIntervalMs ?? 10_000;
  }

  private sign(encoded: string): string {
    return createHmac("sha256", this.secret).update(encoded, "utf8").digest("base64url");
  }
}

export function createRoutingId(): string {
  return randomBytes(32).toString("base64url");
}

function validateRoutingId(value: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Relay routing ID is invalid");
}

function isTicketPayload(value: unknown): value is RelayTicketPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.routingId === "string" &&
    (candidate.role === "host" || candidate.role === "device") &&
    typeof candidate.expiresAt === "string" &&
    Number.isFinite(Date.parse(candidate.expiresAt)) &&
    typeof candidate.nonce === "string" &&
    candidate.nonce.length >= 32 &&
    Object.keys(candidate).length === 5
  );
}
