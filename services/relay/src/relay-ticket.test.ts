import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RelayTicketAuthority, createRoutingId } from "./relay-ticket.js";

describe("RelayTicketAuthority", () => {
  it("issues one-use, role-bound, expiring routing tickets", () => {
    let now = new Date("2026-08-23T12:00:00Z");
    const authority = new RelayTicketAuthority(randomBytes(32), () => now);
    const route = createRoutingId();
    const host = authority.issue(route, "host", 2_000);
    authority.consume(host, route, "host");
    expect(() => authority.consume(host, route, "host")).toThrow(/already used/);

    const device = authority.issue(route, "device", 2_000);
    expect(() => authority.consume(device, route, "host")).toThrow(/scope/);
    now = new Date("2026-08-23T12:00:03Z");
    expect(() => authority.consume(device, route, "device")).toThrow(/expired/);
    expect(() => authority.consume("malformed", route, "device")).toThrow(/malformed/);
    expect(() => authority.issue("short", "host")).toThrow(/routing ID/);
    expect(() => authority.issue(route, "host", 999)).toThrow(/lifetime/);
    expect(() => new RelayTicketAuthority(Buffer.alloc(31))).toThrow(/at least 32 bytes/);
    const [payload, signature] = host.split(".") as [string, string];
    const tampered = `${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    expect(() => authority.consume(tampered, route, "host")).toThrow(/signature/);
  });

  it("stops tracking a consumed ticket once it could not be replayed anyway", () => {
    let now = new Date("2026-08-23T12:00:00.000Z");
    const authority = new RelayTicketAuthority(randomBytes(32), () => now, { pruneIntervalMs: 1 });
    const routingId = createRoutingId();
    authority.consume(authority.issue(routingId, "host", 60_000), routingId, "host");
    expect(authority.trackedTicketCount).toBe(1);

    // Past the ticket's own expiry the replay entry is redundant, because
    // consume() rejects the ticket on age before reaching the replay check.
    now = new Date("2026-08-23T12:02:00.000Z");
    authority.consume(authority.issue(routingId, "device", 60_000), routingId, "device");
    expect(authority.trackedTicketCount).toBe(1);
  });

  it("enforces an absolute replay-state ceiling without repeated full scans", () => {
    const authority = new RelayTicketAuthority(randomBytes(32), () => new Date(), {
      maxTrackedTickets: 2,
      pruneIntervalMs: 60_000
    });
    const routingId = createRoutingId();
    authority.consume(authority.issue(routingId, "host"), routingId, "host");
    authority.consume(authority.issue(routingId, "device"), routingId, "device");

    expect(() => authority.consume(
      authority.issue(routingId, "host"),
      routingId,
      "host"
    )).toThrow(/capacity/);
    expect(authority.trackedTicketCount).toBe(2);
  });
});
