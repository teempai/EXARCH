import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject
} from "node:crypto";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { z } from "zod";
import {
  CanonicalStore,
  encodeP256DevicePublicKey,
  x963P256PublicKey
} from "../../../packages/core/src/index.js";
import {
  NoiseEndpoint,
  connectEncryptedRelay,
  type PairingPayloadSigner
} from "../../../packages/relay/src/index.js";
import type { PairingInvitation } from "../../../packages/protocol/src/index.js";
import { PairingHost, type PendingPairingConfirmation } from "./pairing-host.js";
import { loadDaemonRuntimeConfig, type DaemonRuntimeConfig } from "./runtime-config.js";
import {
  loadDaemonCoreSecrets,
  secretAccount,
  type SecretStore
} from "./secret-store.js";

const RouteCredentialsSchema = z
  .object({
    routingId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.string().datetime({ offset: true }),
    hostAccessToken: z.string().min(32).max(4096),
    deviceAccessToken: z.string().min(32).max(4096),
    hostTicket: z.string().min(32).max(4096),
    deviceTicket: z.string().min(32).max(4096)
  })
  .strict();

export interface BootstrapPairingOptions {
  relayWebSocketUrl: string;
  relayAdminToken: string;
  configPath: string;
  dataDirectory: string;
  apiPort?: number;
  secretStore: SecretStore;
  request?: typeof fetch;
  onInvitation: (invitation: PairingInvitation) => Promise<void> | void;
  confirm: (pairing: PendingPairingConfirmation) => Promise<boolean>;
}

export interface BootstrapPairingResult {
  config: DaemonRuntimeConfig;
  deviceId: string;
  deviceDisplayName: string;
  sas: string;
  transportPeerId: string;
}

export interface InitializeLocalRuntimeOptions {
  configPath: string;
  dataDirectory: string;
  apiPort?: number;
  secretStore: SecretStore;
}

export interface RevokePairingOptions {
  config: DaemonRuntimeConfig;
  configPath: string;
  secretStore: SecretStore;
  store: CanonicalStore;
  deviceId?: string;
  request?: typeof fetch;
}

/**
 * Creates the laptop-owned encrypted store independently of phone pairing.
 * The operation is idempotent for an existing valid installation and never
 * creates relay credentials.
 */
export async function initializeLocalRuntime(
  options: InitializeLocalRuntimeOptions
): Promise<DaemonRuntimeConfig> {
  validatePrivateTarget(options.configPath, options.dataDirectory);
  const existingConfig = await loadExistingConfig(options.configPath);
  if (existingConfig !== null) {
    await loadDaemonCoreSecrets(existingConfig.secretAccountPrefix, options.secretStore);
    return existingConfig;
  }

  await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(options.dataDirectory, 0o700);
  const databasePath = join(options.dataDirectory, "context.sqlite");
  await assertPathDoesNotExist(
    databasePath,
    "An unconfigured database already exists; move it aside or restore its matching Keychain secrets"
  );

  const databaseEncryptionKey = randomBytes(32);
  const contextCapabilitySecret = randomBytes(32);
  const hostTransportPrivateKey = await generateKeyPair("Ed25519");
  const secretAccountPrefix = randomBytes(24).toString("base64url");
  const config: DaemonRuntimeConfig = {
    version: 2,
    dataDirectory: options.dataDirectory,
    secretAccountPrefix,
    apiPort: options.apiPort ?? 32_146,
    requireEncryptedStorage: true,
    pairing: null
  };
  const secrets = [
    [secretAccount.databaseKey(secretAccountPrefix), databaseEncryptionKey.toString("base64url")],
    [secretAccount.contextCapability(secretAccountPrefix), contextCapabilitySecret.toString("base64url")],
    [
      secretAccount.hostTransport(secretAccountPrefix),
      Buffer.from(privateKeyToProtobuf(hostTransportPrivateKey)).toString("base64url")
    ]
  ] as const;
  const written: string[] = [];
  let completed = false;
  const store = new CanonicalStore(databasePath, {
    requireEncrypted: true,
    encryptionKey: databaseEncryptionKey
  });
  store.close();
  try {
    for (const [account, value] of secrets) {
      await options.secretStore.put(account, value);
      written.push(account);
    }
    await writePrivateConfig(options.configPath, config);
    completed = true;
    return config;
  } finally {
    if (!completed) {
      await Promise.allSettled(written.map((account) => options.secretStore.delete(account)));
      await removeDatabaseFiles(databasePath);
    }
  }
}

export async function bootstrapPairing(
  options: BootstrapPairingOptions
): Promise<BootstrapPairingResult> {
  validatePrivateTarget(options.configPath, options.dataDirectory);
  if (options.relayAdminToken.length < 32 || options.relayAdminToken.length > 4096) {
    throw new Error("Relay administrator token is invalid");
  }
  const existingConfig = await loadExistingConfig(options.configPath);
  if (existingConfig?.pairing !== null && existingConfig !== null) {
    throw new Error("A phone is already paired; remove that pairing before creating another");
  }
  const dataDirectory = existingConfig?.dataDirectory ?? options.dataDirectory;
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(dataDirectory, 0o700);
  const route = await provisionRoute(
    options.relayWebSocketUrl,
    options.relayAdminToken,
    options.request
  );
  const existingSecrets = existingConfig === null
    ? null
    : await loadDaemonCoreSecrets(existingConfig.secretAccountPrefix, options.secretStore);
  const databaseEncryptionKey = existingSecrets === null
    ? randomBytes(32)
    : Buffer.from(existingSecrets.databaseEncryptionKey, "base64url");
  const contextCapabilitySecret = existingSecrets === null
    ? randomBytes(32)
    : Buffer.from(existingSecrets.contextCapabilitySecret, "base64url");
  const hostTransportPrivateKey = existingSecrets === null
    ? await generateKeyPair("Ed25519")
    : privateKeyFromProtobuf(Buffer.from(existingSecrets.hostTransportPrivateKey, "base64url"));
  if (hostTransportPrivateKey.type !== "Ed25519") {
    throw new Error("Host transport identity must be Ed25519");
  }
  const endpoint = new NoiseEndpoint(hostTransportPrivateKey);
  const hostPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const hostSigningKey = p256Signer(hostPair.privateKey, hostPair.publicKey);
  const databasePath = join(dataDirectory, "context.sqlite");
  if (existingConfig === null) {
    await assertPathDoesNotExist(
      databasePath,
      "An unconfigured database already exists; move it aside or restore its matching Keychain secrets"
    );
  }
  const store = new CanonicalStore(databasePath, {
    requireEncrypted: true,
    encryptionKey: databaseEncryptionKey
  });
  let confirmation: PendingPairingConfirmation | undefined;
  let completed = false;
  try {
    const pairingHost = new PairingHost({
      store,
      hostSigningKey,
      hostTransportPeerId: endpoint.peerId.toString(),
      confirm: async (pending) => {
        confirmation = pending;
        return options.confirm(pending);
      }
    });
    const invitation = pairingHost.createInvitation({
      relayWebSocketUrl: options.relayWebSocketUrl,
      routingId: route.routingId,
      deviceTicket: route.deviceTicket,
      deviceAccessToken: route.deviceAccessToken
    });
    await options.onInvitation(invitation);
    const connectionPromise = connectEncryptedRelay({
      wsUrl: options.relayWebSocketUrl,
      routingId: route.routingId,
      role: "host",
      ticket: route.hostTicket,
      endpoint,
      handshake: "responder",
      counterpartTimeoutMs: pairingConnectionWaitMs(invitation.expiresAt)
    });
    const connection = await connectionPromise;
    try {
      await pairingHost.accept(connection.channel);
    } finally {
      await connection.close();
    }
    if (confirmation === undefined) throw new Error("Pairing completed without a confirmation transcript");
    const secretAccountPrefix = existingConfig?.secretAccountPrefix
      ?? randomBytes(24).toString("base64url");
    const secrets = existingConfig === null
      ? [
          [secretAccount.databaseKey(secretAccountPrefix), databaseEncryptionKey.toString("base64url")],
          [secretAccount.contextCapability(secretAccountPrefix), contextCapabilitySecret.toString("base64url")],
          [
            secretAccount.hostTransport(secretAccountPrefix),
            Buffer.from(privateKeyToProtobuf(hostTransportPrivateKey)).toString("base64url")
          ],
          [secretAccount.hostRelayAccess(secretAccountPrefix), route.hostAccessToken]
        ] as const
      : [[secretAccount.hostRelayAccess(secretAccountPrefix), route.hostAccessToken]] as const;
    const written: string[] = [];
    try {
      for (const [account, value] of secrets) {
        await options.secretStore.put(account, value);
        written.push(account);
      }
    } catch (error) {
      await Promise.allSettled(written.map((account) => options.secretStore.delete(account)));
      throw error;
    }
    const config: DaemonRuntimeConfig = {
      version: 2,
      dataDirectory,
      secretAccountPrefix,
      apiPort: existingConfig?.apiPort ?? options.apiPort ?? 32_146,
      requireEncryptedStorage: true,
      pairing: {
        relayWebSocketUrl: options.relayWebSocketUrl,
        routingId: route.routingId,
        expectedDevicePeerId: confirmation.transportPeerId
      }
    };
    try {
      await writePrivateConfig(options.configPath, config);
    } catch (error) {
      await Promise.allSettled(written.map((account) => options.secretStore.delete(account)));
      throw error;
    }
    completed = true;
    return {
      config,
      deviceId: confirmation.deviceId,
      deviceDisplayName: confirmation.displayName,
      sas: confirmation.sas,
      transportPeerId: confirmation.transportPeerId
    };
  } finally {
    store.close();
    if (!completed && existingConfig === null) await removeDatabaseFiles(databasePath);
  }
}

export function pairingConnectionWaitMs(expiresAt: string, now = Date.now()): number {
  const remaining = Date.parse(expiresAt) - now;
  if (!Number.isSafeInteger(remaining) || remaining < 1_000 || remaining > 10 * 60_000) {
    throw new Error("Pairing invitation connection window is outside the allowed range");
  }
  return remaining;
}

export async function provisionRoute(
  relayWebSocketUrl: string,
  relayAdminToken: string,
  request: typeof fetch = fetch
): Promise<z.infer<typeof RouteCredentialsSchema>> {
  const endpoint = relayManagementEndpoint(relayWebSocketUrl);
  const response = await request(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${relayAdminToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  });
  if (response.status !== 201) {
    throw new Error(`Relay route provisioning failed with status ${response.status}`);
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > 32 * 1024) throw new Error("Relay route response is too large");
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > 32 * 1024) throw new Error("Relay route response is too large");
  return RouteCredentialsSchema.parse(JSON.parse(raw) as unknown);
}

export async function revokePairing(options: RevokePairingOptions): Promise<string[]> {
  const revokedDeviceIds = await preparePairingRevocation(options);
  await completePairingRevocation(options);
  return revokedDeviceIds;
}

/**
 * Durably records the removal before withdrawing local phone authority. Once
 * this resolves, a caller may safely acknowledge the request: either this
 * process or the next daemon start can finish the relay-side cleanup.
 */
export async function preparePairingRevocation(options: RevokePairingOptions): Promise<string[]> {
  const pairing = options.config.pairing;
  if (pairing === null) return [];
  if (
    options.deviceId !== undefined &&
    pairing.revocationPending !== true &&
    options.store.getDevice(options.deviceId).status !== "active"
  ) {
    throw new Error("The requesting phone is not an active paired device");
  }
  if (pairing.revocationPending !== true) {
    await writePrivateConfig(options.configPath, {
      ...options.config,
      pairing: { ...pairing, revocationPending: true }
    });
  }
  const activeDevices = options.store.listDevices().filter((device) =>
    device.status === "active" && device.capabilities.includes("mobile-control")
  );
  for (const device of activeDevices) options.store.revokeDevice(device.id);
  return activeDevices.map((device) => device.id);
}

/** Completes the retryable remote half of a previously prepared removal. */
export async function completePairingRevocation(options: RevokePairingOptions): Promise<void> {
  const pairing = options.config.pairing;
  if (pairing === null) return;
  const hostAccessToken = await options.secretStore.get(
    secretAccount.hostRelayAccess(options.config.secretAccountPrefix)
  );
  await revokeRelayRoute(
    pairing.relayWebSocketUrl,
    pairing.routingId,
    hostAccessToken,
    options.request
  );
  await writePrivateConfig(options.configPath, { ...options.config, pairing: null });
  await options.secretStore.delete(secretAccount.hostRelayAccess(options.config.secretAccountPrefix));
}

export async function revokeRelayRoute(
  relayWebSocketUrl: string,
  routingId: string,
  hostAccessToken: string,
  request: typeof fetch = fetch
): Promise<void> {
  const endpoint = relayManagementEndpoint(relayWebSocketUrl);
  endpoint.pathname = `/v1/routes/${encodeURIComponent(routingId)}`;
  const response = await request(endpoint, {
    method: "DELETE",
    headers: { authorization: `Bearer ${hostAccessToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  });
  if (response.status !== 204) {
    throw new Error(`Relay route revocation failed with status ${response.status}`);
  }
}

export async function writePrivateConfig(path: string, config: DaemonRuntimeConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export function p256Signer(privateKey: KeyObject, publicKey?: KeyObject): PairingPayloadSigner {
  const actualPublic = publicKey ?? createPublicKey(privateKey);
  return {
    publicKey: encodeP256DevicePublicKey(x963P256PublicKey(actualPublic)),
    async sign(payload) {
      return sign("sha256", payload, privateKey).toString("base64url");
    }
  };
}

export function restoreP256Signer(encodedPrivateKey: string): PairingPayloadSigner {
  const key = createPrivateKey({
    key: Buffer.from(encodedPrivateKey, "base64url"),
    format: "der",
    type: "pkcs8"
  });
  if (key.asymmetricKeyType !== "ec") throw new Error("Host pairing identity must be P-256");
  return p256Signer(key);
}

function relayManagementEndpoint(raw: string): URL {
  const url = new URL(raw);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/v1/relay" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback))
  ) {
    throw new Error("Relay URL must be the exact TLS-protected /v1/relay endpoint");
  }
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/v1/routes";
  return url;
}

async function loadExistingConfig(path: string): Promise<DaemonRuntimeConfig | null> {
  try {
    return await loadDaemonRuntimeConfig(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function assertPathDoesNotExist(path: string, message: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(message);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function removeDatabaseFiles(databasePath: string): Promise<void> {
  const results = await Promise.allSettled(
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map(async (path) => {
      try {
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    })
  );
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, "Incomplete setup database cleanup failed");
}

function validatePrivateTarget(configPath: string, dataDirectory: string): void {
  if (!configPath.startsWith("/") || !dataDirectory.startsWith("/")) {
    throw new Error("Setup paths must be absolute");
  }
  if (configPath === "/" || dataDirectory === "/") throw new Error("Setup paths are too broad");
}
