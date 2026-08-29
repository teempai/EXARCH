import { randomBytes } from "node:crypto";
import { generateKeyPair } from "@libp2p/crypto/keys";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  NoiseEndpoint,
  WebSocketMessageStream
} from "../../../packages/relay/src/index.js";
import { OpaqueRelayServer } from "./relay-server.js";
import { RelayTicketAuthority, createRoutingId } from "./relay-ticket.js";
import { RelayAccessAuthority } from "./relay-access.js";

const servers: OpaqueRelayServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe("OpaqueRelayServer", () => {
  it("adapts relayed WebSocket binary messages into a libp2p message stream", async () => {
    const authority = new RelayTicketAuthority(randomBytes(32));
    const server = new OpaqueRelayServer(authority);
    servers.push(server);
    const { wsUrl } = await server.start();
    const routingId = createRoutingId();
    const hostSocket = await connected(wsUrl);
    const deviceSocket = await connected(wsUrl);
    const hostReady = waitForControl(hostSocket, "ready");
    const deviceReady = waitForControl(deviceSocket, "ready");
    hostSocket.send(
      JSON.stringify({
        type: "register",
        routingId,
        role: "host",
        ticket: authority.issue(routingId, "host")
      })
    );
    deviceSocket.send(
      JSON.stringify({
        type: "register",
        routingId,
        role: "device",
        ticket: authority.issue(routingId, "device")
      })
    );
    await Promise.all([hostReady, deviceReady]);
    const hostTransport = new WebSocketMessageStream(hostSocket, "outbound");
    const deviceTransport = new WebSocketMessageStream(deviceSocket, "inbound");
    const received = deviceTransport[Symbol.asyncIterator]().next();
    expect(hostTransport.send(Buffer.from("transport probe", "utf8"))).toBe(true);
    expect(Buffer.from((await received).value!.subarray())).toEqual(
      Buffer.from("transport probe", "utf8")
    );
    hostSocket.terminate();
    deviceSocket.terminate();
  });

  it("forwards only live opaque frames while Noise hides canonical plaintext", async () => {
    const authority = new RelayTicketAuthority(randomBytes(32));
    const captured: Buffer[] = [];
    const server = new OpaqueRelayServer(authority, (_metadata, bytes) => captured.push(Buffer.from(bytes)));
    servers.push(server);
    const address = await server.start();
    expect((await fetch(`${address.baseUrl}/health`)).status).toBe(200);
    const routingId = createRoutingId();
    const hostSocket = await connected(address.wsUrl);
    const deviceSocket = await connected(address.wsUrl);
    const hostReady = waitForControl(hostSocket, "ready");
    const deviceReady = waitForControl(deviceSocket, "ready");
    hostSocket.send(
      JSON.stringify({
        type: "register",
        routingId,
        role: "host",
        ticket: authority.issue(routingId, "host")
      })
    );
    deviceSocket.send(
      JSON.stringify({
        type: "register",
        routingId,
        role: "device",
        ticket: authority.issue(routingId, "device")
      })
    );
    await Promise.all([hostReady, deviceReady]);
    const hostIdentity = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const deviceIdentity = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const hostTransport = new WebSocketMessageStream(hostSocket, "outbound");
    const deviceTransport = new WebSocketMessageStream(deviceSocket, "inbound");
    const handshakes = await Promise.allSettled([
      hostIdentity.connect(hostTransport, deviceIdentity.peerId, AbortSignal.timeout(2_000)),
      deviceIdentity.accept(deviceTransport, hostIdentity.peerId, AbortSignal.timeout(2_000))
    ]);
    const failures = handshakes.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${index === 0 ? "host" : "device"}: ${String(result.reason)}`]
        : []
    );
    const diagnostics = [
      ...failures,
      `host transport=${hostTransport.status}/${hostTransport.remoteWriteStatus} socket=${hostSocket.readyState}`,
      `device transport=${deviceTransport.status}/${deviceTransport.remoteWriteStatus} socket=${deviceSocket.readyState}`,
      `relay frames=${captured.length} sizes=${captured.map((frame) => frame.byteLength).join(",")}`
    ].join("\n");
    expect(failures, diagnostics).toEqual([]);
    if (handshakes[0]?.status !== "fulfilled" || handshakes[1]?.status !== "fulfilled") return;
    const host = handshakes[0].value;
    const device = handshakes[1].value;
    const secret = Buffer.from("relay must never see this canonical conversation text", "utf8");
    const received = device.frames()[Symbol.asyncIterator]().next();
    host.send(secret);
    expect(Buffer.from((await received).value as Uint8Array)).toEqual(secret);
    expect(Buffer.concat(captured).includes(secret)).toBe(false);
    expect(server.activeRoutes()).toBe(1);
    hostSocket.terminate();
    deviceSocket.terminate();
  });

  it("rejects registration replay and refuses to queue frames for an offline counterpart", async () => {
    const authority = new RelayTicketAuthority(randomBytes(32));
    const server = new OpaqueRelayServer(authority);
    servers.push(server);
    const { wsUrl } = await server.start();
    const routingId = createRoutingId();
    const ticket = authority.issue(routingId, "host");
    const host = await connected(wsUrl);
    const registered = waitForControl(host, "registered");
    host.send(JSON.stringify({ type: "register", routingId, role: "host", ticket }));
    await registered;
    const offlineClose = waitForClose(host);
    host.send(Buffer.from("opaque", "utf8"));
    await expect(offlineClose).resolves.toBe(1013);

    const replay = await connected(wsUrl);
    const replayClose = waitForClose(replay);
    replay.send(JSON.stringify({ type: "register", routingId, role: "host", ticket }));
    await expect(replayClose).resolves.toBe(1008);

    const malformed = await connected(wsUrl);
    const malformedClose = waitForClose(malformed);
    malformed.send("{}");
    await expect(malformedClose).resolves.toBe(1008);
  });

  it("rejects duplicate roles and plaintext after registration", async () => {
    const authority = new RelayTicketAuthority(randomBytes(32));
    const server = new OpaqueRelayServer(authority);
    servers.push(server);
    const { wsUrl } = await server.start();
    const routingId = createRoutingId();
    const host = await connected(wsUrl);
    const registered = waitForControl(host, "registered");
    host.send(
      JSON.stringify({
        type: "register",
        routingId,
        role: "host",
        ticket: authority.issue(routingId, "host")
      })
    );
    await registered;

    const duplicate = await connected(wsUrl);
    const duplicateClose = waitForClose(duplicate);
    duplicate.send(
      JSON.stringify({
        type: "register",
        routingId,
        role: "host",
        ticket: authority.issue(routingId, "host")
      })
    );
    await expect(duplicateClose).resolves.toBe(1008);
    expect(authority.trackedTicketCount).toBe(1);

    const plaintextClose = waitForClose(host);
    host.send("plaintext is forbidden");
    await expect(plaintextClose).resolves.toBe(1003);
  });

  it("provisions routes only to the administrator and rotates one-use tickets", async () => {
    const secret = randomBytes(32);
    const tickets = new RelayTicketAuthority(secret);
    const access = new RelayAccessAuthority(secret, tickets);
    const adminToken = randomBytes(32).toString("base64url");
    const server = new OpaqueRelayServer(tickets, undefined, { adminToken, access });
    servers.push(server);
    const { baseUrl } = await server.start();
    const unauthorized = await fetch(`${baseUrl}/v1/routes`, {
      method: "POST",
      headers: { authorization: "Bearer wrong" }
    });
    expect(unauthorized.status).toBe(401);
    const provisioned = await fetch(`${baseUrl}/v1/routes`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(provisioned.status).toBe(201);
    const route = (await provisioned.json()) as {
      routingId: string;
      hostAccessToken: string;
    };
    const refreshed = await fetch(`${baseUrl}/v1/tickets`, {
      method: "POST",
      headers: { authorization: `Bearer ${route.hostAccessToken}` }
    });
    expect(refreshed.status).toBe(201);
    const ticket = (await refreshed.json()) as { routingId: string; role: string; ticket: string };
    expect(ticket).toMatchObject({ routingId: route.routingId, role: "host" });
    expect(() => tickets.consume(ticket.ticket, route.routingId, "host")).not.toThrow();
    const revoked = await fetch(`${baseUrl}/v1/routes/${route.routingId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${route.hostAccessToken}` }
    });
    expect(revoked.status).toBe(204);
    const rejected = await fetch(`${baseUrl}/v1/tickets`, {
      method: "POST",
      headers: { authorization: `Bearer ${route.hostAccessToken}` }
    });
    expect(rejected.status).toBe(401);
  });

  it("requires the trusted proxy to attest HTTPS for credentials and WebSocket tickets", async () => {
    const secret = randomBytes(32);
    const tickets = new RelayTicketAuthority(secret);
    const access = new RelayAccessAuthority(secret, tickets);
    const adminToken = randomBytes(32).toString("base64url");
    const server = new OpaqueRelayServer(
      tickets,
      undefined,
      { adminToken, access },
      { trustedProxy: true }
    );
    servers.push(server);
    const { baseUrl, wsUrl } = await server.start();

    const plaintext = await fetch(`${baseUrl}/v1/routes`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(plaintext.status).toBe(426);
    const protectedRequest = await fetch(`${baseUrl}/v1/routes`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-forwarded-proto": "https"
      }
    });
    expect(protectedRequest.status).toBe(201);

    const socket = new WebSocket(wsUrl);
    const failure = new Promise<number>((resolve) => socket.once(
      "unexpected-response",
      (_request, response) => resolve(response.statusCode ?? 0)
    ));
    expect(await failure).toBe(426);

    const protectedSocket = new WebSocket(wsUrl, {
      headers: { "x-forwarded-proto": "https", "fly-client-ip": "203.0.113.10" }
    });
    await new Promise<void>((resolve, reject) => {
      protectedSocket.once("open", resolve);
      protectedSocket.once("error", reject);
    });
    protectedSocket.close();
  });

  it("rejects excess pre-auth upgrades before allocating another WebSocket", async () => {
    const authority = new RelayTicketAuthority(randomBytes(32));
    const server = new OpaqueRelayServer(
      authority,
      undefined,
      undefined,
      { trustedProxy: false },
      { maxPendingConnections: 1, maxActiveConnections: 1 }
    );
    servers.push(server);
    const { wsUrl } = await server.start();
    const first = await connected(wsUrl);
    const second = new WebSocket(wsUrl);
    await expect(unexpectedStatus(second)).resolves.toBe(503);
    first.terminate();
  });

  it("rate-limits upgrades by authoritative client source", async () => {
    const authority = new RelayTicketAuthority(randomBytes(32));
    const server = new OpaqueRelayServer(
      authority,
      undefined,
      undefined,
      { trustedProxy: false },
      { maxUpgradesPerSource: 1 }
    );
    servers.push(server);
    const { wsUrl } = await server.start();
    const first = await connected(wsUrl);
    first.terminate();
    await new Promise((resolve) => setImmediate(resolve));
    const second = new WebSocket(wsUrl);
    await expect(unexpectedStatus(second)).resolves.toBe(429);
  });

  it("closes both peers before forwarding beyond the route backpressure budget", async () => {
    const authority = new RelayTicketAuthority(randomBytes(32));
    const server = new OpaqueRelayServer(
      authority,
      undefined,
      undefined,
      { trustedProxy: false },
      { maxQueuedBytesPerPeer: 1, maxQueuedBytesGlobal: 1 }
    );
    servers.push(server);
    const { wsUrl } = await server.start();
    const routingId = createRoutingId();
    const host = await connected(wsUrl);
    const device = await connected(wsUrl);
    const hostReady = waitForControl(host, "ready");
    const deviceReady = waitForControl(device, "ready");
    host.send(JSON.stringify({
      type: "register",
      routingId,
      role: "host",
      ticket: authority.issue(routingId, "host")
    }));
    device.send(JSON.stringify({
      type: "register",
      routingId,
      role: "device",
      ticket: authority.issue(routingId, "device")
    }));
    await Promise.all([hostReady, deviceReady]);
    const hostClosed = waitForClose(host);
    const deviceClosed = waitForClose(device);
    host.send(Buffer.from("xx"));
    await expect(Promise.all([hostClosed, deviceClosed])).resolves.toEqual([1013, 1013]);
  });

  it("does not forward frames from a connection whose registration was rejected", async () => {
    const authority = new RelayTicketAuthority(randomBytes(32));
    const server = new OpaqueRelayServer(authority);
    servers.push(server);
    const { wsUrl } = await server.start();
    const routingId = createRoutingId();

    const hostSocket = await connected(wsUrl);
    const deviceSocket = await connected(wsUrl);
    const hostReady = waitForControl(hostSocket, "ready");
    hostSocket.send(
      JSON.stringify({ type: "register", routingId, role: "host", ticket: authority.issue(routingId, "host") })
    );
    deviceSocket.send(
      JSON.stringify({ type: "register", routingId, role: "device", ticket: authority.issue(routingId, "device") })
    );
    await hostReady;

    const delivered: Buffer[] = [];
    hostSocket.on("message", (data, isBinary) => {
      if (isBinary) delivered.push(data as Buffer);
    });

    // A second device holding a valid ticket for the same route. The role slot
    // is taken, so registration is rejected; the frame it sends immediately
    // afterwards must not reach the host, whose Noise session would otherwise
    // fail to authenticate it and tear down.
    const intruderSocket = await connected(wsUrl);
    const intruderClosed = new Promise<number>((resolve) => intruderSocket.once("close", resolve));
    intruderSocket.send(
      JSON.stringify({ type: "register", routingId, role: "device", ticket: authority.issue(routingId, "device") })
    );
    intruderSocket.send(Buffer.from("injected"), { binary: true });

    expect(await intruderClosed).toBe(1008);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(delivered).toHaveLength(0);
    expect(server.activeRoutes()).toBe(1);

    hostSocket.close();
    deviceSocket.close();
  });
});

async function connected(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 70 * 1024 });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

function waitForControl(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2_000);
    const listener = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      const value = JSON.parse(data.toString()) as Record<string, unknown>;
      if (value.type !== type) return;
      clearTimeout(timeout);
      socket.off("message", listener);
      resolve(value);
    };
    socket.on("message", listener);
  });
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

function unexpectedStatus(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    socket.once("open", () => reject(new Error("WebSocket upgrade unexpectedly succeeded")));
    socket.once("error", () => {
      // `unexpected-response` is the authoritative status path.
    });
  });
}

describe("forwarded-proto trust", () => {
  it("keeps accepting the header when no proxy address is configured", async () => {
    const relay = new OpaqueRelayServer(
      new RelayTicketAuthority(randomBytes(32)),
      undefined,
      undefined,
      { trustedProxy: true }
    );
    const { baseUrl } = await relay.start(0, "127.0.0.1");
    const response = await fetch(`${baseUrl}/v1/routes`, {
      method: "POST",
      headers: { "x-forwarded-proto": "https" }
    });
    // No management options, so this is a 404 rather than the 426 the check
    // would produce. What matters is that it is not 426.
    expect(response.status).not.toBe(426);
    await relay.stop();
  });

  it("refuses the header from a peer that is not the configured proxy", async () => {
    const relay = new OpaqueRelayServer(
      new RelayTicketAuthority(randomBytes(32)),
      undefined,
      undefined,
      { trustedProxy: true, proxyAddresses: ["10.0.0.7"] }
    );
    const { baseUrl } = await relay.start(0, "127.0.0.1");
    const response = await fetch(`${baseUrl}/v1/routes`, {
      method: "POST",
      headers: { "x-forwarded-proto": "https" }
    });
    expect(response.status).toBe(426);
    expect(await response.json()).toEqual({ error: "tls_required" });
    await relay.stop();
  });
});
