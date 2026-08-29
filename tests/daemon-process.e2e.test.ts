import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmod, mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromString } from "@libp2p/peer-id";
import { describe, expect, it } from "vitest";
import {
  encodeP256DevicePublicKey,
  x963P256PublicKey
} from "../packages/core/src/index.js";
import {
  requestSignaturePayload,
  type RequestSignatureInput
} from "../packages/protocol/src/index.js";
import {
  NoiseEndpoint,
  RelayRpcClient,
  connectEncryptedRelay,
  pairDevice,
  requestRelayTicket
} from "../packages/relay/src/index.js";
import {
  KeychainCommandSecretStore,
  bootstrapPairing,
  p256Signer
} from "../services/daemon/src/index.js";
import {
  OpaqueRelayServer,
  RelayAccessAuthority,
  RelayTicketAuthority
} from "../services/relay/src/index.js";

describe.sequential("assembled daemon process", () => {
  it("starts from private config plus Keychain, then serves an authenticated phone request", async () => {
    const root = await mkdtemp(join(tmpdir(), "exarch-daemon-process-"));
    const configPath = join(root, "config.json");
    const dataDirectory = join(root, "data");
    const secretDirectory = join(root, "secrets");
    const helper = join(process.cwd(), "services/daemon/src/fixtures/secret-store-helper.mjs");
    await chmod(helper, 0o700);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(secretDirectory, { mode: 0o700 }));
    const secretStore = new KeychainCommandSecretStore(helper, {
      ...process.env,
      PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
      EXARCH_TEST_SECRET_DIR: secretDirectory
    });
    const relaySecret = randomBytes(32);
    const adminToken = randomBytes(32).toString("base64url");
    const tickets = new RelayTicketAuthority(relaySecret);
    const relay = new OpaqueRelayServer(tickets, undefined, {
      adminToken,
      access: new RelayAccessAuthority(relaySecret, tickets)
    });
    const relayAddress = await relay.start();
    const deviceTransport = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const devicePair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const deviceSigner = p256Signer(devicePair.privateKey, devicePair.publicKey);
    const deviceId = "device_process_test";
    let deviceAccessToken = "";
    let hostPeerId = "";
    let daemon: ChildProcess | undefined;
    let client: RelayRpcClient | undefined;
    try {
      const apiPort = await freePort();
      let mobile: Promise<void> | undefined;
      await bootstrapPairing({
        relayWebSocketUrl: relayAddress.wsUrl,
        relayAdminToken: adminToken,
        configPath,
        dataDirectory,
        apiPort,
        secretStore,
        onInvitation(invitation) {
          hostPeerId = invitation.hostTransportPeerId;
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
              const result = await pairDevice(
                connection.channel,
                invitation,
                {
                  deviceId,
                  displayName: "Process test phone",
                  signingKey: deviceSigner,
                  approvalPublicKey: deviceSigner.publicKey
                },
                async () => true
              );
              deviceAccessToken = result.relayAccessToken;
            } finally {
              await connection.close();
            }
          })();
        },
        confirm: async () => true
      });
      await mobile;

      daemon = spawn(
        process.execPath,
        [
          join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
          join(process.cwd(), "services/daemon/src/main.ts")
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
            EXARCH_CONFIG_PATH: configPath,
            EXARCH_KEYCHAIN_HELPER: helper,
            EXARCH_TEST_SECRET_DIR: secretDirectory
          },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      await waitForEvent(daemon, "online");
      const config = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(configPath, "utf8"))) as {
        pairing: { routingId: string };
      };
      const ticket = await requestRelayTicket(relayAddress.wsUrl, deviceAccessToken, {
        routingId: config.pairing.routingId,
        role: "device"
      });
      const connection = await connectEncryptedRelay({
        wsUrl: relayAddress.wsUrl,
        routingId: config.pairing.routingId,
        role: "device",
        ticket: ticket.ticket,
        endpoint: deviceTransport,
        handshake: "initiator",
        expectedRemote: peerIdFromString(hostPeerId)
      });
      client = new RelayRpcClient(connection.channel);
      const challengeBody = Buffer.from(JSON.stringify({ deviceId }), "utf8");
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
      const path = "/api/v1/health";
      const timestamp = new Date().toISOString();
      const signatureInput: RequestSignatureInput = {
        method: "GET",
        path,
        body: Buffer.alloc(0),
        nonce: challenge.nonce,
        counter: 1,
        timestamp,
        challengeExpiresAt: challenge.expiresAt
      };
      const health = await client.request({
        method: "GET",
        path,
        headers: {
          "x-exarch-device-id": deviceId,
          "x-exarch-nonce": challenge.nonce,
          "x-exarch-counter": "1",
          "x-exarch-timestamp": timestamp,
          "x-exarch-signature": sign("sha256", requestSignaturePayload(signatureInput), devicePair.privateKey)
            .toString("base64url")
        }
      });
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body.toString("utf8"))).toEqual({ status: "ok", version: 1 });
      expect(deviceSigner.publicKey).toBe(
        encodeP256DevicePublicKey(x963P256PublicKey(devicePair.publicKey))
      );
    } finally {
      await client?.close().catch(() => undefined);
      if (daemon?.exitCode === null) daemon.kill("SIGTERM");
      if (daemon !== undefined) await waitForExit(daemon);
      await relay.stop();
    }
  }, 20_000);
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not reserve a port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForEvent(child: ChildProcess, expected: string): Promise<void> {
  let buffer = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for daemon ${expected}`)), 10_000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (const line of buffer.split("\n")) {
        try {
          if ((JSON.parse(line) as { event?: string }).event === expected) return finish();
        } catch { /* incomplete line */ }
      }
    };
    const onExit = (code: number | null) => finish(new Error(`Daemon exited early (${code})`));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      error ? reject(error) : resolve();
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}
