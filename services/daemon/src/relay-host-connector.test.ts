import { generateKeyPair } from "@libp2p/crypto/keys";
import { describe, expect, it, vi } from "vitest";
import { NoiseEndpoint } from "../../../packages/relay/src/index.js";
import { RelayHostConnector, type RelayConnectorState } from "./relay-host-connector.js";

describe("RelayHostConnector", () => {
  it("reports a failed connection, waits interruptibly, and stops", async () => {
    const host = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const device = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const controller = new AbortController();
    const states: RelayConnectorState[] = [];
    const requestTicket = vi.fn(async () => {
      throw new Error("relay unavailable");
    });
    const connector = new RelayHostConnector({
      relayWebSocketUrl: "wss://relay.example/v1/relay",
      routingId: "a".repeat(43),
      accessToken: "access-token-that-is-definitely-longer-than-32-characters",
      endpoint: host,
      expectedDevicePeer: device.peerId,
      laptopBaseUrl: "http://127.0.0.1:43120",
      requestTicket,
      onState(state) {
        states.push(state);
        if (state === "reconnecting") controller.abort();
      }
    });
    await connector.run(controller.signal);
    expect(requestTicket).toHaveBeenCalledOnce();
    expect(states).toEqual(["requesting-ticket", "reconnecting", "stopped"]);
  });

  it("closes a registered relay connection before a retry can begin", async () => {
    const host = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const device = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const close = vi.fn(async () => {});
    const connector = new RelayHostConnector({
      relayWebSocketUrl: "wss://relay.example/v1/relay",
      routingId: "a".repeat(43),
      accessToken: "access-token-that-is-definitely-longer-than-32-characters",
      endpoint: host,
      expectedDevicePeer: device.peerId,
      laptopBaseUrl: "http://127.0.0.1:43120",
      requestTicket: async () => ({
        routingId: "a".repeat(43),
        role: "host",
        ticket: "ticket-that-is-definitely-longer-than-32-characters"
      }),
      connect: async () => ({
        socket: {} as never,
        channel: {
          async *frames() {
            throw new Error("device disconnected");
          }
        } as never,
        close
      })
    });

    await expect(connector.serveOnce()).rejects.toThrow("device disconnected");
    expect(close).toHaveBeenCalledOnce();
  });
});
