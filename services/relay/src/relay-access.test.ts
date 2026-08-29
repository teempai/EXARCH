import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RelayAccessAuthority } from "./relay-access.js";
import { RelayTicketAuthority } from "./relay-ticket.js";

describe("RelayAccessAuthority", () => {
  it("exchanges scoped access capabilities for one-use connection tickets", async () => {
    let now = new Date("2026-08-23T12:00:00Z");
    const tickets = new RelayTicketAuthority(randomBytes(32), () => now);
    const access = new RelayAccessAuthority(randomBytes(32), tickets, () => now);
    const route = access.issueRoute(60_000);
    const host = access.issueTicket(route.hostAccessToken);
    expect(host).toMatchObject({ routingId: route.routingId, role: "host" });
    expect(() => tickets.consume(host.ticket, route.routingId, "host")).not.toThrow();
    const device = access.issueTicket(route.deviceAccessToken);
    expect(device.role).toBe("device");
    await access.revokeRoute(route.hostAccessToken, route.routingId);
    expect(() => access.issueTicket(route.deviceAccessToken)).toThrow(/revoked/);
    now = new Date("2026-08-23T12:01:01Z");
    expect(() => access.issueTicket(route.hostAccessToken)).toThrow(/expired/);
    expect(() => new RelayAccessAuthority(Buffer.alloc(31), tickets)).toThrow(/at least 32 bytes/);
    expect(() => access.issueRoute(999)).toThrow(/lifetime/);
    expect(() => access.issueTicket("malformed")).toThrow(/malformed/);
    const [payload, signature] = route.hostAccessToken.split(".") as [string, string];
    const tampered = `${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    expect(() => access.issueTicket(tampered)).toThrow(/signature/);
  });

  it("accepts already-issued pre-EXARCH access capabilities through the explicit migration verifier", () => {
    const currentSecret = randomBytes(32);
    const legacySecret = randomBytes(32);
    const tickets = new RelayTicketAuthority(randomBytes(32));
    const issuer = new RelayAccessAuthority(legacySecret, tickets);
    const issued = issuer.issueRoute();
    const [payload] = issued.hostAccessToken.split(".") as [string];
    const legacyToken = `${payload}.${createHmac("sha256", legacySecret)
      .update("mobile-remote-agent/relay-access/1\0", "utf8")
      .update(payload, "utf8")
      .digest("base64url")}`;
    const migrated = new RelayAccessAuthority(
      currentSecret,
      tickets,
      () => new Date(),
      undefined,
      [{ secret: legacySecret, domain: "mobile-remote-agent/relay-access/1\0" }]
    );
    expect(migrated.issueTicket(legacyToken)).toMatchObject({
      routingId: issued.routingId,
      role: "host"
    });
  });

  it("rate-limits ticket issuance per access capability", () => {
    const tickets = new RelayTicketAuthority(randomBytes(32));
    const access = new RelayAccessAuthority(randomBytes(32), tickets);
    const route = access.issueRoute();
    for (let index = 0; index < 20; index += 1) {
      expect(access.issueTicket(route.hostAccessToken).role).toBe("host");
    }
    expect(() => access.issueTicket(route.hostAccessToken)).toThrow(/rate/);
    expect(access.issueTicket(route.deviceAccessToken).role).toBe("device");
  });
});
