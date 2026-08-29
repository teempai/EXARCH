import { randomBytes } from "node:crypto";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CanonicalStore,
  DeviceAuthenticator,
  createTestP256DeviceKeyPair
} from "../packages/core/src/index.js";
import type { RequestSignatureInput } from "../packages/protocol/src/index.js";
import {
  NoiseEndpoint,
  RelayRpcClient,
  connectEncryptedRelay,
  requestRelayTicket
} from "../packages/relay/src/index.js";
import {
  ConversationCoordinator,
  DeterministicProviderAdapter,
  LaptopApiServer,
  RelayHostConnector
} from "../services/daemon/src/index.js";
import {
  OpaqueRelayServer,
  RelayAccessAuthority,
  RelayTicketAuthority
} from "../services/relay/src/index.js";

describe.sequential("remote laptop API end to end", () => {
  let store: CanonicalStore;
  let laptop: LaptopApiServer;
  let relay: OpaqueRelayServer;
  let relayBaseUrl: string;
  let relayWebSocketUrl: string;
  let laptopBaseUrl: string;
  let route: ReturnType<RelayAccessAuthority["issueRoute"]>;
  let hostTransport: NoiseEndpoint;
  let deviceTransport: NoiseEndpoint;
  const deviceKeys = createTestP256DeviceKeyPair();

  beforeAll(async () => {
    store = new CanonicalStore(":memory:");
    hostTransport = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    deviceTransport = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    store.registerDevice({
      id: "device_remote",
      displayName: "Remote P-256 phone",
      signingPublicKey: deviceKeys.publicKey,
      approvalPublicKey: deviceKeys.publicKey,
      capabilities: ["mobile-control"],
      attestation: { transportPeerId: deviceTransport.peerId.toString() }
    });
    const coordinator = new ConversationCoordinator(store, [
      new DeterministicProviderAdapter("codex"),
      new DeterministicProviderAdapter("claude"),
      new DeterministicProviderAdapter("hermes")
    ]);
    laptop = new LaptopApiServer(coordinator, new DeviceAuthenticator(store));
    const laptopAddress = await laptop.start();
    laptopBaseUrl = laptopAddress.baseUrl;
    const secret = randomBytes(32);
    const tickets = new RelayTicketAuthority(secret);
    const access = new RelayAccessAuthority(secret, tickets);
    route = access.issueRoute();
    relay = new OpaqueRelayServer(tickets, undefined, {
      adminToken: randomBytes(32).toString("base64url"),
      access
    });
    const relayAddress = await relay.start();
    relayBaseUrl = relayAddress.baseUrl;
    relayWebSocketUrl = relayAddress.wsUrl;
  });

  afterAll(async () => {
    await Promise.all([laptop.stop(), relay.stop()]);
    store.close();
  });

  it("authenticates a native-signed request through the opaque encrypted connector", async () => {
    const connector = new RelayHostConnector({
      relayWebSocketUrl,
      routingId: route.routingId,
      accessToken: route.hostAccessToken,
      endpoint: hostTransport,
      expectedDevicePeer: deviceTransport.peerId,
      laptopBaseUrl
    });
    const serving = connector.serveOnce();
    const deviceTicket = await requestRelayTicket(relayWebSocketUrl, route.deviceAccessToken, {
      routingId: route.routingId,
      role: "device"
    });
    const deviceConnection = await connectEncryptedRelay({
      wsUrl: relayWebSocketUrl,
      routingId: route.routingId,
      role: "device",
      ticket: deviceTicket.ticket,
      endpoint: deviceTransport,
      handshake: "initiator",
      expectedRemote: hostTransport.peerId
    });
    const client = new RelayRpcClient(deviceConnection.channel);
    const challengeBody = Buffer.from(JSON.stringify({ deviceId: "device_remote" }), "utf8");
    const challengeResponse = await client.request({
      method: "POST",
      path: "/api/v1/auth/challenge",
      headers: { "content-type": "application/json" },
      body: challengeBody
    });
    expect(challengeResponse.status).toBe(200);
    const challenge = JSON.parse(challengeResponse.body.toString("utf8")) as {
      nonce: string;
      expiresAt: string;
    };
    const path = "/api/v1/providers";
    const timestamp = new Date().toISOString();
    const body = Buffer.alloc(0);
    const signatureInput: RequestSignatureInput = {
      method: "GET",
      path,
      body,
      nonce: challenge.nonce,
      counter: 1,
      timestamp,
      challengeExpiresAt: challenge.expiresAt
    };
    const providersResponse = await client.request({
      method: "GET",
      path,
      headers: {
        "x-exarch-device-id": "device_remote",
        "x-exarch-nonce": challenge.nonce,
        "x-exarch-counter": "1",
        "x-exarch-timestamp": timestamp,
        "x-exarch-signature": deviceKeys.signRequest(signatureInput)
      }
    });
    expect(providersResponse.status).toBe(200);
    expect(JSON.parse(providersResponse.body.toString("utf8"))).toHaveLength(3);
    expect(relayBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    await client.close();
    await serving;
  });
});
