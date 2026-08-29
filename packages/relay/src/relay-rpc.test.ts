import { randomBytes } from "node:crypto";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { afterEach, describe, expect, it } from "vitest";
import { OpaqueRelayServer } from "../../../services/relay/src/relay-server.js";
import { RelayTicketAuthority, createRoutingId } from "../../../services/relay/src/relay-ticket.js";
import { NoiseEndpoint } from "./noise-channel.js";
import { connectEncryptedRelay } from "./relay-connection.js";
import { RelayRpcClient, RelayRpcServer } from "./relay-rpc.js";

const servers: OpaqueRelayServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe("encrypted relay RPC", () => {
  it("carries bounded HTTP semantics end-to-end without exposing content to the relay", async () => {
    const authority = new RelayTicketAuthority(randomBytes(32));
    const observed: Buffer[] = [];
    const relay = new OpaqueRelayServer(authority, (_metadata, bytes) => observed.push(Buffer.from(bytes)));
    servers.push(relay);
    const { wsUrl } = await relay.start();
    const routingId = createRoutingId();
    const hostIdentity = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const deviceIdentity = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const [hostConnection, deviceConnection] = await Promise.all([
      connectEncryptedRelay({
        wsUrl,
        routingId,
        role: "host",
        ticket: authority.issue(routingId, "host"),
        endpoint: hostIdentity,
        handshake: "responder",
        expectedRemote: deviceIdentity.peerId
      }),
      connectEncryptedRelay({
        wsUrl,
        routingId,
        role: "device",
        ticket: authority.issue(routingId, "device"),
        endpoint: deviceIdentity,
        handshake: "initiator",
        expectedRemote: hostIdentity.peerId
      })
    ]);
    const secret = "relay cannot read this signed request";
    const largeResponse = Buffer.concat([Buffer.from(secret, "utf8"), Buffer.alloc(90_000, 7)]);
    const rpcServer = new RelayRpcServer(hostConnection.channel, async (request) => {
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/api/v1/conversations/conv_1/messages");
      expect(request.headers?.["x-exarch-device-id"]).toBe("device_1");
      expect(Buffer.from(request.body ?? []).toString("utf8")).toBe(secret);
      return { status: 201, contentType: "application/octet-stream", body: largeResponse };
    });
    const serving = rpcServer.serve();
    const client = new RelayRpcClient(deviceConnection.channel);
    const response = await client.request({
      method: "POST",
      path: "/api/v1/conversations/conv_1/messages",
      headers: { "x-exarch-device-id": "device_1" },
      body: Buffer.from(secret, "utf8")
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual(largeResponse);
    expect(Buffer.concat(observed).includes(Buffer.from(secret, "utf8"))).toBe(false);
    await client.close();
    await serving;
  });

  it("turns laptop handler failures into a bounded 502 response", async () => {
    const authority = new RelayTicketAuthority(randomBytes(32));
    const relay = new OpaqueRelayServer(authority);
    servers.push(relay);
    const { wsUrl } = await relay.start();
    const routingId = createRoutingId();
    const hostIdentity = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const deviceIdentity = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const [hostConnection, deviceConnection] = await Promise.all([
      connectEncryptedRelay({
        wsUrl,
        routingId,
        role: "host",
        ticket: authority.issue(routingId, "host"),
        endpoint: hostIdentity,
        handshake: "responder"
      }),
      connectEncryptedRelay({
        wsUrl,
        routingId,
        role: "device",
        ticket: authority.issue(routingId, "device"),
        endpoint: deviceIdentity,
        handshake: "initiator",
        expectedRemote: hostIdentity.peerId
      })
    ]);
    const server = new RelayRpcServer(hostConnection.channel, async () => {
      throw new Error("loopback unavailable");
    });
    const serving = server.serve();
    const client = new RelayRpcClient(deviceConnection.channel);
    const response = await client.request({ method: "GET", path: "/api/v1/health" });
    expect(response.status).toBe(502);
    expect(response.body.toString("utf8")).toContain("laptop_bridge_failed");
    await client.close();
    await serving;
  });
});
