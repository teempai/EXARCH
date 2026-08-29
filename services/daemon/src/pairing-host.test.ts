import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { afterEach, describe, expect, it } from "vitest";
import { encodeP256DevicePublicKey, x963P256PublicKey } from "../../../packages/core/src/index.js";
import { CanonicalStore } from "../../../packages/core/src/store/canonical-store.js";
import {
  NoiseEndpoint,
  connectEncryptedRelay,
  pairDevice,
  type PairingPayloadSigner
} from "../../../packages/relay/src/index.js";
import { OpaqueRelayServer } from "../../relay/src/relay-server.js";
import { RelayTicketAuthority, createRoutingId } from "../../relay/src/relay-ticket.js";
import { PairingHost } from "./pairing-host.js";

const relays: OpaqueRelayServer[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.stop()));
});

describe("PairingHost", () => {
  it("bounds invitation lifetime and relay capability material", async () => {
    const store = new CanonicalStore(":memory:");
    const transport = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const host = new PairingHost({
      store,
      hostSigningKey: softwareP256Signer(),
      hostTransportPeerId: transport.peerId.toString(),
      confirm: async () => true
    });
    const base = {
      relayWebSocketUrl: "wss://relay.example/v1/relay",
      routingId: "a".repeat(43),
      deviceTicket: "ticket-that-is-at-least-thirty-two-characters",
      deviceAccessToken: "access-token-that-is-at-least-thirty-two-characters"
    };
    expect(() => host.createInvitation({ ...base, lifetimeMs: 29_999 })).toThrow(/lifetime/);
    expect(() => host.createInvitation({ ...base, lifetimeMs: 10 * 60_000 + 1 })).toThrow(
      /lifetime/
    );
    expect(() => host.createInvitation({ ...base, deviceAccessToken: "short" })).toThrow(
      /access token/
    );
    store.close();
  });

  it("binds P-256 device keys to the authenticated Noise identity after matching SAS confirmation", async () => {
    const authority = new RelayTicketAuthority(randomBytes(32));
    const observed: Buffer[] = [];
    const relay = new OpaqueRelayServer(authority, (_metadata, bytes) => observed.push(Buffer.from(bytes)));
    relays.push(relay);
    const { wsUrl } = await relay.start();
    const routingId = createRoutingId();
    const hostTransport = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const deviceTransport = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const hostSigningKey = softwareP256Signer();
    const deviceSigningKey = softwareP256Signer();
    const approvalKey = softwareP256Signer();
    const store = new CanonicalStore(":memory:");
    let laptopSas: string | null = null;
    let deviceSas: string | null = null;
    const pairingHost = new PairingHost({
      store,
      hostSigningKey,
      hostTransportPeerId: hostTransport.peerId.toString(),
      confirm: async (pending) => {
        laptopSas = pending.sas;
        return true;
      }
    });
    const invitation = pairingHost.createInvitation({
      relayWebSocketUrl: wsUrl,
      routingId,
      deviceTicket: authority.issue(routingId, "device"),
      deviceAccessToken: "device-access-token-that-is-at-least-32-bytes-long"
    });
    const [hostConnection, deviceConnection] = await Promise.all([
      connectEncryptedRelay({
        wsUrl,
        routingId,
        role: "host",
        ticket: authority.issue(routingId, "host"),
        endpoint: hostTransport,
        handshake: "responder"
      }),
      connectEncryptedRelay({
        wsUrl,
        routingId,
        role: "device",
        ticket: invitation.deviceTicket,
        endpoint: deviceTransport,
        handshake: "initiator",
        expectedRemote: hostTransport.peerId
      })
    ]);
    const [registered, paired] = await Promise.all([
      pairingHost.accept(hostConnection.channel),
      pairDevice(
        deviceConnection.channel,
        invitation,
        {
          deviceId: "device_phone",
          displayName: "Teemu's iPhone",
          signingKey: deviceSigningKey,
          approvalPublicKey: approvalKey.publicKey
        },
        async (sas) => {
          deviceSas = sas;
          expect(laptopSas).toBe(sas);
          return true;
        }
      )
    ]);
    expect(registered.id).toBe("device_phone");
    expect(paired.deviceId).toBe("device_phone");
    expect(laptopSas).toMatch(/^[0-9]{18}$/);
    expect(deviceSas).toBe(laptopSas);
    expect(store.getDevice("device_phone")).toMatchObject({
      signingPublicKey: deviceSigningKey.publicKey,
      approvalPublicKey: approvalKey.publicKey,
      attestation: {
        transportPeerId: deviceTransport.peerId.toString(),
        pairingTranscriptHash: paired.transcriptHash
      }
    });
    expect(Buffer.concat(observed).includes(Buffer.from("Teemu's iPhone", "utf8"))).toBe(false);
    await Promise.allSettled([hostConnection.close(), deviceConnection.close()]);
    store.close();
  });

  it("fails closed when the phone declines the authentication string", async () => {
    const authority = new RelayTicketAuthority(randomBytes(32));
    const relay = new OpaqueRelayServer(authority);
    relays.push(relay);
    const { wsUrl } = await relay.start();
    const routingId = createRoutingId();
    const hostTransport = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const deviceTransport = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const store = new CanonicalStore(":memory:");
    const pairingHost = new PairingHost({
      store,
      hostSigningKey: softwareP256Signer(),
      hostTransportPeerId: hostTransport.peerId.toString(),
      confirm: async () => true
    });
    const invitation = pairingHost.createInvitation({
      relayWebSocketUrl: wsUrl,
      routingId,
      deviceTicket: authority.issue(routingId, "device"),
      deviceAccessToken: "declined-device-access-token-at-least-32-bytes"
    });
    const [hostConnection, deviceConnection] = await Promise.all([
      connectEncryptedRelay({
        wsUrl,
        routingId,
        role: "host",
        ticket: authority.issue(routingId, "host"),
        endpoint: hostTransport,
        handshake: "responder"
      }),
      connectEncryptedRelay({
        wsUrl,
        routingId,
        role: "device",
        ticket: invitation.deviceTicket,
        endpoint: deviceTransport,
        handshake: "initiator",
        expectedRemote: hostTransport.peerId
      })
    ]);
    const signingKey = softwareP256Signer();
    const results = await Promise.allSettled([
      pairingHost.accept(hostConnection.channel),
      pairDevice(
        deviceConnection.channel,
        invitation,
        {
          deviceId: "device_declined",
          displayName: "Declined phone",
          signingKey,
          approvalPublicKey: softwareP256Signer().publicKey
        },
        async () => false
      )
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(() => store.getDevice("device_declined")).toThrow(/Unknown device/);
    await Promise.allSettled([hostConnection.close(), deviceConnection.close()]);
    store.close();
  });
});

function softwareP256Signer(): PairingPayloadSigner {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKey: encodeP256DevicePublicKey(x963P256PublicKey(pair.publicKey)),
    sign(payload) {
      return sign("sha256", payload, pair.privateKey).toString("base64url");
    }
  };
}
