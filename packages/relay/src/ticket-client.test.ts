import { describe, expect, it, vi } from "vitest";
import { requestRelayTicket } from "./ticket-client.js";

const routingId = "a".repeat(43);
const accessToken = "access-token-that-is-definitely-longer-than-32-characters";

describe("requestRelayTicket", () => {
  it("validates the HTTPS endpoint and returned route scope", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://relay.example/v1/tickets");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
      return Response.json(
        { routingId, role: "device", ticket: "t".repeat(32) },
        { status: 201 }
      );
    });
    await expect(
      requestRelayTicket(
        "wss://relay.example/v1/relay",
        accessToken,
        { routingId, role: "device" },
        request
      )
    ).resolves.toMatchObject({ routingId, role: "device" });
  });

  it("rejects invalid configuration, status, scope, and oversized responses", async () => {
    await expect(
      requestRelayTicket("https://relay.example/v1/relay", accessToken, {
        routingId,
        role: "host"
      })
    ).rejects.toThrow(/wss/);
    await expect(
      requestRelayTicket("wss://relay.example/wrong", accessToken, { routingId, role: "host" })
    ).rejects.toThrow(/exact/);
    await expect(
      requestRelayTicket("wss://relay.example/v1/relay", "short", { routingId, role: "host" })
    ).rejects.toThrow(/access token/);

    const forbidden = vi.fn<typeof fetch>(async () => new Response("no", { status: 401 }));
    await expect(
      requestRelayTicket(
        "wss://relay.example/v1/relay",
        accessToken,
        { routingId, role: "host" },
        forbidden
      )
    ).rejects.toThrow(/status 401/);

    const wrongScope = vi.fn<typeof fetch>(async () =>
      Response.json(
        { routingId: "b".repeat(43), role: "device", ticket: "t".repeat(32) },
        { status: 201 }
      )
    );
    await expect(
      requestRelayTicket(
        "wss://relay.example/v1/relay",
        accessToken,
        { routingId, role: "host" },
        wrongScope
      )
    ).rejects.toThrow(/scope/);

    const oversized = vi.fn<typeof fetch>(async () =>
      new Response("{}", { status: 201, headers: { "content-length": "9000" } })
    );
    await expect(
      requestRelayTicket(
        "wss://relay.example/v1/relay",
        accessToken,
        { routingId, role: "host" },
        oversized
      )
    ).rejects.toThrow(/exceeds/);
  });
});
