import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromString } from "@libp2p/peer-id";
import { describe, expect, it, vi } from "vitest";
import { CanonicalStore } from "../../../packages/core/src/index.js";
import {
  NoiseEndpoint,
  connectEncryptedRelay,
  pairDevice,
  type PairingClientResult
} from "../../../packages/relay/src/index.js";
import {
  OpaqueRelayServer,
  RelayAccessAuthority,
  RelayTicketAuthority
} from "../../relay/src/index.js";
import { loadDaemonRuntimeConfig } from "./runtime-config.js";
import {
  bootstrapPairing,
  completePairingRevocation,
  initializeLocalRuntime,
  pairingConnectionWaitMs,
  p256Signer,
  provisionRoute,
  preparePairingRevocation,
  restoreP256Signer,
  writePrivateConfig
} from "./setup.js";
import { secretAccount, type SecretStore } from "./secret-store.js";

describe("secure laptop bootstrap", () => {
  it("initializes an encrypted laptop store without creating a phone pairing", async () => {
    const root = await mkdtemp(join(tmpdir(), "exarch-local-init-"));
    const configPath = join(root, "config.json");
    const dataDirectory = join(root, "data");
    const secrets = new MemorySecretStore();

    const initialized = await initializeLocalRuntime({
      configPath,
      dataDirectory,
      secretStore: secrets
    });

    expect(initialized.pairing).toBeNull();
    expect(initialized.requireEncryptedStorage).toBe(true);
    expect((await lstat(configPath)).mode & 0o777).toBe(0o600);
    expect(secrets.count).toBe(3);
    const databaseKey = await secrets.get(secretAccount.databaseKey(initialized.secretAccountPrefix));
    const store = new CanonicalStore(join(dataDirectory, "context.sqlite"), {
      requireEncrypted: true,
      encryptionKey: Buffer.from(databaseKey, "base64url")
    });
    expect(store.listConversations()).toEqual([]);
    store.close();

    await expect(initializeLocalRuntime({ configPath, dataDirectory, secretStore: secrets }))
      .resolves.toEqual(initialized);
    expect(secrets.count).toBe(3);
  });

  it("waits for the invitation lifetime rather than the normal relay connection timeout", () => {
    const now = Date.parse("2026-08-23T15:00:00.000Z");
    expect(pairingConnectionWaitMs("2026-08-23T15:05:00.000Z", now)).toBe(5 * 60_000);
    expect(() => pairingConnectionWaitMs("2026-08-23T15:00:00.000Z", now)).toThrow(/window/);
  });

  it("provisions a route, pairs one device, encrypts its store, and writes a private config", async () => {
    const relaySecret = randomBytes(32);
    const adminToken = randomBytes(32).toString("base64url");
    const tickets = new RelayTicketAuthority(relaySecret);
    const relay = new OpaqueRelayServer(tickets, undefined, {
      adminToken,
      access: new RelayAccessAuthority(relaySecret, tickets)
    });
    const address = await relay.start();
    const root = await mkdtemp(join(tmpdir(), "exarch-bootstrap-"));
    const configPath = join(root, "config.json");
    const dataDirectory = join(root, "data");
    const deviceTransport = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const devicePair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const deviceSigner = p256Signer(devicePair.privateKey, devicePair.publicKey);
    const secrets = new MemorySecretStore();
    await initializeLocalRuntime({ configPath, dataDirectory, secretStore: secrets });
    let mobile: Promise<PairingClientResult> | undefined;
    try {
      const setup = await bootstrapPairing({
        relayWebSocketUrl: address.wsUrl,
        relayAdminToken: adminToken,
        configPath,
        dataDirectory,
        secretStore: secrets,
        onInvitation(invitation) {
          mobile = (async () => {
            const connection = await connectEncryptedRelay({
              wsUrl: invitation.relayWebSocketUrl,
              routingId: invitation.routingId,
              role: "device",
              ticket: invitation.deviceTicket,
              endpoint: deviceTransport,
              handshake: "initiator",
              expectedRemote: peerIdFromString(invitation.hostTransportPeerId)
            });
            try {
              return await pairDevice(
                connection.channel,
                invitation,
                {
                  deviceId: "device_test_phone",
                  displayName: "Test iPhone",
                  signingKey: deviceSigner,
                  approvalPublicKey: deviceSigner.publicKey
                },
                async () => true
              );
            } finally {
              await connection.close();
            }
          })();
        },
        confirm: async () => true
      });
      const mobileResult = await mobile;
      expect(mobileResult?.sas).toBe(setup.sas);
      expect(setup.deviceId).toBe("device_test_phone");
      expect(setup.transportPeerId).toBe(deviceTransport.peerId.toString());

      const metadata = await lstat(configPath);
      expect(metadata.mode & 0o777).toBe(0o600);
      const rawConfig = await readFile(configPath, "utf8");
      expect(rawConfig).not.toContain(adminToken);
      const config = await loadDaemonRuntimeConfig(configPath);
      expect(rawConfig).not.toContain(await secrets.get(secretAccount.databaseKey(config.secretAccountPrefix)));
      const store = new CanonicalStore(join(dataDirectory, "context.sqlite"), {
        requireEncrypted: true,
        encryptionKey: Buffer.from(
          await secrets.get(secretAccount.databaseKey(config.secretAccountPrefix)),
          "base64url"
        )
      });
      expect(store.getDevice("device_test_phone").displayName).toBe("Test iPhone");
      store.close();
    } finally {
      await relay.stop();
    }
  });

  it("refuses insecure relay provisioning and weak config permissions", async () => {
    await expect(provisionRoute("ws://relay.example/v1/relay", "a".repeat(32))).rejects.toThrow(
      /TLS-protected/
    );
    const root = await mkdtemp(join(tmpdir(), "exarch-bootstrap-existing-"));
    const path = join(root, "config.json");
    await expect(loadDaemonRuntimeConfig(path)).rejects.toThrow();
    await chmod(root, 0o700);
  });

  it("fails closed on unsafe bootstrap targets and malformed relay responses", async () => {
    const secrets = new MemorySecretStore();
    const root = await mkdtemp(join(tmpdir(), "exarch-bootstrap-invalid-"));
    const callbacks = {
      secretStore: secrets,
      onInvitation: () => undefined,
      confirm: async () => false
    };
    await expect(bootstrapPairing({
      relayWebSocketUrl: "wss://relay.example/v1/relay",
      relayAdminToken: "a".repeat(32),
      configPath: "relative.json",
      dataDirectory: "/tmp/exarch-data",
      ...callbacks
    })).rejects.toThrow(/absolute/);
    await expect(bootstrapPairing({
      relayWebSocketUrl: "wss://relay.example/v1/relay",
      relayAdminToken: "short",
      configPath: join(root, "config.json"),
      dataDirectory: join(root, "data"),
      ...callbacks
    })).rejects.toThrow(/administrator token/);

    const failed = vi.fn(async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    await expect(provisionRoute(
      "wss://relay.example/v1/relay",
      "a".repeat(32),
      failed
    )).rejects.toThrow(/status 503/);

    const declaredOversize = vi.fn(async () => new Response("{}", {
      status: 201,
      headers: { "content-length": String(33 * 1024) }
    })) as unknown as typeof fetch;
    await expect(provisionRoute(
      "wss://relay.example/v1/relay",
      "a".repeat(32),
      declaredOversize
    )).rejects.toThrow(/too large/);

    const actualOversize = vi.fn(async () => new Response("x".repeat(33 * 1024), {
      status: 201
    })) as unknown as typeof fetch;
    await expect(provisionRoute(
      "wss://relay.example/v1/relay",
      "a".repeat(32),
      actualOversize
    )).rejects.toThrow(/too large/);
  });

  it("derives the P-256 public key and rejects a non-EC restored identity", async () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const signer = p256Signer(pair.privateKey);
    expect(signer.publicKey).toMatch(/^p256:[A-Za-z0-9_-]+$/);
    await expect(signer.sign(Buffer.from("pairing"))).resolves.toMatch(/^[A-Za-z0-9_-]+$/);

    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey;
    const encoded = Buffer.from(rsa.export({ format: "der", type: "pkcs8" })).toString("base64url");
    expect(() => restoreP256Signer(encoded)).toThrow(/P-256/);
  });

  it("removes a newly-created encrypted database when setup aborts before pairing", async () => {
    const relaySecret = randomBytes(32);
    const adminToken = randomBytes(32).toString("base64url");
    const tickets = new RelayTicketAuthority(relaySecret);
    const relay = new OpaqueRelayServer(tickets, undefined, {
      adminToken,
      access: new RelayAccessAuthority(relaySecret, tickets)
    });
    const address = await relay.start();
    const root = await mkdtemp(join(tmpdir(), "exarch-bootstrap-abort-"));
    const configPath = join(root, "config.json");
    const dataDirectory = join(root, "data");
    const secrets = new MemorySecretStore();
    try {
      await expect(bootstrapPairing({
        relayWebSocketUrl: address.wsUrl,
        relayAdminToken: adminToken,
        configPath,
        dataDirectory,
        secretStore: secrets,
        onInvitation() { throw new Error("UI closed"); },
        confirm: async () => false
      })).rejects.toThrow(/UI closed/);
      await expect(lstat(join(dataDirectory, "context.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(secrets.count).toBe(0);
    } finally {
      await relay.stop();
    }
  });

  it("retires the relay route and phone while preserving encrypted laptop context", async () => {
    const root = await mkdtemp(join(tmpdir(), "exarch-unpair-"));
    const dataDirectory = join(root, "data");
    const configPath = join(root, "config.json");
    const prefix = "s".repeat(32);
    const databaseKey = randomBytes(32);
    await mkdir(dataDirectory, { mode: 0o700 });
    const secrets = new MemorySecretStore();
    await secrets.put(secretAccount.databaseKey(prefix), databaseKey.toString("base64url"));
    await secrets.put(secretAccount.contextCapability(prefix), randomBytes(32).toString("base64url"));
    const hostTransport = await generateKeyPair("Ed25519");
    await secrets.put(
      secretAccount.hostTransport(prefix),
      Buffer.from(privateKeyToProtobuf(hostTransport)).toString("base64url")
    );
    await secrets.put(secretAccount.hostRelayAccess(prefix), "h".repeat(64));
    const config = {
      version: 2 as const,
      dataDirectory,
      secretAccountPrefix: prefix,
      apiPort: 32_146,
      requireEncryptedStorage: true,
      pairing: {
        relayWebSocketUrl: "wss://relay.example/v1/relay",
        routingId: "r".repeat(43),
        expectedDevicePeerId: hostTransport.publicKey.toString()
      }
    };
    await writePrivateConfig(configPath, config);
    const store = new CanonicalStore(join(dataDirectory, "context.sqlite"), {
      requireEncrypted: true,
      encryptionKey: databaseKey
    });
    store.registerDevice({
      id: "device_test_phone",
      displayName: "Test iPhone",
      signingPublicKey: p256Signer(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey).publicKey,
      approvalPublicKey: p256Signer(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey).publicKey,
      capabilities: ["mobile-control"]
    });
    store.registerDevice({
      id: "device_test_mac",
      displayName: "Test Mac",
      signingPublicKey: p256Signer(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey).publicKey,
      approvalPublicKey: p256Signer(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey).publicKey,
      capabilities: ["mac-client"]
    });
    const project = store.enrollProject({ name: "Preserved", repoRoot: root });
    const conversation = store.createConversation({ projectId: project.id, title: "Keep me", activeProvider: "codex" });
    let relayAvailable = false;
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      expect(init?.headers).toEqual({ authorization: `Bearer ${"h".repeat(64)}` });
      return new Response(null, { status: relayAvailable ? 204 : 503 });
    }) as unknown as typeof fetch;

    await expect(preparePairingRevocation({
      config,
      configPath,
      secretStore: secrets,
      store,
      deviceId: "device_test_phone"
    })).resolves.toEqual(["device_test_phone"]);
    expect(request).not.toHaveBeenCalled();
    expect(store.getDevice("device_test_phone").status).toBe("revoked");
    const pendingConfig = await loadDaemonRuntimeConfig(configPath);
    expect(pendingConfig.pairing).toMatchObject({ revocationPending: true });

    await expect(completePairingRevocation({
      config: pendingConfig,
      configPath,
      secretStore: secrets,
      store,
      request
    })).rejects.toThrow(/status 503/);
    await expect(secrets.get(secretAccount.hostRelayAccess(prefix))).resolves.toBe("h".repeat(64));

    // Simulate a fresh daemon loading the durable tombstone after the failed
    // cleanup. It can complete without the now-revoked phone credential.
    relayAvailable = true;
    const restartedConfig = await loadDaemonRuntimeConfig(configPath);
    await expect(preparePairingRevocation({
      config: restartedConfig,
      configPath,
      secretStore: secrets,
      store
    })).resolves.toEqual([]);
    await expect(completePairingRevocation({
      config: restartedConfig,
      configPath,
      secretStore: secrets,
      store,
      request
    })).resolves.toBeUndefined();
    expect((await loadDaemonRuntimeConfig(configPath)).pairing).toBeNull();
    expect(store.getDevice("device_test_phone").status).toBe("revoked");
    expect(store.getDevice("device_test_mac").status).toBe("active");
    expect(store.getConversation(conversation.id).title).toBe("Keep me");
    await expect(secrets.get(secretAccount.hostRelayAccess(prefix))).rejects.toThrow(/missing/);
    await expect(secrets.get(secretAccount.databaseKey(prefix))).resolves.toBe(databaseKey.toString("base64url"));
    store.close();
  });
});

class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  get count(): number { return this.values.size; }
  async put(account: string, value: string): Promise<void> { this.values.set(account, value); }
  async get(account: string): Promise<string> {
    const value = this.values.get(account);
    if (value === undefined) throw new Error("missing secret");
    return value;
  }
  async delete(account: string): Promise<void> { this.values.delete(account); }
}
